/**
 * Giao diện hợp nhất: 🚨 Cảnh báo | 🔍 Tra cứu | 📊 Thống kê (bảng + biểu đồ) | ⚙️ Cài đặt | 📖 Hướng dẫn
 *
 * Chạy ở 2 chế độ:
 * - TIỆN ÍCH TRÌNH DUYỆT (chrome-extension://): dữ liệu do background.js tải, lưu trong chrome.storage
 * - ỨNG DỤNG DESKTOP (.exe, http://127.0.0.1:<cổng>): gọi REST API cục bộ, kèm mã bảo vệ phiên (token)
 *
 * Logic tính hạn dùng chung nằm trong core.js (HSMC), biểu đồ trong charts.js (HSMCCharts).
 */
"use strict";

const IS_EXTENSION = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id) && location.protocol === "chrome-extension:";
const IS_DESKTOP = !IS_EXTENSION && (location.protocol === "http:" || location.protocol === "https:");

let currentAlerts = [];
let allDossiers = [];
let sheetUrl = "";
let lastCheckTimeIso = null;
let checkIntervalMin = HSMC.DEFAULTS.checkInterval;
let isChecking = false;

// Cấu hình vị trí cột & giám sát quy trình từng bước
let columnMapping = Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING);
let enableStepTracking = false;
let stepDefinitions = HSMC.DEFAULT_WORKFLOW_STEPS.map((s) => Object.assign({}, s));
let detectedSheetHeaders = [];

// Tab 1: Cảnh báo
let alertFilter = "all"; // "all" | "HẾT HẠN" | "SẮP HẾT HẠN"
let alertSearch = "";

// Tab 2: Tra cứu
let lookupSearch = "";
let lookupField = "";
let lookupStatus = "";
let lookupProgress = "";
let lookupPage = 1;
const LOOKUP_PAGE_SIZE = 50;

// Tab 3: Thống kê
let analyticsDateFrom = "";
let analyticsDateTo = "";
let analyticsDateInitialized = false;
let analyticsDomain = "";
let analyticsMatrixViewMode = "count";
let analyticsActiveSubtab = "charts"; // "charts" | "domain" | "matrix" | "procedure" | "status-detail"
let analyticsStatusDetailFilter = "all";
let analyticsStatusDetailSearch = "";
let analyticsStatusDetailDomain = "";
let analyticsStatusDetailPage = 1;
const STATUS_DETAIL_PAGE_SIZE = 50;

// ----------------------------------------------------
// API CỤC BỘ (BẢN DESKTOP) - luôn kèm token phiên
// ----------------------------------------------------
function getApiToken() {
  const meta = document.querySelector('meta[name="hsmc-token"]');
  const t = meta ? meta.getAttribute("content") : "";
  return t && !t.startsWith("__") ? t : "";
}

function apiFetch(path, options) {
  const opts = Object.assign({ method: "GET", cache: "no-store" }, options || {});
  opts.headers = Object.assign({ "X-HSMC-Token": getApiToken() }, opts.headers || {});
  return fetch(path, opts);
}

// ----------------------------------------------------
// BỘ LƯU TRỮ ĐA NỀN TẢNG (Web PWA: LocalStorage cho Config + IndexedDB cho Dữ liệu lớn)
// ----------------------------------------------------
const WEB_STORAGE_KEY = "hsmc_web_config_v1.1";

// Cache hồ sơ lớn (>5MB) bằng IndexedDB để không bao giờ bị tràn giới hạn 5MB của localStorage
const DossierCache = {
  _dbPromise: null,
  _getDB() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      try {
        const req = indexedDB.open("HSMC_Web_DB", 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("cache")) {
            db.createObjectStore("cache");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
    return this._dbPromise;
  },
  async get(key) {
    try {
      const db = await this._getDB();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("cache", "readonly");
          const req = tx.objectStore("cache").get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    } catch (e) {
      return null;
    }
  },
  async set(key, val) {
    try {
      const db = await this._getDB();
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("cache", "readwrite");
          tx.objectStore("cache").put(val, key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    } catch (e) {
      return false;
    }
  }
};

const Storage = {
  _readAll() {
    try {
      let raw = localStorage.getItem(WEB_STORAGE_KEY);

      // Tự động dọn dẹp các key phiên bản cũ nếu đã bị đầy quota
      try {
        const legacyKeys = ["hsmc_web_storage_v1", "hsmc_web_storage_v1.1"];
        legacyKeys.forEach((lk) => {
          const oldVal = localStorage.getItem(lk);
          if (oldVal) {
            try {
              const parsed = JSON.parse(oldVal);
              delete parsed.allDossiers;
              if (!raw) {
                localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(parsed));
                raw = localStorage.getItem(WEB_STORAGE_KEY);
              }
            } catch (_) {}
            localStorage.removeItem(lk);
          }
        });
      } catch (_) {}

      if (!raw) {
        let savedUrl = "";
        try { savedUrl = localStorage.getItem("hoSoMotCua_savedSheetUrl") || ""; } catch (_) {}
        if (!savedUrl && typeof HSMC !== "undefined") savedUrl = HSMC.DEFAULT_SHEET_URL || "";

        const init = {
          sheetUrl: savedUrl,
          lastSheetUrl: savedUrl,
          calcMethod: typeof HSMC !== "undefined" ? HSMC.DEFAULTS.calcMethod : "weekdays_only",
          thresholdUnder7: typeof HSMC !== "undefined" ? HSMC.DEFAULTS.thresholdUnder7 : 50,
          thresholdOver7: typeof HSMC !== "undefined" ? HSMC.DEFAULTS.thresholdOver7 : 20,
          checkInterval: typeof HSMC !== "undefined" ? HSMC.DEFAULTS.checkInterval : 30,
          extraHolidays: typeof HSMC !== "undefined" ? HSMC.DEFAULT_EXTRA_HOLIDAYS : "",
          columnMapping: typeof HSMC !== "undefined" ? Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING) : {},
          enableStepTracking: false,
          stepDefinitions: typeof HSMC !== "undefined" ? HSMC.DEFAULT_WORKFLOW_STEPS.map((s) => Object.assign({}, s)) : []
        };
        try { localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(init)); } catch (_) {}
        return init;
      }
      const data = JSON.parse(raw);
      if (data && data.allDossiers) {
        delete data.allDossiers;
        try { localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
      }
      return data || {};
    } catch (e) {
      console.error("[WebStorage] Read error:", e);
      return {};
    }
  },

  get(keys, callback) {
    const data = this._readAll();
    if (!data.sheetUrl && !data.lastSheetUrl) {
      try {
        const u = localStorage.getItem("hoSoMotCua_savedSheetUrl");
        if (u) { data.sheetUrl = u; data.lastSheetUrl = u; }
      } catch (_) {}
    }

    const keyArr = keys ? (Array.isArray(keys) ? keys : [keys]) : Object.keys(data);
    const needsDossiers = keyArr.includes("allDossiers");
    const needsAlerts = keyArr.includes("currentAlerts");

    if (needsDossiers || needsAlerts) {
      (async () => {
        const result = {};
        keyArr.forEach((k) => {
          if (k in data) result[k] = data[k];
        });
        if (needsDossiers) {
          result.allDossiers = (allDossiers && allDossiers.length) ? allDossiers : ((await DossierCache.get("allDossiers")) || []);
        }
        if (needsAlerts) {
          result.currentAlerts = (currentAlerts && currentAlerts.length) ? currentAlerts : ((await DossierCache.get("currentAlerts")) || []);
        }
        callback(result);
      })();
      return;
    }

    const result = {};
    keyArr.forEach((k) => {
      if (k in data) result[k] = data[k];
    });
    callback(result);
  },

  set(items, callback) {
    try {
      const existing = this._readAll();
      const clone = Object.assign({}, items || {});

      // Lưu trữ allDossiers & currentAlerts vào IndexedDB & RAM, tuyệt đối KHÔNG lưu allDossiers vào localStorage
      if ("allDossiers" in clone) {
        if (Array.isArray(clone.allDossiers)) allDossiers = clone.allDossiers;
        DossierCache.set("allDossiers", clone.allDossiers).catch(() => {});
        delete clone.allDossiers;
      }
      if ("currentAlerts" in clone) {
        if (Array.isArray(clone.currentAlerts)) currentAlerts = clone.currentAlerts;
        DossierCache.set("currentAlerts", clone.currentAlerts).catch(() => {});
      }

      if (clone.sheetUrl) {
        try { localStorage.setItem("hoSoMotCua_savedSheetUrl", clone.sheetUrl); } catch (_) {}
      }

      const merged = Object.assign({}, existing || {}, clone);
      delete merged.allDossiers;
      localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(merged));
    } catch (e) {
      console.error("[WebStorage] Write error:", e);
    }
    if (callback) callback();
  }
};

function storageGet(keys) {
  return new Promise((resolve) => Storage.get(keys, resolve));
}
function storageSet(items) {
  return new Promise((resolve) => Storage.set(items, resolve));
}

// ----------------------------------------------------
// TIỆN ÍCH
// ----------------------------------------------------
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("vi-VN");
}

function showToast(message, type) {
  const box = document.getElementById("toast-container");
  if (!box) return;
  const t = document.createElement("div");
  t.className = "toast toast-" + (type || "info");
  t.textContent = message;
  box.appendChild(t);
  setTimeout(() => t.classList.add("toast-hide"), 4200);
  setTimeout(() => t.remove(), 4700);
}

/** Ngày dùng cho thống kê: Cột F → mã hồ sơ (YYMMDD) → ngày hẹn trả */
function parseItemDate(item) {
  if (!item) return null;
  if (item.ngayTiepNhan) {
    const d = HSMC.parseCustomDate(item.ngayTiepNhan);
    if (d) return d;
  }
  if (item.maHoSo) {
    const m = item.maHoSo.match(/-(\d{2})(\d{2})(\d{2})-/);
    if (m) {
      const d = new Date(2000 + +m[1], +m[2] - 1, +m[3]);
      if (!isNaN(d.getTime()) && d.getMonth() === +m[2] - 1) return d;
    }
  }
  if (item.ngayHenTra) {
    const d = HSMC.parseCustomDate(item.ngayHenTra);
    if (d) return d;
  }
  return null;
}

function getStatusBadge(status) {
  switch (status) {
    case "Hết hạn":
      return `<span class="tag tag-danger">🔴 Hết hạn</span>`;
    case "Sắp hết hạn":
    case "Sắp hết":
      return `<span class="tag tag-warning">🟡 Sắp hết</span>`;
    case "Đang xử lý":
    case "Đang XL":
      return `<span class="tag tag-info">🔵 Đang XL</span>`;
    case "Hoàn thành trước hạn":
      return `<span class="tag tag-success">🟢 HT trước</span>`;
    case "Hoàn thành đúng hạn":
      return `<span class="tag tag-success">🟢 HT đúng</span>`;
    case "Hoàn thành trễ hạn":
      return `<span class="tag tag-orange">🟠 HT trễ</span>`;
    case "Hoàn thành":
      return `<span class="tag tag-neutral">⚪ Hoàn thành</span>`;
    case "Đã trả kết quả":
    case "Đã xử lý xong":
      return `<span class="tag tag-success">${escapeHtml(status)}</span>`;
    case "Đã rút hồ sơ":
    case "Dừng xử lý":
    case "Chờ rút hồ sơ":
    case "Không được tiếp nhận":
      return `<span class="tag tag-neutral">⚪ ${escapeHtml(status)}</span>`;
    default:
      return `<span class="tag tag-neutral">${escapeHtml(status || "---")}</span>`;
  }
}

function isFinished(item) {
  return (item.formulaStatus || "").startsWith("Hoàn thành");
}

/** Đối chiếu hồ sơ với các nhóm tiến độ chuẩn ('all' = tất cả) */
function matchesStatusProgress(item, key) {
  if (!key || key === "all") return true;
  const s = item.formulaStatus || "";
  switch (key) {
    case "Hết hạn":
      return s === "Hết hạn";
    case "Sắp hết":
    case "Sắp hết hạn":
      return s === "Sắp hết hạn";
    case "Đang XL":
    case "Đang xử lý":
      return s === "Đang xử lý";
    case "HT trước":
    case "Hoàn thành trước hạn":
      return s === "Hoàn thành trước hạn";
    case "HT đúng":
    case "Hoàn thành đúng hạn":
      return s === "Hoàn thành đúng hạn";
    case "HT đúng/trước":
      return s === "Hoàn thành trước hạn" || s === "Hoàn thành đúng hạn";
    case "HT trễ":
    case "Hoàn thành trễ hạn":
      return s === "Hoàn thành trễ hạn";
    case "HT khác":
    case "Hoàn thành":
      return s === "Hoàn thành";
    case "Đã xong":
      return isFinished(item);
    default:
      return s === key || item.trangThaiHoSo === key;
  }
}

const STATUS_KEY_LABELS = {
  "all": "Tất cả",
  "Hết hạn": "Hết hạn",
  "Sắp hết": "Sắp hết hạn",
  "Đang XL": "Đang xử lý",
  "HT trước": "Hoàn thành trước hạn",
  "HT đúng": "Hoàn thành đúng hạn",
  "HT đúng/trước": "Hoàn thành đúng/trước hạn",
  "HT trễ": "Hoàn thành trễ hạn",
  "HT khác": "Kết thúc khác (rút, không tiếp nhận…)",
  "Đã xong": "Đã kết thúc (mọi loại)"
};

// ----------------------------------------------------
// TẢI & XỬ LÝ DỮ LIỆU
// ----------------------------------------------------
async function webFetchText(url) {
  const proxyUrl = "/api/proxy?url=" + encodeURIComponent(url);
  const res = await fetch(proxyUrl, { cache: "no-store" });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || ("Máy chủ phản hồi HTTP " + res.status));
  }
  return res.text();
}

async function fetchSheetCsvForUi(url) {
  return HSMC.fetchSheetCSV(url, webFetchText);
}

async function checkAndTriggerAlertCore(opts) {
  opts = opts || {};
  if (isChecking) return { success: false, error: "Đang cập nhật..." };
  isChecking = true;
  setRefreshBusy(true);
  try {
    if (IS_EXTENSION) {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "CHECK_NOW", forceOpen: false }, (res) => {
          if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
          else resolve(res || { success: false, error: "Không nhận được phản hồi từ tiện ích." });
        });
      });
    }

    const config = await storageGet([
      "sheetUrl", "lastSheetUrl", "thresholdUnder7", "thresholdOver7",
      "calcMethod", "selectedFields", "selectedStatuses", "extraHolidays",
      "columnMapping", "enableStepTracking", "stepDefinitions"
    ]);
    let target = config.sheetUrl || config.lastSheetUrl || "";
    if (!target) {
      try { target = localStorage.getItem("hoSoMotCua_savedSheetUrl") || ""; } catch (_) {}
    }
    if (!target) {
      await storageSet({ sheetUrlMissing: true, currentAlerts: [], allDossiers: [] });
      return { success: false, error: "Chưa cấu hình link Google Sheet. Vui lòng vào tab Cài Đặt để nhập link." };
    }

    try {
      const { allDossiers: list, alertRecords } = await HSMC.runCheck(target, config, webFetchText, new Date());
      currentAlerts = alertRecords || [];
      allDossiers = list || [];
      await storageSet({
        currentAlerts: alertRecords,
        allDossiers: list,
        lastCheckTime: new Date().toISOString(),
        lastSheetUrl: target,
        sheetUrl: target,
        sheetUrlMissing: false,
        lastCheckError: null
      });
      if (opts.notify && alertRecords.length > 0) {
        const overdue = alertRecords.filter((a) => a.alertStatus === "HẾT HẠN").length;
        const msg = `Có ${overdue} hồ sơ hết hạn và ${alertRecords.length - overdue} hồ sơ sắp hết hạn cần xử lý.`;
        sendWebNotification("🏛️ Cảnh báo hồ sơ Một Cửa", msg);
      }
      return { success: true, count: alertRecords.length, total: list.length };
    } catch (err) {
      await storageSet({ lastCheckError: err.message, lastCheckTime: new Date().toISOString() });
      return { success: false, error: err.message };
    }
  } finally {
    isChecking = false;
    setRefreshBusy(false);
  }
}

function sendDesktopNotification(message) {
  if (!IS_DESKTOP) return;
  apiFetch("/api/notify", {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: String(message).slice(0, 240)
  }).catch(() => {});
}

function setRefreshBusy(busy) {
  const btn = document.getElementById("btn-refresh");
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? "⏳ Đang tải..." : "🔄 Cập nhật";
}

async function refreshNow(opts) {
  const res = await checkAndTriggerAlertCore(opts);
  loadAllData();
  return res;
}

/** Tự động làm mới khi dữ liệu cũ hơn chu kỳ đã cài đặt */
function isDataStale() {
  if (!lastCheckTimeIso) return true;
  const t = new Date(lastCheckTimeIso).getTime();
  if (isNaN(t)) return true;
  const interval = Math.max(1, Number(checkIntervalMin) || HSMC.DEFAULTS.checkInterval);
  return Date.now() - t >= interval * 60000;
}

function startAutoRefresh() {
  setInterval(() => {
    if (!isChecking && isDataStale() && Number(checkIntervalMin) > 0) refreshNow({ notify: true });
  }, 60000);
}

// ----------------------------------------------------
// CHUYỂN TAB
// ----------------------------------------------------
function switchTab(targetTab) {
  const tabs = {
    alerts: ["tab-alerts-btn", "view-alerts"],
    lookup: ["tab-lookup-btn", "view-lookup"],
    analytics: ["tab-analytics-btn", "view-analytics"],
    settings: ["tab-settings-btn", "view-settings"],
    guide: ["tab-guide-btn", "view-guide"]
  };
  if (!tabs[targetTab]) targetTab = "alerts";
  Object.keys(tabs).forEach((k) => {
    const [btnId, viewId] = tabs[k];
    const b = document.getElementById(btnId);
    const v = document.getElementById(viewId);
    if (b) {
      b.classList.toggle("active", k === targetTab);
      b.setAttribute("aria-selected", k === targetTab ? "true" : "false");
    }
    if (v) v.style.display = k === targetTab ? "block" : "none";
  });
  if (window.HSMCCharts) HSMCCharts.hideTip();

  if (targetTab === "lookup") renderLookupTable();
  else if (targetTab === "analytics") renderAnalytics();
  else if (targetTab === "settings") loadSettingsIntoForm();
  else if (targetTab === "guide") document.querySelector(".main-content").scrollTo({ top: 0 });
  else renderAlertsTable();
}

// ----------------------------------------------------
// TAB 1: CẢNH BÁO
// ----------------------------------------------------
function textMatch(item, q, withPhone) {
  if (!q) return true;
  return (
    (item.maHoSo || "").toLowerCase().includes(q) ||
    (item.tenThuTuc || "").toLowerCase().includes(q) ||
    (item.tenLinhVuc || "").toLowerCase().includes(q) ||
    (item.nguoiNop || "").toLowerCase().includes(q) ||
    (item.chuHoSo || "").toLowerCase().includes(q) ||
    (withPhone && (item.soDienThoai || "").toLowerCase().includes(q))
  );
}

function remainingText(item) {
  if (item.remainingDays === null || item.remainingDays === undefined) return `<span class="muted">Chưa có hạn</span>`;
  const total = item.totalDays;
  const totalTxt = total !== null && total !== undefined ? ` / ${total} ngày` : " ngày";

  if (item.alertStatus === "HẾT HẠN" || item.formulaStatus === "Hết hạn") {
    const d = Math.abs(item.remainingDays || 0);
    const overdueLabel = d > 0 ? `Quá hạn ${d} ngày` : "Hết hạn hôm nay";
    const totalSub = total !== null && total !== undefined ? ` <span class="cell-sub" style="color: #64748b; font-size: 11.5px;">(Tổng: ${total} ngày)</span>` : "";
    return `<span class="text-danger font-semibold">${overdueLabel}</span>${totalSub}`;
  }
  return `<span class="text-warning font-semibold">Còn <b>${item.remainingDays}</b>${totalTxt}</span>`;
}

function renderAlertsTable() {
  const tbody = document.getElementById("alerts-tbody");
  const emptyState = document.getElementById("alerts-empty");
  tbody.innerHTML = "";
  const q = alertSearch.toLowerCase().trim();

  const filtered = currentAlerts.filter((item) => {
    if (alertFilter !== "all" && item.alertStatus !== alertFilter) return false;
    return textMatch(item, q, false);
  });

  emptyState.style.display = filtered.length === 0 ? "block" : "none";
  if (filtered.length === 0) {
    emptyState.querySelector(".empty-title").textContent = currentAlerts.length
      ? "Không có hồ sơ cảnh báo khớp bộ lọc."
      : "Tuyệt vời! Không có hồ sơ nào quá hạn hoặc sắp hết hạn.";
    return;
  }

  const html = filtered.map((item) => {
    const isOverdue = item.alertStatus === "HẾT HẠN";
    return `<tr>
      <td><button type="button" class="code" data-code="${escapeHtml(item.maHoSo)}">${escapeHtml(item.maHoSo)}</button></td>
      <td>${isOverdue ? `<span class="tag tag-danger">🔴 HẾT HẠN</span>` : `<span class="tag tag-warning">🟡 SẮP HẾT HẠN</span>`}</td>
      <td>${getStatusBadge(item.trangThaiHoSo)}</td>
      <td>${remainingText(item)}</td>
      <td>${escapeHtml(item.tenLinhVuc || "---")}</td>
      <td class="cell-proc" title="${escapeHtml(item.tenThuTuc)}">${escapeHtml(item.tenThuTuc || "---")}</td>
      <td class="cell-date">${escapeHtml(item.ngayHenTra || "---")}</td>
      <td><button type="button" class="btn btn-secondary btn-xs btn-view-detail" data-code="${escapeHtml(item.maHoSo)}">🔍 Xem</button></td>
    </tr>`;
  });
  tbody.innerHTML = html.join("");
}

// ----------------------------------------------------
// TAB 2: TRA CỨU
// ----------------------------------------------------
function fillSelect(select, values, placeholder, current) {
  select.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = placeholder;
  select.appendChild(first);
  values.forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    if (v === current) o.selected = true;
    select.appendChild(o);
  });
  if (current && !values.includes(current)) select.value = "";
}

function uniqueSorted(list, key) {
  return Array.from(new Set(list.map((d) => d[key]).filter(Boolean))).sort((a, b) => a.localeCompare(b, "vi"));
}

function populateLookupDropdowns() {
  const fields = uniqueSorted(allDossiers, "tenLinhVuc");
  const statuses = uniqueSorted(allDossiers, "trangThaiHoSo");
  fillSelect(document.getElementById("lookup-filter-field"), fields, "-- Tất cả Lĩnh vực --", lookupField);
  fillSelect(document.getElementById("lookup-filter-status"), statuses, "-- Tất cả Trạng thái (Cột L) --", lookupStatus);
  if (!fields.includes(lookupField)) lookupField = "";
  if (!statuses.includes(lookupStatus)) lookupStatus = "";
}

function renderLookupTable() {
  const tbody = document.getElementById("lookup-tbody");
  const emptyState = document.getElementById("lookup-empty");
  const countText = document.getElementById("lookup-count-text");
  const q = lookupSearch.toLowerCase().trim();

  const filtered = allDossiers.filter((item) => {
    if (lookupField && item.tenLinhVuc !== lookupField) return false;
    if (lookupStatus && item.trangThaiHoSo !== lookupStatus) return false;
    if (lookupProgress && !matchesStatusProgress(item, lookupProgress)) return false;
    return textMatch(item, q, true);
  });

  countText.textContent = `Tìm thấy ${fmtNum(filtered.length)} hồ sơ khớp điều kiện (tổng số trong hệ thống: ${fmtNum(allDossiers.length)})`;

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    emptyState.style.display = "block";
    document.getElementById("lookup-pagination").style.display = "none";
    return;
  }
  emptyState.style.display = "none";
  document.getElementById("lookup-pagination").style.display = "flex";

  const totalPages = Math.ceil(filtered.length / LOOKUP_PAGE_SIZE) || 1;
  lookupPage = Math.min(Math.max(1, lookupPage), totalPages);
  document.getElementById("page-indicator").textContent = `Trang ${lookupPage} / ${totalPages}`;
  document.getElementById("btn-prev-page").disabled = lookupPage <= 1;
  document.getElementById("btn-next-page").disabled = lookupPage >= totalPages;

  const thStep = document.getElementById("th-lookup-step");
  if (thStep) thStep.style.display = enableStepTracking ? "" : "none";

  const startIdx = (lookupPage - 1) * LOOKUP_PAGE_SIZE;
  tbody.innerHTML = filtered.slice(startIdx, startIdx + LOOKUP_PAGE_SIZE).map((item, i) => {
    const citizen = item.nguoiNop || item.chuHoSo || "---";
    const phone = item.soDienThoai ? `<div class="cell-sub">📞 ${escapeHtml(item.soDienThoai)}</div>` : "";
    const stepTd = enableStepTracking
      ? `<td>${item.currentStep ? `<span class="tag ${item.delayedStep ? 'tag-danger' : 'tag-info'}">${escapeHtml(item.currentStep)}${item.delayedStep ? ` <span title="Trễ ở ${escapeHtml(item.delayedStep)}">⚠️</span>` : ''}</span>` : '---'}</td>`
      : "";
    return `<tr>
      <td class="cell-stt">${startIdx + i + 1}</td>
      <td><button type="button" class="code" data-code="${escapeHtml(item.maHoSo)}">${escapeHtml(item.maHoSo)}</button></td>
      <td><b>${escapeHtml(citizen)}</b>${phone}</td>
      <td class="cell-proc" title="${escapeHtml(item.tenThuTuc)}">${escapeHtml(item.tenThuTuc || "---")}</td>
      <td>${escapeHtml(item.tenLinhVuc || "---")}</td>
      <td class="cell-date">${escapeHtml(item.ngayHenTra || "---")}</td>
      <td>${getStatusBadge(item.trangThaiHoSo)}</td>
      ${stepTd}
      <td>${getStatusBadge(item.formulaStatus)}</td>
      <td><button type="button" class="btn btn-secondary btn-xs btn-view-detail" data-code="${escapeHtml(item.maHoSo)}">Chi tiết</button></td>
    </tr>`;
  }).join("");
}

// ----------------------------------------------------
// TAB 3: THỐNG KÊ & BÁO CÁO
// ----------------------------------------------------
function formatDateToYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatYMDtoVN(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

function populateAnalyticsDropdowns() {
  const fields = uniqueSorted(allDossiers, "tenLinhVuc");
  fillSelect(document.getElementById("analytics-domain-select"), fields, "-- Tất cả Lĩnh vực --", analyticsDomain);
  if (!fields.includes(analyticsDomain)) analyticsDomain = "";
  fillSelect(document.getElementById("status-detail-filter-domain"), fields, "-- Tất cả Lĩnh vực --", analyticsStatusDetailDomain);
  if (!fields.includes(analyticsStatusDetailDomain)) analyticsStatusDetailDomain = "";
}

function initAnalyticsDateRange() {
  const fromEl = document.getElementById("analytics-date-from");
  const toEl = document.getElementById("analytics-date-to");
  if (!analyticsDateInitialized && allDossiers.length > 0) {
    let min = null, max = null;
    allDossiers.forEach((item) => {
      const d = parseItemDate(item);
      if (d) {
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      }
    });
    if (min && max) {
      analyticsDateFrom = formatDateToYMD(min);
      analyticsDateTo = formatDateToYMD(max);
    }
    analyticsDateInitialized = true;
  }
  fromEl.value = analyticsDateFrom;
  toEl.value = analyticsDateTo;
}

function getFilteredAnalyticsDossiers() {
  const dFrom = analyticsDateFrom ? new Date(analyticsDateFrom + "T00:00:00") : null;
  const dTo = analyticsDateTo ? new Date(analyticsDateTo + "T23:59:59") : null;
  return allDossiers.filter((item) => {
    if (analyticsDomain && item.tenLinhVuc !== analyticsDomain) return false;
    if (dFrom || dTo) {
      const d = parseItemDate(item);
      if (d) {
        if (dFrom && d < dFrom) return false;
        if (dTo && d > dTo) return false;
      }
    }
    return true;
  });
}

function renderAnalytics() {
  populateAnalyticsDropdowns();
  initAnalyticsDateRange();
  const filtered = getFilteredAnalyticsDossiers();

  renderAnalyticsKPIs(filtered);
  updateStatusPillCounts(filtered);
  switchAnalyticsSubtab(analyticsActiveSubtab, filtered);
}

function renderAnalyticsKPIs(filtered) {
  const total = filtered.length;
  let finished = 0, onTime = 0, late = 0, processing = 0, near = 0, overdue = 0;
  filtered.forEach((item) => {
    const s = item.formulaStatus || "";
    if (s === "Hết hạn") overdue++;
    else if (s === "Sắp hết hạn") near++;
    else if (s === "Đang xử lý") processing++;
    else if (s.startsWith("Hoàn thành")) {
      finished++;
      if (s === "Hoàn thành trước hạn" || s === "Hoàn thành đúng hạn") onTime++;
      else if (s === "Hoàn thành trễ hạn") late++;
    }
  });
  const resolved = onTime + late;
  const onTimeRate = resolved ? ((onTime / resolved) * 100).toFixed(1).replace(".", ",") : "0";

  document.getElementById("kpi-total-records").textContent = fmtNum(total);
  document.getElementById("kpi-completed-rate").textContent = `${onTimeRate}%`;
  document.getElementById("kpi-completed-count").textContent = `${fmtNum(onTime)}/${fmtNum(resolved)} hồ sơ giải quyết đúng/trước hạn`;
  document.getElementById("kpi-processing-count").textContent = fmtNum(processing);
  document.getElementById("kpi-near-count").textContent = fmtNum(near);
  document.getElementById("kpi-overdue-count").textContent = fmtNum(overdue);
  document.getElementById("kpi-late-sub").textContent = `${fmtNum(late)} hồ sơ đã giải quyết trễ hạn`;

  const domainLabel = analyticsDomain ? analyticsDomain : "Tất cả lĩnh vực";
  const dateLabel = analyticsDateFrom || analyticsDateTo
    ? `${analyticsDateFrom ? formatYMDtoVN(analyticsDateFrom) : "…"} – ${analyticsDateTo ? formatYMDtoVN(analyticsDateTo) : "…"}`
    : "toàn thời gian";
  document.getElementById("kpi-total-sub").textContent = `${domainLabel} · ${dateLabel}`;
}

function drillAttrs(status, proc, domain) {
  return `data-drill-status="${escapeHtml(status || "all")}" data-drill-proc="${escapeHtml(proc || "")}" data-drill-domain="${escapeHtml(domain || "")}" tabindex="0" role="button"`;
}

// Bảng 1: Theo lĩnh vực
function renderDomainSummaryTable(filtered) {
  const tbody = document.getElementById("domain-summary-tbody");
  const counts = {};
  filtered.forEach((i) => {
    const d = i.tenLinhVuc || "Chưa xác định";
    counts[d] = (counts[d] || 0) + 1;
  });
  const domains = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const total = filtered.length;
  document.getElementById("domain-summary-count-badge").textContent = `${domains.length} lĩnh vực`;

  if (!domains.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="cell-empty">Không có dữ liệu trong khoảng thời gian này.</td></tr>`;
    return;
  }
  const rows = domains.map((domain, idx) => {
    const n = counts[domain];
    const p = total ? (n / total) * 100 : 0;
    return `<tr>
      <td class="cell-stt">${idx + 1}</td>
      <td><b>${escapeHtml(domain)}</b></td>
      <td class="num"><span class="stat-cell-clickable" ${drillAttrs("all", "", domain)} title="Xem danh sách hồ sơ">${fmtNum(n)}</span></td>
      <td><div class="visual-bar-wrap"><div class="visual-bar-track"><div class="visual-bar-fill" style="width:${Math.min(100, Math.max(1, p))}%"></div></div><span class="visual-bar-text">${p.toFixed(1).replace(".", ",")}%</span></div></td>
    </tr>`;
  });
  rows.push(`<tr class="row-total"><td></td><td>TỔNG CỘNG</td><td class="num total">${fmtNum(total)}</td><td><span class="visual-bar-text">100%</span></td></tr>`);
  tbody.innerHTML = rows.join("");
}

// Bảng 2: Ma trận lĩnh vực × tiến độ
const MATRIX_STATUS_KEYS = [
  ["Hết hạn", "Hết hạn", "tag-danger"],
  ["Sắp hết hạn", "Sắp hết", "tag-warning"],
  ["Đang xử lý", "Đang XL", "tag-info"],
  ["Hoàn thành trước hạn", "HT trước", "tag-success"],
  ["Hoàn thành đúng hạn", "HT đúng", "tag-success"],
  ["Hoàn thành trễ hạn", "HT trễ", "tag-orange"],
  ["Hoàn thành", "HT khác", "tag-neutral"]
];

function renderMatrixTable(filtered) {
  const tbody = document.getElementById("matrix-summary-tbody");
  const matrix = {};
  const colTotals = {};
  MATRIX_STATUS_KEYS.forEach(([k]) => (colTotals[k] = 0));
  filtered.forEach((item) => {
    const domain = item.tenLinhVuc || "Chưa xác định";
    const s = item.formulaStatus;
    if (!matrix[domain]) {
      matrix[domain] = { total: 0 };
      MATRIX_STATUS_KEYS.forEach(([k]) => (matrix[domain][k] = 0));
    }
    if (s in colTotals) {
      matrix[domain][s]++;
      colTotals[s]++;
    }
    matrix[domain].total++;
  });
  const domains = Object.keys(matrix).sort((a, b) => matrix[b].total - matrix[a].total);
  if (!domains.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="cell-empty">Không có dữ liệu trong khoảng thời gian này.</td></tr>`;
    return;
  }
  const grand = filtered.length;
  const cell = (val, rowTotal, statusKey, cls, domain) => {
    if (!val) return `<td class="center muted">-</td>`;
    const display = analyticsMatrixViewMode === "percent" ? `${((val / rowTotal) * 100).toFixed(1).replace(".", ",")}%` : fmtNum(val);
    return `<td class="center"><span class="stat-cell-clickable tag ${cls}" ${drillAttrs(statusKey, "", domain)} title="Xem danh sách">${display}</span></td>`;
  };
  const rows = domains.map((domain) => {
    const r = matrix[domain];
    return `<tr><td><b>${escapeHtml(domain)}</b></td>${MATRIX_STATUS_KEYS.map(([k, key, cls]) => cell(r[k], r.total, key, cls, domain)).join("")}
      <td class="num"><span class="stat-cell-clickable" ${drillAttrs("all", "", domain)}>${fmtNum(r.total)}</span></td></tr>`;
  });
  rows.push(`<tr class="row-total"><td>TỔNG CỘNG</td>${MATRIX_STATUS_KEYS.map(([k, key]) => {
    const v = colTotals[k];
    if (!v) return `<td class="center muted">-</td>`;
    const display = analyticsMatrixViewMode === "percent" ? `${((v / grand) * 100).toFixed(1).replace(".", ",")}%` : fmtNum(v);
    return `<td class="center"><span class="stat-cell-clickable" ${drillAttrs(key, "", "")}>${display}</span></td>`;
  }).join("")}<td class="num total"><span class="stat-cell-clickable" ${drillAttrs("all", "", "")}>${fmtNum(grand)}</span></td></tr>`);
  tbody.innerHTML = rows.join("");
}

// Bảng 3: Chi tiết theo thủ tục
function renderProcedureDetailTable(filtered) {
  const tbody = document.getElementById("procedure-summary-tbody");
  document.getElementById("procedure-selected-domain-text").textContent = analyticsDomain ? `Lĩnh vực: ${analyticsDomain}` : "Tất cả lĩnh vực";

  const stats = {};
  const keyMap = {
    "Hết hạn": "overdue", "Sắp hết hạn": "near", "Đang xử lý": "processing",
    "Hoàn thành trước hạn": "before", "Hoàn thành đúng hạn": "ontime",
    "Hoàn thành trễ hạn": "late", "Hoàn thành": "other"
  };
  filtered.forEach((item) => {
    const p = item.tenThuTuc || "Chưa xác định thủ tục";
    if (!stats[p]) stats[p] = { total: 0, overdue: 0, near: 0, processing: 0, before: 0, ontime: 0, late: 0, other: 0 };
    stats[p].total++;
    const k = keyMap[item.formulaStatus];
    if (k) stats[p][k]++;
  });
  const procs = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total);
  document.getElementById("procedure-count-badge").textContent = `${procs.length} thủ tục`;
  if (!procs.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="cell-empty">Không có dữ liệu trong lĩnh vực hoặc thời gian đã chọn.</td></tr>`;
    return;
  }
  const cols = [
    ["overdue", "Hết hạn", "tag-danger"], ["near", "Sắp hết", "tag-warning"], ["processing", "Đang XL", "tag-info"],
    ["before", "HT trước", "tag-success"], ["ontime", "HT đúng", "tag-success"], ["late", "HT trễ", "tag-orange"],
    ["other", "HT khác", "tag-neutral"]
  ];
  tbody.innerHTML = procs.map((p, idx) => {
    const st = stats[p];
    return `<tr>
      <td class="cell-stt">${idx + 1}</td>
      <td class="cell-proc-wide" title="${escapeHtml(p)}"><b>${escapeHtml(p)}</b></td>
      <td class="num"><span class="stat-cell-clickable" ${drillAttrs("all", p, "")}>${fmtNum(st.total)}</span></td>
      ${cols.map(([k, key, cls]) => st[k] > 0
        ? `<td class="center"><span class="stat-cell-clickable tag ${cls}" ${drillAttrs(key, p, "")}>${fmtNum(st[k])}</span></td>`
        : `<td class="center muted">-</td>`).join("")}
    </tr>`;
  }).join("");
}

// Bảng 4: Danh sách chi tiết theo tình trạng
function getStatusDetailFilteredDossiers(base) {
  const q = analyticsStatusDetailSearch.toLowerCase().trim();
  return (base || getFilteredAnalyticsDossiers()).filter((item) => {
    if (!matchesStatusProgress(item, analyticsStatusDetailFilter)) return false;
    if (analyticsStatusDetailDomain && item.tenLinhVuc !== analyticsStatusDetailDomain) return false;
    return textMatch(item, q, true);
  });
}

function updateStatusPillCounts(base) {
  const list = base || getFilteredAnalyticsDossiers();
  const counts = { all: list.length };
  document.querySelectorAll(".status-pill-btn").forEach((btn) => {
    const key = btn.getAttribute("data-status");
    if (key !== "all") counts[key] = list.filter((i) => matchesStatusProgress(i, key)).length;
    const el = btn.querySelector(".pill-count");
    if (el) el.textContent = fmtNum(counts[key]);
  });
}

function renderStatusDetailTable(base) {
  const tbody = document.getElementById("status-detail-tbody");
  const filtered = getStatusDetailFilteredDossiers(base);

  document.getElementById("status-detail-total-badge").textContent = `${fmtNum(filtered.length)} hồ sơ`;
  let scope = analyticsStatusDetailFilter !== "all" ? `Tình trạng: ${STATUS_KEY_LABELS[analyticsStatusDetailFilter] || analyticsStatusDetailFilter}` : "Tất cả tình trạng";
  if (analyticsStatusDetailDomain) scope += ` • Lĩnh vực: ${analyticsStatusDetailDomain}`;
  if (analyticsStatusDetailSearch) scope += ` • Lọc: "${analyticsStatusDetailSearch}"`;
  document.getElementById("status-detail-scope-badge").textContent = scope;

  document.querySelectorAll(".status-pill-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-status") === analyticsStatusDetailFilter));

  const emptyDiv = document.getElementById("status-detail-empty");
  const pag = document.getElementById("status-detail-pagination");
  if (!filtered.length) {
    tbody.innerHTML = "";
    emptyDiv.style.display = "block";
    pag.style.display = "none";
    return;
  }
  emptyDiv.style.display = "none";
  pag.style.display = "flex";

  const totalPages = Math.ceil(filtered.length / STATUS_DETAIL_PAGE_SIZE) || 1;
  analyticsStatusDetailPage = Math.min(Math.max(1, analyticsStatusDetailPage), totalPages);
  const start = (analyticsStatusDetailPage - 1) * STATUS_DETAIL_PAGE_SIZE;

  tbody.innerHTML = filtered.slice(start, start + STATUS_DETAIL_PAGE_SIZE).map((item, idx) => `<tr>
    <td class="cell-stt">${start + idx + 1}</td>
    <td><button type="button" class="code" data-code="${escapeHtml(item.maHoSo)}">${escapeHtml(item.maHoSo)}</button></td>
    <td class="cell-proc" title="${escapeHtml(item.tenThuTuc)}"><b>${escapeHtml(item.tenThuTuc)}</b></td>
    <td>${escapeHtml(item.tenLinhVuc || "-")}</td>
    <td><div>${escapeHtml(item.nguoiNop || item.chuHoSo || "-")}</div><div class="cell-sub">${escapeHtml(item.soDienThoai || "")}</div></td>
    <td class="cell-date">${escapeHtml(item.ngayTiepNhan || "-")}</td>
    <td class="cell-date">${escapeHtml(item.ngayHenTra || "-")}</td>
    <td class="center">${getStatusBadge(item.formulaStatus)}</td>
    <td class="center"><button type="button" class="btn btn-secondary btn-xs btn-view-detail" data-code="${escapeHtml(item.maHoSo)}">Chi tiết</button></td>
  </tr>`).join("");

  document.getElementById("status-detail-page-indicator").textContent = `Trang ${analyticsStatusDetailPage} / ${totalPages}`;
  document.getElementById("status-detail-btn-prev").disabled = analyticsStatusDetailPage <= 1;
  document.getElementById("status-detail-btn-next").disabled = analyticsStatusDetailPage >= totalPages;
}

function renderCharts(filtered) {
  const container = document.getElementById("analytics-charts");
  if (!container || !window.HSMCCharts) return;
  HSMCCharts.render(container, filtered, {
    parseItemDate,
    onDrill: (status, proc, domain) => openStatusDetailTab(status || "all", proc || "", domain || "")
  });
}

function switchAnalyticsSubtab(target, base) {
  analyticsActiveSubtab = target;
  const panels = {
    charts: ["subtab-charts-btn", "analytics-panel-charts"],
    domain: ["subtab-domain-summary-btn", "analytics-panel-domain"],
    matrix: ["subtab-matrix-btn", "analytics-panel-matrix"],
    procedure: ["subtab-procedure-detail-btn", "analytics-panel-procedure"],
    "status-detail": ["subtab-status-detail-btn", "analytics-panel-status-detail"]
  };
  Object.keys(panels).forEach((k) => {
    const [btnId, panelId] = panels[k];
    const b = document.getElementById(btnId);
    const p = document.getElementById(panelId);
    if (b) b.classList.toggle("active", k === target);
    if (p) p.style.display = k === target ? "block" : "none";
  });
  if (window.HSMCCharts) HSMCCharts.hideTip();

  const filtered = base || getFilteredAnalyticsDossiers();
  if (target === "charts") renderCharts(filtered);
  else if (target === "domain") renderDomainSummaryTable(filtered);
  else if (target === "matrix") renderMatrixTable(filtered);
  else if (target === "procedure") renderProcedureDetailTable(filtered);
  else if (target === "status-detail") renderStatusDetailTable(filtered);
}

/** Bấm vào số liệu/biểu đồ → mở danh sách chi tiết đúng phạm vi */
function openStatusDetailTab(statusKey, procedureFilter, domainFilter) {
  const normalize = {
    "Sắp hết hạn": "Sắp hết", "Đang xử lý": "Đang XL", "Hoàn thành trước hạn": "HT trước",
    "Hoàn thành đúng hạn": "HT đúng", "Hoàn thành trễ hạn": "HT trễ", "Hoàn thành": "HT khác"
  };
  analyticsStatusDetailFilter = normalize[statusKey] || statusKey || "all";
  analyticsStatusDetailSearch = procedureFilter || "";
  analyticsStatusDetailDomain = domainFilter || "";
  analyticsStatusDetailPage = 1;

  document.getElementById("status-detail-search-input").value = analyticsStatusDetailSearch;
  analyticsActiveSubtab = "status-detail";
  switchTab("analytics");
  document.getElementById("status-detail-filter-domain").value = analyticsStatusDetailDomain;

  setTimeout(() => {
    const p = document.getElementById("analytics-panel-status-detail");
    if (p) p.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);
}

// ----------------------------------------------------
// TAB 4: CÀI ĐẶT
// ----------------------------------------------------
function loadSettingsIntoForm() {
  Storage.get([
    "sheetUrl", "lastSheetUrl", "thresholdUnder7", "thresholdOver7", "calcMethod",
    "checkInterval", "availableFields", "selectedFields", "availableStatuses", "selectedStatuses", "extraHolidays",
    "columnMapping", "enableStepTracking", "stepDefinitions", "sheetHeaders"
  ], (data) => {
    let url = data.sheetUrl || data.lastSheetUrl || "";
    if (!url) {
      try { url = localStorage.getItem("hoSoMotCua_savedSheetUrl") || ""; } catch (e) {}
    }
    document.getElementById("settings-sheet-url").value = url || "";
    document.getElementById("settings-threshold-under7").value = data.thresholdUnder7 ?? HSMC.DEFAULTS.thresholdUnder7;
    document.getElementById("settings-threshold-over7").value = data.thresholdOver7 ?? HSMC.DEFAULTS.thresholdOver7;
    document.getElementById("settings-calc-method").value = data.calcMethod || HSMC.DEFAULTS.calcMethod;
    document.getElementById("settings-check-interval").value = String(data.checkInterval ?? HSMC.DEFAULTS.checkInterval);
    document.getElementById("settings-extra-holidays").value =
      data.extraHolidays === undefined ? HSMC.DEFAULT_EXTRA_HOLIDAYS : data.extraHolidays;

    columnMapping = Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING, data.columnMapping || {});
    enableStepTracking = !!data.enableStepTracking;
    stepDefinitions = Array.isArray(data.stepDefinitions) && data.stepDefinitions.length > 0
      ? data.stepDefinitions
      : HSMC.DEFAULT_WORKFLOW_STEPS.map((s) => Object.assign({}, s));
    detectedSheetHeaders = data.sheetHeaders || [];

    renderColumnMappingForm(columnMapping, detectedSheetHeaders);
    renderStepTrackingForm(enableStepTracking, stepDefinitions, detectedSheetHeaders);

    if (IS_DESKTOP) {
      apiFetch("/api/autostart")
        .then((r) => (r.ok ? r.json() : {}))
        .then((res) => {
          const chk = document.getElementById("settings-autostart");
          if (chk && res && res.success) chk.checked = !!res.enabled;
        })
        .catch(() => {});
    }

    // Nếu chưa quét danh mục: lấy từ dữ liệu đã tải
    const availableFields = (data.availableFields && data.availableFields.length) ? data.availableFields : uniqueSorted(allDossiers, "tenLinhVuc");
    const availableStatuses = (data.availableStatuses && data.availableStatuses.length) ? data.availableStatuses : uniqueSorted(allDossiers, "trangThaiHoSo");
    renderCheckboxList("settings-fields-container", availableFields, data.selectedFields || [], "field");
    renderCheckboxList("settings-statuses-container", availableStatuses, data.selectedStatuses || [], "status");
  });
}

function renderColumnMappingForm(mapping, headers) {
  const container = document.getElementById("col-mapping-container");
  if (!container) return;
  container.innerHTML = "";

  const letters = [];
  for (let i = 0; i < 26; i++) letters.push(String.fromCharCode(65 + i));
  for (let i = 0; i < 26; i++) letters.push("A" + String.fromCharCode(65 + i));

  const colOptions = [];
  letters.forEach((colLetter, idx) => {
    let headerName = headers && headers[idx] ? ` (${headers[idx]})` : "";
    colOptions.push({ letter: colLetter, label: `${colLetter}${headerName}` });
  });

  HSMC.COLUMN_FIELDS.forEach((f) => {
    const item = document.createElement("div");
    item.className = "col-mapping-item";

    const label = document.createElement("div");
    label.className = "col-mapping-label";
    label.innerHTML = `${escapeHtml(f.label)} ${f.required ? '<span class="col-mapping-req">*</span>' : ''}`;

    const select = document.createElement("select");
    select.className = "col-mapping-select";
    select.dataset.field = f.key;

    const currentLetter = (mapping[f.key] || f.defaultCol).toUpperCase();

    colOptions.forEach((opt) => {
      const optEl = document.createElement("option");
      optEl.value = opt.letter;
      optEl.textContent = opt.label;
      if (opt.letter === currentLetter) optEl.selected = true;
      select.appendChild(optEl);
    });

    item.appendChild(label);
    item.appendChild(select);
    container.appendChild(item);
  });
}

function renderStepTrackingForm(enabled, steps, headers) {
  const toggle = document.getElementById("settings-enable-step-tracking");
  const panel = document.getElementById("step-tracking-panel");
  if (toggle) toggle.checked = !!enabled;
  if (panel) panel.style.display = enabled ? "block" : "none";

  renderStepsTable(steps, headers);
}

function renderStepsTable(steps, headers) {
  const tbody = document.getElementById("steps-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const letters = [""];
  for (let i = 0; i < 26; i++) letters.push(String.fromCharCode(65 + i));
  for (let i = 0; i < 26; i++) letters.push("A" + String.fromCharCode(65 + i));

  steps.forEach((st, idx) => {
    const tr = document.createElement("tr");

    // STT
    const tdIdx = document.createElement("td");
    tdIdx.style.textAlign = "center";
    tdIdx.style.fontWeight = "700";
    tdIdx.textContent = String(idx + 1);
    tr.appendChild(tdIdx);

    // Tên bước
    const tdName = document.createElement("td");
    const inputName = document.createElement("input");
    inputName.type = "text";
    inputName.className = "step-input-text";
    inputName.value = st.name || "";
    inputName.placeholder = `Bước ${idx + 1}...`;
    tdName.appendChild(inputName);
    tr.appendChild(tdName);

    // Cột Ngày thực tế
    const tdDate = document.createElement("td");
    const selDate = document.createElement("select");
    selDate.className = "step-select-col";
    letters.forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = l ? `Cột ${l}` : "-- Không có --";
      if (l === (st.dateCol || "").toUpperCase()) opt.selected = true;
      selDate.appendChild(opt);
    });
    tdDate.appendChild(selDate);
    tr.appendChild(tdDate);

    // Cột Hạn bước
    const tdDeadline = document.createElement("td");
    const selDeadline = document.createElement("select");
    selDeadline.className = "step-select-col";
    letters.forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = l ? `Cột ${l}` : "-- Không có --";
      if (l === (st.deadlineCol || "").toUpperCase()) opt.selected = true;
      selDeadline.appendChild(opt);
    });
    tdDeadline.appendChild(selDeadline);
    tr.appendChild(tdDeadline);

    // Nút Xóa
    const tdDel = document.createElement("td");
    tdDel.style.textAlign = "center";
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn btn-danger btn-xs";
    btnDel.textContent = "✕";
    btnDel.title = "Xóa bước này";
    btnDel.addEventListener("click", () => {
      steps.splice(idx, 1);
      renderStepsTable(steps, headers);
    });
    tdDel.appendChild(btnDel);
    tr.appendChild(tdDel);

    tbody.appendChild(tr);
  });
}

function renderCheckboxList(containerId, allItems, selectedItems, prefix) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  const badgeId = prefix === "field" ? "settings-field-count-badge" : "settings-status-count-badge";

  if (!allItems || allItems.length === 0) {
    container.innerHTML = `<div class="muted" style="padding: 10px;">Chưa có dữ liệu danh mục. Vui lòng bấm "Quét Lĩnh vực & Trạng thái".</div>`;
    updateCheckboxCountBadge(badgeId, 0, 0);
    return;
  }
  // Danh sách chọn rỗng = theo dõi tất cả
  allItems.forEach((item) => {
    const checked = selectedItems.length === 0 || selectedItems.includes(item);
    const label = document.createElement("label");
    label.className = "checkbox-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = item;
    cb.checked = checked;
    cb.dataset.type = prefix;
    cb.addEventListener("change", () => updateCheckboxCountBadge(badgeId, container.querySelectorAll("input:checked").length, allItems.length));
    const span = document.createElement("span");
    span.textContent = item;
    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  });
  updateCheckboxCountBadge(badgeId, container.querySelectorAll("input:checked").length, allItems.length);
}

function updateCheckboxCountBadge(badgeId, selectedCount, totalCount) {
  const badge = document.getElementById(badgeId);
  if (badge) badge.textContent = `${selectedCount}/${totalCount} đã chọn`;
}

function getSelectedCheckboxes(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type='checkbox']:checked`)).map((cb) => cb.value);
}

function setAllCheckboxes(containerId, badgeId, checked) {
  const boxes = document.querySelectorAll(`#${containerId} input[type='checkbox']`);
  boxes.forEach((cb) => (cb.checked = checked));
  updateCheckboxCountBadge(badgeId, checked ? boxes.length : 0, boxes.length);
}

function setSettingsMessage(text, type) {
  const el = document.getElementById("settings-status-msg");
  el.textContent = text;
  el.className = "settings-msg " + (type ? "msg-" + type : "");
}

function clampPercent(v, def) {
  const n = parseInt(v, 10);
  if (!n || isNaN(n)) return def;
  return Math.min(90, Math.max(1, n));
}

// ----------------------------------------------------
// MODAL CHI TIẾT HỒ SƠ
// ----------------------------------------------------
function openDetailModal(code) {
  const item = allDossiers.find((d) => d.maHoSo === code) || currentAlerts.find((d) => d.maHoSo === code);
  if (!item) return;
  document.getElementById("modal-title").textContent = `Hồ sơ: ${item.maHoSo || ""}`;
  const totalDaysTxt = item.totalDays !== null && item.totalDays !== undefined ? ` / Tổng ${item.totalDays} ngày` : "";
  const remain = item.remainingDays === null || item.remainingDays === undefined
    ? "Chưa có ngày hẹn trả"
    : `${item.remainingDays >= 0 ? `Còn ${item.remainingDays}` : `Quá hạn ${Math.abs(item.remainingDays)}`} ngày${totalDaysTxt} · ${escapeHtml(item.calcMethod || "")}`;

  let stepTimelineHtml = "";
  if (item.stepDetails && item.stepDetails.length > 0) {
    stepTimelineHtml = `
      <div class="detail-box">
        <div class="detail-label">TIẾN ĐỘ QUY TRÌNH TỪNG BƯỚC</div>
        ${item.delayedStep ? `<div class="tag tag-danger" style="margin-bottom: 8px;">⚠️ Trễ tại: <b>${escapeHtml(item.delayedStep)}</b></div>` : ''}
        <div class="step-timeline">
          ${item.stepDetails.map((st) => {
            const statusLabel = st.status === 'COMPLETED' ? '<span class="tag tag-success">Đã hoàn thành</span>'
              : st.status === 'DELAYED' ? '<span class="tag tag-danger">Quá hạn</span>'
              : st.status === 'IN_PROGRESS' ? '<span class="tag tag-info">Đang xử lý</span>'
              : '<span class="tag">Chờ xử lý</span>';
            return `
              <div class="step-timeline-item ${st.status}">
                <div>
                  <b>${escapeHtml(st.name)}</b>
                  <div class="cell-sub">
                    ${st.actualDate ? `Thực tế: ${escapeHtml(st.actualDate)}` : 'Chưa có ngày thực tế'}
                    ${st.deadlineDate ? ` · Hạn bước: ${escapeHtml(st.deadlineDate)}` : ''}
                  </div>
                </div>
                <div>${statusLabel}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  document.getElementById("modal-content").innerHTML = `
    <div class="detail-grid">
      <div><div class="detail-label">CHỦ HỒ SƠ</div><div class="detail-value strong">${escapeHtml(item.chuHoSo || "---")}</div></div>
      <div><div class="detail-label">NGƯỜI NỘP / LIÊN HỆ</div><div class="detail-value">${escapeHtml(item.nguoiNop || "---")} (${escapeHtml(item.soDienThoai || "Không có SĐT")})</div></div>
    </div>
    <div class="detail-block"><div class="detail-label">TÊN THỦ TỤC HÀNH CHÍNH</div><div class="detail-value primary">${escapeHtml(item.tenThuTuc || "---")}</div></div>
    <div class="detail-grid">
      <div><div class="detail-label">LĨNH VỰC</div><div class="detail-value">${escapeHtml(item.tenLinhVuc || "---")}</div></div>
      <div><div class="detail-label">TRẠNG THÁI HỒ SƠ</div><div>${getStatusBadge(item.trangThaiHoSo)}</div></div>
    </div>
    <div class="detail-box">
      <div class="detail-label">TIẾN ĐỘ & THỜI HẠN XỬ LÝ</div>
      <div class="detail-grid three">
        <div><b>Tiếp nhận:</b><br>${escapeHtml(item.ngayTiepNhan || "---")}</div>
        <div><b>Hẹn trả:</b><br>${escapeHtml(item.ngayHenTra || "---")}</div>
        <div><b>Kết thúc:</b><br>${escapeHtml(item.ngayKetThuc || "Chưa có")}</div>
      </div>
      <div class="detail-progress">
        <div><b>Tiến độ quy trình:</b> ${getStatusBadge(item.formulaStatus)}</div>
        <div class="muted">Thời gian còn lại: <b>${remain}</b></div>
      </div>
    </div>
    ${stepTimelineHtml}
    ${item.noiDung ? `<div class="detail-block"><div class="detail-label">NỘI DUNG YÊU CẦU</div><div class="detail-note">${escapeHtml(item.noiDung)}</div></div>` : ""}
  `;

  const searchUrl = HSMC.buildDossierSearchUrl(item.maHoSo);
  const portalBtn = document.getElementById("modal-btn-open-portal");
  if (portalBtn) {
    portalBtn.href = searchUrl;
    portalBtn.title = `Chuyển sang trang kết quả tìm kiếm hồ sơ ${item.maHoSo || ""} trên Hệ thống Một Cửa điện tử`;
  }

  openModal("detail-modal");
}

function openModal(id) {
  const m = document.getElementById(id);
  m.style.display = "flex";
  const btn = m.querySelector(".modal-close");
  if (btn) btn.focus();
}
function closeModal(id) {
  document.getElementById(id).style.display = "none";
}

// ----------------------------------------------------
// NẠP DỮ LIỆU TỪ BỘ NHỚ & HIỂN THỊ
// ----------------------------------------------------
function loadAllData(callback) {
  Storage.get([
    "currentAlerts", "allDossiers", "lastCheckTime", "lastSheetUrl", "sheetUrl", "lastCheckError", "checkInterval",
    "columnMapping", "enableStepTracking", "stepDefinitions"
  ], (data) => {
    currentAlerts = (data.currentAlerts && data.currentAlerts.length) ? data.currentAlerts : (currentAlerts || []);
    allDossiers = (data.allDossiers && data.allDossiers.length) ? data.allDossiers : (allDossiers || []);
    lastCheckTimeIso = data.lastCheckTime || null;
    checkIntervalMin = data.checkInterval ?? HSMC.DEFAULTS.checkInterval;
    sheetUrl = data.sheetUrl || data.lastSheetUrl || "";
    columnMapping = Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING, data.columnMapping || {});
    enableStepTracking = !!data.enableStepTracking;
    stepDefinitions = Array.isArray(data.stepDefinitions) && data.stepDefinitions.length > 0
      ? data.stepDefinitions
      : HSMC.DEFAULT_WORKFLOW_STEPS.map((s) => Object.assign({}, s));

    if (!sheetUrl) {
      try { sheetUrl = localStorage.getItem("hoSoMotCua_savedSheetUrl") || ""; } catch (e) {}
    }

    document.getElementById("banner-sheet-missing").style.display = sheetUrl ? "none" : "flex";

    const errBanner = document.getElementById("banner-error");
    if (data.lastCheckError) {
      document.getElementById("banner-error-text").textContent = data.lastCheckError;
      errBanner.style.display = "flex";
    } else {
      errBanner.style.display = "none";
    }

    const expired = currentAlerts.filter((a) => a.alertStatus === "HẾT HẠN").length;
    const warning = currentAlerts.length - expired;
    document.getElementById("badge-expired").textContent = `● Hết hạn: ${fmtNum(expired)}`;
    document.getElementById("badge-warning").textContent = `▲ Sắp hết hạn: ${fmtNum(warning)}`;
    document.getElementById("badge-total-alerts").textContent = `Tổng cảnh báo: ${fmtNum(currentAlerts.length)}`;
    document.getElementById("nav-alert-count").textContent = fmtNum(currentAlerts.length);
    document.getElementById("nav-all-count").textContent = fmtNum(allDossiers.length);
    document.getElementById("last-check-text").textContent = `Cập nhật lúc: ${HSMC.formatDateTimeVN(lastCheckTimeIso)}`;

    const sourceEl = document.getElementById("data-source-text");
    if (sheetUrl) {
      const id = HSMC.getSheetId(sheetUrl);
      sourceEl.textContent = `Nguồn: Google Sheet ${id ? id.slice(0, 10) + "…" : ""} · trang 'Nhập DL' · ${IS_DESKTOP ? "Bản Desktop" : "Tiện ích trình duyệt"}`;
    }

    renderAlertsTable();
    populateLookupDropdowns();
    if (document.getElementById("view-lookup").style.display !== "none") renderLookupTable();
    if (document.getElementById("view-analytics").style.display !== "none") renderAnalytics();
    if (callback) callback();
  });
}

// ----------------------------------------------------
// CÀI DESKTOP: tạo shortcut (bản .exe) hoặc tải file .bat (bản tiện ích)
// ----------------------------------------------------
function buildShortcutBat(extId) {
  // Chỉ chứa ID tiện ích (a-p, 32 ký tự) - kiểm tra lại để không chèn ký tự lạ vào file .bat
  const safeId = /^[a-p]{32}$/.test(extId) ? extId : "gjiencblhohdgkigdjagihhhcoinjlif";
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "title Cai Dat Loi Tat Ung Dung Ho So Mot Cua",
    "echo Dang tao loi tat 'Ho So Mot Cua' ra Desktop...",
    `set "APP_URL=chrome-extension://${safeId}/alert.html"`,
    'set "BROWSER_EXE="',
    'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER_EXE if exist "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER_EXE (echo [LOI] Khong tim thay Chrome hoac Edge. & pause & exit /b 1)',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath(\'Desktop\'); $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut((Join-Path $d \'Ho So Mot Cua.lnk\')); $s.TargetPath=$env:BROWSER_EXE; $s.Arguments=\'--app=\' + $env:APP_URL; $s.IconLocation=$env:BROWSER_EXE + \',0\'; $s.Save()"',
    "echo Hoan tat! Nhap dup bieu tuong 'Ho So Mot Cua' tren Desktop de mo ung dung.",
    "pause"
  ];
  return lines.join("\r\n") + "\r\n";
}

function downloadShortcutBat() {
  const extId = IS_EXTENSION ? chrome.runtime.id : "";
  const blob = new Blob([buildShortcutBat(extId)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "Tao_Loi_Tat_Ho_So_Mot_Cua.bat";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function createDesktopShortcut() {
  if (!IS_DESKTOP) {
    openModal("desktop-modal");
    return;
  }
  try {
    const res = await apiFetch("/api/create-shortcut", { method: "POST" });
    const data = await res.json();
    if (data && data.success) {
      showToast(`🎉 Đã tạo lối tắt 'Hồ Sơ Một Cửa' trên Desktop: ${data.path}`, "success");
    } else {
      showToast("Không thể tạo lối tắt: " + ((data && data.error) || "lỗi không xác định"), "error");
    }
  } catch (e) {
    showToast("Không thể tạo lối tắt tự động. Hãy chạy Cai_Dat_Ho_So_Mot_Cua.exe trong thư mục ứng dụng.", "error");
  }
}

// ----------------------------------------------------
// KHỞI TẠO
// ----------------------------------------------------
function on(id, evt, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add(IS_DESKTOP ? "mode-desktop" : "mode-extension");

  // Ẩn các câu trả lời FAQ lúc đầu
  document.querySelectorAll(".faq-answer").forEach((a) => (a.style.display = "none"));

  loadAllData(() => {
    // Tự tải lần đầu nếu dữ liệu đã cũ (hoặc chưa có)
    if (isDataStale()) refreshNow({ notify: true });
  });
  startAutoRefresh();

  if (IS_EXTENSION) {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender && sender.id === chrome.runtime.id && msg && msg.action === "REFRESH_ALERT_DATA") loadAllData();
    });
  }

  // Tabs
  on("tab-alerts-btn", "click", () => switchTab("alerts"));
  on("tab-lookup-btn", "click", () => switchTab("lookup"));
  on("tab-analytics-btn", "click", () => switchTab("analytics"));
  on("tab-settings-btn", "click", () => switchTab("settings"));
  on("tab-guide-btn", "click", () => switchTab("guide"));
  on("btn-go-settings-tab", "click", () => switchTab("settings"));
  on("btn-error-settings", "click", () => switchTab("settings"));
  if (location.hash === "#settings") switchTab("settings");
  else if (location.hash === "#guide") switchTab("guide");

  // Nút Mã hồ sơ / Chi tiết (ủy quyền sự kiện cho mọi bảng)
  document.querySelector(".main-content").addEventListener("click", (e) => {
    const codeBtn = e.target.closest(".code, .btn-view-detail");
    if (codeBtn && codeBtn.dataset.code) {
      openDetailModal(codeBtn.dataset.code);
      return;
    }
    const drill = e.target.closest("[data-drill-status]");
    if (drill) {
      openStatusDetailTab(drill.dataset.drillStatus, drill.dataset.drillProc, drill.dataset.drillDomain);
    }
  });
  document.querySelector(".main-content").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-drill-status]")) {
      e.preventDefault();
      e.target.click();
    }
  });

  // Hướng dẫn
  document.querySelectorAll(".guide-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-guide-target");
      document.querySelectorAll(".guide-nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".guide-section").forEach((sec) => sec.classList.toggle("active", sec.id === targetId));
    });
  });
  on("guide-hero-btn-install", "click", createDesktopShortcut);
  on("guide-hero-btn-settings", "click", () => switchTab("settings"));
  document.querySelectorAll(".faq-question").forEach((q) => {
    q.addEventListener("click", () => {
      const ans = q.nextElementSibling;
      if (!ans) return;
      const hidden = ans.style.display === "none";
      ans.style.display = hidden ? "block" : "none";
      const arrow = q.querySelector("span:last-child");
      if (arrow) arrow.textContent = hidden ? "▲" : "▼";
    });
  });

  // Tab 1
  on("alert-search-input", "input", (e) => {
    alertSearch = e.target.value;
    renderAlertsTable();
  });
  [["btn-filter-alert-all", "all"], ["btn-filter-alert-expired", "HẾT HẠN"], ["btn-filter-alert-near", "SẮP HẾT HẠN"]].forEach(([id, val]) => {
    on(id, "click", (e) => {
      alertFilter = val;
      document.querySelectorAll("#alert-filter-group .seg-btn").forEach((b) => b.classList.toggle("active", b === e.currentTarget));
      renderAlertsTable();
    });
  });

  // Tab 2
  on("lookup-search-input", "input", (e) => { lookupSearch = e.target.value; lookupPage = 1; renderLookupTable(); });
  on("lookup-filter-field", "change", (e) => { lookupField = e.target.value; lookupPage = 1; renderLookupTable(); });
  on("lookup-filter-status", "change", (e) => { lookupStatus = e.target.value; lookupPage = 1; renderLookupTable(); });
  on("lookup-filter-progress", "change", (e) => { lookupProgress = e.target.value; lookupPage = 1; renderLookupTable(); });
  on("btn-prev-page", "click", () => { lookupPage--; renderLookupTable(); });
  on("btn-next-page", "click", () => { lookupPage++; renderLookupTable(); });
  on("btn-reset-filters", "click", () => {
    ["lookup-search-input", "lookup-filter-field", "lookup-filter-status", "lookup-filter-progress"].forEach((id) => (document.getElementById(id).value = ""));
    lookupSearch = lookupField = lookupStatus = lookupProgress = "";
    lookupPage = 1;
    renderLookupTable();
  });

  // Tab 3
  on("analytics-date-from", "change", (e) => { analyticsDateFrom = e.target.value; renderAnalytics(); });
  on("analytics-date-to", "change", (e) => { analyticsDateTo = e.target.value; renderAnalytics(); });
  on("analytics-domain-select", "change", (e) => { analyticsDomain = e.target.value; renderAnalytics(); });
  on("analytics-btn-this-month", "click", () => {
    const now = new Date();
    analyticsDateFrom = formatDateToYMD(new Date(now.getFullYear(), now.getMonth(), 1));
    analyticsDateTo = formatDateToYMD(now);
    renderAnalytics();
  });
  on("analytics-btn-last-30", "click", () => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 29);
    analyticsDateFrom = formatDateToYMD(from);
    analyticsDateTo = formatDateToYMD(now);
    renderAnalytics();
  });
  on("analytics-btn-all-time", "click", () => {
    analyticsDateFrom = "";
    analyticsDateTo = "";
    renderAnalytics();
  });

  [["subtab-charts-btn", "charts"], ["subtab-domain-summary-btn", "domain"], ["subtab-matrix-btn", "matrix"],
   ["subtab-procedure-detail-btn", "procedure"], ["subtab-status-detail-btn", "status-detail"]].forEach(([id, key]) => {
    on(id, "click", () => switchAnalyticsSubtab(key));
  });

  [["bento-card-total", "all"], ["bento-card-success", "HT đúng/trước"], ["bento-card-processing", "Đang XL"],
   ["bento-card-warning", "Sắp hết"], ["bento-card-danger", "Hết hạn"]].forEach(([id, key]) => {
    const card = document.getElementById(id);
    if (!card) return;
    card.addEventListener("click", () => openStatusDetailTab(key));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openStatusDetailTab(key);
      }
    });
  });

  document.querySelectorAll(".status-pill-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      analyticsStatusDetailFilter = btn.getAttribute("data-status") || "all";
      analyticsStatusDetailPage = 1;
      renderStatusDetailTable();
    });
  });
  on("status-detail-search-input", "input", (e) => { analyticsStatusDetailSearch = e.target.value.trim(); analyticsStatusDetailPage = 1; renderStatusDetailTable(); });
  on("status-detail-filter-domain", "change", (e) => { analyticsStatusDetailDomain = e.target.value; analyticsStatusDetailPage = 1; renderStatusDetailTable(); });
  on("status-detail-reset-btn", "click", () => {
    analyticsStatusDetailFilter = "all";
    analyticsStatusDetailSearch = "";
    analyticsStatusDetailDomain = "";
    analyticsStatusDetailPage = 1;
    document.getElementById("status-detail-search-input").value = "";
    document.getElementById("status-detail-filter-domain").value = "";
    renderStatusDetailTable();
  });
  on("status-detail-btn-prev", "click", () => { analyticsStatusDetailPage--; renderStatusDetailTable(); });
  on("status-detail-btn-next", "click", () => { analyticsStatusDetailPage++; renderStatusDetailTable(); });

  on("matrix-btn-view-count", "click", (e) => {
    analyticsMatrixViewMode = "count";
    document.querySelectorAll("#matrix-view-group .seg-btn").forEach((b) => b.classList.toggle("active", b === e.currentTarget));
    renderMatrixTable(getFilteredAnalyticsDossiers());
  });
  on("matrix-btn-view-percent", "click", (e) => {
    analyticsMatrixViewMode = "percent";
    document.querySelectorAll("#matrix-view-group .seg-btn").forEach((b) => b.classList.toggle("active", b === e.currentTarget));
    renderMatrixTable(getFilteredAnalyticsDossiers());
  });

  // Vẽ lại biểu đồ khi đổi kích thước cửa sổ
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (analyticsActiveSubtab === "charts" && document.getElementById("view-analytics").style.display !== "none") {
        renderCharts(getFilteredAnalyticsDossiers());
      }
    }, 200);
  });

  // Tab 4: Cài đặt
  on("settings-btn-select-all-fields", "click", () => setAllCheckboxes("settings-fields-container", "settings-field-count-badge", true));
  on("settings-btn-deselect-all-fields", "click", () => setAllCheckboxes("settings-fields-container", "settings-field-count-badge", false));
  on("settings-btn-select-all-statuses", "click", () => setAllCheckboxes("settings-statuses-container", "settings-status-count-badge", true));
  on("settings-btn-deselect-all-statuses", "click", () => setAllCheckboxes("settings-statuses-container", "settings-status-count-badge", false));
  on("settings-btn-select-default-statuses", "click", () => {
    const boxes = document.querySelectorAll("#settings-statuses-container input[type='checkbox']");
    let n = 0;
    boxes.forEach((cb) => {
      cb.checked = HSMC.DEFAULT_ACTIVE_STATUSES.includes(cb.value);
      if (cb.checked) n++;
    });
    updateCheckboxCountBadge("settings-status-count-badge", n, boxes.length);
  });
  on("settings-btn-default-holidays", "click", () => {
    document.getElementById("settings-extra-holidays").value = HSMC.DEFAULT_EXTRA_HOLIDAYS;
  });

  // Ánh xạ cột & Quy trình từng bước
  on("btn-auto-detect-cols", "click", async () => {
    if (!detectedSheetHeaders || !detectedSheetHeaders.length) {
      const url = document.getElementById("settings-sheet-url").value.trim();
      if (HSMC.isValidSheetUrl(url)) {
        try {
          const rows = HSMC.parseFullCSV(await fetchSheetCsvForUi(url));
          if (rows && rows[0]) detectedSheetHeaders = rows[0];
        } catch (e) {}
      }
    }
    if (detectedSheetHeaders && detectedSheetHeaders.length) {
      columnMapping = HSMC.detectColumnMapping(detectedSheetHeaders);
      renderColumnMappingForm(columnMapping, detectedSheetHeaders);
      showToast("🔍 Đã tự động nhận diện các cột theo tiêu đề sheet!", "success");
    } else {
      showToast("Vui lòng bấm 'Quét Lĩnh vực & Trạng thái' trước để đọc tiêu đề cột từ Sheet.", "warning");
    }
  });

  on("btn-reset-cols", "click", () => {
    columnMapping = Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING);
    renderColumnMappingForm(columnMapping, detectedSheetHeaders);
    showToast("↺ Đã khôi phục vị trí các cột chuẩn A đến L.", "info");
  });

  on("settings-enable-step-tracking", "change", (e) => {
    enableStepTracking = e.target.checked;
    const panel = document.getElementById("step-tracking-panel");
    if (panel) panel.style.display = enableStepTracking ? "block" : "none";
  });

  on("btn-default-steps", "click", () => {
    stepDefinitions = HSMC.DEFAULT_WORKFLOW_STEPS.map((s) => Object.assign({}, s));
    renderStepsTable(stepDefinitions, detectedSheetHeaders);
    showToast("↺ Đã nạp lại 4 bước quy trình Một Cửa chuẩn.", "info");
  });

  on("btn-add-step", "click", () => {
    stepDefinitions.push({
      id: "step_" + Date.now(),
      name: `Bước ${stepDefinitions.length + 1}`,
      dateCol: "",
      deadlineCol: ""
    });
    renderStepsTable(stepDefinitions, detectedSheetHeaders);
  });

  on("settings-sheet-url", "change", (e) => {
    const val = e.target.value.trim();
    if (HSMC.isValidSheetUrl(val)) {
      try { localStorage.setItem("hoSoMotCua_savedSheetUrl", val); } catch (err) {}
      Storage.set({ sheetUrl: val, lastSheetUrl: val });
    }
  });

  on("settings-autostart", "change", async (e) => {
    if (!IS_DESKTOP) return;
    const enabled = e.target.checked;
    try {
      const res = await apiFetch("/api/autostart", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json();
      if (data && data.success) {
        showToast(
          enabled
            ? "🚀 Đã bật tự khởi động cùng Windows khi bật/khởi động lại máy!"
            : "ℹ️ Đã tắt tự khởi động cùng Windows.",
          "info"
        );
      } else {
        showToast("Không thể cập nhật cấu hình khởi động Windows: " + ((data && data.error) || ""), "error");
      }
    } catch (err) {
      showToast("Lỗi kết nối máy chủ: " + err.message, "error");
    }
  });

  on("settings-check-interval", "change", (e) => {
    const val = parseInt(e.target.value, 10) || HSMC.DEFAULTS.checkInterval;
    storageSet({ checkInterval: val });
    if (IS_EXTENSION) chrome.runtime.sendMessage({ action: "UPDATE_ALARMS", intervalMinutes: val }, () => void chrome.runtime.lastError);
  });

  on("settings-calc-method", "change", (e) => {
    storageSet({ calcMethod: e.target.value });
  });

  on("settings-threshold-under7", "change", (e) => {
    storageSet({ thresholdUnder7: clampPercent(e.target.value, HSMC.DEFAULTS.thresholdUnder7) });
  });

  on("settings-threshold-over7", "change", (e) => {
    storageSet({ thresholdOver7: clampPercent(e.target.value, HSMC.DEFAULTS.thresholdOver7) });
  });

  on("settings-extra-holidays", "change", (e) => {
    storageSet({ extraHolidays: e.target.value.trim() });
  });

  on("settings-fetch-meta-btn", "click", async () => {
    const url = document.getElementById("settings-sheet-url").value.trim();
    if (!HSMC.isValidSheetUrl(url)) {
      setSettingsMessage("❌ Link Google Sheet không hợp lệ (phải bắt đầu bằng https://docs.google.com/spreadsheets/d/...).", "error");
      return;
    }
    const btn = document.getElementById("settings-fetch-meta-btn");
    btn.disabled = true;
    setSettingsMessage("⏳ Đang kết nối và quét dữ liệu từ Google Sheets...", "info");
    try {
      const rows = HSMC.parseFullCSV(await fetchSheetCsvForUi(url));
      if (rows.length <= 1) throw new Error("Bảng tính không có dòng dữ liệu nào.");
      detectedSheetHeaders = rows[0] || [];
      const meta = HSMC.extractMetadata(rows, columnMapping);
      if (!meta.fields.length && !meta.statuses.length) {
        throw new Error("Không tìm thấy dữ liệu ở Cột Lĩnh vực hoặc Trạng thái.");
      }

      // Giữ nguyên lựa chọn hiện có của người dùng
      const prevFields = getSelectedCheckboxes("settings-fields-container");
      const prevStatuses = getSelectedCheckboxes("settings-statuses-container");
      const keepF = prevFields.filter((f) => meta.fields.includes(f));
      const keepS = prevStatuses.filter((s) => meta.statuses.includes(s));
      renderCheckboxList("settings-fields-container", meta.fields, keepF.length ? keepF : [], "field");
      renderCheckboxList("settings-statuses-container", meta.statuses,
        keepS.length ? keepS : meta.statuses.filter((s) => HSMC.DEFAULT_ACTIVE_STATUSES.includes(s)), "status");

      // Cập nhật lại dropdown danh sách cột theo tiêu đề vừa quét được
      renderColumnMappingForm(columnMapping, detectedSheetHeaders);
      renderStepsTable(stepDefinitions, detectedSheetHeaders);

      await storageSet({
        sheetUrl: url,
        lastSheetUrl: url,
        availableFields: meta.fields,
        availableStatuses: meta.statuses,
        sheetHeaders: detectedSheetHeaders
      });
      setSettingsMessage(`✅ Quét thành công: ${meta.fields.length} lĩnh vực, ${meta.statuses.length} trạng thái, ${detectedSheetHeaders.length} cột từ ${fmtNum(meta.totalRows)} hồ sơ. Bấm "Lưu" để áp dụng.`, "success");
    } catch (err) {
      setSettingsMessage(`❌ Lỗi quét dữ liệu: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
    }
  });

  on("settings-save-btn", "click", async () => {
    const url = document.getElementById("settings-sheet-url").value.trim();
    if (!HSMC.isValidSheetUrl(url)) {
      setSettingsMessage("❌ Link Google Sheet không hợp lệ. Link đúng có dạng https://docs.google.com/spreadsheets/d/.../edit", "error");
      return;
    }
    const holidaysText = document.getElementById("settings-extra-holidays").value.trim();

    // Thu thập Column Mapping
    const newMapping = {};
    document.querySelectorAll(".col-mapping-select").forEach((sel) => {
      const field = sel.dataset.field;
      if (field) newMapping[field] = sel.value;
    });
    columnMapping = newMapping;

    // Thu thập Step Tracking
    const isStepTrackingEnabled = document.getElementById("settings-enable-step-tracking").checked;
    const newSteps = [];
    const stepRows = document.querySelectorAll("#steps-tbody tr");
    stepRows.forEach((r, idx) => {
      const input = r.querySelector(".step-input-text");
      const name = input ? input.value.trim() : "";
      const selects = r.querySelectorAll(".step-select-col");
      const dateCol = selects[0] ? selects[0].value : "";
      const deadlineCol = selects[1] ? selects[1].value : "";
      if (name) {
        newSteps.push({ id: "step_" + (idx + 1), name, dateCol, deadlineCol });
      }
    });
    enableStepTracking = isStepTrackingEnabled;
    stepDefinitions = newSteps.length ? newSteps : HSMC.DEFAULT_WORKFLOW_STEPS.map((s) => Object.assign({}, s));

    const payload = {
      sheetUrl: url,
      lastSheetUrl: url,
      thresholdUnder7: clampPercent(document.getElementById("settings-threshold-under7").value, HSMC.DEFAULTS.thresholdUnder7),
      thresholdOver7: clampPercent(document.getElementById("settings-threshold-over7").value, HSMC.DEFAULTS.thresholdOver7),
      calcMethod: document.getElementById("settings-calc-method").value,
      checkInterval: parseInt(document.getElementById("settings-check-interval").value, 10) || HSMC.DEFAULTS.checkInterval,
      selectedFields: getSelectedCheckboxes("settings-fields-container"),
      selectedStatuses: getSelectedCheckboxes("settings-statuses-container"),
      extraHolidays: holidaysText,
      columnMapping: columnMapping,
      enableStepTracking: enableStepTracking,
      stepDefinitions: stepDefinitions,
      sheetHeaders: detectedSheetHeaders
    };
    try { localStorage.setItem("hoSoMotCua_savedSheetUrl", url); } catch (err) {}

    const btn = document.getElementById("settings-save-btn");
    btn.disabled = true;
    setSettingsMessage("⏳ Đang lưu cấu hình và cập nhật dữ liệu...", "info");
    await storageSet(payload);
    if (IS_DESKTOP) {
      const chkAutostart = document.getElementById("settings-autostart");
      if (chkAutostart) {
        apiFetch("/api/autostart", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ enabled: chkAutostart.checked })
        }).catch(() => {});
      }
    }
    if (IS_EXTENSION) chrome.runtime.sendMessage({ action: "UPDATE_ALARMS", intervalMinutes: payload.checkInterval }, () => void chrome.runtime.lastError);
    const res = await refreshNow({ notify: false });
    btn.disabled = false;
    if (res && res.success) {
      setSettingsMessage(`✅ Đã lưu! Phát hiện ${fmtNum(res.count)} hồ sơ cần cảnh báo trên tổng ${fmtNum(res.total)} hồ sơ.`, "success");
    } else {
      setSettingsMessage(`⚠️ Đã lưu cấu hình nhưng chưa tải được dữ liệu: ${(res && res.error) || "lỗi không xác định"}`, "error");
    }
  });

  on("settings-test-btn", "click", async () => {
    const url = document.getElementById("settings-sheet-url").value.trim();
    if (!HSMC.isValidSheetUrl(url)) {
      setSettingsMessage("❌ Link Google Sheet không hợp lệ.", "error");
      return;
    }
    setSettingsMessage("⏳ Đang kiểm tra kết nối tới Google Sheets...", "info");
    try {
      const rows = HSMC.parseFullCSV(await fetchSheetCsvForUi(url));
      setSettingsMessage(`✅ Kết nối thành công! Đọc được ${fmtNum(Math.max(0, rows.length - 1))} dòng dữ liệu, ${rows[0] ? rows[0].length : 0} cột.`, "success");
    } catch (err) {
      setSettingsMessage(`❌ Lỗi kết nối: ${err.message}`, "error");
    }
  });

  // Modal
  document.querySelectorAll("[data-close-modal]").forEach((b) => b.addEventListener("click", () => closeModal(b.getAttribute("data-close-modal"))));
  ["detail-modal", "desktop-modal"].forEach((id) => {
    document.getElementById(id).addEventListener("click", (e) => {
      if (e.target.id === id) closeModal(id);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ["detail-modal", "desktop-modal"].forEach(closeModal);
  });
  on("desktop-modal-btn-guide", "click", () => {
    closeModal("desktop-modal");
    switchTab("guide");
  });
  on("btn-download-shortcut-bat", "click", downloadShortcutBat);

  // Thanh công cụ
  on("btn-open-sheet", "click", () => {
    if (HSMC.isValidSheetUrl(sheetUrl)) window.open(sheetUrl, "_blank", "noopener");
    else switchTab("settings");
  });
  on("btn-refresh", "click", async () => {
    const res = await refreshNow({ notify: false });
    if (res && res.success) showToast(`Đã cập nhật: ${fmtNum(res.total)} hồ sơ, ${fmtNum(res.count)} cần cảnh báo.`, "success");
    else if (res && res.error) showToast("Lỗi tải dữ liệu: " + res.error, "error");
  });

  // Tính năng Web: PWA & Web Notifications
  updateWebNotificationButton();
  on("btn-web-notify-toggle", "click", async () => {
    if (!("Notification" in window)) {
      showToast("Trình duyệt này không hỗ trợ thông báo Web.", "error");
      return;
    }
    if (Notification.permission === "granted") {
      showToast("Thông báo đẩy đã được bật sẵn trên trình duyệt này.", "info");
      return;
    }
    const permission = await Notification.requestPermission();
    updateWebNotificationButton();
    if (permission === "granted") {
      showToast("🔔 Đã bật thông báo! Ứng dụng sẽ nhắc khi có hồ sơ đến hạn.", "success");
      sendWebNotification("Hồ Sơ Một Cửa", "Hệ thống thông báo đẩy đã sẵn sàng hoạt động!");
    } else {
      showToast("Bạn đã từ chối nhận thông báo trên trình duyệt.", "error");
    }
  });

  on("btn-pwa-install", "click", async () => {
    if (!deferredPwaPrompt) return;
    deferredPwaPrompt.prompt();
    const { outcome } = await deferredPwaPrompt.userChoice;
    if (outcome === "accepted") {
      showToast("🎉 Đang cài đặt ứng dụng Hồ Sơ Một Cửa...", "success");
    }
    deferredPwaPrompt = null;
    const btn = document.getElementById("btn-pwa-install");
    if (btn) btn.style.display = "none";
  });

  // Tính năng Web: Xuất & Nhập cấu hình JSON
  on("btn-export-config", "click", () => {
    const data = Storage._readAll();
    const configOnly = {
      sheetUrl: data.sheetUrl,
      checkInterval: data.checkInterval,
      calcMethod: data.calcMethod,
      thresholdUnder7: data.thresholdUnder7,
      thresholdOver7: data.thresholdOver7,
      extraHolidays: data.extraHolidays,
      selectedFields: data.selectedFields,
      selectedStatuses: data.selectedStatuses,
      columnMapping: data.columnMapping,
      enableStepTracking: data.enableStepTracking,
      stepDefinitions: data.stepDefinitions,
      sheetHeaders: data.sheetHeaders,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(configOnly, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Cau_Hinh_Ho_So_Mot_Cua_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast("Đã xuất tệp cấu hình JSON thành công!", "success");
  });

  on("input-import-config", "change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const json = JSON.parse(evt.target.result);
        if (!json || typeof json !== "object") throw new Error("Dữ liệu tệp không hợp lệ");
        await storageSet(json);
        loadSettingsIntoForm();
        showToast("✅ Đã nạp cấu hình thành công! Đang đồng bộ dữ liệu...", "success");
        refreshNow({ notify: false });
      } catch (err) {
        showToast("❌ Không thể nạp cấu hình: " + err.message, "error");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });
});


// ----------------------------------------------------
// TÍNH NĂNG WEB: THÔNG BÁO WEB & PWA INSTALL
// ----------------------------------------------------
function sendWebNotification(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    try {
      new Notification(title, {
        body: body,
        icon: "/icons/icon192.png",
        badge: "/icons/icon48.png"
      });
    } catch (e) {}
  }
}

function updateWebNotificationButton() {
  const btn = document.getElementById("btn-web-notify-toggle");
  if (!btn || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    btn.textContent = "🔔 Thông báo: Bật";
    btn.className = "btn btn-success btn-sm";
  } else if (Notification.permission === "denied") {
    btn.textContent = "🔕 Thông báo: Đã chặn";
    btn.className = "btn btn-secondary btn-sm";
  } else {
    btn.textContent = "🔔 Bật thông báo";
    btn.className = "btn btn-secondary btn-sm";
  }
}

let deferredPwaPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  const btn = document.getElementById("btn-pwa-install");
  if (btn) btn.style.display = "inline-flex";
});

window.addEventListener("appinstalled", () => {
  deferredPwaPrompt = null;
  const btn = document.getElementById("btn-pwa-install");
  if (btn) btn.style.display = "none";
  showToast("🎉 Cảm ơn bạn đã cài đặt ứng dụng Hồ Sơ Một Cửa!", "success");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.log("[PWA] Service worker registration note:", err);
    });
  });
}
