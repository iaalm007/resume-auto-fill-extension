const path = require('path');
/**
 * 极简 CDP 客户端（只用原始 WebSocket，不启用 Network 域）。
 *
 * 为什么不用 puppeteer：页面卡在一次未完成的导航里时，puppeteer 连接阶段的
 * Network.enable 会一直超时，导致根本连不上。原始协议只发我需要的命令，绕开这个问题。
 */
const http = require('http');

/**
 * 单条 CDP 命令的超时。
 *
 * 为什么给到 90 秒（一开始是 30 秒，不够）：页面**主线程被占住**时命令就不会回来，
 * 而这不一定是 bug。实测触发点：清空北森的「三级地区选择器」之后，站点要重画
 * 99 个省/区的列表，主线程被占用十几秒到几十秒，于是 chrome.tabs.sendMessage
 * 的响应迟迟不回 —— 30 秒就正好卡在边界上，报「Runtime.evaluate 超时」，
 * 看起来像我们的代码死循环，其实是对面在忙。
 */
const TIMEOUT_MS = Number(process.env.RJ_CDP_TIMEOUT_MS || 90000);

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: 9222, path: path, timeout: 8000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
  });
}

function connect(wsUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => reject(new Error('ws open timeout')), timeoutMs || 10000);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const myId = ++id;
            // 超时定时器必须**随响应一起清掉**。不清的话每次 send 都留下一个活着的句柄：
            //   1. 脚本跑完要干等 30 秒才能自然退出；
            //   2. 强制 process.exit 时 Node 会在 libuv 里断言崩溃
            //      （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）——
            //      实测就是这么来的，排查起来完全不像定时器的锅。
            const t = setTimeout(() => {
              if (pending.has(myId)) { pending.delete(myId); rej(new Error(method + ' 超时')); }
            }, TIMEOUT_MS);
            pending.set(myId, {
              res: (v) => { clearTimeout(t); res(v); },
              rej: (e) => { clearTimeout(t); rej(e); }
            });
            ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch (e) { /* ignore */ } }
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error).slice(0, 160)));
        else p.res(msg.result);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
  });
}

/** 列出所有可调试目标 */
async function targets() {
  return httpJson('/json');
}

/** 找到投递页（或任意页面）的目标 */
async function findPage(match) {
  const list = await targets();
  return list.find((t) => t.type === 'page' && (!match || t.url.indexOf(match) !== -1)) || null;
}

/** 在页面里求值 */
async function evaluate(client, expression, awaitPromise) {
  const r = await client.send('Runtime.evaluate', {
    expression: expression,
    returnByValue: true,
    awaitPromise: !!awaitPromise
  });
  if (r && r.exceptionDetails) {
    throw new Error('页面内异常：' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r && r.result ? r.result.value : undefined;
}

/**
 * 取一个返回**纯文本**的 HTTP 接口。
 * 比如 /json/close/<id> 关标签返回的是 "Target is closing"，不是 JSON ——
 * 用 httpJson 会直接 JSON.parse 报错，看着像是「关闭失败」，其实早就关掉了。
 */
function httpText(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: 9222, path: p, timeout: 8000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连到浏览器级 endpoint（用来发 Target.* / Extensions.* 这类命令） */
async function browser() {
  const v = await httpJson('/json/version');
  return connect(v.webSocketDebuggerUrl);
}

/**
 * 连到某个页面目标。三种用法都支持：
 *   page(目标对象)                     —— 通常来自 targets() / findPage()
 *   page('ws://127.0.0.1:9222/...')    —— 直接给调试地址
 *   page('zhiye.com')                  —— 按 URL 片段找
 * 一开始没区分第 2 种，结果把 ws 地址当成「URL 片段」去匹配，
 * 报「找不到页面目标：ws://...」，看着像页面没了，其实是参数形式没认出来。
 */
async function page(target) {
  if (typeof target === 'string' && /^wss?:\/\//.test(target)) return connect(target);
  const t = target && target.webSocketDebuggerUrl ? target : await findPage(target);
  if (!t) throw new Error('找不到页面目标：' + target);
  return connect(t.webSocketDebuggerUrl);
}

// ---------------------------------------------------------------- 真实鼠标
//
// 为什么测试里需要它：组件库的「清除图标」是靠 CSS `:hover` 显示的，
// 而 **CSS :hover 合成不了** —— dispatchEvent 派发的 mouseover 不会让浏览器
// 认为指针真的在元素上，`:hover` 不生效。
// CDP 的 Input.dispatchMouseEvent 走的是浏览器输入管线，产生的是**可信事件**，
// 所以能真正触发 :hover。这是测试侧的能力，扩展本身做不到（已在 README 里记为边界）。

async function mouseMove(conn, x, y) {
  await conn.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: x, y: y, button: 'none', buttons: 0, clickCount: 0
  });
}

async function mouseClick(conn, x, y) {
  await mouseMove(conn, x, y);
  await sleep(60);
  await conn.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1
  });
  await sleep(60);
  await conn.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1
  });
}

/** 把鼠标挪到「没人在意」的角落，用于关掉残留浮层 */
async function mousePark(conn) {
  await mouseMove(conn, 3, 3);
}

module.exports = {
  httpJson, httpText, connect, targets, findPage, evaluate, sleep,
  browser, page, mouseMove, mouseClick, mousePark
};
