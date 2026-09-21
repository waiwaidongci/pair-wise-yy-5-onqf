/* 页面展示模块：只负责渲染与交互。
   业务规则一律调用 WeaveRules，数据存取一律经过 WeaveStore，
   每次变更后整页重绘，保证页面汇总与重载后的状态一致。 */
(() => {
  const COLORS = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437", "#355b38", "#713d7b", "#1e1b18", "#e98c52"];
  const STATUS = WeaveRules.STATUS;
  const STATUS_CLASS = { PENDING_MATERIAL: "b-pend", RUNNING: "b-run", PENDING_REVIEW: "b-rev", REWORK: "b-rework", FROZEN: "b-frozen", QUALIFIED: "b-ok" };
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = () => WeaveStore.get();

  let noticeTimer = null;
  function say(msg, err) {
    const n = $("#notice");
    n.textContent = msg;
    n.hidden = false;
    n.classList.toggle("err", !!err);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { n.hidden = true; }, 6000);
  }

  // 变更统一入口：规则计算 → 落库 → 提示 → 重绘
  function act(fn) {
    const r = WeaveStore.update(fn);
    if (r && r.message) say(r.message, r.ok === false);
    renderAll();
    return r;
  }

  /* ---------------- 纹样排版（原有画布） ---------------- */
  const grid = $("#grid"), palette = $("#palette"), stats = $("#stats"), preview = $("#preview"), risk = $("#risk");
  let cols = 18, rows = 14, active = 1, block = "dot", dragging = false;
  let cells = [], undo = [], redo = [];

  function initEditor(loadSaved = true) {
    const saved = loadSaved && JSON.parse(localStorage.getItem("zfl31Pattern") || "null");
    if (saved) { cols = saved.cols; rows = saved.rows; cells = saved.cells; }
    else { cols = Number($("#cols").value); rows = Number($("#rows").value); cells = Array(cols * rows).fill(0); }
    $("#cols").value = cols;
    $("#rows").value = rows;
    renderEditor();
  }

  function renderEditor() {
    palette.innerHTML = COLORS.map((c, i) => '<button class="swatch ' + (i === active ? "active" : "") + '" data-color="' + i + '" style="background:' + c + '"></button>').join("");
    palette.querySelectorAll("[data-color]").forEach(el => el.onclick = () => { active = Number(el.dataset.color); renderEditor(); });
    grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    grid.innerHTML = cells.map((v, i) => '<div class="cell" data-i="' + i + '" style="background:' + COLORS[v] + '"></div>').join("");
    grid.querySelectorAll(".cell").forEach(el => {
      el.onpointerdown = () => { dragging = true; paint(Number(el.dataset.i)); };
      el.onpointerenter = () => { if (dragging) paint(Number(el.dataset.i)); };
    });
    window.onpointerup = () => { dragging = false; };
    renderEditorStats();
  }

  function snapshot() { undo.push([...cells]); redo = []; if (undo.length > 50) undo.shift(); }
  function paint(i) {
    snapshot();
    patternCells(i).forEach(t => { if (t >= 0 && t < cells.length) cells[t] = active; });
    renderEditor();
  }
  function patternCells(i) {
    const x = i % cols, y = Math.floor(i / cols);
    if (block === "cross") return [i, idx(x - 1, y), idx(x + 1, y), idx(x, y - 1), idx(x, y + 1)].filter(v => v !== null);
    if (block === "diamond") return [idx(x, y - 1), idx(x - 1, y), i, idx(x + 1, y), idx(x, y + 1)].filter(v => v !== null);
    return [i];
  }
  function idx(x, y) { return x < 0 || x >= cols || y < 0 || y >= rows ? null : y * cols + x; }

  function renderEditorStats() {
    const counts = COLORS.map((_, i) => cells.filter(v => v === i).length);
    stats.innerHTML = counts.map((n, i) => '<div class="stat"><span><span class="sw" style="background:' + COLORS[i] + '"></span>色线' + i + '</span><b>' + n + '</b></div>').join("");
    preview.innerHTML = Array.from({ length: 36 }, (_, i) => '<div class="mini" style="background:' + COLORS[cells[(i % 6) + Math.floor(i / 6) * cols] || 0] + '"></div>').join("");
    const riskRows = [];
    for (let y = 0; y < rows; y++) {
      let switches = 0;
      for (let x = 1; x < cols; x++) if (cells[y * cols + x] !== cells[y * cols + x - 1]) switches++;
      if (switches > cols * 0.62) riskRows.push(y + 1);
    }
    risk.innerHTML = riskRows.length ? '<p class="warn">第' + riskRows.join("、") + '行换色过密，可能断线。</p>' : "<p>暂无明显断线风险。</p>";
  }

  /* ---------------- 各面板渲染 ---------------- */
  const badge = st => '<span class="badge ' + STATUS_CLASS[st] + '">' + STATUS[st] + "</span>";

  function renderPatterns() {
    const s = S();
    $("#patternList").innerHTML = s.patterns.length ? s.patterns.map(p =>
      '<div class="row"><span><b>' + esc(p.id) + "</b> · " + esc(p.version) + '<br><span class="muted">' + p.cols + "×" + p.rows + " · " + p.savedAt.slice(0, 10) + '</span></span>' +
      '<span class="acts"><button class="small secondary" data-load="' + esc(p.id) + "|" + esc(p.version) + '">载入画布</button></span></div>'
    ).join("") : '<p class="muted">纹样库为空</p>';
  }

  function renderLooms() {
    const s = S();
    $("#loomList").innerHTML = s.looms.map(l => {
      const o = l.occupiedBy && s.orders.find(x => x.id === l.occupiedBy);
      return '<div class="row"><span><b>' + l.id + "</b> " + (o ? '<span class="muted">占用 ' + o.id + "（" + STATUS[o.status] + "）</span>" : '<span class="muted">空闲</span>') + "</span>" +
        "<span class=\"acts\">" + (o ? '<button class="small secondary" data-shutdown="' + l.id + '">关机</button>' : "") + "</span></div>";
    }).join("");
  }

  function renderBatches() {
    const s = S();
    const t = WeaveRules.today();
    $("#batchList").innerHTML = s.batches.map(b =>
      '<div class="row"><span><b>' + esc(b.id) + '</b> <span class="muted">有效期至 ' + b.expiresOn + '</span></span>' +
      '<span class="badge ' + (b.expiresOn < t ? "b-rework" : "b-ok") + '">' + (b.expiresOn < t ? "已过期" : "有效") + "</span></div>"
    ).join("");
  }

  function renderStock() {
    const s = S();
    $("#stockList").innerHTML = COLORS.map((c, i) =>
      '<div class="row"><span><span class="sw" style="background:' + c + '"></span>色线' + i + ' <span class="muted">余 ' + (s.stock[i] || 0) + '</span></span>' +
      '<span class="acts inline"><input type="number" min="1" value="50" id="stockIn' + i + '"><button class="small" data-stock="' + i + '">补料</button></span></div>'
    ).join("");
  }

  let reqEdit = null; // {mode:'new'|'correct'|'replace', reqId}
  function renderReqs() {
    const s = S();
    $("#reqList").innerHTML = s.requisitions.map(r => {
      const lines = Object.keys(r.lines).filter(k => r.lines[k] > 0).map(k => "色" + k + ":" + r.lines[k]).join(" ") || "—";
      const head = r.status === "active" ? "<b>" + r.id + "</b> · 第" + r.revision + "版 · 生效中" : "<b>" + r.id + "</b> · 已撤换→" + r.replacedBy;
      const acts = r.status === "active"
        ? '<button class="small secondary" data-req-edit="correct|' + r.id + '">更正</button><button class="small secondary" data-req-edit="replace|' + r.id + '">撤换</button>'
        : "";
      return '<div class="row"><span>' + head + '<br><span class="muted">' + lines + '</span></span><span class="acts">' + acts + "</span></div>";
    }).join("");
    renderReqEditor();
  }

  function renderReqEditor() {
    const ed = $("#reqEditor");
    if (!reqEdit) { ed.hidden = true; return; }
    const req = reqEdit.reqId && S().requisitions.find(r => r.id === reqEdit.reqId);
    const titles = { new: "新建领用单", correct: "更正 " + reqEdit.reqId, replace: "撤换 " + reqEdit.reqId + "（生成新单，旧单作废）" };
    $("#reqEditorTitle").textContent = titles[reqEdit.mode];
    $("#reqLines").innerHTML = COLORS.map((c, i) => {
      const v = req && req.lines[i] || 0;
      return '<label style="margin:0"><span class="sw" style="background:' + c + '"></span>色线' + i + '<input type="number" min="0" value="' + v + '" id="reqLine' + i + '"></label>';
    }).join("");
    ed.hidden = false;
  }

  function fillSelect(sel, html, keep) {
    const prev = keep ? sel.value : "";
    sel.innerHTML = html;
    if (keep && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  function renderScheduleForm() {
    const s = S();
    fillSelect($("#schPattern"),
      s.patterns.map(p => '<option value="' + esc(p.id) + "|" + esc(p.version) + '">' + esc(p.id) + " · " + esc(p.version) + "（" + p.cols + "×" + p.rows + "）</option>").join("") || "<option value=''>（纹样库为空）</option>", true);
    fillSelect($("#schLoom"), s.looms.map(l => '<option value="' + l.id + '">' + l.id + (l.occupiedBy ? "（占用中）" : "") + "</option>").join(""), true);
    fillSelect($("#schBatch"), s.batches.map(b => '<option value="' + esc(b.id) + '">' + esc(b.id) + "（至" + b.expiresOn + "）</option>").join(""), true);
    fillSelect($("#schReq"),
      s.requisitions.filter(r => r.status === "active").map(r => '<option value="' + r.id + '">' + r.id + "（第" + r.revision + "版）</option>").join("") || "<option value=''>（无生效领用单）</option>", true);
  }

  function renderPending() {
    const list = S().orders.filter(o => o.status === "PENDING_MATERIAL");
    $("#pendingList").innerHTML = list.length ? list.map(o =>
      '<div class="row"><span><b>' + o.id + "</b> · " + esc(o.patternId) + " " + esc(o.version) + " → " + o.loomId + '<br><span class="warn">' + o.pendingReasons.join("；") + '</span></span>' +
      '<span class="acts"><button class="small secondary" data-act="recheck" data-id="' + o.id + '">重检补料</button></span></div>'
    ).join("") : '<p class="muted">暂无待补料工单</p>';
  }

  let recordingId = null;
  function orderActions(o) {
    switch (o.status) {
      case "RUNNING": return '<button class="small" data-act="record" data-id="' + o.id + '">录入记录</button>';
      case "PENDING_REVIEW": return '<button class="small" data-act="pass" data-id="' + o.id + '">复核通过</button> <button class="small secondary" data-act="reject" data-id="' + o.id + '">退回返修</button>';
      case "REWORK": return '<button class="small" data-act="rework" data-id="' + o.id + '">返修开工</button>';
      case "QUALIFIED": return '<button class="small secondary" data-act="shutdown" data-id="' + o.id + '">织机关机</button>';
      case "PENDING_MATERIAL": return '<button class="small secondary" data-act="recheck" data-id="' + o.id + '">重检补料</button>';
      case "FROZEN": return '<span class="muted">待' + o.freezeCause + "返修合格</span>";
      default: return "";
    }
  }

  function recordFormRow(o) {
    const L = WeaveRules.LIMITS;
    return '<tr class="subrow"><td colspan="9"><div class="inline" style="flex-wrap:wrap">' +
      "<span>录入 <b>" + o.id + "</b> 试织记录：</span>" +
      '<label style="margin:0">断线次数<input type="number" id="recBreaks" min="0" value="0" style="width:70px"></label>' +
      '<label style="margin:0">经密<input type="number" id="recWarp" min="0" value="40" style="width:70px"></label>' +
      '<label style="margin:0">纬密<input type="number" id="recWeft" min="0" value="30" style="width:70px"></label>' +
      '<label style="margin:0">样片结果<select id="recSample" style="width:90px"><option>合格</option><option>不合格</option></select></label>' +
      '<button class="small" data-act="submit-record" data-id="' + o.id + '">提交记录</button>' +
      '<button class="small secondary" data-act="cancel-record">取消</button>' +
      '<span class="muted">断线≤' + L.maxBreaks + "，经密" + L.warpMin + "-" + L.warpMax + "，纬密" + L.weftMin + "-" + L.weftMax + "；超限只能返修</span>" +
      "</div></td></tr>";
  }

  function renderOrders() {
    const s = S();
    const tb = $("#orderTable tbody");
    if (!s.orders.length) { tb.innerHTML = '<tr><td colspan="9" class="muted">暂无工单</td></tr>'; return; }
    tb.innerHTML = s.orders.map(o => {
      const resCell = o.result
        ? "断" + o.result.breaks + " · 经" + o.result.warp + " · 纬" + o.result.weft + " · " + o.result.sample
        : (o.status === "QUALIFIED" && o.conclusion ? '<span class="muted">合格于' + o.conclusion.at.slice(0, 10) + "</span>" : '<span class="muted">—</span>');
      const stCell = badge(o.status) +
        (o.status === "PENDING_MATERIAL" ? '<br><span class="warn">' + o.pendingReasons.join("；") + "</span>" : "") +
        (o.status === "FROZEN" ? '<br><span class="muted">因' + o.freezeCause + "超限冻结</span>" : "") +
        (o.invalidations.length ? '<br><span class="muted">失效重算' + o.invalidations.length + "次</span>" : "");
      return "<tr><td><b>" + o.id + "</b><br><span class=\"muted\">" + o.createdAt.slice(0, 10) + "</span></td>" +
        "<td>" + esc(o.patternId) + " · " + esc(o.version) + "</td><td>" + o.loomId + "</td><td>" + esc(o.batchId) + "</td><td>" + o.requisitionId + "</td><td>" + o.expectedDate + "</td>" +
        "<td>" + stCell + "</td><td>" + resCell + "</td><td>" + orderActions(o) + "</td></tr>" +
        (recordingId === o.id ? recordFormRow(o) : "");
    }).join("");
  }

  function renderArchives() {
    const s = S();
    $("#archiveList").innerHTML = s.archives.length ? s.archives.slice().reverse().map(a => {
      const r = a.snapshot.result;
      const detail = r ? "断线" + r.breaks + " · 经密" + r.warp + " · 纬密" + r.weft + " · 样片" + r.sample : (a.snapshot.conclusion ? "合格结论" : "—");
      return '<div class="row"><span><b>' + a.orderId + "</b> · " + (a.kind === "result" ? "试织结果留档" : "排机与结论失效") + " · " + esc(a.reason) +
        '<br><span class="muted">' + detail + '</span></span><span class="muted">' + a.at.slice(0, 16).replace("T", " ") + "</span></div>";
    }).join("") : '<p class="muted">暂无留档</p>';
  }

  function renderSummary() {
    const s = S();
    const st = WeaveRules.computeStats(s);
    $("#statusCards").innerHTML = Object.keys(STATUS).map(k =>
      '<div class="card"><span class="badge ' + STATUS_CLASS[k] + '">' + STATUS[k] + "</span><b>" + (st.byStatus[k] || 0) + "</b></div>").join("");
    $("#qualStats").innerHTML =
      '<div class="stat"><span>合格工单（计入合格统计）</span><b>' + st.qualifiedCount + "</b></div>" +
      '<div class="stat"><span>留档记录（不计入合格统计）</span><b>' + st.archivedCount + "</b></div>" +
      (st.qualified.length
        ? st.qualified.map(o => '<div class="stat"><span>' + o.id + " · " + esc(o.patternId) + " " + esc(o.version) + '</span><span class="muted">' + o.conclusion.at.slice(0, 10) + "</span></div>").join("")
        : '<p class="muted">暂无合格工单</p>');
    $("#sumStock").innerHTML = COLORS.map((c, i) => {
      const q = s.stock[i] || 0;
      return '<div class="stat"><span><span class="sw" style="background:' + c + '"></span>色线' + i + "</span><b>" + q + '</b></div><div class="bar"><i style="width:' + Math.min(100, Math.round(q / 6)) + '%"></i></div>';
    }).join("");
    $("#sumLooms").innerHTML = s.looms.map(l => {
      const o = l.occupiedBy && s.orders.find(x => x.id === l.occupiedBy);
      return '<div class="stat"><span>' + l.id + "</span><span>" + (o ? o.id + "（" + STATUS[o.status] + "）" : "空闲") + "</span></div>";
    }).join("");
    $("#logList").innerHTML = s.log.slice(0, 30).map(e =>
      '<div class="stat"><span>' + esc(e.msg) + '</span><span class="muted">' + e.at.slice(5, 16).replace("T", " ") + "</span></div>").join("");
  }

  function renderAll() {
    renderPatterns();
    renderLooms();
    renderBatches();
    renderStock();
    renderReqs();
    renderScheduleForm();
    renderPending();
    renderOrders();
    renderArchives();
    renderSummary();
  }

  /* ---------------- 事件绑定 ---------------- */
  function newRequestKey() { return "RK-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
  let currentRequestKey = newRequestKey();

  $("#tabs").addEventListener("click", e => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    $$("#tabs button").forEach(x => x.classList.toggle("active", x === b));
    $$(".tab").forEach(sec => sec.classList.toggle("active", sec.id === "tab-" + b.dataset.tab));
    renderAll();
  });

  // 画布
  document.querySelectorAll("[data-block]").forEach(btn => btn.onclick = () => { block = btn.dataset.block; });
  $("#newBtn").onclick = () => { undo = []; redo = []; initEditor(false); };
  $("#undoBtn").onclick = () => { if (!undo.length) return; redo.push([...cells]); cells = undo.pop(); renderEditor(); };
  $("#redoBtn").onclick = () => { if (!redo.length) return; undo.push([...cells]); cells = redo.pop(); renderEditor(); };
  $("#draftBtn").onclick = () => { localStorage.setItem("zfl31Pattern", JSON.stringify({ cols, rows, cells })); say("画布草稿已保存"); };
  $("#exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(S(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "brocade-bench.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("#savePatternBtn").onclick = () => {
    const id = $("#patId").value.trim(), version = $("#patVer").value.trim();
    act(s => WeaveRules.savePattern(s, { id, version, cols, rows, cells: [...cells] }));
  };
  $("#patternList").addEventListener("click", e => {
    const b = e.target.closest("[data-load]");
    if (!b) return;
    const v = b.dataset.load, i = v.lastIndexOf("|");
    const p = S().patterns.find(x => x.id === v.slice(0, i) && x.version === v.slice(i + 1));
    if (!p) return;
    cols = p.cols; rows = p.rows; cells = [...p.cells]; undo = []; redo = [];
    $("#cols").value = cols; $("#rows").value = rows;
    renderEditor();
    say("已载入纹样" + p.id + " " + p.version);
  });

  // 基础资料
  $("#addLoomBtn").onclick = () => act(s => WeaveRules.addLoom(s));
  $("#loomList").addEventListener("click", e => {
    const b = e.target.closest("[data-shutdown]");
    if (b) act(s => WeaveRules.shutdownLoom(s, b.dataset.shutdown));
  });
  $("#addBatchBtn").onclick = () => {
    act(s => WeaveRules.addBatch(s, $("#batchId").value.trim(), $("#batchExp").value));
  };
  $("#stockList").addEventListener("click", e => {
    const b = e.target.closest("[data-stock]");
    if (!b) return;
    const i = Number(b.dataset.stock);
    act(s => WeaveRules.addStock(s, i, Number($("#stockIn" + i).value)));
  });

  // 领用单
  $("#newReqBtn").onclick = () => { reqEdit = { mode: "new" }; renderReqs(); };
  $("#reqCancelBtn").onclick = () => { reqEdit = null; renderReqs(); };
  $("#reqList").addEventListener("click", e => {
    const b = e.target.closest("[data-req-edit]");
    if (!b) return;
    const [mode, reqId] = b.dataset.reqEdit.split("|");
    reqEdit = { mode, reqId };
    renderReqs();
  });
  $("#reqSaveBtn").onclick = () => {
    const lines = {};
    COLORS.forEach((_, i) => { lines[i] = Math.max(0, Number($("#reqLine" + i).value) || 0); });
    const { mode, reqId } = reqEdit;
    act(s => mode === "new" ? WeaveRules.createRequisition(s, lines)
      : mode === "correct" ? WeaveRules.correctRequisition(s, reqId, lines)
      : WeaveRules.replaceRequisition(s, reqId, lines));
    reqEdit = null;
    renderAll();
  };

  // 排机登记
  $("#admitBtn").onclick = () => {
    const pv = $("#schPattern").value;
    if (!pv) return say("纹样库为空，请先在排版台保存纹样", true);
    const i = pv.lastIndexOf("|");
    const r = act(s => WeaveRules.admit(s, {
      requestKey: currentRequestKey,
      patternId: pv.slice(0, i),
      version: pv.slice(i + 1),
      loomId: $("#schLoom").value,
      batchId: $("#schBatch").value,
      requisitionId: $("#schReq").value,
      expectedDate: $("#schDate").value
    }));
    currentRequestKey = newRequestKey();
    return r;
  };

  // 工单操作（复核台 + 待补料列表共用）
  function doRecheck() {
    act(s => {
      const changed = WeaveRules.recheckPending(s);
      return { ok: true, message: changed.length ? "补料到位，转进行中：" + changed.map(o => o.id).join("、") : "条件仍不足，保持待补料" };
    });
  }
  $("#pendingList").addEventListener("click", e => {
    if (e.target.closest('[data-act="recheck"]')) doRecheck();
  });
  $("#orderTable").addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.dataset.id, name = btn.dataset.act;
    if (name === "record") { recordingId = id; renderOrders(); }
    else if (name === "cancel-record") { recordingId = null; renderOrders(); }
    else if (name === "submit-record") {
      const rec = { breaks: Number($("#recBreaks").value), warp: Number($("#recWarp").value), weft: Number($("#recWeft").value), sample: $("#recSample").value };
      if ([rec.breaks, rec.warp, rec.weft].some(v => isNaN(v) || v < 0)) return say("断线次数与经纬密度必须为非负数值", true);
      recordingId = null;
      act(s => WeaveRules.record(s, id, rec));
    }
    else if (name === "pass") act(s => WeaveRules.review(s, id, true));
    else if (name === "reject") act(s => WeaveRules.review(s, id, false));
    else if (name === "rework") act(s => WeaveRules.startRework(s, id));
    else if (name === "shutdown") {
      const o = S().orders.find(x => x.id === id);
      if (o) act(s => WeaveRules.shutdownLoom(s, o.loomId));
    }
    else if (name === "recheck") doRecheck();
  });

  // 汇总
  $("#resetBtn").onclick = () => {
    if (!confirm("确定重置全部数据？此操作不可恢复。")) return;
    WeaveStore.reset();
    renderAll();
    say("已重置为初始数据");
  };

  /* ---------------- 启动 ---------------- */
  WeaveStore.load();
  initEditor(true);
  $("#schDate").value = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  renderAll();
})();
