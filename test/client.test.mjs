/*
 * dsha-mobile 的纯逻辑测试：抽屉里点会话行该怎么处理、会话 id 从哪里读。
 *
 * 这两处决定了「侧边栏进的去、历史对话进不去」这个真机 bug 会不会回来：
 * 宿主 DSHA_SESSION_INTERACTION_V2 把会话行拆成「单击=选中、双击=打开」，
 * 抽屉如果在第一次点击就收起，第二次点击永远落不到行上，会话就打不开了。
 *
 *   node --test test/
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
