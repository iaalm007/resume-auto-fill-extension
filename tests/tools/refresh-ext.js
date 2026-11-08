/**
 * 把调试浏览器里的扩展刷新成磁盘上的代码（并保留扩展存储）。
 *
 *   node tests/tools/refresh-ext.js            刷新到磁盘版本
 *   node tests/tools/refresh-ext.js --no-keep  不保留存储
 *
 * 为什么不用 `chrome.developerPrivate.reload`（ext-state.js --reload 就是它）：
 * 在 Chrome 156 + 日常 profile 上实测**会把扩展刷成 DISABLED，且版本不跟磁盘走**。
 * 之后 `chrome.management.setEnabled(true)` 能救回 ENABLED，但代码仍是旧的；
 * 禁用→启用来回切也一样。也就是说那条路在这台机器上是坏的（README 里那句
 * 「实测有效」只对当时那台机器成立，别再当通用结论）。
 *
 * 实测可行的办法：`Extensions.loadUnpacked` 装一个**新实例**（必然读磁盘最新代码），
 * 把旧实例的存储搬过去，再把旧实例 `Extensions.uninstall` 掉。
 * 副作用是扩展 ID 会变 —— 所以所有测试都按**目录路径**认扩展，不写死 ID。
 */
const C = require('../lib/cdp.js');
const E = require('../lib/extension.js');

const KEEP_STORAGE = process.argv.indexOf('--no-keep') === -1;

/** 按路径列出已装实例（可能有重复安装，同一目录装了两次） */
async function listByPath(browser) {
  const t = await browser.send('Target.createTarget', { url: 'chrome://extensions/' });
  await C.sleep(2600);
  const tgt = (await C.targets()).filter(function (x) { return x.id === t.targetId; })[0];
  if (!tgt || !tgt.webSocketDebuggerUrl) throw new Error('chrome://extensions 打不开');
  const c = await C.connect(tgt.webSocketDebuggerUrl);
  try {
    const want = E.EXT_DIR.toLowerCase();
    const all = await C.evaluate(c, 'new Promise(function (res) {' +
      '  chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true },' +
      '    function (all) { res(all.map(function (x) {' +
      '      return { id: x.id, name: x.name, version: x.version, state: x.state, path: String(x.path || "") };' +
      '    })); });' +
      '})', true);
    return (all || []).filter(function (x) { return String(x.path).toLowerCase() === want; });
  } finally {
    await C.httpText('/json/close/' + t.targetId).catch(function () { });
    try { c.close(); } catch (e) { /* ignore */ }
  }
}

(async () => {
  const disk = E.diskVersion();
  const browser = await C.browser();
  try {
    const before = await listByPath(browser);
    console.log('磁盘版本：' + disk);
    before.forEach(function (x) {
      console.log('  已装：' + x.version + ' · ' + x.state + ' · ' + x.id);
    });

    const good = before.filter(function (x) { return String(x.version) === String(disk); });
    if (good.length === 1 && before.length === 1) {
      console.log('✅ 已经是磁盘上的代码，且只有一个实例，不用刷');
      console.log('扩展 ID：' + good[0].id + '（状态 ' + good[0].state + '）');
      return;
    }
    if (good.length > 1) {
      console.log('⚠️ 同一个目录装了 ' + good.length + ' 份同版本扩展，会重复注入 —— 需要清理');
    }

    // 1) 备份存储（简历 / AI 配置都在这儿，别弄丢）
    // storageArea 不能省：只传 {id} 会报 "Failed to deserialize parameters"（实测）
    let backup = null;
    const src = (good[0] || before[0] || {}).id;
    if (KEEP_STORAGE && src) {
      backup = await browser.send('Extensions.getStorageItems', { id: src, storageArea: 'local' })
        .catch(function (e) { console.log('读旧存储失败（跳过备份）：' + String(e.message).slice(0, 80)); return null; });
      try {
        const n = backup && backup.data ? Object.keys(backup.data).length : 0;
        console.log('旧存储备份：' + n + ' 个键');
      } catch (e) { /* ignore */ }
    }

    // 2) 装新实例（读的一定是磁盘上的代码）
    const r = await browser.send('Extensions.loadUnpacked', { path: E.EXT_DIR });
    if (!r || !r.id) throw new Error('Extensions.loadUnpacked 没返回 id');
    const newId = r.id;
    await C.sleep(1800);
    console.log('已装入新实例：' + newId);

    // 3) 把存储搬过去
    if (backup && backup.data) {
      const w = await browser.send('Extensions.setStorageItems',
        { id: newId, values: backup.data, storageArea: 'local' })
        .catch(function (e) { return { err: String(e.message).slice(0, 80) }; });
      console.log('存储迁移：' + (w && w.err ? '失败 ' + w.err : 'ok'));
    }

    // 4) 核对新实例的版本，再把旧实例卸掉（否则两个实例会同时注入 content script）
    const after = await listByPath(browser);
    const installed = after.filter(function (x) { return x.id === newId; })[0];
    if (!installed) throw new Error('装完却查不到新实例');
    console.log('新实例：' + installed.version + ' · ' + installed.state);
    if (String(installed.version) !== String(disk)) {
      throw new Error('新实例版本是 ' + installed.version + '，磁盘是 ' + disk);
    }

    for (const old of after) {
      if (old.id === newId) continue;
      const u = await browser.send('Extensions.uninstall', { id: old.id })
        .catch(function (e) { return { err: String(e.message).slice(0, 80) }; });
      console.log('卸载旧实例 ' + old.version + ' / ' + old.id + '：' + (u && u.err ? '失败 ' + u.err : 'ok'));
    }

    const left = await listByPath(browser);
    console.log('剩余实例：' + left.length + ' 个' +
      left.map(function (x) { return ' [' + x.version + ' ' + x.state + ']'; }).join(''));
    if (left.length !== 1) {
      console.log('❌ 仍然不是唯一实例，请到 chrome://extensions 手工清理');
      process.exitCode = 1;
    } else {
      console.log('✅ 完成，扩展 ID：' + left[0].id + '（版本 ' + left[0].version + '）');
    }
  } finally {
    try { browser.close(); } catch (e) { /* ignore */ }
  }
  process.exit(process.exitCode || 0);
})().catch(function (e) {
  console.log('失败：' + String((e && e.message) || e).slice(0, 300));
  process.exit(1);
});
