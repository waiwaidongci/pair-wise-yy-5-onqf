/* 规则模块：试织排机与色线领用复核的全部业务规则。
   只读写传入的状态对象，不接触页面与存储。 */
const WeaveRules = (() => {
  // 超限阈值：断线次数上限、经纬密度合格区间（根/厘米）
  const LIMITS = { maxBreaks: 3, warpMin: 20, warpMax: 80, weftMin: 15, weftMax: 60 };
  const STATUS = {
    PENDING_MATERIAL: "待补料",
    RUNNING: "进行中",
    PENDING_REVIEW: "待复核",
    REWORK: "返修",
    FROZEN: "冻结",
    QUALIFIED: "合格"
  };
  // 参与“重复/并发排机沿用首次工单”判定的活动状态（合格属已完结，不拦截新试织）
  const DEDUPE_ACTIVE = ["PENDING_MATERIAL", "RUNNING", "PENDING_REVIEW", "REWORK", "FROZEN"];

  const now = () => new Date().toISOString();
  const today = () => now().slice(0, 10);
  const clone = o => JSON.parse(JSON.stringify(o));

  function log(state, msg) {
    state.log.unshift({ at: now(), msg });
    if (state.log.length > 200) state.log.length = 200;
  }

  // 旧结果/旧结论留档：只存档，不计入合格统计
  function archive(state, order, kind, reason) {
    state.archives.push({
      id: "AR-" + String(state.seq.archive++).padStart(4, "0"),
      orderId: order.id, kind, reason,
      snapshot: { result: clone(order.result || null), conclusion: clone(order.conclusion || null), status: order.status },
      at: now()
    });
  }

  // 纹样各色线用量（1格=1单位）
  function patternUsage(pattern) {
    const usage = {};
    pattern.cells.forEach(c => { usage[c] = (usage[c] || 0) + 1; });
    return usage;
  }

  // 色线库存/领用单额度/经线批次有效期检查
  function checkMaterial(state, usage, batch, req, expectedDate) {
    const reasons = [];
    Object.keys(usage).forEach(ci => {
      const need = usage[ci];
      const stockQty = state.stock[ci] || 0;
      const reqQty = req && req.lines ? req.lines[ci] || 0 : 0;
      if (stockQty < need) reasons.push(`色线${ci}库存不足（需${need}/存${stockQty}）`);
      else if (reqQty < need) reasons.push(`领用单色线${ci}额度不足（需${need}/批${reqQty}）`);
    });
    if (!batch) reasons.push("经线批次不存在");
    else if (batch.expiresOn < expectedDate) reasons.push(`经线批次${batch.id}于${batch.expiresOn}过期，早于预计完成日${expectedDate}`);
    if (!req || req.status !== "active") reasons.push("色线领用单不存在或已撤换");
    return { ok: reasons.length === 0, reasons };
  }

  function deductStock(state, usage) { Object.keys(usage).forEach(ci => { state.stock[ci] = (state.stock[ci] || 0) - usage[ci]; }); }
  function restoreStock(state, usage) { Object.keys(usage).forEach(ci => { state.stock[ci] = (state.stock[ci] || 0) + usage[ci]; }); }

  const getOrder = (state, id) => state.orders.find(o => o.id === id);

  /* 纹样入库：按编号+版本唯一 */
  function savePattern(state, p) {
    if (!p.id || !p.version) return { ok: false, message: "纹样编号与版本必填" };
    if (state.patterns.some(x => x.id === p.id && x.version === p.version)) {
      return { ok: false, message: `纹样${p.id} ${p.version}已存在，编号+版本必须唯一，请升版本` };
    }
    state.patterns.push({ id: p.id, version: p.version, cols: p.cols, rows: p.rows, cells: p.cells, savedAt: now() });
    log(state, `纹样${p.id} ${p.version}入库`);
    return { ok: true, message: `纹样${p.id} ${p.version}已入库` };
  }

  /* 排机登记 */
  function admit(state, input) {
    const { requestKey, patternId, version, loomId, batchId, requisitionId, expectedDate } = input;
    if (!expectedDate) return { ok: false, message: "请填写预计完成日" };
    // 重复或并发排机：同一请求键，或同纹样（编号+版本）已有活动工单，一律沿用首次工单
    const byKey = state.orders.find(o => o.requestKey === requestKey);
    if (byKey) return { ok: true, code: "REUSED", order: byKey, message: `重复提交，沿用首次工单${byKey.id}` };
    const dup = state.orders.find(o => o.patternId === patternId && o.version === version && DEDUPE_ACTIVE.includes(o.status));
    if (dup) return { ok: true, code: "REUSED", order: dup, message: `该纹样已有活动工单，沿用首次工单${dup.id}` };
    const pattern = state.patterns.find(p => p.id === patternId && p.version === version);
    if (!pattern) return { ok: false, message: "纹样不存在，请先在排版台入库" };
    const loom = state.looms.find(l => l.id === loomId);
    if (!loom) return { ok: false, message: "织机不存在" };
    const batch = state.batches.find(b => b.id === batchId);
    const req = state.requisitions.find(r => r.id === requisitionId);
    if (!batch) return { ok: false, message: "经线批次不存在，请先登记批次" };
    if (!req || req.status !== "active") return { ok: false, message: "色线领用单不存在或已撤换，请重新选择" };
    const usage = patternUsage(pattern);
    const order = {
      id: "WO-" + String(state.seq.order++).padStart(4, "0"),
      requestKey, patternId, version, loomId, batchId, requisitionId, expectedDate,
      usage, status: null, pendingReasons: [], result: null, conclusion: null,
      freezeCause: null, stockDeducted: false, invalidations: [],
      createdAt: now(), updatedAt: now()
    };
    // 色线不足或批次过期：只存待补料，不占织机
    const check = checkMaterial(state, usage, batch, req, expectedDate);
    if (!check.ok) {
      order.status = "PENDING_MATERIAL";
      order.pendingReasons = check.reasons;
      state.orders.push(order);
      log(state, `工单${order.id}登记为待补料：${check.reasons.join("；")}`);
      return { ok: true, code: "PENDING_MATERIAL", order, message: `已存待补料（不占织机）：${check.reasons.join("；")}` };
    }
    // 同一织机未关机不得承接第二个试织任务
    if (loom.occupiedBy) return { ok: false, code: "LOOM_BUSY", message: `织机${loom.id}未关机，不得承接第二个试织任务` };
    deductStock(state, usage);
    order.stockDeducted = true;
    order.status = "RUNNING";
    loom.occupiedBy = order.id;
    state.orders.push(order);
    log(state, `工单${order.id}排机成功，占用织机${loom.id}，预计${expectedDate}完成`);
    return { ok: true, code: "RUNNING", order, message: `排机成功：工单${order.id}占用织机${loom.id}` };
  }

  /* 待补料重检：补料、换批次、领用单变更后自动调用 */
  function recheckPending(state) {
    const changed = [];
    state.orders.filter(o => o.status === "PENDING_MATERIAL").forEach(o => {
      const batch = state.batches.find(b => b.id === o.batchId);
      const req = state.requisitions.find(r => r.id === o.requisitionId);
      const check = checkMaterial(state, o.usage, batch, req, o.expectedDate);
      if (!check.ok) { o.pendingReasons = check.reasons; return; }
      const loom = state.looms.find(l => l.id === o.loomId);
      if (loom.occupiedBy) { o.pendingReasons = [`织机${loom.id}被占用，待其关机`]; return; }
      deductStock(state, o.usage);
      o.stockDeducted = true;
      o.status = "RUNNING";
      o.pendingReasons = [];
      loom.occupiedBy = o.id;
      o.updatedAt = now();
      changed.push(o);
      log(state, `工单${o.id}补料到位，转进行中并占用织机${loom.id}`);
    });
    return changed;
  }

  /* 录入试织记录：断线次数、经纬密度、样片结果 */
  function record(state, orderId, rec) {
    const order = getOrder(state, orderId);
    if (!order) return { ok: false, message: "工单不存在" };
    if (order.status !== "RUNNING") return { ok: false, message: "仅进行中工单可录入试织记录" };
    if ([rec.breaks, rec.warp, rec.weft].some(v => typeof v !== "number" || isNaN(v) || v < 0)) {
      return { ok: false, message: "断线次数与经纬密度必须为非负数值" };
    }
    if (order.result) archive(state, order, "result", "重新录入，旧结果留档");
    order.result = { breaks: rec.breaks, warp: rec.warp, weft: rec.weft, sample: rec.sample, at: now() };
    order.updatedAt = now();
    const L = LIMITS, over = [];
    if (rec.breaks > L.maxBreaks) over.push(`断线${rec.breaks}次超限（≤${L.maxBreaks}）`);
    if (rec.warp < L.warpMin || rec.warp > L.warpMax) over.push(`经密${rec.warp}超出${L.warpMin}-${L.warpMax}`);
    if (rec.weft < L.weftMin || rec.weft > L.weftMax) over.push(`纬密${rec.weft}超出${L.weftMin}-${L.weftMax}`);
    if (over.length) {
      // 断线或密度超限：只能返修；旧结果留档不计合格；相关待复核试织冻结
      archive(state, order, "result", `超限留档：${over.join("；")}`);
      order.result = null;
      order.status = "REWORK";
      const frozen = state.orders.filter(o => o.id !== order.id && o.patternId === order.patternId && o.status === "PENDING_REVIEW");
      frozen.forEach(o => { o.status = "FROZEN"; o.freezeCause = order.id; o.updatedAt = now(); });
      log(state, `工单${order.id}断线/密度超限转返修${frozen.length ? "，冻结待复核工单：" + frozen.map(o => o.id).join("、") : ""}`);
      return { ok: true, code: "REWORK", order, frozen, message: `断线或密度超限，只能返修；旧结果已留档${frozen.length ? "；已冻结相关待复核工单" : ""}` };
    }
    order.status = "PENDING_REVIEW";
    // 返修工单重新记录合格后，解冻由其引起的冻结工单
    const unfrozen = state.orders.filter(o => o.freezeCause === order.id && o.status === "FROZEN");
    unfrozen.forEach(o => { o.status = "PENDING_REVIEW"; o.freezeCause = null; o.updatedAt = now(); });
    log(state, `工单${order.id}记录入库，转入待复核${unfrozen.length ? "，解冻：" + unfrozen.map(o => o.id).join("、") : ""}`);
    return { ok: true, code: "PENDING_REVIEW", order, unfrozen, message: "记录已入库，工单转入待复核" };
  }

  /* 复核 */
  function review(state, orderId, pass) {
    const order = getOrder(state, orderId);
    if (!order) return { ok: false, message: "工单不存在" };
    if (order.status !== "PENDING_REVIEW") return { ok: false, message: "仅待复核工单可复核" };
    if (pass && (!order.result || order.result.sample !== "合格")) return { ok: false, message: "样片结果不合格，只能退回返修" };
    order.updatedAt = now();
    if (pass) {
      order.status = "QUALIFIED";
      order.conclusion = { at: now(), by: "复核台" };
      log(state, `工单${order.id}复核通过，结论合格`);
      return { ok: true, code: "QUALIFIED", order, message: `工单${order.id}复核合格` };
    }
    archive(state, order, "result", "复核退回，结果留档");
    order.result = null;
    order.status = "REWORK";
    log(state, `工单${order.id}复核退回，转返修`);
    return { ok: true, code: "REWORK", order, message: "已退回返修，旧结果留档" };
  }

  /* 返修开工：返修工单的唯一出路 */
  function startRework(state, orderId) {
    const order = getOrder(state, orderId);
    if (!order || order.status !== "REWORK") return { ok: false, message: "仅返修工单可返修开工" };
    order.status = "RUNNING";
    order.updatedAt = now();
    log(state, `工单${order.id}返修开工`);
    return { ok: true, order, message: `工单${order.id}已返修开工，请重新录入试织记录` };
  }

  /* 织机关机：合格工单的织机才允许关机释放 */
  function shutdownLoom(state, loomId) {
    const loom = state.looms.find(l => l.id === loomId);
    if (!loom) return { ok: false, message: "织机不存在" };
    if (!loom.occupiedBy) return { ok: false, message: `织机${loom.id}本已空闲` };
    const order = getOrder(state, loom.occupiedBy);
    if (order && order.status !== "QUALIFIED") return { ok: false, message: `工单${order.id}尚未合格，不得关机` };
    loom.occupiedBy = null;
    log(state, `织机${loom.id}关机，可承接新任务`);
    return { ok: true, message: `织机${loom.id}已关机释放` };
  }

  /* 领用单新建/更正/撤换 */
  function createRequisition(state, lines) {
    const id = "RQ-" + String(state.seq.req++).padStart(4, "0");
    state.requisitions.push({ id, status: "active", revision: 1, lines, createdAt: now() });
    log(state, `领用单${id}创建`);
    return { ok: true, message: `领用单${id}已创建` };
  }

  function correctRequisition(state, reqId, lines) {
    const req = state.requisitions.find(r => r.id === reqId);
    if (!req || req.status !== "active") return { ok: false, message: "领用单不存在或已撤换" };
    req.lines = lines;
    req.revision = (req.revision || 1) + 1;
    req.updatedAt = now();
    log(state, `领用单${req.id}更正为第${req.revision}版`);
    const affected = invalidateByRequisition(state, req.id);
    return { ok: true, affected, message: `领用单${req.id}已更正，${affected.length}个关联工单失效重算` };
  }

  function replaceRequisition(state, reqId, lines) {
    const old = state.requisitions.find(r => r.id === reqId);
    if (!old || old.status !== "active") return { ok: false, message: "领用单不存在或已撤换" };
    const neo = { id: "RQ-" + String(state.seq.req++).padStart(4, "0"), status: "active", revision: 1, lines, replaces: old.id, createdAt: now() };
    state.requisitions.push(neo);
    old.status = "replaced";
    old.replacedBy = neo.id;
    state.orders.filter(o => o.requisitionId === old.id).forEach(o => { o.requisitionId = neo.id; });
    log(state, `领用单${old.id}撤换为${neo.id}`);
    const affected = invalidateByRequisition(state, neo.id);
    return { ok: true, affected, newReq: neo, message: `已撤换为${neo.id}，${affected.length}个关联工单失效重算` };
  }

  // 领用单更正/撤换后：关联排机与合格结论立即失效并重算
  function invalidateByRequisition(state, reqId) {
    const affected = [];
    state.orders.filter(o => o.requisitionId === reqId).forEach(o => {
      if (o.status === "QUALIFIED" || o.result || o.conclusion) archive(state, o, "conclusion", "领用单变更，排机与合格结论失效");
      if (o.stockDeducted) { restoreStock(state, o.usage); o.stockDeducted = false; }
      o.result = null;
      o.conclusion = null;
      o.freezeCause = null;
      o.invalidations.push({ reqId, at: now() });
      const loom = state.looms.find(l => l.id === o.loomId);
      if (loom.occupiedBy === o.id) loom.occupiedBy = null;
      const batch = state.batches.find(b => b.id === o.batchId);
      const req = state.requisitions.find(r => r.id === o.requisitionId);
      const check = checkMaterial(state, o.usage, batch, req, o.expectedDate);
      if (!check.ok) {
        o.status = "PENDING_MATERIAL";
        o.pendingReasons = check.reasons;
      } else if (loom.occupiedBy) {
        o.status = "PENDING_MATERIAL";
        o.pendingReasons = [`织机${loom.id}被占用，待其关机`];
      } else {
        deductStock(state, o.usage);
        o.stockDeducted = true;
        o.status = "RUNNING";
        o.pendingReasons = [];
        loom.occupiedBy = o.id;
      }
      o.updatedAt = now();
      affected.push(o);
      log(state, `工单${o.id}因领用单变更失效，重算为${STATUS[o.status]}`);
    });
    return affected;
  }

  /* 基础资料登记 */
  function addLoom(state) {
    const id = "L-" + String(state.seq.loom++).padStart(2, "0");
    state.looms.push({ id, occupiedBy: null });
    log(state, `织机${id}登记`);
    return { ok: true, message: `织机${id}已登记` };
  }

  function addBatch(state, id, expiresOn) {
    if (!id || !expiresOn) return { ok: false, message: "批次号与有效期必填" };
    if (state.batches.some(b => b.id === id)) return { ok: false, message: `批次${id}已存在` };
    state.batches.push({ id, expiresOn });
    log(state, `经线批次${id}登记，有效期至${expiresOn}`);
    const changed = recheckPending(state);
    return { ok: true, message: `批次${id}已登记${changed.length ? "，补料重检通过：" + changed.map(o => o.id).join("、") : ""}` };
  }

  function addStock(state, colorIdx, qty) {
    if (!(qty > 0)) return { ok: false, message: "补料数量需大于0" };
    state.stock[colorIdx] = (state.stock[colorIdx] || 0) + qty;
    log(state, `色线${colorIdx}补料${qty}，余${state.stock[colorIdx]}`);
    const changed = recheckPending(state);
    return { ok: true, message: `色线${colorIdx}已补料${changed.length ? "，工单转进行中：" + changed.map(o => o.id).join("、") : ""}` };
  }

  /* 汇总：合格统计只计当前合格工单，留档结果不计入 */
  function computeStats(state) {
    const byStatus = {};
    Object.keys(STATUS).forEach(s => { byStatus[s] = 0; });
    state.orders.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
    return {
      byStatus,
      qualified: state.orders.filter(o => o.status === "QUALIFIED"),
      qualifiedCount: byStatus.QUALIFIED || 0,
      archived: state.archives,
      archivedCount: state.archives.length
    };
  }

  return {
    LIMITS, STATUS, DEDUPE_ACTIVE, today, patternUsage, checkMaterial,
    savePattern, admit, recheckPending, record, review, startRework, shutdownLoom,
    createRequisition, correctRequisition, replaceRequisition,
    addLoom, addBatch, addStock, computeStats
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = WeaveRules;
