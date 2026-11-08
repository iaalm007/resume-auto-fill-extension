/**
 * 扩展状态体检：门禁跑之前先看这个，能一眼看出「环境哪一项没准备好」。
 *
 *   node tools/ext-state.js            只报告
 *   node tools/ext-state.js --load     没装的话装上（装的是磁盘上的最新代码）
 *   node tools/ext-state.js --reload   把装着的扩展刷成磁盘上的代码，并核对版本真的变了
 */
const C = require('../lib/cdp.js');
const E = require('../lib/extension.js');

const LOAD = process.argv.indexOf('--load') !== -1;
const RELOAD = process.argv.indexOf('--reload') !== -1;

/**
 * 用 chrome://extensions 上那个「重新加载」按钮背后的接口刷新扩展。
 *
 * 为什么是这个接口而不是 `chrome.runtime.reload()`：
 * 后者实测会把通过 CDP 装进来的 unpacked 扩展弄成 DISABLED（页面全变 ERR_BLOCKED_BY_CLIENT）。
 * `chrome.developerPrivate.reload` 才是 UI 自己用的那条路 —— 实测调用后
 * 扩展保持 ENABLED、版本立刻跟上磁盘。
 * 而且**每次都核对结果**（轮询到版本一致为止），不假设调用成功就等于刷新成功。
 */
async function reloadExtension(browser, wantVersion) {
  const t = await browser.send('Target.createTarget', { url: 'chrome://extensions/' });
  await C.sleep(2800);
  const tgt = (await C.targets()).filter(function (x) { return x.id === t.targetId; })[0];
  if (!tgt || !tgt.webSocketDebuggerUrl) throw new Error('chrome://extensions 打不开');
  const c = await C.connect(tgt.webSocketDebuggerUrl);

  const INFO = 'new Promise(function (resolve) {' +
    '  chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true },' +
    '    function (all) {' +
    '      var mine = all.filter(function (x) {' +
    '        return String(x.path || "").toLowerCase() === ' + JSON.stringify(E.EXT_DIR.toLowerCase()) + ';' +
    '      })[0];' +
    '      resolve(mine ? { id: mine.id, version: mine.version, state: mine.state } : null);' +
    '    });' +
    '})';

  try {
    const before = await C.evaluate(c, INFO, true);
    if (!before) throw new Error('chrome://extensions 列表里找不到这个路径的扩展');
    console.log('刷新前：版本 ' + before.version + ' · 状态 ' + before.state);
    if (String(before.version) === String(wantVersion)) {
      console.log('已经是最新代码，不用刷');
      return { ok: true, id: before.id };
    }
    const r = await C.evaluate(c,
      'new Promise(function (resolve) {' +
      '  try {' +
      '    chrome.developerPrivate.reload(' + JSON.stringify(before.id) + ', function () {' +
      '      resolve(chrome.runtime.lastError ? ("lastError: " + chrome.runtime.lastError.message) : "ok");' +
      '    });' +
      '  } catch (e) { resolve("抛错: " + e.message); }' +
      '})', true);
    console.log('reload 调用：' + JSON.stringify(r));

    for (let i = 0; i < 8; i++) {
      await C.sleep(1500);
      const now = await C.evaluate(c, INFO, true).catch(function () { return null; });
      if (now && String(now.version) === String(wantVersion)) {
        console.log('刷新后：版本 ' + now.version + ' · 状态 ' + now.state + '  ✓ 与磁盘一致');
        return { ok: true, id: before.id };
      }
      if (now) console.log('  等待中…版本 ' + now.version + ' · 状态 ' + now.state);
    }
    console.log('❌ 刷新后版本仍不是 ' + wantVersion + ' —— 到 chrome://extensions 手工点一下「重新加载」');
    return { ok: false, id: before.id };
  } finally {
    await C.httpText('/json/close/' + t.targetId).catch(function () { /* ignore */ });
    try { c.close(); } catch (e) { /* ignore */ }
  }
}

(async () => {
  let targets;
  try {
    const v = await C.httpJson('/json/version');
    console.log('浏览器：' + String(v.Browser || '').slice(0, 50));
    targets = await C.targets();
  } catch (e) {
    console.log('❌ 连不上调试端口 127.0.0.1:9222');
    process.exit(2);
  }

  const disk = E.diskVersion();
  console.log('磁盘版本：' + disk + '   （' + E.EXT_DIR + '）');

  const browser = await C.browser();

  // --reload：把装着的扩展刷成磁盘上的代码。
  // 门禁会因为「已装版本 ≠ 磁盘版本」而跳过，这时先刷一下再跑。
  let reloadedId = null;
  if (RELOAD) {
    const r = await reloadExtension(browser, disk).catch(function (e) {
      console.log('刷新失败：' + String((e && e.message) || e).slice(0, 140));
      return null;
    });
    if (!r || !r.ok) {
      try { browser.close(); } catch (e) { /* ignore */ }
      process.exit(1);
    }
    reloadedId = r.id;
  }

  // 先按路径问（准确），再退回「看谁开着扩展页面」。
  // 反过来的话，日常 profile 里别的扩展开着页面时 findExtId 会抓到别人的 ID —— 实测踩过。
  let id = reloadedId;
  if (!id) {
    const installed = await E.findInstalledId(browser).catch(function () { return null; });
    if (installed && installed.id) {
      id = installed.id;
      console.log('（按路径认出已装：' + installed.state + '）');
    }
  }
  // --load 时不走 findExtId：它认不准（会抓到别人的扩展页面），
  // 而「没装」正是 --load 该干活的时候。
  if (!id && !LOAD) id = E.findExtId(targets);
  if (!id && LOAD) {
    const r = await E.ensureLoaded(browser, targets);
    id = r.id;
    console.log('已装入扩展：' + id);
  }
  if (!id) {
    console.log('❌ 浏览器里没装本扩展');
    console.log('   → 打开 chrome://extensions → 开发者模式 → 加载已解压的扩展 → 选 ' + E.EXT_DIR);
    console.log('   → 或跑：node tools/ext-state.js --load');
    process.exit(2);
  }
  console.log('扩展 ID：' + id);

  const ext = await E.openPage(browser, id);
  const st = await E.state(ext);
  console.log('已装版本：' + st.version + '  ' +
    (String(st.version) === String(disk) ? '✓ 和磁盘一致' : '⚠️ 与磁盘不一致（扩展是旧代码，去 chrome://extensions 点「重新加载」）'));

  const info = await C.evaluate(ext,
    'chrome.storage.local.get(null).then(function (o) {' +
    '  var id = o.rj_active_resume;' +
    '  var r = id ? o["rj_resume_" + id] : null;' +
    '  var ai = o.rj_ai_config || {};' +
    '  var rate = o.rj_ai_rate || null;' +
    '  var cd = o.rj_ai_cooldown || null;' +
    '  var cache = o.rj_ai_cache || {};' +
    '  return {' +
    '    name: r ? r.profile.basic.name : null,' +
    '    edu: r ? (r.profile.education || []).length : 0,' +
    '    exp: r ? (r.profile.experience || []).length : 0,' +
    '    prj: r ? (r.profile.projects || []).length : 0,' +
    '    aiEnabled: !!ai.enabled,' +
    '    aiModel: ai.model || "(未配置)",' +
    '    aiBase: String(ai.baseUrl || "(未配置)").replace(/^https?:\\/\\//, ""),' +
    '    aiHasKey: !!ai.apiKey,' +
    '    aiMaxFields: ai.maxFieldsPerCall || 0,' +
    '    rateCount: rate ? rate.count : 0,' +
    '    cooldownSec: cd ? Math.max(0, Math.round((cd.until - Date.now()) / 1000)) : 0,' +
    '    cacheN: Object.keys(cache).length' +
    '  };' +
    '})', true).catch(function (e) { return { __err: String(e.message || e) }; });

  if (info && info.__err) {
    console.log('❌ 读存储失败：' + info.__err.slice(0, 120));
  } else {
    if (!info || !String(info.name || '').trim()) {
      console.log('⚠️ 存储里没有简历（门禁会自动导入项目根目录的 PDF）');
    } else {
      console.log('简历：' + info.name + '  教育 ' + info.edu + ' · 工作 ' + info.exp +
        ' · 项目 ' + info.prj);
    }
    // AI 配置：这里只报「模型 / 地址 / 有没有 Key」，**绝不打印 Key 本身**
    console.log('AI：' + (info.aiEnabled ? '已启用' : '未启用') +
      ' · 模型 ' + info.aiModel + ' · 地址 ' + info.aiBase +
      ' · Key ' + (info.aiHasKey ? '已配置' : '未配置') +
      ' · 单次最多 ' + info.aiMaxFields + ' 字段 · 缓存 ' + info.cacheN + ' 条');
    console.log('限流状态：本分钟已发 ' + info.rateCount + ' 次' +
      (info.cooldownSec ? '，冷却中还剩 ' + info.cooldownSec + ' 秒（说明刚被接口限过）' : '，无冷却'));
  }

  // 页面里的 content script 活着吗
  const formTab = targets.filter(function (t) {
    return t.type === 'page' && /zhiye\.com/.test(String(t.url));
  })[0];
  if (!formTab) {
    console.log('⚠️ 没找到投递页标签（门禁会跳过）。请把投递页打开并登录。');
  } else {
    const tabId = await C.evaluate(ext,
      'chrome.tabs.query({ url: "*://*.zhiye.com/*" }).then(function (t) { return t[0] && t[0].id; })', true);
    const alive = await C.evaluate(ext,
      'chrome.tabs.sendMessage(' + tabId + ', {type:"RJ_PING"})' +
      '.then(function (r) { return !!(r && r.ok); }, function () { return false; })', true)
      .catch(function () { return false; });
    console.log('投递页：tabId=' + tabId + '  content script ' + (alive ? '在' : '不在（门禁会自动补注入）'));
  }

  await E.closePages();
  ext.close();
  browser.close();
})().catch(async (e) => {
  console.log('异常：' + String((e && e.stack) || e).slice(0, 500));
  await E.closePages().catch(function () { });
  process.exit(1);
});
