/* 记录存储模块：全部业务记录落 localStorage，页面重载后状态可复原。
   不包含业务规则，只负责读写与初始数据。 */
const WeaveStore = (() => {
  const KEY = "brocade.trialBench.v1";
  const mem = {};
  const storage = typeof localStorage !== "undefined" ? localStorage : {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  };
  let state = null;

  // 首次使用的初始数据：示例纹样、织机、批次、库存与一张生效领用单
  function seed() {
    const cols = 18, rows = 14, cells = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      const d = Math.abs(x - 8.5) + Math.abs(y - 6.5);
      cells.push(border ? 1 : (Math.round(d) % 4 === 0 ? 2 : (d < 3 ? 3 : 0)));
    }
    const at = new Date().toISOString();
    return {
      seq: { order: 1, req: 2, loom: 4, archive: 1 },
      patterns: [{ id: "P-1001", version: "v1", cols, rows, cells, savedAt: at }],
      looms: [{ id: "L-01", occupiedBy: null }, { id: "L-02", occupiedBy: null }, { id: "L-03", occupiedBy: null }],
      batches: [
        { id: "WARP-A", expiresOn: "2027-06-30" },
        { id: "WARP-B", expiresOn: "2026-09-10" }
      ],
      stock: { "0": 600, "1": 160, "2": 120, "3": 120, "4": 80, "5": 60, "6": 200, "7": 40 },
      requisitions: [{
        id: "RQ-0001", status: "active", revision: 1,
        lines: { "0": 600, "1": 200, "2": 200, "3": 200, "4": 120, "5": 120, "6": 200, "7": 120 },
        createdAt: at
      }],
      orders: [],
      archives: [],
      log: [{ at, msg: "系统初始化：示例纹样、织机、批次、库存与领用单已就绪" }]
    };
  }

  function load() {
    try { state = JSON.parse(storage.getItem(KEY)) || seed(); }
    catch (e) { state = seed(); }
    return state;
  }

  function save() { storage.setItem(KEY, JSON.stringify(state)); }
  function get() { return state; }

  // 所有变更统一入口：先执行规则/修改，再落库，保证重载后状态一致
  function update(fn) {
    const r = fn(state);
    save();
    return r;
  }

  function reset() {
    state = seed();
    save();
    return state;
  }

  return { KEY, load, save, get, update, reset };
})();
if (typeof module !== "undefined" && module.exports) module.exports = WeaveStore;
