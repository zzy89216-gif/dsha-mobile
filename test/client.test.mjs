/*
 * dsha-mobile 的纯逻辑测试：抽屉里点会话行该怎么处理、会话 id 从哪里读。
 *
 * 这两处决定了「侧边栏进的去、历史对话进不去」这个真机 bug 会不会回来：
 * 宿主 DSHA_SESSION_INTERACTION_V2 把会话行拆成「单击=选中、双击=打开」，
 * 抽屉如果在第一次点击就收起，第二次点击永远落不到行上，会话就打不开了。
 *
 *   node --test test/client.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "lib", "client.js");

/** 用最小的宿主桩加载客户端包，拿到它与 dsh 无关的纯逻辑。 */
async function loadPlugin() {
  const loaded = [];
  globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  await import(`${new URL(`file://${clientPath}`).href}?t=${Math.random()}`);
  assert.equal(loaded.length, 1, "client.js 必须登记一个模块");
  const reactStub = {
    createElement: () => null,
    Fragment: null,
    useSyncExternalStore: () => undefined,
    useEffect: () => undefined,
    useState: () => [undefined, () => {}],
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  };
  const require = (name) => (name === "react" ? reactStub : {});
  return loaded[0].factory(require).__test;
}

const plugin = await loadPlugin();

function row(attrs) {
  return { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
}

test("会话 id 优先读宿主标记，其次回退 data-row-key", () => {
  assert.equal(plugin.sessionIdOf(row({ "data-dsha-session-select": "s-1" })), "s-1");
  assert.equal(plugin.sessionIdOf(row({ "data-row-key": "session:s-2" })), "s-2");
  assert.equal(plugin.sessionIdOf(row({ "data-row-key": "workspace:w-1" })), "");
  assert.equal(plugin.sessionIdOf(row({})), "");
  assert.equal(plugin.sessionIdOf(null), "");
});

test("未选中的会话行：单击就打开（不是只收抽屉）", () => {
  assert.equal(plugin.rowTapAction({ suppressed: false, longPress: false, moved: false, selected: false }), "open");
});

test("已经是当前会话：只收抽屉，不重复导航", () => {
  assert.equal(plugin.rowTapAction({ suppressed: false, longPress: false, moved: false, selected: true }), "close");
});

test("长按 / 拖列表 / 合成点击都不当打开", () => {
  const base = { suppressed: false, longPress: false, moved: false, selected: false };
  assert.equal(plugin.rowTapAction({ ...base, longPress: true }), "ignore");
  assert.equal(plugin.rowTapAction({ ...base, moved: true }), "ignore");
  assert.equal(plugin.rowTapAction({ ...base, suppressed: true }), "ignore");
});

test("源码里不许再有「点一下就收抽屉」的旧写法", () => {
  const source = readFileSync(clientPath, "utf8");
  assert.ok(!source.includes("setTimeout(() => setDrawer(false), 120)"),
    "旧的「第一次点击就收抽屉」是历史 bug，收早了双击就永远到不了");
  assert.ok(source.includes('document.addEventListener("dsha-session-open"'),
    "宿主真的打开会话时会派发 dsha-session-open，抽屉要跟着它收");
  assert.ok(source.includes('service("sessions")'),
    "打开会话要走宿主自己的会话服务，不能猜路由");
  assert.ok(source.includes("z-index:60;"), "抽屉必须在遮罩（z-index:29）之上，否则点击会被遮罩吃掉");
});

test("收抽屉按 DOM 真实状态判断，并按意图去抖", () => {
  // 会话打开事件与自己排的关闭几乎同时到；照缓存值 toggle 第二次会把抽屉重新打开。
  const source = readFileSync(clientPath, "utf8");
  assert.ok(source.includes("function drawerOpenNow()"), "必须能读框架上的真实开合状态");
  assert.ok(source.includes("const live = drawerOpenNow();"), "setDrawer 要以真实状态为准");
  assert.ok(source.includes("DRAWER_TOGGLE_DEBOUNCE_MS"), "同一个意图的重复请求要能去抖");
  assert.ok(source.includes("actions.sessions() { setDrawer(!drawerOpenNow()); }") ||
    source.includes("sessions() { setDrawer(!drawerOpenNow()); }"),
    "底栏「会话」应按真实状态取反");
});

test("⋯ 菜单锚点 / 行内操作区 / 菜单本身：都不当成「点行」", () => {
  // 宿主实测（2026-10-03，dsh-client-ui-workspace）：⋯ 锚点是 span[class*=_rowActions] 里的
  // button，只有 aria-label，没有 aria-haspopup；菜单由宿主 portal 到 body（role=menu）。
  assert.equal(plugin.isRowActionTarget({ closest: (sel) => (sel === plugin.ROW_ACTION_SELECTOR ? {} : null) }), true);
  assert.equal(plugin.isRowActionTarget({ closest: () => ({}) }), true, "命中操作区就豁免");
  assert.equal(plugin.isRowActionTarget({ closest: () => null }), false, "行体本身要照常打开会话");
  assert.equal(plugin.isRowActionTarget(null), false);
  assert.equal(plugin.isRowActionTarget({}), false, "没有 closest 也不能炸");
});

test("豁免选择器必须能命中宿主的 ⋯ 锚点（它没有 aria-haspopup）", () => {
  // 老写法只认 button[aria-haspopup]，宿主的 ⋯ 不匹配 → 点击被当成点行，
  // 打开会话并收起抽屉，菜单永远打不开（删除 / 改名 / 归档全做不了）。
  const sel = plugin.ROW_ACTION_SELECTOR;
  assert.ok(sel.includes("button"), "行内按钮");
  assert.ok(sel.includes("_rowActions"), "宿主的行内操作区（稳定子串）");
  assert.ok(sel.includes("[role=menu]"), "菜单面板（portal 到 body）");
  assert.ok(sel.includes("[role=menuitem]"), "菜单条目");
  assert.ok(!sel.includes("aria-haspopup"), "锚点没有 aria-haspopup，不能再依赖它");
});

test("⋯ 菜单要抬到抽屉之上、且在触屏常显", () => {
  // 宿主把菜单 portal 到 body，默认层级低于抽屉（60）→ 菜单整块画在抽屉下面，点不到。
  // 触屏没有 hover，行内操作区只在 :hover / menuOpen 时显示 → 不常显就没有入口。
  const source = readFileSync(clientPath, "utf8");
  assert.ok(/\[role=menu\]\{z-index:1400/.test(source), "菜单层级必须高于抽屉");
  assert.ok(/\[class\*="_rowActions"\]\{display:inline-flex/.test(source), "抽屉里的 ⋯ 要常显");
});
