/**
 * 忠实模拟 Service Worker 启动。
 * 用 vm 上下文：sandbox 本身就是全局对象 —— 这样 self.x = 1 之后，
 * 裸标识符 x 能解析（classic worker 就是这个语义，new Function 不是）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.resolve(__dirname, '..', '..', 'extension');

const sandbox = {};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.AbortController = AbortController;
sandbox.fetch = () => Promise.reject(new Error('no network in test'));
sandbox.location = { origin: 'chrome-extension://test' };

const listeners = [];
sandbox.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener: () => {} },
    openOptionsPage: () => {}
  },
  storage: { local: { get: (k, cb) => setTimeout(() => cb({}), 0), set: (o, cb) => setTimeout(() => cb && cb(), 0) } },
  tabs: {}
};

const ctx = vm.createContext(sandbox);
const toasts = [];

function evalFile(file) {
  const src = fs.readFileSync(path.join(EXT, file), 'utf8');
  vm.runInContext(src, ctx, { filename: file });
}

sandbox.importScripts = function () {
  Array.prototype.slice.call(arguments).forEach(evalFile);
};

let failed = false;
try {
  evalFile('background.js');
  console.log('background.js 启动成功');
} catch (e) {
  failed = true;
  console.log('background.js 启动失败 ->\n  ' + (e && e.stack || e));
}

console.log('\n全局自检（裸标识符能不能解析 —— 这正是后台代码的写法）：');
['__RJ_AI__', '__RJ_STORE__', '__RJ_AI_MAP__'].forEach((name) => {
  const viaSelf = vm.runInContext('typeof self.' + name, ctx);
  const bare = vm.runInContext('typeof ' + name, ctx);
  console.log('  ' + name.padEnd(15) + ' self.= ' + viaSelf + '  裸用 = ' + bare);
  if (bare !== 'object') failed = true;
});
console.log('  消息监听器数量 = ' + listeners.length);
if (typeof sandbox.__RJ_AI_MAP__ === 'object') {
  console.log('  allowedPaths 数 = ' + sandbox.__RJ_AI_MAP__.allowedPaths().length);
}
if (!listeners.length) failed = true;

// 复现设置页的两个探针：真实走一遍监听器（用 vm 里的函数调用，保证作用域一致）
console.log('\n复现探针：');
let handled = false;
let pingOk = false;

listeners.forEach((fn) => {
  // 1) RJ_PING_BG —— 设置页用它判断「后台是否活着」
  try {
    let replied = null;
    const ret = fn({ type: 'RJ_PING_BG' }, {}, (res) => { replied = res; });
    console.log('  RJ_PING_BG  返回 ' + ret + '  回复 = ' + JSON.stringify(replied));
    if (replied && replied.ok === true) pingOk = true;
  } catch (e) {
    failed = true;
    console.log('  RJ_PING_BG 监听器抛错 ->\n    ' + (e && e.stack || e));
  }

  // 2) RJ_AI_TEST —— 「测试连接」
  try {
    const ret = fn({ type: 'RJ_AI_TEST' }, {}, (res) => {
      console.log('  RJ_AI_TEST  回调 -> ' + JSON.stringify(res).slice(0, 240));
    });
    console.log('  RJ_AI_TEST  返回 ' + ret + '（true = 会异步回）');
    if (ret === true) handled = true;
  } catch (e) {
    failed = true;
    console.log('  RJ_AI_TEST 监听器抛错 ->\n    ' + (e && e.stack || e));
  }
});
if (!handled) failed = true;
if (!pingOk) { failed = true; console.log('  ！RJ_PING_BG 没有正常回应 —— 那设置页报「后台连不上」就是误报'); }

setTimeout(() => {
  console.log('\n' + (failed ? '>>> 存在问题' : '>>> 启动与消息处理都正常 —— 后台代码本身没问题'));
  process.exit(failed ? 1 : 0);
}, 500);
