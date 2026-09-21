/* ============================================================
 * 记录存储模块（store.js）
 * 唯一事实来源：负责 localStorage 持久化与全部状态变更。
 * 所有业务判定委托规则模块（BrocadeRules），本模块只做
 * 状态读写、序号发放与变更通知；页面刷新后由本模块恢复状态。
 * ============================================================ */
window.BrocadeStore = (() => {
  const R = window.BrocadeRules;
  const KEY = "zfl31.station.v1";
  let state = null;
  const listeners = [];

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  /* ---------- 演示初始数据 ---------- */
  function seed() {
    const cells = (cols, rows, fn) => Array.from({ length: cols * rows }, (_, i) => fn(i % cols, Math.floor(i / cols)));
    return {
      patterns: [
        { no: "P-1001", version: "v1.0", cols: 12, rows: 10, cells: cells(12, 10, (x, y) => ((x + y) % 4 === 0 ? 1 : 0)), savedAt: "2026-09-10" },
        { no: "P-1001", version: "v2.0", cols: 12, rows: 10, cells: cells(12, 10, (x, y) => (x % 3 === 0 || y % 3 === 0 ? 2 : 0)), savedAt: "2026-09-15" },
        { no: "P-1002", version: "v1.0", cols: 10, rows: 10, cells: cells(10, 10, (x, y) => (x === y || x + y === 9 ? 3 : 0)), savedAt: "2026-09-12" },
      ],
      looms: [{ no: "L-01" }, { no: "L-02" }, { no: "L-03" }],
      warpBatches: [
        { id: "W-2026A", expiry: "2027-03-31" },
        { id: "W-2025B", expiry: "2026-08-31" }, // 已过期（演示待补料）
        { id: "W-2026C", expiry: "2026-12-15" },
      ],
      // 色线库存（色号与排版台色板一致）；色线5 库存仅 3（演示不足）
      stocks: [0, 1, 2, 3, 4, 5, 6, 7].map(c => ({ color: c, qty: [40, 30, 25, 20, 18, 3, 12, 16][c] })),
      requisitions: [
        { id: "RQ-001", items: { "1": 6, "2": 4 }, status: "有效", revision: 1, replacedBy: null },
        { id: "RQ-002", items: { "5": 8 }, status: "有效", revision: 1, replacedBy: null }, // 色线5需8仅3 → 待补料
        { id: "RQ-003", items: { "0": 10, "3": 5 }, status: "有效", revision: 1, replacedBy: null },
      ],
      orders: [
        // 已在织工单：演示「织机未关机不得承接第二个任务」与「重复排机沿用首次工单」
        {
          id: "GD-0001", requestKey: "P-1001|v1.0|L-01", patternNo: "P-1001", version: "v1.0",
          loomNo: "L-01", warpBatchId: "W-2026A", requisitionId: "RQ-001", dueDate: "2026-09-30",
          status: "在织", holdReasons: [], note: "", createdAt: "2026-09-15", closedAt: null, conclusionInvalid: false,
        },
      ],
      trials: [],
      seq: { order: 2, trial: 1, req: 4 },
    };
  }

  /* ---------- 持久化 ---------- */
  function load() {
    try { state = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { state = null; }
    if (!state || !Array.isArray(state.orders) || !Array.isArray(state.trials)) state = seed();
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
  function commit() { save(); listeners.forEach(fn => fn(state)); }

  const getState = () => state;
  const subscribe = fn => { listeners.push(fn); };
  const findOrder = id => state.orders.find(o => o.id === id) || null;

  /* ---------- 纹样登记：编号 + 版本唯一 ---------- */
  function registerPattern({ no, version, cols, rows, cells }) {
    no = String(no || "").trim();
    version = String(version || "").trim();
    if (!no || !version) return { ok: false, message: "纹样编号与版本必填" };
    if (R.findPattern(state.patterns, no, version))
      return { ok: false, message: `纹样 ${no} / ${version} 已存在：编号+版本须唯一，请升版本` };
    state.patterns.push({ no, version, cols, rows, cells: [...cells], savedAt: today() });
    commit();
    return { ok: true, message: `纹样 ${no} / ${version} 已登记入库` };
  }

  /* ---------- 排机登记 ----------
   * 登记织机号、经线批次、色线领用单、预计完成日；
   * 重复/并发排机沿用首次工单；织机未关机不得承接第二个任务；
   * 色线不足或批次过期只存待补料，不占织机。 */
  function schedule({ patternNo, version, loomNo, warpBatchId, requisitionId, dueDate }) {
    if (!R.findPattern(state.patterns, patternNo, version))
      return { ok: false, message: `纹样 ${patternNo} / ${version} 未登记，不能排机` };
    if (!dueDate) return { ok: false, message: "请填写预计完成日" };
    const requestKey = `${patternNo}|${version}|${loomNo}`;
    // 重复或并发排机：请求键相同的存活工单直接沿用首次工单（提交同步串行，并发以首次为准）
    const dup = R.findLiveOrderByKey(state.orders, requestKey);
    if (dup) return { ok: true, reused: true, order: dup, message: `重复/并发排机，沿用首次工单 ${dup.id}（${dup.status}）` };
    // 同一织机未关机不得承接第二个试织任务（待补料不占机）
    const busy = R.activeOrderOnLoom(state.orders, loomNo);
    if (busy) return { ok: false, message: `织机${loomNo}未关机（工单${busy.id} ${busy.status}），不得承接第二个试织任务` };
    const evalRes = R.evaluateMaterials(state, { warpBatchId, requisitionId }, null, today());
    if (evalRes.fatal) return { ok: false, message: evalRes.reasons.join("；") };
    const order = {
      id: "GD-" + String(state.seq.order++).padStart(4, "0"),
      requestKey, patternNo, version, loomNo, warpBatchId, requisitionId, dueDate,
      status: evalRes.ok ? "在织" : "待补料",
      holdReasons: evalRes.reasons, note: "", createdAt: today(), closedAt: null, conclusionInvalid: false,
    };
    state.orders.push(order);
    commit();
    return {
      ok: true, reused: false, order,
      message: evalRes.ok
        ? `工单 ${order.id} 已上机（在织），预计 ${dueDate} 完成`
        : `工单 ${order.id} 登记为待补料（不占织机）：${evalRes.reasons.join("；")}`,
    };
  }

  /* ---------- 录入试织记录：断线次数、经纬密度、样片结果 ---------- */
  function recordTrial(orderId, { breaks, warpDensity, weftDensity, sample }) {
    const order = findOrder(orderId);
    if (!order) return { ok: false, message: "工单不存在" };
    if (!["在织", "返修"].includes(order.status))
      return { ok: false, message: `工单 ${orderId} 当前为「${order.status}」，不能录入试织` };
    if (![breaks, warpDensity, weftDensity].every(Number.isFinite))
      return { ok: false, message: "断线次数与经纬密度须为数字" };
    // 旧结果留档，不计入合格统计
    state.trials.filter(t => t.orderId === orderId && !t.archived)
      .forEach(t => { t.archived = true; t.note = "新试织录入，旧结果留档"; });
    const evalRes = R.evaluateTrial({ breaks, warpDensity, weftDensity });
    const trial = {
      id: "SJ-" + String(state.seq.trial++).padStart(4, "0"),
      orderId, breaks, warpDensity, weftDensity, sample: sample || "合格",
      verdict: evalRes.verdict, reasons: evalRes.reasons, archived: false, note: "", createdAt: today(),
    };
    state.trials.push(trial);
    let extra = "";
    if (evalRes.verdict === "返修") {
      // 断线或密度超限：只能返修；相关（同纹样编号+版本）待复核试织冻结
      order.status = "返修";
      const related = state.orders.filter(o =>
        o.id !== orderId && o.patternNo === order.patternNo && o.version === order.version && o.status === "待复核");
      related.forEach(o => {
        o.status = "冻结";
        state.trials.filter(t => t.orderId === o.id && !t.archived && t.verdict === "待复核")
          .forEach(t => { t.verdict = "冻结"; });
      });
      if (related.length) extra = `；已冻结相关待复核工单：${related.map(o => o.id).join("、")}`;
    } else {
      order.status = "待复核";
    }
    commit();
    return {
      ok: true,
      message: evalRes.verdict === "返修"
        ? `试织 ${trial.id} 超限（${evalRes.reasons.join("；")}），只能返修${extra}`
        : `试织 ${trial.id} 已录入，工单 ${orderId} 待复核`,
    };
  }

  /* ---------- 复核：通过 → 合格；退回 → 返修 ---------- */
  function reviewOrder(orderId, pass) {
    const order = findOrder(orderId);
    if (!order || order.status !== "待复核") return { ok: false, message: `工单 ${orderId} 不在待复核状态` };
    const trial = state.trials.find(t => t.orderId === orderId && !t.archived);
    if (!trial || trial.verdict !== "待复核") return { ok: false, message: "无待复核的试织记录" };
    trial.verdict = pass ? "合格" : "返修";
    order.status = pass ? "合格" : "返修";
    commit();
    return { ok: true, message: pass ? `工单 ${orderId} 复核合格` : `工单 ${orderId} 退回返修` };
  }

  /* ---------- 解冻：冻结 → 待复核 ---------- */
  function unfreezeOrder(orderId) {
    const order = findOrder(orderId);
    if (!order || order.status !== "冻结") return { ok: false, message: `工单 ${orderId} 不在冻结状态` };
    order.status = "待复核";
    state.trials.filter(t => t.orderId === orderId && !t.archived && t.verdict === "冻结")
      .forEach(t => { t.verdict = "待复核"; });
    commit();
    return { ok: true, message: `工单 ${orderId} 已解冻，恢复待复核` };
  }

  /* ---------- 关机：结束任务并释放织机 ---------- */
  function closeOrder(orderId) {
    const order = findOrder(orderId);
    if (!order || !["合格", "返修"].includes(order.status))
      return { ok: false, message: `工单 ${orderId} 当前为「${order ? order.status : "无"}」，须合格或返修后方可关机` };
    order.status = "已关机";
    order.closedAt = today();
    commit();
    return { ok: true, message: `工单 ${orderId} 已关机，织机 ${order.loomNo} 释放` };
  }

  /* ---------- 待补料复核：补料到位后上机 ---------- */
  function recheckOrder(orderId) {
    const order = findOrder(orderId);
    if (!order || order.status !== "待补料") return { ok: false, message: `工单 ${orderId} 不在待补料状态` };
    const evalRes = R.evaluateMaterials(state, { warpBatchId: order.warpBatchId, requisitionId: order.requisitionId }, order.id, today());
    if (!evalRes.ok) {
      order.holdReasons = evalRes.reasons;
      commit();
      return { ok: false, message: `工单 ${orderId} 仍待补料：${evalRes.reasons.join("；")}` };
    }
    const busy = R.activeOrderOnLoom(state.orders, order.loomNo, order.id);
    if (busy) {
      order.holdReasons = [`织机被工单${busy.id}占用`];
      commit();
      return { ok: false, message: `织机 ${order.loomNo} 被工单 ${busy.id} 占用，暂不能上机` };
    }
    order.status = "在织";
    order.holdReasons = [];
    order.note = "补料完成，已上机";
    commit();
    return { ok: true, message: `工单 ${orderId} 补料完成，已上机在织` };
  }

  /* ---------- 色线入库 ---------- */
  function replenishStock(color, qty) {
    const s = state.stocks.find(x => x.color === color);
    if (!s || !Number.isInteger(qty) || qty <= 0) return { ok: false, message: "入库数量无效" };
    s.qty += qty;
    commit();
    return { ok: true, message: `色线${color} 入库 ${qty}，现库存 ${s.qty}` };
  }

  /* ---------- 领用单更正 / 撤换：关联排机与合格结论立即失效并重算 ---------- */
  function cascadeRequisitionChange(requisitionId, label) {
    state.orders.filter(o => o.requisitionId === requisitionId).forEach(o => {
      // 合格结论与试织结果立即失效：留档，不计入统计
      state.trials.filter(t => t.orderId === o.id && !t.archived)
        .forEach(t => { t.archived = true; t.note = `${label}，结论失效留档`; });
      if (o.status === "已关机") { o.conclusionInvalid = true; o.note = `${label}，合格结论已失效`; return; }
      // 关联排机立即失效并重算：按新领用单重新判定物料与织机
      const evalRes = R.evaluateMaterials(state, { warpBatchId: o.warpBatchId, requisitionId: o.requisitionId }, o.id, today());
      const busy = R.activeOrderOnLoom(state.orders, o.loomNo, o.id);
      o.holdReasons = evalRes.ok ? (busy ? [`织机被工单${busy.id}占用`] : []) : evalRes.reasons;
      o.status = evalRes.ok && !busy ? "在织" : "待补料";
      o.note = `${label}，排机已重算`;
    });
  }

  function correctRequisition(reqId, items) {
    const req = state.requisitions.find(r => r.id === reqId);
    if (!req || req.status !== "有效") return { ok: false, message: `领用单 ${reqId} 不可更正` };
    req.items = items;
    req.revision += 1;
    cascadeRequisitionChange(reqId, "领用单更正");
    commit();
    return { ok: true, message: `领用单 ${reqId} 已更正（第${req.revision}版），关联排机与合格结论已失效并重算` };
  }

  function replaceRequisition(reqId, items) {
    const req = state.requisitions.find(r => r.id === reqId);
    if (!req || req.status !== "有效") return { ok: false, message: `领用单 ${reqId} 不可撤换` };
    const newId = "RQ-" + String(state.seq.req++).padStart(3, "0");
    state.requisitions.push({ id: newId, items, status: "有效", revision: 1, replacedBy: null });
    req.status = "已撤换";
    req.replacedBy = newId;
    state.orders.filter(o => o.requisitionId === reqId).forEach(o => { o.requisitionId = newId; });
    cascadeRequisitionChange(newId, "领用单撤换");
    commit();
    return { ok: true, message: `领用单 ${reqId} 已撤换为 ${newId}，关联排机与合格结论已失效并重算` };
  }

  /* ---------- 重置演示数据 ---------- */
  function reset() {
    state = seed();
    commit();
  }

  load();

  return {
    today, getState, subscribe,
    registerPattern, schedule, recordTrial, reviewOrder, unfreezeOrder, closeOrder,
    recheckOrder, replenishStock, correctRequisition, replaceRequisition, reset,
  };
})();
