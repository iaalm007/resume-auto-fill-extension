/** scanner.js 回归：标签推断（12 种结构 + 反面对照）+ 指纹/缓存键 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="form-item"><div class="label">姓名</div><div class="control"><div class="inner"><input id="c1" placeholder="请输入" /></div></div></div>
<div class="ant-form-item">
  <div class="ant-form-item-label"><label>手机号码</label></div>
  <div class="ant-form-item-control"><div class="ant-form-item-control-input"><input id="c2" placeholder="请输入" /></div></div>
</div>
<table><tr><td>电子邮箱</td><td><input id="c3" placeholder="请输入" /></td></tr></table>
<div class="row4">出生日期<input id="c4" placeholder="请选择" /></div>
<label>身份证号 <input id="c5" placeholder="请输入" /></label>
<label for="c6">现居住地</label><input id="c6" placeholder="请输入" />
<div class="form-item">
  <div class="label">性别</div>
  <div class="options"><label><input type="radio" name="g7" value="M" />男</label><label><input type="radio" name="g7" value="F" />女</label></div>
</div>
<div class="ant-form-item">
  <div class="ant-form-item-label"><label>政治面貌</label></div>
  <div class="ant-form-item-control"><div class="ant-radio-group">
    <label class="ant-radio-wrapper"><span><input type="radio" name="g8" value="a" /></span><span>群众</span></label>
    <label class="ant-radio-wrapper"><span><input type="radio" name="g8" value="b" /></span><span>中共党员</span></label>
  </div></div>
</div>
<div class="form-item">
  <div class="label">求职身份</div>
  <div class="opts9"><div><input type="radio" name="g9" value="1" /><span>在校生</span></div><div><input type="radio" name="g9" value="2" /><span>社会人员</span></div></div>
</div>
<div class="form-item"><div class="label">自我评价</div><div class="control"><textarea id="c10" placeholder="请输入"></textarea></div></div>
<div class="form-item"><div class="label">所在城市</div><div class="control"><select id="c11"><option value="bj">北京</option><option value="sh">上海</option></select></div></div>
<div class="form-item"><div class="label">姓名</div><div class="control"><input id="c12a" placeholder="请输入" /></div></div>
<div class="form-item"><div class="label">电话</div><div class="control"><input id="c12b" placeholder="请输入" /></div></div>
<div class="form-item"><div class="control"><input id="p1" placeholder="请输入" /></div></div>
<div class="form-item"><div class="control"><input id="p2" placeholder="请输入" /></div></div>
<div class="form-item">
  <div class="opts"><label><input type="radio" name="ra" value="1" />是</label><label><input type="radio" name="ra" value="2" />否</label></div>
</div>
<div class="form-item">
  <div class="opts"><label><input type="radio" name="rb" value="1" />是</label><label><input type="radio" name="rb" value="2" />否</label></div>
</div>
</body></html>`;

// 有真标签的「姓名」，两个页面外层结构完全不同 —— 指纹应当一致
const PAGE_B = `<!doctype html><html><body>
<div class="site-b-form"><div class="label">姓名</div><div class="ctl"><input id="b1" placeholder="请输入" /></div></div>
</body></html>`;
const PAGE_C = `<!doctype html><html><body>
<table><tr><td>姓名</td><td><input id="c1" placeholder="请输入" /></td></tr></table>
</body></html>`;

const CASES = [
  { id: 'c1', label: '姓名', path: 'basic.name' },
  { id: 'c2', label: '手机号码', path: 'basic.phone' },
  { id: 'c3', label: '电子邮箱', path: 'basic.email' },
  { id: 'c4', label: '出生日期', path: 'basic.birthday' },
  { id: 'c5', label: '身份证号', path: 'basic.idCard' },
  { id: 'c6', label: '现居住地', path: 'basic.location' },
  { id: 'g7', label: '性别', path: 'basic.gender', options: '男/女' },
  { id: 'g8', label: '政治面貌', path: 'basic.politicalStatus', options: '群众/中共党员' },
  { id: 'g9', label: '求职身份', path: null, options: '在校生/社会人员' },
  { id: 'c10', label: '自我评价', path: 'selfEvaluation' },
  { id: 'c11', label: '所在城市', path: 'basic.location', options: '北京/上海' },
  { id: 'c12b', label: '电话', path: 'basic.phone' }
];

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

async function inject(page) {
  await page.evaluate(() => {
    delete window.__RJ_SCANNER__; delete window.__RJ_CONFIG__; delete window.__RJ_MATCHER__;
  });
  for (const f of ['content/config.js', 'content/scanner.js', 'content/matcher.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), 'utf8') });
  }
}

async function scan(page) {
  return page.evaluate(() => {
    const SCAN = window.__RJ_SCANNER__, M = window.__RJ_MATCHER__, CFG = window.__RJ_CONFIG__;
    const res = {};
    SCAN.scanAll().forEach((f) => {
      const m = M.matchField(f, CFG.fieldRules);
      const e = SCAN.getEntry(f.id);
      const node = e && (e.el || (e.group && e.group[0]));
      const key = f.type === 'radio-group' ? f.attrs.name : ((node && node.id) || f.id);
      res[key] = {
        label: f.labelText, source: f.labelSource, fp: f.fingerprint, type: f.type,
        path: m ? m.path : null, options: (f.options || []).map((o) => o.text).join('/')
      };
    });
    return res;
  });
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e && e.stack || e).slice(0, 400)));

  console.log('--- 标签推断 ---');
  await page.setContent(HTML, { waitUntil: 'domcontentloaded' });
  await inject(page);
  const res = await scan(page);

  CASES.forEach((c) => {
    const g = res[c.id];
    if (!g) { check(c.id + ' 存在', false, '没扫到'); return; }
    check(c.id + ' 标签 = ' + c.label, g.label === c.label, '实际 "' + g.label + '"');
    check(c.id + ' 标签来源有效', g.source !== 'placeholder' && g.source !== 'none', '实际 ' + g.source);
    if (c.path) check(c.id + ' 匹配 -> ' + c.path, g.path === c.path, '实际 ' + g.path);
    if (c.options) check(c.id + ' 候选项 = ' + c.options, g.options === c.options, '实际 "' + g.options + '"');
  });

  check('p1 无标签时如实回退到 placeholder', res.p1 && res.p1.source === 'placeholder', res.p1 && res.p1.source);
  check('p1 不该匹配到任何字段', res.p1 && res.p1.path === null, res.p1 && res.p1.path);
  check('p2 不偷隔壁字段的标签', res.p2 && res.p2.label === '请输入', res.p2 && res.p2.label);
  check('无标题单选组不会被标成选项名',
    res.ra && res.ra.label === '' && res.rb && res.rb.label === '',
    'ra="' + (res.ra && res.ra.label) + '" rb="' + (res.rb && res.rb.label) + '"');

  console.log('\n--- 指纹 / 缓存键 ---');
  const weakFps = ['p1', 'p2', 'ra', 'rb'].map((k) => res[k] && res[k].fp);
  check('弱标签字段之间指纹互不相同', new Set(weakFps).size === weakFps.length, weakFps.join(','));
  const cache = {};
  cache[weakFps[0]] = { path: 'basic.name' };
  check('第一个字段的答案不会泄漏给其它字段',
    weakFps.slice(1).every((fp) => cache[fp] === undefined));

  await page.setContent(PAGE_B, { waitUntil: 'domcontentloaded' });
  await inject(page);
  const b = await scan(page);
  await page.setContent(PAGE_C, { waitUntil: 'domcontentloaded' });
  await inject(page);
  const c = await scan(page);
  check('B/C 标签都识别正确', b.b1 && b.b1.label === '姓名' && c.c1 && c.c1.label === '姓名',
    (b.b1 && b.b1.label) + ' / ' + (c.c1 && c.c1.label));
  check('标签可信时指纹跨站点一致（缓存复用没被破坏）', b.b1 && c.c1 && b.b1.fp === c.c1.fp,
    (b.b1 && b.b1.fp) + ' vs ' + (c.c1 && c.c1.fp));
  check('弱标签指纹含站点，不会跨站互认', res.p1 && b.b1 && res.p1.fp !== b.b1.fp);

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
