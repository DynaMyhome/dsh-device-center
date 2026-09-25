/**
 * dsh-device-center —— 设备浮层树的纯逻辑回归测试。
 *
 * 为什么有这个文件：2026-09-25 用户报"想展开/折叠某一行，结果第一行折叠或展开了，
 * 搞得不知道自己在哪"。根因是默认展开写成了渲染期哨兵（expanded 为空就临时展开全部
 * 顶层，只写进副本），于是第一次 toggle 会让其它所有顶层行一起折叠。这类状态机 bug
 * 用肉眼看代码很难发现、点几下 UI 又容易漏，所以把树/光标的纯逻辑抽出来直接测。
 *
 * 运行：node test/tree-logic.test.mjs   （零依赖，不需要 jsdom / React）
 *
 * 载入方式：lib/client.js 是给 DSH 前端用的手写 bundle，入口是
 * `window.__ModuleLoader__.load({id, factory})`。这里把 window 塞一个假的 loader
 * 拿到 factory，再用桩 require 调它（factory 体里只用到 react.createElement /
 * useState / useEffect / useRef，且都不在加载期执行）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "..", "lib", "client.js");

let loaded = null;
const fakeWindow = { __ModuleLoader__: { load: function (m) { loaded = m; } } };
new Function("window", readFileSync(BUNDLE, "utf8"))(fakeWindow);
assert.equal(loaded && loaded.id, "dsh-device-center", "bundle 未通过 __ModuleLoader__ 注册");

const stubRequire = function () {
  return {
    createElement: function () { return null; },
    useState: function () {}, useEffect: function () {}, useRef: function () {},
  };
};
const mod = loaded.factory(stubRequire);
const T = mod.__internals;
assert.ok(T && T.flatten && T.prune && T.defaultExpanded && T.resolveCursor,
  "client.js 必须导出 __internals（测试缝）");

/* ---------- 测试夹具 ---------- */

const tree = [
  { id: "A", name: "A", children: [{ id: "a1", name: "a1" }] },
  { id: "B", name: "B", children: [{ id: "b1", name: "b1" }] },
  { id: "C", name: "C", children: [{ id: "c1", name: "c1" }] },
];

/** 与组件里 toggle() 相同的语义：只动目标 id，光标（id）另行记录。 */
function toggle(open, id) {
  const s = new Set(open);
  if (s.has(id)) s.delete(id); else s.add(id);
  return s;
}

/** 复刻组件 render 期的行计算。 */
function rowsFor(data, open, q) {
  const entries = T.toEntries(data);
  const ql = (q || "").trim().toLowerCase();
  const pruned = T.prune(entries, ql);
  const openSet = ql ? T.openedForSearch(pruned) : open;
  return T.flatten(pruned, 0, openSet);
}
const idsOf = (data, open, q) => rowsFor(data, open, q).map((r) => r.node.id);

/* ---------- 用例 ---------- */

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("默认展开第一层 = 顶层 id 集合", () => {
  const s = T.defaultExpanded(tree);
  assert.deepEqual([...s].sort(), ["A", "B", "C"]);
  assert.deepEqual(idsOf(tree, s), ["A", "a1", "B", "b1", "C", "c1"]);
});

test("回归：折叠 B 只影响 B，A/C 的展开态不变（旧哨兵会让它们一起折叠）", () => {
  const seeded = T.defaultExpanded(tree);
  const after = toggle(seeded, "B");
  assert.equal(after.has("B"), false, "B 应被折叠");
  assert.equal(after.has("A"), true, "A 不应被连坐折叠");
  assert.equal(after.has("C"), true, "C 不应被连坐折叠");
  assert.deepEqual(idsOf(tree, after), ["A", "a1", "B", "C", "c1"]);
  // 原始 state 不被就地修改（toggle 必须产新 Set）
  assert.equal(seeded.has("B"), true, "toggle 不得就地改写入参");
});

test("回归：全部折叠后再折叠一次，不会把其它行重新弹开", () => {
  let open = T.defaultExpanded(tree);
  open = toggle(open, "A"); open = toggle(open, "B"); open = toggle(open, "C");
  assert.deepEqual(idsOf(tree, open), ["A", "B", "C"], "全折叠后应只剩顶层行");
  open = toggle(open, "B");           // 折叠一个已经折叠的行 = 展开它
  assert.deepEqual(idsOf(tree, open), ["A", "B", "b1", "C"], "只应展开 B");
});

test("展开嵌套子节点时祖先必须仍然展开（否则该行会从列表里凭空消失）", () => {
  let open = toggle(T.defaultExpanded(tree), "B");     // 先折 B
  assert.deepEqual(idsOf(tree, open), ["A", "a1", "B", "C", "c1"]);
  open = toggle(open, "B");                            // 再展开 B
  open = toggle(open, "b1");                           // 展开 b1
  assert.equal(open.has("B"), true, "展开子节点不得折叠其父节点");
  assert.ok(idsOf(tree, open).includes("b1"), "b1 必须在可见行里");
  // 性质：对任意 id，toggle 都不会删掉其它已展开的 id
  for (const id of ["A", "a1", "B", "b1", "C", "c1"]) {
    const base = new Set(["B", "b1"]);
    const next = toggle(base, id);
    for (const k of ["B", "b1"]) if (k !== id) assert.equal(next.has(k) === base.has(k), true,
      `toggle(${id}) 不得改变 ${k} 的展开态`);
  }
});

test("搜索剪枝：保留命中节点的父链、剪掉未命中兄弟、层级真实", () => {
  const data = [
    { id: "d1", name: "Phy-D", children: [{ id: "h1", name: "Windows 11" }, { id: "h2", name: "Linux" }] },
    { id: "d2", name: "NAS", children: [{ id: "s1", name: "storage" }] },
  ];
  const entries = T.toEntries(data);
  assert.equal(T.prune(entries, ""), entries, "无搜索词时不剪枝（同一引用）");

  const pruned = T.prune(entries, "windows");
  assert.deepEqual(pruned.map((e) => e.node.id), ["d1"], "只留命中节点的父链");
  assert.deepEqual(pruned[0].children.map((e) => e.node.id), ["h1"], "未命中的兄弟被剪掉");

  const rows = T.flatten(pruned, 0, T.openedForSearch(pruned));
  assert.deepEqual(rows.map((r) => r.node.id), ["d1", "h1"]);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1], "父子缩进必须是真实层级，不能是孤儿行");
  assert.equal(rows[0].hasKids, true);
  assert.equal(rows[1].hasKids, false, "被剪掉子节点的行在搜索态按叶子渲染");
});

test("搜索态不写回用户展开状态（清空搜索即恢复原状）", () => {
  const open = new Set();                              // 用户把全部都折叠了
  assert.deepEqual(idsOf(tree, open, "a1"), ["A", "a1"]);
  assert.equal(open.size, 0, "搜索不得污染用户的 expanded");
  assert.deepEqual(idsOf(tree, open), ["A", "B", "C"], "清空搜索后仍是用户自己的折叠状态");
});

test("光标按 id 解析（折叠后不会漂到别的行）", () => {
  const rows = rowsFor(tree, T.defaultExpanded(tree));
  assert.equal(T.resolveCursor(rows, "b1"), 3);
  assert.equal(T.resolveCursor(rows, "A"), 0);
  assert.equal(T.resolveCursor(rows, "不存在"), 0, "id 消失才回落到第一行");
  assert.equal(T.resolveCursor([], "A"), 0, "空列表不越界");
  // 折叠 B 后 b1 消失 -> 光标应回落（调用方此时会把光标设为 B 本身）
  const folded = rowsFor(tree, toggle(T.defaultExpanded(tree), "B"));
  assert.equal(T.resolveCursor(folded, "b1"), 0);
  assert.equal(T.resolveCursor(folded, "B"), 2);
});

test("flatten 是只读的：不改 expanded、不改 entries", () => {
  const entries = T.toEntries(tree);
  const open = T.defaultExpanded(tree);
  const snapshot = [...open].sort();
  T.flatten(entries, 0, open);
  T.prune(entries, "a1");
  assert.deepEqual([...open].sort(), snapshot, "flatten/prune 不得改动展开集合");
  assert.equal(entries[0].node.id, "A");
  assert.equal(entries[0].children.length, 1, "prune 不得改动原 entries");
});

test("matchNode 覆盖 id / 名称 / 主机名 / 描述，且大小写无关", () => {
  const n = { id: "device:phy-d", name: "Phy-D 家庭电脑", hostname: "192.168.0.126", description: "RTX 4060" };
  for (const q of ["phy-d", "PHY-D", "192.168.0", "家庭", "rtx"]) assert.equal(T.matchNode(n, q), true, q);
  assert.equal(T.matchNode(n, "nas"), false);
  assert.equal(T.matchNode(n, ""), true);
});

test("缺 children 字段的节点（叶子）不炸，也不被当成父节点", () => {
  const data = [{ id: "x", name: "x" }, { id: "y", name: "y", children: null }];
  const rows = rowsFor(data, new Set());
  assert.deepEqual(rows.map((r) => r.node.id), ["x", "y"]);
  assert.deepEqual(rows.map((r) => r.hasKids), [false, false]);
});

/* ---------- 运行 ---------- */

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log("  PASS  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + (e && e.message)); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
