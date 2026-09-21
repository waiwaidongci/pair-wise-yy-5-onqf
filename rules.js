/* ============================================================
 * 规则模块（rules.js）
 * 纯业务规则：只接收/返回普通数据，不读写 DOM、不触碰存储。
 *  - 纹样按「编号 + 版本」唯一
 *  - 织机占用判定：未关机不得承接第二个试织任务，待补料不占机
 *  - 色线库存 / 经线批次有效期 → 待补料判定
 *  - 断线次数、经纬密度超限 → 只能返修
 *  - 合格统计：留档旧结果不计入
 * ============================================================ */
window.BrocadeRules = (() => {
  // 试织限值
  const LIMITS = {
    maxBreaks: 3,                          // 断线次数上限（含）
    warpDensity: { min: 20, max: 60 },     // 经密合格区间
    weftDensity: { min: 18, max: 55 },     // 纬密合格区间
  };

  // 工单状态
  const ORDER_STATUS = ["待补料", "在织", "待复核", "返修", "冻结", "合格", "已关机"];

  // 占用织机的状态：未关机的有效任务；待补料不占机，已关机释放
  const OCCUPYING = ["在织", "待复核", "返修", "冻结", "合格"];

  // 占用（预留）色线库存的状态：已上机及以后；已关机视为已消耗；待补料不预留
  const RESERVING = ["在织", "待复核", "返修", "冻结", "合格", "已关机"];

  /* ---------- 纹样：编号 + 版本唯一 ---------- */
  function findPattern(patterns, no, version) {
    return patterns.find(p => p.no === no && p.version === version) || null;
  }

  /* ---------- 织机占用 ---------- */
  // 某台织机上正在占用织机的工单（未关机）；待补料不算占用
  function activeOrderOnLoom(orders, loomNo, excludeId) {
    return orders.find(o => o.loomNo === loomNo && o.id !== excludeId && OCCUPYING.includes(o.status)) || null;
  }

  /* ---------- 重复 / 并发排机：同一请求键的存活工单 ---------- */
  function findLiveOrderByKey(orders, requestKey) {
    return orders.find(o => o.requestKey === requestKey && o.status !== "已关机") || null;
  }

  /* ---------- 色线库存：总量 - 已上机工单预留 = 可用 ---------- */
  function reservedByColor(state, excludeOrderId) {
    const map = {};
    state.orders.forEach(o => {
      if (o.id === excludeOrderId || !RESERVING.includes(o.status)) return;
      const req = state.requisitions.find(r => r.id === o.requisitionId);
      if (!req) return;
      Object.entries(req.items).forEach(([c, q]) => { map[c] = (map[c] || 0) + q; });
    });
    return map;
  }

  function availableStock(state, excludeOrderId) {
    const reserved = reservedByColor(state, excludeOrderId);
    return state.stocks.map(s => ({
      ...s,
      reserved: reserved[s.color] || 0,
      available: s.qty - (reserved[s.color] || 0),
    }));
  }

  /* ---------- 排机物料判定：批次过期 / 色线不足 → 待补料 ----------
   * 返回 { ok, fatal, reasons }；fatal 表示领用单本身无效（数据错误，应拒绝而非待补料） */
  function evaluateMaterials(state, { warpBatchId, requisitionId }, excludeOrderId, today) {
    const reasons = [];
    let fatal = false;
    const batch = state.warpBatches.find(b => b.id === warpBatchId);
    if (!batch) { reasons.push("经线批次不存在"); fatal = true; }
    else if (batch.expiry < today) reasons.push(`经线批次${batch.id}已于${batch.expiry}过期`);
    const req = state.requisitions.find(r => r.id === requisitionId);
    if (!req) { reasons.push("色线领用单不存在"); fatal = true; }
    else if (req.status !== "有效") { reasons.push(`色线领用单${req.id}已撤换，请改用${req.replacedBy || "新单"}`); fatal = true; }
    else {
      const avail = availableStock(state, excludeOrderId);
      Object.entries(req.items).forEach(([c, q]) => {
        const s = avail.find(a => String(a.color) === String(c));
        if (!s || s.available < q) reasons.push(`色线${c}不足：需${q}，可用${s ? s.available : 0}`);
      });
    }
    return { ok: reasons.length === 0, fatal, reasons };
  }

  /* ---------- 试织判定：断线或经纬密度超限 → 只能返修 ---------- */
  function evaluateTrial({ breaks, warpDensity, weftDensity }) {
    const reasons = [];
    if (breaks > LIMITS.maxBreaks) reasons.push(`断线${breaks}次，超上限${LIMITS.maxBreaks}次`);
    if (warpDensity < LIMITS.warpDensity.min || warpDensity > LIMITS.warpDensity.max)
      reasons.push(`经密${warpDensity}超出${LIMITS.warpDensity.min}~${LIMITS.warpDensity.max}`);
    if (weftDensity < LIMITS.weftDensity.min || weftDensity > LIMITS.weftDensity.max)
      reasons.push(`纬密${weftDensity}超出${LIMITS.weftDensity.min}~${LIMITS.weftDensity.max}`);
    return { verdict: reasons.length ? "返修" : "待复核", reasons };
  }

  /* ---------- 汇总统计：留档（archived）旧结果不计入合格统计 ---------- */
  function computeSummary(state) {
    const byStatus = {};
    ORDER_STATUS.forEach(s => { byStatus[s] = 0; });
    state.orders.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
    const live = state.trials.filter(t => !t.archived);
    const pass = live.filter(t => t.verdict === "合格").length;
    const rework = live.filter(t => t.verdict === "返修").length;
    const review = live.filter(t => t.verdict === "待复核").length;
    const frozen = live.filter(t => t.verdict === "冻结").length;
    const archived = state.trials.length - live.length;
    const denom = pass + rework;
    return {
      total: state.orders.length,
      byStatus,
      trials: { pass, rework, review, frozen, archived },
      passRate: denom ? Math.round((pass / denom) * 100) : null,
    };
  }

  return {
    LIMITS, ORDER_STATUS, OCCUPYING, RESERVING,
    findPattern, activeOrderOnLoom, findLiveOrderByKey,
    availableStock, evaluateMaterials, evaluateTrial, computeSummary,
  };
})();
