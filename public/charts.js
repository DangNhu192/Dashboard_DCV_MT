/**
 * HSMC Charts - Biểu đồ trực quan cho tab Thống kê (SVG/HTML thuần, không cần thư viện ngoài,
 * chạy được cả trong Extension MV3 lẫn bản Desktop).
 *
 * Bảng màu tình trạng (đã kiểm tra bằng bộ kiểm định bảng màu - cặp liền kề đạt ngưỡng,
 * cặp xanh lá ↔ cam có thêm mã hóa phụ: khe hở 2px, chú giải, nhãn trực tiếp và bảng số liệu).
 */
(function (root) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  // 6 nhóm tình trạng (≤ 6 phần cho thanh phân đoạn) - màu cố định theo nhóm, không đổi khi lọc
  const GROUPS = [
    { key: "overdue", label: "Hết hạn", color: "#d03b3b", ink: "#ffffff", drill: "Hết hạn" },
    { key: "near", label: "Sắp hết hạn", color: "#eda100", ink: "#1a1a19", drill: "Sắp hết" },
    { key: "processing", label: "Đang xử lý", color: "#2a78d6", ink: "#ffffff", drill: "Đang XL" },
    { key: "ontime", label: "HT đúng/trước hạn", color: "#0ca30c", ink: "#ffffff", drill: "HT đúng/trước" },
    { key: "late", label: "HT trễ hạn", color: "#eb6834", ink: "#1a1a19", drill: "HT trễ" },
    { key: "otherDone", label: "Kết thúc khác (rút, không tiếp nhận…)", short: "Kết thúc khác", color: "#a8a7a1", ink: "#1a1a19", drill: "HT khác" }
  ];

  const INK = {
    primary: "#0f172a",
    secondary: "#475569",
    muted: "#94a3b8",
    grid: "#e8edf3",
    axis: "#cbd5e1",
    surface: "#ffffff"
  };

  function groupOf(item) {
    const s = item.formulaStatus || "";
    if (s === "Hết hạn") return "overdue";
    if (s === "Sắp hết hạn") return "near";
    if (s === "Đang xử lý") return "processing";
    if (s === "Hoàn thành trước hạn" || s === "Hoàn thành đúng hạn") return "ontime";
    if (s === "Hoàn thành trễ hạn") return "late";
    return "otherDone";
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString("vi-VN");
  }
  function pct(n, total, digits) {
    if (!total) return "0%";
    return ((n / total) * 100).toFixed(digits === undefined ? 1 : digits).replace(".", ",") + "%";
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === "text") e.textContent = attrs[k];
        else if (k === "style") e.style.cssText = attrs[k];
        else if (k === "class") e.className = attrs[k];
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => c && e.appendChild(c));
    return e;
  }
  function s(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach((k) => {
      if (k === "text") e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    return e;
  }

  // ------------------------------------------------------------------
  // TOOLTIP (một tooltip dùng chung, nội dung luôn qua textContent)
  // ------------------------------------------------------------------
  let tip = null;
  function ensureTip() {
    if (tip) return tip;
    tip = el("div", { class: "viz-tooltip", role: "tooltip" });
    document.body.appendChild(tip);
    return tip;
  }
  function showTip(evt, title, rows) {
    const t = ensureTip();
    t.innerHTML = "";
    t.appendChild(el("div", { class: "viz-tooltip-title", text: title }));
    rows.forEach((r) => {
      const line = el("div", { class: "viz-tooltip-row" });
      if (r.color) line.appendChild(el("span", { class: "viz-tooltip-key", style: `background:${r.color}` }));
      line.appendChild(el("b", { text: r.value }));
      line.appendChild(el("span", { class: "viz-tooltip-label", text: r.label }));
      t.appendChild(line);
    });
    t.style.display = "block";
    moveTip(evt);
  }
  function moveTip(evt) {
    if (!tip) return;
    let x, y;
    if (evt && evt.clientX !== undefined && evt.type !== "focus") {
      x = evt.clientX;
      y = evt.clientY;
    } else if (evt && evt.target && evt.target.getBoundingClientRect) {
      const r = evt.target.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top;
    } else return;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = x + 14;
    let top = y - h - 10;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top < 8) top = y + 16;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = top + "px";
  }
  function hideTip() {
    if (tip) tip.style.display = "none";
  }
  function bindTip(node, titleFn, rowsFn) {
    node.addEventListener("pointerenter", (e) => showTip(e, titleFn(), rowsFn()));
    node.addEventListener("pointermove", moveTip);
    node.addEventListener("pointerleave", hideTip);
    node.addEventListener("focus", (e) => showTip(e, titleFn(), rowsFn()));
    node.addEventListener("blur", hideTip);
  }

  // ------------------------------------------------------------------
  // KHUNG THẺ BIỂU ĐỒ + CHẾ ĐỘ XEM BẢNG
  // ------------------------------------------------------------------
  function card(opts) {
    const head = el("div", { class: "viz-card-head" }, [
      el("div", {}, [
        el("div", { class: "viz-card-title", text: opts.title }),
        opts.sub ? el("div", { class: "viz-card-sub", text: opts.sub }) : null
      ])
    ]);
    const body = el("div", { class: "viz-card-body" });
    const tableWrap = el("div", { class: "viz-table-wrap", style: "display:none" });
    const c = el("div", { class: "viz-card" + (opts.wide ? " viz-wide" : "") }, [head, body, tableWrap]);

    if (opts.table) {
      const btn = el("button", { class: "btn btn-secondary btn-xs", type: "button", text: "Xem bảng" });
      btn.addEventListener("click", () => {
        const showing = tableWrap.style.display !== "none";
        tableWrap.style.display = showing ? "none" : "block";
        body.style.display = showing ? "block" : "none";
        btn.textContent = showing ? "Xem bảng" : "Xem biểu đồ";
        if (!showing && !tableWrap.firstChild) tableWrap.appendChild(buildTable(opts.table));
      });
      head.appendChild(btn);
    }
    return { card: c, body };
  }

  function buildTable(t) {
    const table = el("table", { class: "viz-table" });
    const thead = el("thead");
    const trh = el("tr");
    t.headers.forEach((h, i) => trh.appendChild(el("th", { text: h, style: i > 0 ? "text-align:right" : "" })));
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = el("tbody");
    t.rows.forEach((r) => {
      const tr = el("tr");
      r.forEach((v, i) => tr.appendChild(el("td", { text: String(v), style: i > 0 ? "text-align:right;font-variant-numeric:tabular-nums" : "" })));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function legend(groups) {
    const lg = el("div", { class: "viz-legend" });
    groups.forEach((g) => {
      lg.appendChild(el("span", { class: "viz-legend-item" }, [
        el("span", { class: "viz-swatch", style: `background:${g.color}` }),
        el("span", { text: g.short || g.label })
      ]));
    });
    return lg;
  }

  function empty(msg) {
    return el("div", { class: "viz-empty", text: msg || "Không có dữ liệu trong phạm vi lọc." });
  }

  // ------------------------------------------------------------------
  // 1. THANH PHÂN ĐOẠN: CƠ CẤU TÌNH TRẠNG TIẾN ĐỘ
  // ------------------------------------------------------------------
  function statusMix(dossiers, ctx) {
    const counts = {};
    GROUPS.forEach((g) => (counts[g.key] = 0));
    dossiers.forEach((d) => counts[groupOf(d)]++);
    const total = dossiers.length;

    const { card: c, body } = card({
      title: "Cơ cấu tình trạng tiến độ",
      sub: `${fmt(total)} hồ sơ trong phạm vi lọc · bấm vào từng phần để xem danh sách`,
      wide: true,
      table: {
        headers: ["Tình trạng", "Số hồ sơ", "Tỷ lệ"],
        rows: GROUPS.map((g) => [g.label, fmt(counts[g.key]), pct(counts[g.key], total)])
      }
    });

    if (!total) {
      body.appendChild(empty());
      return c;
    }

    const bar = el("div", { class: "viz-segbar", role: "img", "aria-label": "Cơ cấu tình trạng tiến độ hồ sơ" });
    GROUPS.forEach((g) => {
      const n = counts[g.key];
      if (!n) return;
      const share = (n / total) * 100;
      const seg = el("button", {
        type: "button",
        class: "viz-seg",
        style: `flex:${n} 1 0;background:${g.color};color:${g.ink}`,
        "aria-label": `${g.label}: ${fmt(n)} hồ sơ (${pct(n, total)})`
      });
      const label = pct(n, total, share >= 10 ? 0 : 1);
      seg.appendChild(el("span", { class: "viz-seg-label", text: label }));
      bindTip(seg, () => g.label, () => [{ color: g.color, value: fmt(n) + " hồ sơ", label: pct(n, total) }]);
      seg.addEventListener("click", () => ctx.onDrill && ctx.onDrill(g.drill));
      bar.appendChild(seg);
    });
    body.appendChild(bar);
    body.appendChild(legend(GROUPS));

    // Ẩn nhãn % ở phần quá hẹp (giá trị vẫn có trong tooltip và bảng)
    requestAnimationFrame(() => {
      bar.querySelectorAll(".viz-seg").forEach((seg) => {
        const lbl = seg.firstChild;
        if (lbl && lbl.offsetWidth + 12 > seg.clientWidth) lbl.style.visibility = "hidden";
      });
    });
    return c;
  }

  // ------------------------------------------------------------------
  // 2 & 3. THANH NGANG XẾP CHỒNG (Lĩnh vực / Thủ tục cần đôn đốc)
  // ------------------------------------------------------------------
  function stackedRows(rows, groups, opts) {
    const wrap = el("div", { class: "viz-hbars" });
    const maxTotal = Math.max(1, ...rows.map((r) => r.total));
    rows.forEach((r) => {
      const track = el("div", { class: "viz-hbar-track" });
      const fill = el("div", { class: "viz-hbar-fill", style: `width:${(r.total / maxTotal) * 100}%` });
      groups.forEach((g) => {
        const n = r.counts[g.key] || 0;
        if (!n) return;
        const seg = el("button", {
          type: "button",
          class: "viz-hseg",
          style: `flex:${n} 1 0;background:${g.color}`,
          "aria-label": `${r.label} - ${g.label}: ${fmt(n)}`
        });
        bindTip(seg, () => r.label, () =>
          groups.filter((x) => r.counts[x.key]).map((x) => ({
            color: x.color,
            value: fmt(r.counts[x.key]),
            label: x.short || x.label
          })).concat([{ value: fmt(r.total), label: "Tổng cộng" }])
        );
        seg.addEventListener("click", () => opts.onDrill && opts.onDrill(g.drill, r));
        fill.appendChild(seg);
      });
      track.appendChild(fill);
      const nameEl = el("button", { type: "button", class: "viz-hbar-name", title: r.label, text: r.label });
      nameEl.addEventListener("click", () => opts.onDrill && opts.onDrill("all", r));
      wrap.appendChild(el("div", { class: "viz-hbar-row" }, [
        nameEl,
        track,
        el("div", { class: "viz-hbar-total", text: fmt(r.total) })
      ]));
    });
    return wrap;
  }

  function byDomain(dossiers, ctx) {
    const map = {};
    dossiers.forEach((d) => {
      const k = d.tenLinhVuc || "Chưa xác định";
      if (!map[k]) map[k] = { label: k, domain: k, total: 0, counts: {} };
      const g = groupOf(d);
      map[k].counts[g] = (map[k].counts[g] || 0) + 1;
      map[k].total++;
    });
    let rows = Object.values(map).sort((a, b) => b.total - a.total);
    const TOP = 8;
    if (rows.length > TOP + 1) {
      const rest = rows.slice(TOP);
      const other = { label: `Các lĩnh vực khác (${rest.length})`, domain: "", total: 0, counts: {}, isOther: true };
      rest.forEach((r) => {
        other.total += r.total;
        Object.keys(r.counts).forEach((k) => (other.counts[k] = (other.counts[k] || 0) + r.counts[k]));
      });
      rows = rows.slice(0, TOP).concat([other]);
    }

    const all = Object.values(map).sort((a, b) => b.total - a.total);
    const { card: c, body } = card({
      title: "Hồ sơ theo lĩnh vực",
      sub: "Xếp theo tổng số hồ sơ, chia theo tình trạng tiến độ",
      table: {
        headers: ["Lĩnh vực", "Tổng"].concat(GROUPS.map((g) => g.short || g.label)),
        rows: all.map((r) => [r.label, fmt(r.total)].concat(GROUPS.map((g) => fmt(r.counts[g.key] || 0))))
      }
    });
    if (!rows.length) {
      body.appendChild(empty());
      return c;
    }
    body.appendChild(stackedRows(rows, GROUPS, {
      onDrill: (status, r) => ctx.onDrill && ctx.onDrill(status, "", r.isOther ? "" : r.domain)
    }));
    body.appendChild(legend(GROUPS));
    return c;
  }

  function urgentProcedures(dossiers, ctx) {
    const groups = GROUPS.slice(0, 2);
    const map = {};
    dossiers.forEach((d) => {
      const g = groupOf(d);
      if (g !== "overdue" && g !== "near") return;
      const k = d.tenThuTuc || "Chưa xác định thủ tục";
      if (!map[k]) map[k] = { label: k, proc: k, total: 0, counts: {} };
      map[k].counts[g] = (map[k].counts[g] || 0) + 1;
      map[k].total++;
    });
    const all = Object.values(map).sort((a, b) => (b.counts.overdue || 0) - (a.counts.overdue || 0) || b.total - a.total);
    const rows = all.slice(0, 10);

    const { card: c, body } = card({
      title: "Thủ tục cần đôn đốc",
      sub: all.length > 10 ? `10/${all.length} thủ tục có nhiều hồ sơ hết hạn, sắp hết hạn nhất` : "Thủ tục có hồ sơ hết hạn hoặc sắp hết hạn",
      table: {
        headers: ["Thủ tục", "Hết hạn", "Sắp hết hạn", "Tổng"],
        rows: all.map((r) => [r.label, fmt(r.counts.overdue || 0), fmt(r.counts.near || 0), fmt(r.total)])
      }
    });
    if (!rows.length) {
      body.appendChild(empty("Không có hồ sơ hết hạn hoặc sắp hết hạn trong phạm vi lọc. 🎉"));
      return c;
    }
    body.appendChild(stackedRows(rows, groups, {
      onDrill: (status, r) => ctx.onDrill && ctx.onDrill(status === "all" ? "all" : status, r.proc, "")
    }));
    body.appendChild(legend(groups));
    return c;
  }

  // ------------------------------------------------------------------
  // 4 & 5. THEO THỜI GIAN (cột: số hồ sơ tiếp nhận; đường: tỷ lệ đúng hạn)
  // ------------------------------------------------------------------
  function bucketize(dossiers, parseItemDate) {
    const dated = [];
    dossiers.forEach((d) => {
      const dt = parseItemDate(d);
      if (dt) dated.push({ d, dt });
    });
    if (!dated.length) return { mode: "month", buckets: [] };
    let min = dated[0].dt, max = dated[0].dt;
    dated.forEach((x) => {
      if (x.dt < min) min = x.dt;
      if (x.dt > max) max = x.dt;
    });
    const spanDays = (max - min) / 86400000;
    const mode = spanDays <= 120 ? "week" : "month";
    const p = (n) => String(n).padStart(2, "0");

    const keyOf = (dt) => {
      if (mode === "month") return { key: dt.getFullYear() * 100 + dt.getMonth(), start: new Date(dt.getFullYear(), dt.getMonth(), 1) };
      const monday = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      return { key: monday.getTime(), start: monday };
    };

    const map = new Map();
    // Tạo đủ các kỳ liên tiếp (kể cả kỳ trống) để trục thời gian không bị nhảy cóc
    const cur = keyOf(min).start;
    const endKey = keyOf(max).key;
    let guard = 0;
    while (guard++ < 400) {
      const k = keyOf(cur);
      map.set(k.key, { start: new Date(k.start), total: 0, ontime: 0, late: 0 });
      if (k.key >= endKey) break;
      if (mode === "month") cur.setMonth(cur.getMonth() + 1);
      else cur.setDate(cur.getDate() + 7);
    }
    dated.forEach(({ d, dt }) => {
      const b = map.get(keyOf(dt).key);
      if (!b) return;
      b.total++;
      const g = groupOf(d);
      if (g === "ontime") b.ontime++;
      else if (g === "late") b.late++;
    });
    const buckets = Array.from(map.values()).map((b) => {
      const end = new Date(b.start);
      if (mode === "month") end.setMonth(end.getMonth() + 1, 0);
      else end.setDate(end.getDate() + 6);
      b.label = mode === "month" ? `${p(b.start.getMonth() + 1)}/${b.start.getFullYear()}` : `${p(b.start.getDate())}/${p(b.start.getMonth() + 1)}`;
      b.longLabel = mode === "month"
        ? `Tháng ${b.start.getMonth() + 1}/${b.start.getFullYear()}`
        : `Tuần ${p(b.start.getDate())}/${p(b.start.getMonth() + 1)} – ${p(end.getDate())}/${p(end.getMonth() + 1)}/${end.getFullYear()}`;
      return b;
    });
    return { mode, buckets };
  }

  function niceMax(v) {
    if (v <= 5) return 5;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function axisFrame(svgEl, W, H, M, yMax, yFmt, ticks) {
    for (let i = 0; i <= ticks; i++) {
      const v = (yMax / ticks) * i;
      const y = M.t + (H - M.t - M.b) * (1 - i / ticks);
      svgEl.appendChild(s("line", { x1: M.l, x2: W - M.r, y1: y, y2: y, stroke: i === 0 ? INK.axis : INK.grid, "stroke-width": 1 }));
      svgEl.appendChild(s("text", { x: M.l - 8, y: y + 4, "text-anchor": "end", "font-size": 11, fill: INK.secondary, text: yFmt(v) }));
    }
  }

  function xLabelsEvery(n, plotW) {
    const maxLabels = Math.max(2, Math.floor(plotW / 54));
    return Math.max(1, Math.ceil(n / maxLabels));
  }

  function intakeOverTime(dossiers, ctx) {
    const { mode, buckets } = bucketize(dossiers, ctx.parseItemDate);
    const unit = mode === "month" ? "tháng" : "tuần";
    const { card: c, body } = card({
      title: `Hồ sơ tiếp nhận theo ${unit}`,
      sub: "Theo ngày tiếp nhận (Cột F), bổ sung từ mã hồ sơ khi thiếu ngày",
      table: {
        headers: [mode === "month" ? "Tháng" : "Tuần", "Số hồ sơ tiếp nhận"],
        rows: buckets.map((b) => [b.longLabel, fmt(b.total)])
      }
    });
    if (!buckets.length) {
      body.appendChild(empty());
      return c;
    }

    const W = Math.max(320, ctx.width || 520);
    const H = 240;
    const M = { t: 22, r: 12, b: 30, l: 46 };
    const plotW = W - M.l - M.r;
    const plotH = H - M.t - M.b;
    const maxV = Math.max(...buckets.map((b) => b.total));
    const yMax = niceMax(maxV);
    const svgEl = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, role: "img", "aria-label": `Số hồ sơ tiếp nhận theo ${unit}` });
    axisFrame(svgEl, W, H, M, yMax, (v) => fmt(Math.round(v)), 4);

    const band = plotW / buckets.length;
    const barW = Math.max(3, Math.min(24, band - 4));
    const every = xLabelsEvery(buckets.length, plotW);
    const maxIdx = buckets.findIndex((b) => b.total === maxV);

    buckets.forEach((b, i) => {
      const x = M.l + band * i + (band - barW) / 2;
      const h = (b.total / yMax) * plotH;
      const y = M.t + plotH - h;
      if (b.total > 0) {
        const r = Math.min(4, barW / 2, h);
        // Đầu cột bo 4px, chân cột vuông tại trục
        const d = `M${x},${M.t + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${M.t + plotH} Z`;
        svgEl.appendChild(s("path", { d, fill: "#2a78d6", class: "viz-col" }));
      }
      if (i % every === 0 || i === buckets.length - 1) {
        svgEl.appendChild(s("text", { x: M.l + band * i + band / 2, y: H - 10, "text-anchor": "middle", "font-size": 11, fill: INK.secondary, text: b.label }));
      }
      if (i === maxIdx && b.total > 0) {
        svgEl.appendChild(s("text", { x: x + barW / 2, y: y - 6, "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: INK.primary, text: fmt(b.total) }));
      }
      // Vùng bắt chuột rộng bằng cả dải
      const hit = s("rect", { x: M.l + band * i, y: M.t, width: band, height: plotH, fill: "transparent", tabindex: 0, class: "viz-hit" });
      bindTip(hit, () => b.longLabel, () => [{ color: "#2a78d6", value: fmt(b.total), label: "hồ sơ tiếp nhận" }]);
      svgEl.appendChild(hit);
    });
    body.appendChild(svgEl);
    return c;
  }

  function onTimeRate(dossiers, ctx) {
    const { mode, buckets } = bucketize(dossiers, ctx.parseItemDate);
    const unit = mode === "month" ? "tháng" : "tuần";
    const pts = buckets.map((b) => {
      const done = b.ontime + b.late;
      return { b, done, rate: done ? (b.ontime / done) * 100 : null };
    });
    const totalOn = buckets.reduce((a, b) => a + b.ontime, 0);
    const totalDone = buckets.reduce((a, b) => a + b.ontime + b.late, 0);

    const { card: c, body } = card({
      title: `Tỷ lệ giải quyết đúng/trước hạn theo ${unit}`,
      sub: totalDone ? `Chung toàn kỳ: ${pct(totalOn, totalDone)} (${fmt(totalOn)}/${fmt(totalDone)} hồ sơ đã giải quyết có ngày kết thúc)` : "Chưa có hồ sơ đã giải quyết có ngày kết thúc",
      table: {
        headers: [mode === "month" ? "Tháng" : "Tuần", "Đúng/trước hạn", "Trễ hạn", "Tỷ lệ đúng/trước hạn"],
        rows: pts.map((p) => [p.b.longLabel, fmt(p.b.ontime), fmt(p.b.late), p.rate === null ? "—" : pct(p.b.ontime, p.done)])
      }
    });
    if (!totalDone) {
      body.appendChild(empty());
      return c;
    }

    const W = Math.max(320, ctx.width || 520);
    const H = 240;
    const M = { t: 22, r: 16, b: 30, l: 46 };
    const plotW = W - M.l - M.r;
    const plotH = H - M.t - M.b;
    const svgEl = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, role: "img", "aria-label": `Tỷ lệ đúng hạn theo ${unit}` });
    // Trục tỷ lệ: thu hẹp về vùng có dữ liệu khi mọi kỳ đều cao (biểu đồ đường không bắt buộc gốc 0)
    const rates = pts.filter((p) => p.rate !== null).map((p) => p.rate);
    const minRate = Math.min(...rates);
    const yMin = minRate >= 60 ? Math.max(0, Math.floor((minRate - 5) / 10) * 10) : 0;
    const span = 100 - yMin;
    for (let i = 0; i <= 4; i++) {
      const v = yMin + (span / 4) * i;
      const y = M.t + plotH * (1 - i / 4);
      svgEl.appendChild(s("line", { x1: M.l, x2: W - M.r, y1: y, y2: y, stroke: i === 0 ? INK.axis : INK.grid, "stroke-width": 1 }));
      svgEl.appendChild(s("text", { x: M.l - 8, y: y + 4, "text-anchor": "end", "font-size": 11, fill: INK.secondary, text: String(Math.round(v * 10) / 10).replace(".", ",") + "%" }));
    }

    const band = plotW / pts.length;
    const xOf = (i) => M.l + band * i + band / 2;
    const yOf = (v) => M.t + plotH * (1 - (v - yMin) / span);
    const every = xLabelsEvery(pts.length, plotW);

    // Đường nối các kỳ có dữ liệu (kỳ không có hồ sơ giải quyết thì ngắt đoạn)
    let d = "";
    let pen = false;
    pts.forEach((p, i) => {
      if (p.rate === null) {
        pen = false;
        return;
      }
      d += (pen ? "L" : "M") + xOf(i) + "," + yOf(p.rate) + " ";
      pen = true;
    });
    svgEl.appendChild(s("path", { d, fill: "none", stroke: "#0ca30c", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

    const cross = s("line", { x1: 0, x2: 0, y1: M.t, y2: M.t + plotH, stroke: INK.axis, "stroke-width": 1, visibility: "hidden" });
    svgEl.appendChild(cross);

    let lastIdx = -1;
    pts.forEach((p, i) => {
      if (p.rate !== null) {
        lastIdx = i;
        svgEl.appendChild(s("circle", { cx: xOf(i), cy: yOf(p.rate), r: 4, fill: "#0ca30c", stroke: INK.surface, "stroke-width": 2 }));
      }
      if (i % every === 0 || i === pts.length - 1) {
        svgEl.appendChild(s("text", { x: xOf(i), y: H - 10, "text-anchor": "middle", "font-size": 11, fill: INK.secondary, text: p.b.label }));
      }
    });
    if (lastIdx >= 0) {
      const lp = pts[lastIdx];
      svgEl.appendChild(s("text", {
        x: Math.min(xOf(lastIdx), W - M.r - 4), y: yOf(lp.rate) - 10,
        "text-anchor": "end", "font-size": 11, "font-weight": 700, fill: INK.primary,
        text: Math.round(lp.rate) + "%"
      }));
    }

    pts.forEach((p, i) => {
      const hit = s("rect", { x: M.l + band * i, y: M.t, width: band, height: plotH, fill: "transparent", tabindex: 0, class: "viz-hit" });
      const show = () => {
        cross.setAttribute("x1", xOf(i));
        cross.setAttribute("x2", xOf(i));
        cross.setAttribute("visibility", "visible");
      };
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("pointerleave", () => cross.setAttribute("visibility", "hidden"));
      hit.addEventListener("blur", () => cross.setAttribute("visibility", "hidden"));
      bindTip(hit, () => p.b.longLabel, () => p.rate === null
        ? [{ value: "—", label: "chưa có hồ sơ giải quyết" }]
        : [
            { color: "#0ca30c", value: pct(p.b.ontime, p.done), label: "đúng/trước hạn" },
            { value: `${fmt(p.b.ontime)}/${fmt(p.done)}`, label: "hồ sơ" },
            { color: "#eb6834", value: fmt(p.b.late), label: "trễ hạn" }
          ]);
      svgEl.appendChild(hit);
    });
    body.appendChild(svgEl);
    return c;
  }

  // ------------------------------------------------------------------
  // VẼ TOÀN BỘ
  // ------------------------------------------------------------------
  function render(container, dossiers, ctx) {
    if (!container) return;
    hideTip();
    container.innerHTML = "";
    const grid = el("div", { class: "viz-grid" });
    container.appendChild(grid);

    // Chiều rộng 1 cột của lưới (2 cột khi đủ rộng)
    const full = container.clientWidth || 1000;
    const twoCol = full >= 900;
    const colW = (twoCol ? (full - 14) / 2 : full) - 30;
    const c2 = Object.assign({}, ctx, { width: colW });

    grid.appendChild(statusMix(dossiers, c2));
    grid.appendChild(byDomain(dossiers, c2));
    grid.appendChild(urgentProcedures(dossiers, c2));
    grid.appendChild(intakeOverTime(dossiers, c2));
    grid.appendChild(onTimeRate(dossiers, c2));
  }

  root.HSMCCharts = { render, GROUPS, groupOf, hideTip };
})(window);
