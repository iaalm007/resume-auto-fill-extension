/**
 * 后台 Service Worker 体检：
 *   1. 加载扩展，主动发一条消息把 SW 唤醒（MV3 的 SW 是惰性的，不碰它不会起）
 *   2. 复现「测试连接」的调用，看 lastError 到底是什么
 *   3. 抓 SW 里的启动期报错
 */
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profileDir = path.join(os.tmpdir(), 'rj-sw-profile-' + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    ignoreDefaultArgs: ['--disable-features'],
    args: [
      `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
      '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,' +
        'ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes,DisableLoadExtensionCommandLineSwitch'
    ]
  });

  const cdpBrowser = await browser.target().createCDPSession();
  let extId = null;
  try {
    const res = await cdpBrowser.send('Extensions.loadUnpacked', { path: EXT });
    extId = res && res.id;
    console.log('扩展已加载，ID = ' + extId);
  } catch (e) {
    console.log('CDP loadUnpacked 失败：' + String(e).slice(0, 300));
    await browser.close();
    process.exit(2);
  }

  const OPTIONS_URL = `chrome-extension://${extId}/options.html`;
  await sleep(2000);

  // 打开设置页（这一步同时会唤醒 SW）
  let page = null;
  for (let i = 0; i < 25 && !page; i++) {
    const t = browser.targets().find((x) => x.type() === 'page' && x.url() === OPTIONS_URL);
    if (t) { page = await t.page(); console.log('（复用扩展自动打开的设置页）'); break; }
    await sleep(300);
  }
  if (!page) {
    try {
      await cdpBrowser.send('Target.createTarget', { url: OPTIONS_URL });
      const t = await browser.waitForTarget((x) => x.type() === 'page' && x.url() === OPTIONS_URL, { timeout: 12000 });
      page = await t.page();
      console.log('（通过 CDP 打开了设置页）');
    } catch (e) {
      console.log('打开设置页失败：' + String(e).slice(0, 200));
    }
  }
  if (!page) { await browser.close(); process.exit(2); }
  page.on('pageerror', (e) => console.log('  [options page error]', String(e && e.stack || e).slice(0, 300)));
  await sleep(1500);

  const extCtx = await page.evaluate(() => ({
    hasChromeRuntime: typeof chrome !== 'undefined' && !!chrome.runtime,
    id: chrome.runtime && chrome.runtime.id,
    hasStore: typeof window.__RJ_STORE__,
    hasAi: typeof window.__RJ_AI__,
    hasFileText: typeof window.__RJ_FILE_TEXT__
  }));
  console.log('\n设置页环境：' + JSON.stringify(extCtx));

  // 复现「测试连接」
  const reply = await page.evaluate(() => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'RJ_AI_TEST' }, (res) => {
        resolve({
          lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
          gotReply: !!res,
          replyKeys: res ? Object.keys(res) : null,
          error: res && res.error ? String(res.error).slice(0, 200) : null
        });
      });
    } catch (e) {
      resolve({ threw: String(e).slice(0, 300) });
    }
  }));
  console.log('\n「测试连接」→ RJ_AI_TEST 的结果：');
  console.log(JSON.stringify(reply, null, 1));

  // SW 现在应该被唤醒了
  await sleep(1500);
  let swTarget = browser.targets().find((t) => t.type() === 'service_worker' && /background\.js/.test(t.url()));
  console.log('\nservice worker target：' + (swTarget ? swTarget.url() : '（仍然没有）'));

  if (swTarget) {
    const worker = await swTarget.worker();
    const session = await worker.createCDPSession();
    const errors = [];
    session.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      errors.push('EXCEPTION: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
    });
    await session.send('Runtime.enable').catch(() => {});
    await worker.evaluate(() => 1).catch((e) => errors.push('evaluate: ' + String(e).slice(0, 400)));
    await sleep(600);
    const probe = await worker.evaluate(() => ({
      hasAIConfig: typeof self.__RJ_AI__,
      hasStore: typeof self.__RJ_STORE__,
      hasAiMap: typeof self.__RJ_AI_MAP__,
      allowedPathCount: (function () {
        try { return self.__RJ_AI_MAP__.allowedPaths().length; } catch (e) { return 'ERR ' + e.message; }
      })()
    })).catch((e) => ({ evalError: String(e).slice(0, 400) }));
    console.log('\nSW 内部状态：' + JSON.stringify(probe));
    console.log('SW 报错：' + (errors.length ? '\n  ' + errors.join('\n  ') : '（无）'));
  } else {
    console.log('SW 没起来 —— 后台脚本很可能在启动时就抛错了');
  }

  await browser.close();
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
