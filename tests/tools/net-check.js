const path = require('path');
/** 探测：我这个可控 Chrome 能不能访问公网（决定能不能替用户跑真实页面） */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  for (const url of ['https://example.com', 'https://www.baidu.com']) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const title = await page.title();
      console.log('OK   ' + url + '  status=' + (resp ? resp.status() : '?') + '  title="' + title.slice(0, 40) + '"');
    } catch (e) {
      console.log('FAIL ' + url + '  -> ' + String(e && e.message || e).slice(0, 140));
    }
  }
  await browser.close();
})().catch((e) => { console.error('运行异常：', String(e).slice(0, 300)); process.exit(2); });
