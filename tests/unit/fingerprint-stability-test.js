/**
 * 指纹稳定性：同一个字段，在同一页面上扫描两次，指纹必须一样 ——
 * 否则 AI 缓存永远命不中，每次扫描都要发一次请求，配额很快见底。
 *
 * 重点模拟真实框架的行为：聚焦、填写、校验都会往元素上加减 class。
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="ant-form">
  <!-- 3 个标签不可信的字段：它们的指纹会掺入「站点 + 结构签名」 -->
  <div class="ant-form-item"><div class="ant-form-item-control">
    <div class="ant-form-item-control-input"><input id="w1" class="ant-input" placeholder="请输入" /></div>
  </div></div>
  <div class="ant-form-item"><div class="ant-form-item-control">
    <div class="ant-form-item-control-input"><input id="w2" class="ant-input" placeholder="请输入" /></div>
  </div></div>
  <div class="ant-form-item"><div class="ant-form-item-control">
    <div class="ant-form-item-control-input"><input id="w3" class="ant-input" placeholder="请输入" /></div>
  </div></div>
  <!-- 一个有真标签的字段：指纹应当跨站点稳定 -->
  <div class="ant-form-item"><div class="label">姓名</div><div class="ant-form-item-control">
    <div class="ant-form-item-control-input"><input id="s1" class="ant-input" placeholder="请输入" /></div>
  </div></div>
</div>
</body></html>`;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

async function scan(page) {
  await page.evaluate(() => {
    delete window.__RJ_SCANNER__; delete window.__RJ_CONFIG__; delete window.__RJ_MATCHER__;
  });
  for (const f of ['content/config.js', 'content/scanner.js', 'content/matcher.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), 'utf8') });
  }
  return page.evaluate(() => {
    const SCAN = window.__RJ_SCANNER__;
    const out = {};
    SCAN.scanAll().forEach((f) => {
      const e = SCAN.getEntry(f.id);
      const el = e && (e.el || (e.group && e.group[0]));
      if (el && el.id) out[el.id] = { fp: f.fingerprint, label: f.labelText, src: f.labelSource };
    });
    return out;
  });
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e).slice(0, 200)));
  await page.setContent(HTML, { waitUntil: 'domcontentloaded' });

  console.log('--- 第 1 次扫描（页面原始状态）---');
  const s1 = await scan(page);
  Object.keys(s1).forEach((k) => console.log('  ' + k + '  fp=' + s1[k].fp + '  src=' + s1[k].src));

  console.log('\n--- 模拟框架的日常动作后，第 2 次扫描 ---');
  console.log('    （聚焦加 class、填了值、校验态、加个错误提示，全是最常见的前端行为）');
  await page.evaluate(() => {
    // 1. 聚焦：AntD / Element 一定会往元素和包裹层加状态类
    document.getElementById('w1').classList.add('ant-input-focused');
    document.getElementById('w1').closest('.ant-form-item').classList.add('ant-form-item-has-focus');
    // 2. 输入后加 has-value 类 + 真的填了值
    document.getElementById('w2').value = '一些已经填过的内容';
    document.getElementById('w2').classList.add('ant-input-filled');
    document.getElementById('w2').closest('.ant-form-item').classList.add('ant-form-item-has-value');
    // 3. 校验失败：加错误类 + 插一条错误提示
    document.getElementById('w3').classList.add('ant-input-status-error');
    const tip = document.createElement('div');
    tip.className = 'ant-form-item-explain-error';
    tip.textContent = '此项必填';
    document.getElementById('w3').closest('.ant-form-item-control').appendChild(tip);
    // 把焦点移走
    document.getElementById('s1').focus();
    document.getElementById('s1').blur();
  });
  const s2 = await scan(page);
  Object.keys(s2).forEach((k) => console.log('  ' + k + '  fp=' + s2[k].fp + '  src=' + s2[k].src));

  console.log('\n--- 对比 ---');
  const keys = Object.keys(s1);
  let unstable = [];
  keys.forEach((k) => {
    const same = s1[k].fp === s2[k].fp;
    console.log('  ' + k + '  ' + (same ? '一致 ' : '**变了**') +
      '  ' + s1[k].fp + (same ? '' : '  ->  ' + s2[k].fp));
    if (!same) unstable.push(k);
  });

  check('有真标签的字段指纹稳定', s1.s1.fp === s2.s1.fp, s1.s1.fp + ' vs ' + s2.s1.fp);
  check('标签不可信的字段指纹也要稳定（否则缓存永远不命中）',
    unstable.every((k) => k === 's1'), '波动的字段：' + unstable.join(','));
  check('3 个弱标签字段的指纹互不相同（不会互相串答案）',
    new Set(['w1', 'w2', 'w3'].map((k) => s1[k].fp)).size === 3);

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('>>> 指纹不稳 = AI 缓存每次都 miss = 每次扫描都发请求 = 配额被打满');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
