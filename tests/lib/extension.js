/**
 * 扩展的装配与状态管理 —— 真实站点用例靠它保证「测的是磁盘上的代码」。
 *
 * 关于「让页面跑上最新代码」这件事，踩过一次坑，记在这里免得再绕回去：
 *
 *   ❌ **不要用 `chrome.runtime.reload()`**。
 *      对「通过 CDP `Extensions.loadUnpacked` 装进来的」unpacked 扩展，reload 之后
 *      它不会正常回来，打开的所有扩展页面会变成
 *      `ERR_BLOCKED_BY_CLIENT`（Chrome 里显示「此页面已被 X 屏蔽」）。
 *      实测后果：浏览器里堆了一排列着长 ID 的报错标签，看起来像扩展坏了。
 *
 *   ✅ 正确的两条路：
 *      · **扩展没装** → `Extensions.loadUnpacked`（此时读的就是磁盘上的最新代码）
 *      · **扩展已装** → 先比对「已装版本 vs 磁盘版本」；不一致就**明确报出来**，
 *        让人去 chrome://extensions 点「重新加载」。程序化刷新不值得再冒险。
 *        至于页面里的 content script 旧了，用 `ensureContentScript`（清守卫 + 补注入）
 *        就能解决 —— 那正是 popup 里已经在用的机制。
 */
const fs = require('fs');
const path = require('path');
const C = require('./cdp.js');

const EXT_DIR = path.resolve(__dirname, '..', '..', 'extension');

/** 注入顺序必须和 popup.js 里的一致，顺序错了模块之间会拿不到彼此 */
const CONTENT_FILES = [
  'shared/profile-store.js',
  'content/debug.js',
  'content/config.js',
  'content/scanner.js',
  'content/filler.js',
  'content/matcher.js',
  'content/main.js'
];

/** 磁盘上 manifest 的版本 —— 判断「装着的扩展是不是旧代码」的依据 */
function diskVersion() {
  return JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')).version;
}

/** 从目标列表里认出本扩展的 ID */
function findExtId(targets) {
  let id = null;
  (targets || []).forEach(function (t) {
    const m = String(t.url).match(/^chrome-extension:\/\/([a-p]{32})/);
    if (m && !id) id = m[1];
  });
  return id;
}

/**
 * 按**路径**问 chrome://extensions，认出已装的扩展。
 *
 * 为什么需要它：`findExtId` 是「看有没有 chrome-extension:// 的页面目标」，
 * 而 MV3 的 Service Worker 空闲约 30 秒就会被回收、页面也未必开着 ——
 * 那时看起来像「没装」，于是会去调 `Extensions.loadUnpacked`（没必要，而且多一次冒险）。
 * 这个走的是 chrome://extensions 自己的接口，和「有没有开着页面」无关。
 *
 * @returns {Promise<{id:string, version:string, state:string}|null>}
 */
async function findInstalledId(browser) {
  const t = await browser.send('Target.createTarget', { url: 'chrome://extensions/' });
  try {
    await C.sleep(2500);
    const tgt = (await C.targets()).filter(function (x) { return x.id === t.targetId; })[0];
    if (!tgt || !tgt.webSocketDebuggerUrl) return null;
    const c = await C.connect(tgt.webSocketDebuggerUrl);
    try {
      return await C.evaluate(c, 'new Promise(function (resolve) {' +
        '  if (!chrome.developerPrivate) return resolve(null);' +
        '  chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true },' +
        '    function (all) {' +
        '      var mine = all.filter(function (x) {' +
        '        return String(x.path || "").toLowerCase() === ' + JSON.stringify(EXT_DIR.toLowerCase()) + ';' +
        '      })[0];' +
        '      resolve(mine ? { id: mine.id, version: mine.version, state: mine.state } : null);' +
        '    });' +
        '})', true);
    } finally {
      try { c.close(); } catch (e) { /* ignore */ }
    }
  } finally {
    await C.httpText('/json/close/' + t.targetId).catch(function () { /* ignore */ });
  }
}

/**
 * 保证扩展装着。返回 { id, how, version? }：
 *   how = 'already'     已在（可能是旧代码，用版本比对判断）
 *   how = 'just-loaded' 刚装（必然是磁盘上的代码）
 */
async function ensureLoaded(browser, targets) {
  // 顺序很重要：**先按路径问 chrome://extensions**，再退回「看谁开着扩展页面」。
  // 反过来的话，用户日常 profile 里只要装着别的扩展、并且恰好开着一个扩展页面，
  // findExtId 就会抓到**别人的 ID** —— 实测踩过：被认成 Chrome Web Store 的 ID，
  // 于是去打开一个不属于本扩展的 options.html，报「chrome.storage 一直不可用」。
  const installed = await findInstalledId(browser).catch(function () { return null; });
  if (installed && installed.id) {
    return { id: installed.id, how: 'already', version: installed.version, state: installed.state };
  }
  const id = findExtId(targets);
  if (id) return { id: id, how: 'already' };
  const r = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
  if (!r || !r.id) throw new Error('Extensions.loadUnpacked 没返回 id');
  return { id: r.id, how: 'just-loaded' };
}

/** 这个扩展页面对应的是不是我们要的那个扩展（ID 认错时立刻发现，而不是静默跑偏） */
async function pageExtId(conn) {
  return await C.evaluate(conn, 'chrome.runtime && chrome.runtime.id')
    .catch(function () { return null; });
}

/** 等页面上的 chrome.* API 就绪（刚创建的扩展页面可能还只是网页版的 chrome 对象） */
async function waitChromeApis(conn) {
  for (let i = 0; i < 20; i++) {
    const ok = await C.evaluate(conn,
      'typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local) && !!chrome.tabs'
    ).catch(function () { return false; });
    if (ok) return true;
    await C.sleep(400);
  }
  return false;
}

// 这个模块开出来的扩展页面都记在这儿，好在结束时一并关掉 ——
// 用例绝不能往用户的浏览器里留标签。
const opened = [];

async function openPage(browser, extId, file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = await browser.send('Target.createTarget', {
      url: 'chrome-extension://' + extId + '/' + (file || 'options.html')
    });
    opened.push(t.targetId);
    await C.sleep(1200);
    const list = await C.targets();
    const tgt = list.filter(function (x) { return x.id === t.targetId; })[0];
    if (!tgt || !tgt.webSocketDebuggerUrl) { await C.sleep(800); continue; }
    const conn = await C.connect(tgt.webSocketDebuggerUrl);
    if (await waitChromeApis(conn)) {
      // 只认「chrome.storage 可用」还不够：别的扩展同样可用。
      // 必须核对这就是我们要的那个扩展，否则后面的断言会打在别人的页面上。
      const real = await pageExtId(conn);
      if (String(real) === String(extId)) return conn;
      try { conn.close(); } catch (e) { /* ignore */ }
      throw new Error('打开的扩展页面不属于本扩展（期望 ' + extId + '，实际 ' + real + '）' +
        ' —— 扩展 ID 认错了，别继续跑');
    }
    try { conn.close(); } catch (e) { /* ignore */ }
    await C.sleep(900);
  }
  throw new Error('扩展页面打不开（chrome.storage 一直不可用）');
}

/** 关掉本模块开出来的所有扩展页面 */
async function closePages() {
  const ids = opened.splice(0, opened.length);
  for (const id of ids) {
    await C.httpText('/json/close/' + id).catch(function () { /* 已经没了就算了 */ });
  }
}

/** 已装扩展的基本状态 */
async function state(conn) {
  return await C.evaluate(conn,
    '({ version: chrome.runtime.getManifest().version, id: chrome.runtime.id })'
  ).catch(function () { return { version: '?', id: '?' }; });
}

module.exports = {
  EXT_DIR, CONTENT_FILES,
  diskVersion, findExtId, findInstalledId, ensureLoaded, openPage, closePages, waitChromeApis, state
};
