/**
 * 复现「扩展重载后，旧页面发消息」的场景。
 * 假设：重载扩展会让已打开的扩展页面失效，此时 sendMessage 报的正是
 *       "Could not establish connection. Receiving end does not exist."
 */
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshSession(browser) {
  return browser.target().createCDPSession();
}

(async () => {
  const profileDir = path.join(os.tmpdir(), 'rj-stale-' + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    ignoreDefaultArgs: ['--disable-features'],
    args: [
      `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--enable-unsafe-extension-debugging',
      '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,' +
        'ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes,DisableLoadExtensionCommandLineSwitch'
    ]
  });

  let extId = null;
  try {
    const s = await freshSession(browser);
    const res = await s.send('Extensions.loadUnpacked', { path: EXT });
    extId = res && res.id;
    console.log('扩展已加载，ID = ' + extId);
  } catch (e) {
    console.log('loadUnpacked 失败：' + String(e).slice(0, 200));
    await browser.close(); process.exit(2);
  }
  if (!extId) { await browser.close(); process.exit(2); }

  const OPTIONS_URL = `chrome-extension://${extId}/options.html`;
  await sleep(1500);

  // 开设置页
  let page = null;
  try {
    const s = await freshSession(browser);
    await s.send('Target.createTarget', { url: OPTIONS_URL });
    const t = await browser.waitForTarget((x) => x.type() === 'page' && x.url() === OPTIONS_URL, { timeout: 12000 });
    page = await t.page();
  } catch (e) {
    console.log('打开设置页失败：' + String(e).slice(0, 200));
  }
  if (!page) { await browser.close(); process.exit(2); }
  await sleep(1200);

  const send = () => page.evaluate(() => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'RJ_AI_TEST' }, (res) => {
        resolve({
          lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
          reply: res ? JSON.stringify(res).slice(0, 120) : null
        });
      });
    } catch (e) {
      resolve({ threw: String(e).slice(0, 200) });
    }
  }));

  const ctx1 = await page.evaluate(() => ({
    hasRuntime: typeof chrome !== 'undefined' && !!chrome.runtime,
    id: chrome.runtime && chrome.runtime.id
  })).catch((e) => ({ err: String(e).slice(0, 160) }));
  console.log('\n[重载前] 页面上下文：' + JSON.stringify(ctx1));
  console.log('[重载前] 发消息 -> ' + JSON.stringify(await send()));

  // 重载扩展（等价于用户在 chrome://extensions 点「重新加载」）
  console.log('\n... 现在重载扩展 ...');
  try {
    const s = await freshSession(browser);
    const res = await s.send('Extensions.loadUnpacked', { path: EXT });
    console.log('重载完成，ID = ' + (res && res.id));
  } catch (e) {
    console.log('重载失败：' + String(e).slice(0, 200));
  }
  await sleep(2000);

  const ctx2 = await page.evaluate(() => ({
    hasRuntime: typeof chrome !== 'undefined' && !!chrome.runtime,
    id: chrome.runtime && chrome.runtime.id
  })).catch((e) => ({ err: String(e).slice(0, 200) }));
  console.log('\n[重载后] 同一个旧页面：' + JSON.stringify(ctx2));
  console.log('[重载后] 同一个旧页面发消息 -> ' + JSON.stringify(await send()));

  // 新开一个设置页对比
  console.log('\n... 新开一个设置页对比 ...');
  let page2 = null;
  try {
    const s = await freshSession(browser);
    await s.send('Target.createTarget', { url: OPTIONS_URL });
    const t = await browser.waitForTarget(
      (x) => x.type() === 'page' && x.url() === OPTIONS_URL && x !== (page.target && page.target()),
      { timeout: 12000 });
    page2 = await t.page();
  } catch (e) {
    // 退路：直接取当前仍在的 options 页面里最新的那个
    const ts = browser.targets().filter((x) => x.type() === 'page' && x.url() === OPTIONS_URL);
    if (ts.length) page2 = await ts[ts.length - 1].page();
  }
  if (page2) {
    await sleep(1200);
    const send2 = () => page2.evaluate(() => new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'RJ_AI_TEST' }, (res) => {
          resolve({
            lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
            reply: res ? JSON.stringify(res).slice(0, 120) : null
          });
        });
      } catch (e) { resolve({ threw: String(e).slice(0, 200) }); }
    }));
    console.log('[新页面] 发消息 -> ' + JSON.stringify(await send2()));
  } else {
    console.log('[新页面] 没能打开');
  }

  await browser.close();
})().catch((e) => { console.error('运行异常：', String(e).slice(0, 400)); process.exit(2); });
