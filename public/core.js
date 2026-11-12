/**
 * HSMC Core - Logic dùng chung cho Extension (background + giao diện) và Ứng dụng Desktop (.exe)
 * - Phân tích CSV chuẩn RFC 4180
 * - Phân tích ngày tháng (DD/MM/YYYY và YYYY-MM-DD)
 * - Tính ngày làm việc (loại trừ T7, CN, ngày lễ cố định + danh sách ngày nghỉ bổ sung cấu hình được)
 * - Tải CSV Google Sheet theo nhiều đường dẫn dự phòng
 * - Phân loại tiến độ hồ sơ khớp công thức Cột N của Google Sheet
 *
 * Tệp này không phụ thuộc DOM nên chạy được trong Service Worker (importScripts) lẫn trang HTML.
 */
(function (root) {
  "use strict";

  const HSMC = {};

  HSMC.VERSION = "1.1.1";

  HSMC.DEFAULT_SHEET_URL = "";

  HSMC.SHEET_NAME = "Nhập DL";

  // Cổng thông tin giải quyết TTHC Ngành NN&MT
  HSMC.DOSSIER_SEARCH_BASE_URL = "https://motcuannmt.mae.gov.vn/vi/dossier/search";

  /**
   * Tạo link tra cứu hồ sơ trực tiếp trên Cổng Một Cửa điện tử theo mã hồ sơ
   * @param {string} code Mã hồ sơ (VD: H20.42-260914-101100)
   * @returns {string} URL tra cứu đầy đủ
   */
  HSMC.buildDossierSearchUrl = function (code) {
    const cleanCode = code ? String(code).trim() : "";
    const params = [
      `code=${encodeURIComponent(cleanCode)}`,
      "identity=",
      "applicant=",
      "page=1",
      "size=10",
      "sector=",
      "applyMethod=",
      "province=",
      "ward=",
      "ownerFullname=",
      "acceptFrom=",
      "acceptTo=",
      "status=",
      "remindId=",
      "sortId=0",
      "applicantOrganization=",
      "appointmentFrom=",
      "appointmentTo=",
      "resultReturnedFrom=",
      "resultReturnedTo=",
      "receiptCode=",
      "taxCode=",
      "resPerson=",
      "dossierProcessingStatus=",
      "vnpostStatus=",
      "phoneNumberApply=",
      "advFilingFrom=",
      "advFilingTo="
    ];
    return `${HSMC.DOSSIER_SEARCH_BASE_URL}?${params.join("&")}`;
  };

  // Trạng thái Cột L được xem là đã kết thúc (khớp công thức Google Sheet)
  HSMC.FINAL_STATUSES = [
    "Đã rút hồ sơ",
    "Dừng xử lý",
    "Chờ rút hồ sơ",
    "Không được tiếp nhận",
    "Đã trả kết quả",
    "Đã xử lý xong"
  ];

  // Trạng thái Cột L cần đối chiếu thời hạn (mặc định chuẩn - lấy từ dữ liệu thực tế của hệ thống Một cửa)
  HSMC.DEFAULT_ACTIVE_STATUSES = [
    "Đang xử lý",
    "Chờ xử lý",
    "Được tiếp nhận",
    "Phân công xử lý",
    "Phê duyệt",
    "Duyệt hồ sơ",
    "Mới đăng ký",
    "Đã có kết quả"
  ];

  // Ngày nghỉ bổ sung năm 2026 cho CB-CC-VC (theo thông báo lịch nghỉ lễ 2026).
  // Ngày lễ cố định 01/01, 30/04, 01/05, 02/09 đã được tính sẵn, không cần nhập lại.
  HSMC.DEFAULT_EXTRA_HOLIDAYS =
    "02/01/2026\n16/02/2026-20/02/2026\n27/04/2026\n31/08/2026\n01/09/2026";

  HSMC.DEFAULTS = {
    thresholdUnder7: 20,
    thresholdOver7: 15,
    calcMethod: "working_days",
    checkInterval: 30
  };

  // Nhóm tiến độ chuẩn (dùng cho thống kê, biểu đồ, bộ lọc)
  HSMC.PROGRESS = {
    OVERDUE: "Hết hạn",
    NEAR: "Sắp hết hạn",
    PROCESSING: "Đang xử lý",
    DONE_EARLY: "Hoàn thành trước hạn",
    DONE_ONTIME: "Hoàn thành đúng hạn",
    DONE_LATE: "Hoàn thành trễ hạn",
    DONE: "Hoàn thành"
  };

  // Ánh xạ vị trí cột mặc định (chuẩn Cột A-L ban đầu)
  HSMC.DEFAULT_COLUMN_MAPPING = {
    stt: "A",
    maHoSo: "B",
    tenThuTuc: "C",
    tenLinhVuc: "D",
    noiDung: "E",
    ngayTiepNhan: "F",
    ngayHenTra: "G",
    ngayKetThuc: "H",
    chuHoSo: "I",
    nguoiNop: "J",
    soDienThoai: "K",
    trangThaiHoSo: "L"
  };

  // Danh mục trường thông tin hồ sơ cho phép cấu hình cột
  HSMC.COLUMN_FIELDS = [
    { key: "stt", label: "Số thứ tự (STT)", defaultCol: "A", required: false },
    { key: "maHoSo", label: "Mã hồ sơ", defaultCol: "B", required: true },
    { key: "tenThuTuc", label: "Tên thủ tục hành chính", defaultCol: "C", required: true },
    { key: "tenLinhVuc", label: "Tên lĩnh vực", defaultCol: "D", required: false },
    { key: "noiDung", label: "Nội dung yêu cầu giải quyết", defaultCol: "E", required: false },
    { key: "ngayTiepNhan", label: "Ngày tiếp nhận (dd/mm/yyyy hh:mm:ss)", defaultCol: "F", required: true },
    { key: "ngayHenTra", label: "Ngày hẹn trả (dd/mm/yyyy hh:mm:ss)", defaultCol: "G", required: true },
    { key: "ngayKetThuc", label: "Ngày kết thúc xử lý", defaultCol: "H", required: false },
    { key: "chuHoSo", label: "Chủ hồ sơ", defaultCol: "I", required: false },
    { key: "nguoiNop", label: "Người nộp hồ sơ", defaultCol: "J", required: false },
    { key: "soDienThoai", label: "Số điện thoại", defaultCol: "K", required: false },
    { key: "trangThaiHoSo", label: "Trạng thái hồ sơ", defaultCol: "L", required: true }
  ];

  // Chuyển ký tự cột (A, B, C, ... AA) sang chỉ số 0-based index
  HSMC.colLetterToIndex = function (letter) {
    if (letter === null || letter === undefined) return -1;
    if (typeof letter === "number") return letter >= 0 ? Math.floor(letter) : -1;
    const str = String(letter).trim().toUpperCase();
    if (!str || !/^[A-Z]+$/.test(str)) return -1;
    let idx = 0;
    for (let i = 0; i < str.length; i++) {
      idx = idx * 26 + (str.charCodeAt(i) - 64);
    }
    return idx - 1;
  };

  // Chuyển chỉ số 0-based index sang ký tự cột (0 -> A, 1 -> B, 26 -> AA)
  HSMC.indexToColLetter = function (idx) {
    if (typeof idx !== "number" || idx < 0) return "";
    let n = Math.floor(idx) + 1;
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - m) / 26);
    }
    return s;
  };

  // Tự động phát hiện vị trí cột dựa trên dòng tiêu đề thực tế của Sheet
  HSMC.detectColumnMapping = function (headerRow) {
    if (!headerRow || !Array.isArray(headerRow)) return Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING);
    const mapping = Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING);
    const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

    headerRow.forEach((colName, idx) => {
      const h = norm(colName);
      const letter = HSMC.indexToColLetter(idx);
      if (!h || !letter) return;

      if (h.includes("ma ho so") || h.includes("mahs")) mapping.maHoSo = letter;
      else if (h.includes("thu tuc") || h.includes("ten thu tuc")) mapping.tenThuTuc = letter;
      else if (h.includes("linh vuc")) mapping.tenLinhVuc = letter;
      else if (h.includes("noi dung")) mapping.noiDung = letter;
      else if (h.includes("tiep nhan")) mapping.ngayTiepNhan = letter;
      else if (h.includes("hen tra") || h.includes("ngay hen")) mapping.ngayHenTra = letter;
      else if (h.includes("ket thuc") || h.includes("tra ket qua")) mapping.ngayKetThuc = letter;
      else if (h.includes("chu ho so")) mapping.chuHoSo = letter;
      else if (h.includes("nguoi nop")) mapping.nguoiNop = letter;
      else if (h.includes("dien thoai") || h.includes("sdt") || h.includes("so dt")) mapping.soDienThoai = letter;
      else if (h.includes("trang thai")) mapping.trangThaiHoSo = letter;
      else if (h === "stt" || h.includes("so thu tu")) mapping.stt = letter;
    });
    return mapping;
  };

  // Cấu hình quy trình các bước chuẩn mẫu (tham khảo một cửa)
  HSMC.DEFAULT_WORKFLOW_STEPS = [
    { id: "step_tiep_nhan", name: "1. Tiếp nhận hồ sơ", dateCol: "F", deadlineCol: "G" },
    { id: "step_thu_ly", name: "2. Thụ lý & Thẩm định", dateCol: "", deadlineCol: "" },
    { id: "step_phe_duyet", name: "3. Trình ký & Phê duyệt", dateCol: "", deadlineCol: "" },
    { id: "step_tra_kq", name: "4. Trả kết quả", dateCol: "H", deadlineCol: "G" }
  ];

  // ---------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------
  HSMC.parseFullCSV = function (text) {
    const rows = [];
    let currentRow = [];
    let currentField = "";
    let inQuotes = false;
    const s = String(text || "").replace(/^﻿/, "");

    for (let i = 0; i < s.length; i++) {
      const char = s[i];
      const nextChar = s[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        currentRow.push(currentField.trim());
        currentField = "";
      } else if ((char === "\r" || char === "\n") && !inQuotes) {
        if (char === "\r" && nextChar === "\n") i++;
        currentRow.push(currentField.trim());
        if (currentRow.some((col) => col.length > 0)) rows.push(currentRow);
        currentRow = [];
        currentField = "";
      } else {
        currentField += char;
      }
    }
    if (currentField || currentRow.length > 0) {
      currentRow.push(currentField.trim());
      if (currentRow.some((col) => col.length > 0)) rows.push(currentRow);
    }
    return rows;
  };

  // ---------------------------------------------------------------
  // NGÀY THÁNG
  // ---------------------------------------------------------------
  function buildDate(y, m, d, hh, mm, ss) {
    const dt = new Date(y, m, d, hh || 0, mm || 0, ss || 0);
    // Loại bỏ ngày không tồn tại (VD 31/02 bị JS tự cuộn sang tháng 3)
    if (isNaN(dt.getTime()) || dt.getMonth() !== m || dt.getDate() !== d) return null;
    return dt;
  }

  HSMC.parseCustomDate = function (dateStr, defaultHour, defaultMinute, defaultSecond) {
    if (!dateStr) return null;
    const cleaned = String(dateStr).replace(/"/g, "").trim();
    if (!cleaned) return null;

    const defH = defaultHour !== undefined ? defaultHour : 0;
    const defM = defaultMinute !== undefined ? defaultMinute : 0;
    const defS = defaultSecond !== undefined ? defaultSecond : 0;

    const vn = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (vn) {
      const hasTime = vn[4] !== undefined;
      return buildDate(
        +vn[3],
        +vn[2] - 1,
        +vn[1],
        hasTime ? +vn[4] : defH,
        hasTime ? +vn[5] : defM,
        hasTime ? +(vn[6] || 0) : defS
      );
    }

    const iso = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (iso) {
      const hasTime = iso[4] !== undefined;
      return buildDate(
        +iso[1],
        +iso[2] - 1,
        +iso[3],
        hasTime ? +iso[4] : defH,
        hasTime ? +iso[5] : defM,
        hasTime ? +(iso[6] || 0) : defS
      );
    }

    // Định dạng gviz kiểu Date(2026,4,11,7,9,47)
    const gv = cleaned.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})(?:,(\d{1,2}),(\d{1,2})(?:,(\d{1,2}))?)?\)$/);
    if (gv) {
      const hasTime = gv[4] !== undefined;
      return buildDate(
        +gv[1],
        +gv[2],
        +gv[3],
        hasTime ? +gv[4] : defH,
        hasTime ? +gv[5] : defM,
        hasTime ? +(gv[6] || 0) : defS
      );
    }
    return null;
  };

  function dayKey(d) {
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  /**
   * Đọc danh sách ngày nghỉ bổ sung: mỗi mục là DD/MM/YYYY hoặc khoảng DD/MM/YYYY-DD/MM/YYYY,
   * phân tách bằng dấu phẩy, chấm phẩy hoặc xuống dòng.
   */
  HSMC.parseHolidayList = function (text) {
    const set = new Set();
    if (!text) return set;
    String(text)
      .split(/[\n,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((token) => {
        const parts = token.split(/\s*(?:-|–|đến)\s*(?=\d{1,2}\/)/);
        const a = HSMC.parseCustomDate(parts[0]);
        const b = parts[1] ? HSMC.parseCustomDate(parts[1]) : a;
        if (!a || !b) return;
        const from = a <= b ? a : b;
        const to = a <= b ? b : a;
        const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
        let guard = 0;
        while (cur <= to && guard < 400) {
          set.add(dayKey(cur));
          cur.setDate(cur.getDate() + 1);
          guard++;
        }
      });
    return set;
  };

  function isFixedHoliday(date) {
    const m = date.getMonth();
    const d = date.getDate();
    return (m === 0 && d === 1) || (m === 3 && d === 30) || (m === 4 && d === 1) || (m === 8 && d === 2);
  }

  HSMC.isNonWorkingDay = function (date, holidaySet) {
    const dow = date.getDay();
    if (dow === 0 || dow === 6) return true;
    if (isFixedHoliday(date)) return true;
    return !!(holidaySet && holidaySet.has(dayKey(date)));
  };

  /**
   * Số ngày làm việc giữa 2 mốc (đếm các ngày làm việc trong khoảng (start, end]).
   * Cùng một ngày làm việc = 0.5 ngày. Kết quả âm nếu end < start.
   */
  HSMC.calculateWorkingDays = function (startDate, endDate, holidaySet) {
    const dStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const dEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());

    if (dStart.getTime() === dEnd.getTime()) {
      return HSMC.isNonWorkingDay(dStart, holidaySet) ? 0 : 0.5;
    }

    const isReverse = dStart > dEnd;
    const from = isReverse ? dEnd : dStart;
    const to = isReverse ? dStart : dEnd;

    let count = 0;
    const cur = new Date(from);
    cur.setDate(cur.getDate() + 1);
    let guard = 0;
    while (cur <= to && guard < 3700) {
      if (!HSMC.isNonWorkingDay(cur, holidaySet)) count++;
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    return isReverse ? -count : count;
  };

  HSMC.formatDateTimeVN = function (iso) {
    if (!iso) return "---";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  };

  // ---------------------------------------------------------------
  // GOOGLE SHEET
  // ---------------------------------------------------------------
  HSMC.getSheetId = function (url) {
    if (!url) return null;
    const m = String(url).trim().match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/i);
    return m ? m[1] : null;
  };

  HSMC.isValidSheetUrl = function (url) {
    return !!HSMC.getSheetId(String(url || "").trim());
  };

  HSMC.buildCandidateUrls = function (url) {
    const sheetId = HSMC.getSheetId(url);
    if (!sheetId) return [];
    const base = `https://docs.google.com/spreadsheets/d/${sheetId}`;
    const gidMatch = String(url).match(/[?&#]gid=(\d+)/);
    const sheetParam = encodeURIComponent(HSMC.SHEET_NAME);

    const list = [
      `${base}/gviz/tq?tqx=out:csv&sheet=${sheetParam}`,
      `${base}/export?format=csv&sheet=${sheetParam}`
    ];
    if (gidMatch) {
      list.push(`${base}/export?format=csv&gid=${gidMatch[1]}`);
      list.push(`${base}/gviz/tq?tqx=out:csv&gid=${gidMatch[1]}`);
    }
    list.push(`${base}/export?format=csv&gid=342857175`);
    list.push(`${base}/export?format=csv`);
    list.push(`${base}/gviz/tq?tqx=out:csv`);
    return Array.from(new Set(list));
  };

  function looksLikeDossierHeader(headerRow) {
    const h = (headerRow || []).join(" ").toLowerCase();
    return (
      h.includes("mã hồ sơ") ||
      h.includes("ma ho so") ||
      h.includes("thủ tục") ||
      h.includes("lĩnh vực") ||
      h.includes("tiếp nhận") ||
      h.includes("hẹn trả") ||
      h.includes("trạng thái")
    );
  }

  /**
   * Tải CSV trang tính 'Nhập DL'.
   * @param {string} url Link Google Sheet
   * @param {(u: string) => Promise<string|null>} fetchText Hàm tải nội dung (trả null nếu lỗi HTTP)
   */
  HSMC.fetchSheetCSV = async function (url, fetchText) {
    if (!url || !String(url).trim()) throw new Error("Chưa nhập đường link Google Sheet.");
    if (!HSMC.isValidSheetUrl(url)) {
      throw new Error("Đường link Google Sheet không hợp lệ. Link phải có dạng https://docs.google.com/spreadsheets/d/.../edit");
    }

    let bestCsv = "";
    let permissionDenied = false;
    let networkErrors = 0;
    const candidates = HSMC.buildCandidateUrls(url);

    for (const candidate of candidates) {
      let text = null;
      try {
        text = await fetchText(candidate);
      } catch (e) {
        networkErrors++;
        text = null;
      }
      if (!text || !text.trim()) continue;

      const trimmed = text.trim();
      if (/^<!DOCTYPE/i.test(trimmed) || /^<html/i.test(trimmed) || trimmed.includes("accounts.google.com")) {
        permissionDenied = true;
        continue;
      }
      if (trimmed.includes("google.visualization.Query.setResponse") && trimmed.includes('"status":"error"')) continue;

      const rows = HSMC.parseFullCSV(text);
      if (rows.length >= 2) {
        if (looksLikeDossierHeader(rows[0])) return text;
        if (!bestCsv && rows[0].length >= 12) bestCsv = text;
      }
    }

    if (bestCsv) return bestCsv;
    if (networkErrors === candidates.length) {
      throw new Error("Không kết nối được tới Google Sheets. Vui lòng kiểm tra kết nối mạng rồi bấm 'Cập nhật'.");
    }
    if (permissionDenied) {
      throw new Error(
        "Google yêu cầu đăng nhập để xem bảng tính. Hãy mở Google Sheet → Chia sẻ → 'Bất kỳ ai có đường liên kết' quyền 'Người xem' (hoặc đăng nhập đúng tài khoản Google trên trình duyệt khi dùng tiện ích)."
      );
    }
    throw new Error(
      "Không thể đọc dữ liệu từ sheet! Hãy đảm bảo bảng tính có trang tính tên 'Nhập DL' chứa dữ liệu Cột A–L trích xuất từ https://motcuannmt.mae.gov.vn/."
    );
  };

  // ---------------------------------------------------------------
  // PHÂN LOẠI TIẾN ĐỘ HỒ SƠ
  // ---------------------------------------------------------------
  function dateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /**
   * Xử lý toàn bộ dòng CSV → danh sách hồ sơ + danh sách cảnh báo.
   * @param {string[][]} rows Dòng CSV (dòng 0 là tiêu đề)
   * @param {object} config Cấu hình đã lưu
   * @param {Date} [now]
   */
  HSMC.processRows = function (rows, config, now) {
    config = config || {};
    now = now || new Date();

    const mapping = Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING, config.columnMapping || {});
    const colIdx = {};
    Object.keys(HSMC.DEFAULT_COLUMN_MAPPING).forEach((k) => {
      colIdx[k] = HSMC.colLetterToIndex(mapping[k] !== undefined ? mapping[k] : HSMC.DEFAULT_COLUMN_MAPPING[k]);
    });

    const header = rows[0] || [];
    const requiredKeys = ["maHoSo", "ngayTiepNhan", "ngayHenTra", "trangThaiHoSo"];
    const missingKeys = requiredKeys.filter((k) => colIdx[k] < 0 || colIdx[k] >= header.length);
    if (missingKeys.length > 0 && header.length < 12) {
      throw new Error(
        `Cấu trúc cột chưa phù hợp (sheet hiện có ${header.length} cột). Vui lòng vào tab 'Cài đặt' để tùy chỉnh hoặc tự động nhận diện lại vị trí các cột.`
      );
    }

    const thresholdUnder7 = (Number(config.thresholdUnder7) || HSMC.DEFAULTS.thresholdUnder7) / 100;
    const thresholdOver7 = (Number(config.thresholdOver7) || HSMC.DEFAULTS.thresholdOver7) / 100;
    const isWorkingDays = config.calcMethod !== "calendar_days";
    const selectedFields = Array.isArray(config.selectedFields) ? config.selectedFields : [];
    const selectedStatuses = Array.isArray(config.selectedStatuses) ? config.selectedStatuses : [];
    const holidaySet = HSMC.parseHolidayList(
      config.extraHolidays === undefined ? HSMC.DEFAULT_EXTRA_HOLIDAYS : config.extraHolidays
    );
    const DAY_MS = 86400000;

    const allDossiers = [];
    const alertRecords = [];

    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i];
      if (!cols || cols.length === 0) continue;

      const getVal = (idx) => (idx >= 0 && idx < cols.length ? (cols[idx] || "").trim() : "");

      const maHoSo = getVal(colIdx.maHoSo);
      if (!maHoSo) continue;

      const item = {
        stt: getVal(colIdx.stt) || String(i),
        maHoSo,
        tenThuTuc: getVal(colIdx.tenThuTuc),
        tenLinhVuc: getVal(colIdx.tenLinhVuc),
        noiDung: getVal(colIdx.noiDung),
        ngayTiepNhan: getVal(colIdx.ngayTiepNhan),
        ngayHenTra: getVal(colIdx.ngayHenTra),
        ngayKetThuc: getVal(colIdx.ngayKetThuc),
        chuHoSo: getVal(colIdx.chuHoSo),
        nguoiNop: getVal(colIdx.nguoiNop),
        soDienThoai: getVal(colIdx.soDienThoai),
        trangThaiHoSo: getVal(colIdx.trangThaiHoSo)
      };

      // Ngày tiếp nhận: nếu không có giờ -> mặc định đầu giờ làm việc (08:00)
      const dateStart = HSMC.parseCustomDate(item.ngayTiepNhan, 8, 0, 0);
      // Ngày hẹn trả: nếu không có giờ -> mặc định cuối giờ hành chính (17:00)
      const dateEnd = HSMC.parseCustomDate(item.ngayHenTra, 17, 0, 0);
      // Ngày kết thúc: nếu không có giờ -> mặc định cuối giờ hành chính (17:00)
      const dateFinish = HSMC.parseCustomDate(item.ngayKetThuc, 17, 0, 0);
      const isCompleted = dateFinish !== null || HSMC.FINAL_STATUSES.includes(item.trangThaiHoSo);

      let status = HSMC.PROGRESS.PROCESSING;
      let totalDays = null;
      let remainingDays = null;
      let remainingRatio = null;

      if (dateEnd) {
        if (isWorkingDays) {
          remainingDays = HSMC.calculateWorkingDays(now, dateEnd, holidaySet);
        } else {
          remainingDays = (dateEnd.getTime() - now.getTime()) / DAY_MS;
        }

        // Tính tổng số ngày từ Ngày tiếp nhận đến Ngày hẹn trả (chính xác theo thời gian dữ liệu Google Sheet)
        if (dateStart) {
          const diffMs = dateEnd.getTime() - dateStart.getTime();
          const diffDays = diffMs / DAY_MS;
          const intDays = Math.round((dateOnly(dateEnd).getTime() - dateOnly(dateStart).getTime()) / DAY_MS);
          // Nếu chênh lệch do giờ/phút nhỏ (< 0.05 ngày, tức dưới 1 giờ lệch) thì lấy tròn số ngày nguyên intDays (khớp INT(G)-INT(F) trong Google Sheet)
          // Nếu có phần thập phân rõ ràng (ví dụ thủ tục 0.5 ngày, 2.5 ngày) thì giữ 1 chữ số thập phân
          if (Math.abs(diffDays - intDays) < 0.05) {
            totalDays = intDays;
          } else {
            totalDays = Math.round(diffDays * 10) / 10;
          }
          if (totalDays <= 0 && intDays > 0) totalDays = intDays;
        }

        const calcTotalDays = totalDays !== null && totalDays > 0 ? totalDays : 1;
        remainingRatio = totalDays !== null ? remainingDays / calcTotalDays : null;
      }

      if (isCompleted) {
        if (dateFinish && dateEnd) {
          const f = dateOnly(dateFinish).getTime();
          const e = dateOnly(dateEnd).getTime();
          status = f < e ? HSMC.PROGRESS.DONE_EARLY : f === e ? HSMC.PROGRESS.DONE_ONTIME : HSMC.PROGRESS.DONE_LATE;
        } else {
          status = HSMC.PROGRESS.DONE;
        }
      } else if (dateEnd) {
        const monitored = selectedStatuses.length === 0 || selectedStatuses.includes(item.trangThaiHoSo);
        if (monitored) {
          if (dateEnd.getTime() <= now.getTime() || remainingDays <= 0) {
            status = HSMC.PROGRESS.OVERDUE;
          } else {
            const threshold = totalDays !== null && totalDays < 7 ? thresholdUnder7 : thresholdOver7;
            // Cảnh báo Sắp hết hạn khi tỷ lệ chạm ngưỡng HOẶC khi chỉ còn <= 1 ngày làm việc
            if (remainingRatio !== null && (remainingRatio <= threshold || remainingDays <= 1)) {
              status = HSMC.PROGRESS.NEAR;
            }
          }
        }
      }

      // Giám sát quy trình từng bước & xác định bước trễ (khi bật tính năng)
      let currentStep = null;
      let delayedStep = null;
      let stepDetails = null;

      if (config.enableStepTracking) {
        const steps = Array.isArray(config.stepDefinitions) && config.stepDefinitions.length > 0
          ? config.stepDefinitions
          : HSMC.DEFAULT_WORKFLOW_STEPS;

        stepDetails = [];
        let foundCurrent = false;

        steps.forEach((st) => {
          const dateIdx = HSMC.colLetterToIndex(st.dateCol);
          const deadlineIdx = HSMC.colLetterToIndex(st.deadlineCol);
          const actualText = getVal(dateIdx);
          const deadlineText = getVal(deadlineIdx);
          const dtActual = actualText ? HSMC.parseCustomDate(actualText, 17, 0, 0) : null;
          const dtDeadline = deadlineText ? HSMC.parseCustomDate(deadlineText, 17, 0, 0) : null;

          let stepStatus = "PENDING"; // PENDING | IN_PROGRESS | COMPLETED | DELAYED
          let isDelayed = false;

          if (dtActual) {
            if (dtDeadline && dtActual.getTime() > dtDeadline.getTime()) {
              stepStatus = "DELAYED";
              isDelayed = true;
              if (!delayedStep) delayedStep = st.name;
            } else {
              stepStatus = "COMPLETED";
            }
          } else if (!foundCurrent && !isCompleted) {
            foundCurrent = true;
            currentStep = st.name;
            if (dtDeadline && now.getTime() > dtDeadline.getTime()) {
              stepStatus = "DELAYED";
              isDelayed = true;
              if (!delayedStep) delayedStep = st.name;
            } else {
              stepStatus = "IN_PROGRESS";
            }
          }

          stepDetails.push({
            name: st.name,
            actualDate: actualText,
            deadlineDate: deadlineText,
            status: stepStatus,
            isDelayed
          });
        });

        if (!currentStep) {
          currentStep = isCompleted ? "Đã hoàn thành" : (item.trangThaiHoSo || "Đang xử lý");
        }
        if (!delayedStep && (status === HSMC.PROGRESS.OVERDUE)) {
          delayedStep = currentStep;
        }
      }

      item.formulaStatus = status;
      item.hasDeadline = !!dateEnd;
      item.remainingDays = remainingDays === null ? null : Math.round(remainingDays * 10) / 10;
      item.totalDays = totalDays === null ? null : Math.round(totalDays * 10) / 10;
      item.remainingPercent =
        remainingRatio === null ? null : Math.max(0, Math.min(100, remainingRatio * 100)).toFixed(1);
      item.calcMethod = isWorkingDays ? "Ngày làm việc" : "Ngày tự nhiên";
      item.currentStep = currentStep;
      item.delayedStep = delayedStep;
      item.stepDetails = stepDetails;

      allDossiers.push(item);

      if (status === HSMC.PROGRESS.OVERDUE || status === HSMC.PROGRESS.NEAR) {
        if (selectedFields.length === 0 || selectedFields.includes(item.tenLinhVuc)) {
          alertRecords.push(Object.assign({}, item, {
            alertStatus: status === HSMC.PROGRESS.OVERDUE ? "HẾT HẠN" : "SẮP HẾT HẠN"
          }));
        }
      }
    }

    alertRecords.sort((a, b) => {
      if (a.alertStatus !== b.alertStatus) return a.alertStatus === "HẾT HẠN" ? -1 : 1;
      return (a.remainingDays || 0) - (b.remainingDays || 0);
    });

    return { allDossiers, alertRecords };
  };

  /**
   * Quy trình đầy đủ: tải CSV → phân tích → phân loại.
   */
  HSMC.runCheck = async function (sheetUrl, config, fetchText, now) {
    const csvText = await HSMC.fetchSheetCSV(sheetUrl, fetchText);
    const rows = HSMC.parseFullCSV(csvText);
    if (rows.length <= 1) return { allDossiers: [], alertRecords: [] };
    return HSMC.processRows(rows, config, now);
  };

  HSMC.extractMetadata = function (rows, mapping) {
    mapping = Object.assign({}, HSMC.DEFAULT_COLUMN_MAPPING, mapping || {});
    const fieldIdx = HSMC.colLetterToIndex(mapping.tenLinhVuc);
    const statusIdx = HSMC.colLetterToIndex(mapping.trangThaiHoSo);

    const fIdx = fieldIdx >= 0 ? fieldIdx : 3;
    const sIdx = statusIdx >= 0 ? statusIdx : 11;

    const fields = new Set();
    const statuses = new Set();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r && r[fIdx]) fields.add(r[fIdx].trim());
      if (r && r[sIdx]) statuses.add(r[sIdx].trim());
    }
    const sortVi = (a, b) => a.localeCompare(b, "vi");
    return {
      headers: rows[0] || [],
      fields: Array.from(fields).filter(Boolean).sort(sortVi),
      statuses: Array.from(statuses).filter(Boolean).sort(sortVi),
      totalRows: Math.max(0, rows.length - 1)
    };
  };

  root.HSMC = HSMC;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
