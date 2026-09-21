/* ============================================================
 * 页面展示模块（app.js）
 * 只负责渲染与交互：所有数据从记录存储模块读取，所有变更
 * 通过存储模块提交后整体重渲染，保证页面汇总与重载后一致。
 * 包含：① 纹样排版台（画布） ② 试织排机与色线领用复核台
 * ============================================================ */
(() => {
  const R = window.BrocadeRules;
  const S = window.BrocadeStore;
  const COLORS = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437", "#355b38", "#713d7b", "#1e1b18", "#e98c52"];
  const COLOR_NAMES = ["米白", "绛红", "靛蓝", "金黄", "墨绿", "紫棕", "墨黑", "橘橙"];
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ============================================================
   * 一、纹样排版台（画布）
   * ============================================================ */
  const grid = $("#grid"), palette = $("#palette"), statsEl = $("#stats"), preview = $("#preview"), risk = $("#risk");
  let cols = 18, rows = 14, active = 1, block = "dot", dragging = false;
  let cells = Array(cols * rows).fill(0);
  let undoStack = [], redoStack = [];

  function renderDesigner() {
    palette.innerHTML = COLORS.map((c, i) => `<button class="swatch ${i === active ? "active" : ""}" data-color="${i}" style="background:${c}"></button>`).join("");
    palette.querySelectorAll("[data-color]").forEach(el => el.onclick = () => { active = Number(el.dataset.color); renderDesigner(); });
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.innerHTML = cells.map((v, i) => `<div class="cell" data-i="${i}" style="background:${COLORS[v]}"></div>`).join("");
    grid.querySelectorAll(".cell").forEach(el => {
      el.onpointerdown = () => { dragging = true; paint(Number(el.dataset.i)); };
      el.onpointerenter = () => { if (dragging) paint(Number(el.dataset.i)); };
    });
    window.onpointerup = () => { dragging = false; };
    renderDesignerStats();
  }
  function snapshot() { undoStack.push([...cells]); redoStack = []; if (undoStack.length > 50) undoStack.shift(); }
  function paint(i) {
    snapshot();
    patternTargets(i).forEach(t => { cells[t] = active; });
    renderDesigner();
  }
  function patternTargets(i) {
    const x = i % cols, y = Math.floor(i / cols);
    const at = (xx, yy) => (xx < 0 || xx >= cols || yy < 0 || yy >= rows ? null : yy * cols + xx);
    if (block === "cross") return [i, at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].filter(v => v !== null);
    if (block === "diamond") return [at(x, y - 1), at(x - 1, y), i, at(x + 1, y), at(x, y + 1)].filter(v => v !== null);
    return [i];
  }
  function renderDesignerStats() {
    const counts = COLORS.map((_, i) => cells.filter(v => v === i).length);
    statsEl.innerHTML = counts.map((n, i) => `<div class="stat"><span><span class="swatch-dot" style="background:${COLORS[i]}"></span>色线${i}</span><b>${n}</b></div>`).join("");
    preview.innerHTML = Array.from({ length: 36 }, (_, i) => `<div class="mini" style="background:${COLORS[cells[(i % 6) + Math.floor(i / 6) * cols] || 0]}"></div>`).join("");
    const riskRows = [];
    for (let y = 0; y < rows; y++) {
      let switches = 0;
      for (let x = 1; x < cols; x++) if (cells[y * cols + x] !== cells[y * cols + x - 1]) switches++;
      if (switches > cols * 0.62) riskRows.push(y + 1);
    }
    risk.innerHTML = riskRows.length ? `<p class="warning">第${riskRows.join("、")}行换色过密，可能断线。</p>` : "<p>暂无明显断线风险。</p>";
  }
  function designMsg(text, ok) { const m = $("#designMsg"); m.textContent = text; m.className = "msg " + (ok ? "ok" : "err"); }
  function loadPatternIntoDesigner(p) {
    cols = p.cols; rows = p.rows; cells = [...p.cells];
    undoStack = []; redoStack = [];
    $("#cols").value = cols; $("#rows").value = rows;
    renderDesigner();
  }

  document.querySelectorAll("[data-block]").forEach(btn => btn.onclick = () => { block = btn.dataset.block; });
  $("#newBtn").onclick = () => {
    cols = Number($("#cols").value); rows = Number($("#rows").value);
    cells = Array(cols * rows).fill(0); undoStack = []; redoStack = [];
    renderDesigner();
  };
  $("#undoBtn").onclick = () => { if (!undoStack.length) return; redoStack.push([...cells]); cells = undoStack.pop(); renderDesigner(); };
  $("#redoBtn").onclick = () => { if (!redoStack.length) return; undoStack.push([...cells]); cells = redoStack.pop(); renderDesigner(); };
  // 保存方案 = 登记纹样（编号+版本唯一），入库后可在排机复核台选用
  $("#saveBtn").onclick = () => {
    const res = S.registerPattern({ no: $("#patNo").value, version: $("#patVer").value, cols, rows, cells });
    designMsg(res.message, res.ok);
  };
  $("#exportBtn").onclick = () => {
    const data = { cols, rows, cells, usage: COLORS.map((color, i) => ({ color, count: cells.filter(v => v === i).length })) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "brocade-pattern.json"; a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ============================================================
   * 二、试织排机与色线领用复核台
   * ============================================================ */
  const fmtItems = items => Object.entries(items).map(([c, q]) => `色线${c}×${q}`).join("、");
  const itemsToText = items => Object.entries(items).map(([c, q]) => `${c}:${q}`).join(",");
  function stationMsg(text, ok) { const m = $("#stationMsg"); m.textContent = text; m.className = "msg " + (ok ? "ok" : "err"); }

  /* ---------- 汇总（由存储状态实时推算，刷新后一致） ---------- */
  function renderSummary(state) {
    const s = R.computeSummary(state);
    const card = (label, value) => `<div class="card"><b>${value}</b><span>${label}</span></div>`;
    $("#sumCards").innerHTML = [
      card("工单总数", s.total),
      card("在织", s.byStatus["在织"]),
      card("待补料", s.byStatus["待补料"]),
      card("待复核", s.byStatus["待复核"]),
      card("返修", s.byStatus["返修"]),
      card("冻结", s.byStatus["冻结"]),
      card("合格", s.byStatus["合格"]),
      card("已关机", s.byStatus["已关机"]),
      card("有效合格样片", s.trials.pass),
      card("合格率", s.passRate === null ? "—" : s.passRate + "%"),
      card("留档旧结果", s.trials.archived),
    ].join("");
  }

  /* ---------- 排机登记表单 + 织机/批次状态 ---------- */
  function renderScheduleForm(state) {
    const keep = { p: $("#schPattern").value, l: $("#schLoom").value, b: $("#schBatch").value, r: $("#schReq").value };
    $("#schPattern").innerHTML = state.patterns.map(p =>
      `<option value="${esc(p.no)}|${esc(p.version)}">${esc(p.no)} / ${esc(p.version)}（${p.cols}×${p.rows}）</option>`).join("");
    $("#schLoom").innerHTML = state.looms.map(l => {
      const busy = R.activeOrderOnLoom(state.orders, l.no);
      return `<option value="${l.no}">${l.no}${busy ? `（占用：${busy.id} ${busy.status}）` : "（空闲）"}</option>`;
    }).join("");
    $("#schBatch").innerHTML = state.warpBatches.map(b =>
      `<option value="${b.id}">${b.id}（有效期至 ${b.expiry}${b.expiry < S.today() ? "，已过期⚠" : ""}）</option>`).join("");
    $("#schReq").innerHTML = state.requisitions.map(r =>
      `<option value="${r.id}" ${r.status !== "有效" ? "disabled" : ""}>${r.id}（${r.status}·第${r.revision}版）${fmtItems(r.items)}</option>`).join("");
    if (keep.p) $("#schPattern").value = keep.p;
    if (keep.l) $("#schLoom").value = keep.l;
    if (keep.b) $("#schBatch").value = keep.b;
    if (keep.r) $("#schReq").value = keep.r;
    $("#loomList").innerHTML = state.looms.map(l => {
      const busy = R.activeOrderOnLoom(state.orders, l.no);
      return `<div class="row-line"><span>${l.no}</span><span>${busy ? `${busy.id} · ${busy.status}` : "空闲"}</span></div>`;
    }).join("");
    $("#batchList").innerHTML = state.warpBatches.map(b =>
      `<div class="row-line"><span>${b.id}</span><span class="${b.expiry < S.today() ? "warning" : ""}">${b.expiry < S.today() ? "已过期 " : "有效期至 "}${b.expiry}</span></div>`).join("");
  }

  /* ---------- 工单与试织记录 ---------- */
  function orderActions(o) {
    const b = [];
    if (o.status === "在织" || o.status === "返修") b.push(`<button data-act="trial" data-id="${o.id}">录试织</button>`);
    if (o.status === "待复核") {
      b.push(`<button data-act="pass" data-id="${o.id}">复核通过</button>`);
      b.push(`<button class="secondary" data-act="reject" data-id="${o.id}">退回返修</button>`);
    }
    if (o.status === "冻结") b.push(`<button data-act="unfreeze" data-id="${o.id}">解冻复核</button>`);
    if (o.status === "待补料") b.push(`<button data-act="recheck" data-id="${o.id}">补料上架</button>`);
    if (o.status === "合格" || o.status === "返修") b.push(`<button class="secondary" data-act="close" data-id="${o.id}">关机</button>`);
    return b.join("");
  }
  function renderOrders(state) {
    const el = $("#orderList");
    if (!state.orders.length) { el.innerHTML = '<p class="muted">暂无工单，请先登记排机。</p>'; return; }
    el.innerHTML = state.orders.map(o => {
      const trials = state.trials.filter(t => t.orderId === o.id);
      const batch = state.warpBatches.find(b => b.id === o.warpBatchId);
      const req = state.requisitions.find(r => r.id === o.requisitionId);
      return `<div class="order-card">
        <div class="order-head"><b>${o.id}</b><span class="badge st-${o.status}">${o.status}</span>
          ${o.conclusionInvalid ? '<span class="badge" style="background:#a03a2e">合格结论已失效</span>' : ""}</div>
        <div class="order-meta">纹样 ${esc(o.patternNo)} / ${esc(o.version)} · 织机 ${o.loomNo} · 批次 ${o.warpBatchId}${batch && batch.expiry < S.today() ? "（已过期）" : ""} · 领用单 ${o.requisitionId}${req ? `（第${req.revision}版）` : ""} · 预计 ${o.dueDate} 完成${o.closedAt ? ` · ${o.closedAt} 关机` : ""}</div>
        ${o.holdReasons && o.holdReasons.length ? `<div class="reasons">${o.holdReasons.map(esc).join("；")}</div>` : ""}
        ${o.note ? `<div class="note">${esc(o.note)}</div>` : ""}
        ${trials.map(t => `<div class="trial ${t.archived ? "archived" : ""}">${t.id} · 断线${t.breaks}次 · 经密${t.warpDensity} · 纬密${t.weftDensity} · 样片${esc(t.sample)} → <b>${t.verdict}</b>${t.archived ? ' <span class="arch-tag">[留档·不计入统计]</span>' : ""}${t.reasons && t.reasons.length ? `（${t.reasons.map(esc).join("；")}）` : ""}${t.note ? `（${esc(t.note)}）` : ""}</div>`).join("")}
        <div class="actions">${orderActions(o)}</div>
      </div>`;
    }).join("");
  }

  /* ---------- 色线库存与领用单 ---------- */
  function renderStock(state) {
    $("#stockList").innerHTML = R.availableStock(state).map(s =>
      `<div class="row-line"><span><span class="swatch-dot" style="background:${COLORS[s.color]}"></span>色线${s.color} ${COLOR_NAMES[s.color]}</span><span>库存${s.qty} · 占用${s.reserved} · <b>可用${s.available}</b></span></div>`).join("");
  }
  function renderReqs(state) {
    $("#reqList").innerHTML = state.requisitions.map(r => `<div class="req-row">
      <div><b>${r.id}</b> <span class="badge ${r.status === "有效" ? "st-合格" : "st-已关机"}">${r.status}</span> 第${r.revision}版${r.replacedBy ? ` → 由 ${r.replacedBy} 接替` : ""}</div>
      <div class="muted">当前明细：${fmtItems(r.items)}</div>
      ${r.status === "有效" ? `<input value="${itemsToText(r.items)}" data-items="${r.id}" placeholder="如 1:6,2:4">
      <div class="actions"><button data-req="${r.id}" data-act="correct">更正（原单修订）</button><button class="secondary" data-req="${r.id}" data-act="replace">撤换（新单接替）</button></div>` : ""}
    </div>`).join("");
  }
  function parseItems(text) {
    const items = {};
    const parts = String(text).split(/[,，;；\s]+/).filter(Boolean);
    if (!parts.length) return { error: "请填写领用明细，如 1:6,2:4" };
    for (const p of parts) {
      const m = p.split(/[:：]/);
      if (m.length !== 2) return { error: `明细“${p}”格式应为 色号:数量` };
      const c = Number(m[0]), q = Number(m[1]);
      if (!Number.isInteger(c) || c < 0 || c >= COLORS.length) return { error: `色号${m[0]}无效（0~${COLORS.length - 1}）` };
      if (!Number.isInteger(q) || q <= 0) return { error: `数量${m[1]}无效` };
      items[c] = q;
    }
    return { items };
  }

  /* ---------- 纹样版本库 ---------- */
  function renderPatterns(state) {
    $("#patternList").innerHTML = state.patterns.map(p =>
      `<div class="row-line"><span>${esc(p.no)} / ${esc(p.version)} · ${p.cols}×${p.rows} · ${p.savedAt}</span><button data-no="${esc(p.no)}" data-ver="${esc(p.version)}" data-act="loadpat">载入排版台</button></div>`).join("")
      || '<p class="muted">暂无纹样</p>';
  }

  function renderStation(state) {
    renderSummary(state);
    renderScheduleForm(state);
    renderOrders(state);
    renderStock(state);
    renderReqs(state);
    renderPatterns(state);
  }

  /* ---------- 事件：排机登记 ---------- */
  $("#schBtn").onclick = () => {
    const v = $("#schPattern").value;
    const idx = v.indexOf("|");
    const res = S.schedule({
      patternNo: v.slice(0, idx), version: v.slice(idx + 1),
      loomNo: $("#schLoom").value, warpBatchId: $("#schBatch").value,
      requisitionId: $("#schReq").value, dueDate: $("#schDue").value,
    });
    stationMsg(res.message, res.ok);
  };

  /* ---------- 事件：工单操作（录试织 / 复核 / 解冻 / 补料上架 / 关机） ---------- */
  let trialOrderId = null;
  $("#orderList").addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    let res = null;
    if (btn.dataset.act === "trial") {
      trialOrderId = id;
      $("#trialOrder").textContent = id;
      $("#trialForm").hidden = false;
      $("#tfBreaks").focus();
      return;
    }
    if (btn.dataset.act === "pass") res = S.reviewOrder(id, true);
    if (btn.dataset.act === "reject") res = S.reviewOrder(id, false);
    if (btn.dataset.act === "unfreeze") res = S.unfreezeOrder(id);
    if (btn.dataset.act === "recheck") res = S.recheckOrder(id);
    if (btn.dataset.act === "close") res = S.closeOrder(id);
    if (res) stationMsg(res.message, res.ok);
  });
  $("#tfCancel").onclick = () => { $("#trialForm").hidden = true; trialOrderId = null; };
  $("#tfSubmit").onclick = () => {
    const res = S.recordTrial(trialOrderId, {
      breaks: Number($("#tfBreaks").value),
      warpDensity: Number($("#tfWarp").value),
      weftDensity: Number($("#tfWeft").value),
      sample: $("#tfSample").value,
    });
    stationMsg(res.message, res.ok);
    if (res.ok) { $("#trialForm").hidden = true; trialOrderId = null; }
  };

  /* ---------- 事件：色线入库 / 领用单更正、撤换 ---------- */
  $("#stockBtn").onclick = () => {
    const res = S.replenishStock(Number($("#stockColor").value), Number($("#stockQty").value));
    stationMsg(res.message, res.ok);
  };
  $("#reqList").addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const reqId = btn.dataset.req;
    const parsed = parseItems($(`input[data-items="${reqId}"]`).value);
    if (parsed.error) { stationMsg(parsed.error, false); return; }
    const res = btn.dataset.act === "correct" ? S.correctRequisition(reqId, parsed.items) : S.replaceRequisition(reqId, parsed.items);
    stationMsg(res.message, res.ok);
  });

  /* ---------- 事件：纹样库载入排版台 ---------- */
  $("#patternList").addEventListener("click", e => {
    const btn = e.target.closest("[data-act='loadpat']");
    if (!btn) return;
    const p = S.getState().patterns.find(x => x.no === btn.dataset.no && x.version === btn.dataset.ver);
    if (p) { loadPatternIntoDesigner(p); switchTab("design"); designMsg(`已载入纹样 ${p.no} / ${p.version}`, true); }
  });

  /* ---------- 页签与重置 ---------- */
  function switchTab(which) {
    $("#designTab").hidden = which !== "design";
    $("#stationTab").hidden = which !== "station";
    $("#tabDesignBtn").classList.toggle("secondary", which !== "design");
    $("#tabStationBtn").classList.toggle("secondary", which !== "station");
  }
  $("#tabDesignBtn").onclick = () => switchTab("design");
  $("#tabStationBtn").onclick = () => switchTab("station");
  $("#resetBtn").onclick = () => {
    if (confirm("清空全部排机与复核数据，恢复演示初始状态？")) { S.reset(); stationMsg("已重置为演示数据", true); }
  };

  /* ---------- 初始化 ---------- */
  $("#stockColor").innerHTML = COLORS.map((c, i) => `<option value="${i}">色线${i} ${COLOR_NAMES[i]}</option>`).join("");
  $("#limBreaks").textContent = R.LIMITS.maxBreaks;
  $("#limWarp").textContent = `${R.LIMITS.warpDensity.min}~${R.LIMITS.warpDensity.max}`;
  $("#limWeft").textContent = `${R.LIMITS.weftDensity.min}~${R.LIMITS.weftDensity.max}`;
  $("#schDue").min = S.today();
  const due = new Date(); due.setDate(due.getDate() + 7);
  $("#schDue").value = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  S.subscribe(renderStation);
  renderStation(S.getState());
  renderDesigner();
})();
