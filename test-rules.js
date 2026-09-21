/* 规则模块自测：node test-rules.js */
const WeaveRules = require("./rules.js");
const WeaveStore = require("./store.js");

let passed = 0, failed = 0;
function t(name, cond) {
  if (cond) passed++;
  else { failed++; console.error("FAIL:", name); }
}

WeaveStore.load();
WeaveStore.reset();
const R = WeaveRules, S = () => WeaveStore.get();
const up = fn => WeaveStore.update(fn);

// 1 排机成功并占用织机、扣减库存
let r = up(s => R.admit(s, { requestKey: "k1", patternId: "P-1001", version: "v1", loomId: "L-01", batchId: "WARP-A", requisitionId: "RQ-0001", expectedDate: "2026-10-01" }));
t("排机成功", r.code === "RUNNING");
t("织机被占用", S().looms.find(l => l.id === "L-01").occupiedBy === "WO-0001");
t("库存按用量扣减", S().stock["1"] === 160 - 60);

// 2 重复/并发排机沿用首次工单
r = up(s => R.admit(s, { requestKey: "k1", patternId: "P-1001", version: "v1", loomId: "L-01", batchId: "WARP-A", requisitionId: "RQ-0001", expectedDate: "2026-10-01" }));
t("同请求键沿用首次工单", r.code === "REUSED" && r.order.id === "WO-0001");
r = up(s => R.admit(s, { requestKey: "k2", patternId: "P-1001", version: "v1", loomId: "L-02", batchId: "WARP-A", requisitionId: "RQ-0001", expectedDate: "2026-10-01" }));
t("同纹样并发沿用首次工单", r.code === "REUSED" && r.order.id === "WO-0001");
t("未生成新工单", S().orders.length === 1);

// 3 同一织机未关机不得承接第二个试织任务
up(s => R.savePattern(s, { id: "P-2000", version: "v1", cols: 6, rows: 6, cells: Array(36).fill(0) }));
r = up(s => R.admit(s, { requestKey: "k3", patternId: "P-2000", version: "v1", loomId: "L-01", batchId: "WARP-A", requisitionId: "RQ-0001", expectedDate: "2026-10-01" }));
t("织机未关机拒绝承接", r.ok === false && r.code === "LOOM_BUSY");

// 4 批次过期只存待补料，不占织机
r = up(s => R.admit(s, { requestKey: "k4", patternId: "P-2000", version: "v1", loomId: "L-02", batchId: "WARP-B", requisitionId: "RQ-0001", expectedDate: "2026-10-01" }));
t("批次过期转待补料", r.code === "PENDING_MATERIAL");
t("待补料不占织机", !S().looms.find(l => l.id === "L-02").occupiedBy);

// 5 断线超限只能返修，旧结果留档
r = up(s => R.record(s, "WO-0001", { breaks: 5, warp: 40, weft: 30, sample: "合格" }));
t("断线超限转返修", r.code === "REWORK" && S().orders[0].status === "REWORK");
t("超限旧结果留档", S().archives.length === 1 && S().archives[0].snapshot.result.breaks === 5);
r = up(s => R.record(s, "WO-0001", { breaks: 0, warp: 40, weft: 30, sample: "合格" }));
t("返修中不可直接录入", r.ok === false);
r = up(s => R.review(s, "WO-0001", true));
t("返修中不可复核", r.ok === false);
up(s => R.startRework(s, "WO-0001"));
t("返修开工回进行中", S().orders[0].status === "RUNNING");

// 6 密度超限同样只能返修
r = up(s => R.record(s, "WO-0001", { breaks: 0, warp: 120, weft: 30, sample: "合格" }));
t("经密超限转返修", r.code === "REWORK");
up(s => R.startRework(s, "WO-0001"));

// 7 合格记录→复核→合格统计
up(s => R.record(s, "WO-0001", { breaks: 1, warp: 40, weft: 30, sample: "合格" }));
t("合格记录转待复核", S().orders[0].status === "PENDING_REVIEW");
up(s => R.review(s, "WO-0001", true));
t("复核通过为合格", S().orders[0].status === "QUALIFIED");
t("合格统计计1", R.computeStats(S()).qualifiedCount === 1);
t("留档不计入合格统计", R.computeStats(S()).qualifiedCount === 1 && S().archives.length === 2);

// 8 合格工单关机后织机释放
r = up(s => R.shutdownLoom(s, "L-01"));
t("合格后关机释放", r.ok && !S().looms.find(l => l.id === "L-01").occupiedBy);

// 9 领用单更正：关联排机与合格结论立即失效并重算
const lines0 = {}; for (let i = 0; i < 8; i++) lines0[i] = 0;
r = up(s => R.correctRequisition(s, "RQ-0001", lines0));
t("更正后关联工单失效", r.affected.some(o => o.id === "WO-0001"));
t("合格结论失效重算为待补料", S().orders[0].status === "PENDING_MATERIAL");
t("合格统计归零", R.computeStats(S()).qualifiedCount === 0);
t("旧结论已留档", S().archives.some(a => a.orderId === "WO-0001" && a.kind === "conclusion"));
t("库存已按用量返还", S().stock["1"] === 160);

// 10 领用单再更正补足：重算回进行中
const linesFull = {}; for (let i = 0; i < 8; i++) linesFull[i] = 600;
up(s => R.correctRequisition(s, "RQ-0001", linesFull));
t("重算回进行中", S().orders[0].status === "RUNNING");
t("重新占用织机", S().looms.find(l => l.id === "L-01").occupiedBy === "WO-0001");

// 11 超限冻结相关待复核，返修合格后解冻
up(s => R.savePattern(s, { id: "P-1001", version: "v2", cols: 6, rows: 6, cells: Array(36).fill(0) }));
up(s => R.admit(s, { requestKey: "k5", patternId: "P-1001", version: "v2", loomId: "L-02", batchId: "WARP-A", requisitionId: "RQ-0001", expectedDate: "2026-10-01" }));
up(s => R.record(s, "WO-0001", { breaks: 0, warp: 40, weft: 30, sample: "合格" }));
const v2 = S().orders.find(o => o.version === "v2");
up(s => R.record(s, v2.id, { breaks: 9, warp: 40, weft: 30, sample: "合格" }));
t("相关待复核试织冻结", S().orders[0].status === "FROZEN" && S().orders[0].freezeCause === v2.id);
r = up(s => R.review(s, "WO-0001", true));
t("冻结工单不可复核", r.ok === false);
up(s => R.startRework(s, v2.id));
up(s => R.record(s, v2.id, { breaks: 0, warp: 40, weft: 30, sample: "合格" }));
t("返修合格后自动解冻", S().orders[0].status === "PENDING_REVIEW");

// 12 领用单撤换：旧单作废，工单迁移新单并重算
r = up(s => R.replaceRequisition(s, "RQ-0001", linesFull));
t("撤换生成新领用单", r.newReq && r.newReq.id === "RQ-0002");
t("旧单标记已撤换", S().requisitions.find(q => q.id === "RQ-0001").status === "replaced");
t("关联工单迁移并重算", S().orders.every(o => o.requisitionId === "RQ-0002"));

// 13 色线不足只存待补料，补料后自动转进行中
up(s => { s.stock["0"] = 10; });
up(s => R.savePattern(s, { id: "P-3000", version: "v1", cols: 6, rows: 6, cells: Array(36).fill(0) }));
r = up(s => R.admit(s, { requestKey: "k6", patternId: "P-3000", version: "v1", loomId: "L-03", batchId: "WARP-A", requisitionId: "RQ-0002", expectedDate: "2026-10-01" }));
t("色线不足转待补料", r.code === "PENDING_MATERIAL");
up(s => R.addStock(s, 0, 1000));
t("补料后自动重检转进行中", S().orders.find(o => o.patternId === "P-3000").status === "RUNNING");

// 14 纹样按编号+版本唯一
r = up(s => R.savePattern(s, { id: "P-3000", version: "v1", cols: 6, rows: 6, cells: [] }));
t("重复编号+版本被拒绝", r.ok === false);
r = up(s => R.savePattern(s, { id: "P-3000", version: "v2", cols: 6, rows: 6, cells: Array(36).fill(1) }));
t("同编号升版本可入库", r.ok === true);

// 15 样片不合格不得复核通过
const wo3 = S().orders.find(o => o.patternId === "P-3000");
up(s => R.record(s, wo3.id, { breaks: 0, warp: 40, weft: 30, sample: "不合格" }));
r = up(s => R.review(s, wo3.id, true));
t("样片不合格不得通过", r.ok === false);
up(s => R.review(s, wo3.id, false));
t("复核退回转返修", S().orders.find(o => o.patternId === "P-3000").status === "REWORK");

// 16 页面汇总与重载后状态一致
WeaveStore.save();
const before = JSON.stringify({ st: R.computeStats(S()).byStatus, stock: S().stock, looms: S().looms });
WeaveStore.load();
const after = JSON.stringify({ st: R.computeStats(S()).byStatus, stock: S().stock, looms: S().looms });
t("重载后汇总状态一致", before === after);

console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
