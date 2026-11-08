/** 先自己验一遍 examples/verify.html，确认交给用户时是「全对」 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 用扩展自带的演示页当固定 fixture（它在 extension/examples/ 里，是项目的一部分）
const PAGE = 'file:///' + path.resolve(__dirname, '..', '..', 'extension', 'examples', 'verify.html').replace(/\\/g, '/');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#tbl tbody tr').length > 5, { timeout: 10000 });

  const snap = await page.evaluate(() => ({
    total: document.getElementById('s-total').textContent,
    matched: document.getElementById('s-matched').textContent,
    weak: document.getElementById('s-weak').textContent,
    verdict: document.getElementById('s-verdict').textContent,
    verdictCls: document.getElementById('s-verdict').className,
    engine: document.getElementById('engine').textContent,
    badPills: document.querySelectorAll('#tbl .pill.bad').length,
    rows: Array.from(document.querySelectorAll('#tbl tbody tr')).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent.trim()))
  }));

  console.log('\n页面自报：' + snap.engine);
  console.log('结论：' + snap.verdict + '  [' + snap.verdictCls + ']');
  console.log('\n字段明细（# / 标签 / 来源 / 匹配到 / 置信度）：');
  snap.rows.forEach((r) => console.log('  ' + r.join('  |  ')));

  check('页面无 JS 报错', errs.length === 0, errs.join(' | '));
  check('结论是「全对」', snap.verdict === '全对', snap.verdict);
  check('没有任何一行被判为不对', snap.badPills === 0, snap.badPills + ' 个');
  // 13 个单输入（含 select / textarea）+ 2 个单选组 = 15
  check('识别到 15 个字段', snap.total === '15', snap.total);
  // 未命中的 2 个： v7「紧急联络方式」是词典缺口、v11 压根没标签
  check('规则命中 13 个，剩 2 个留给 AI', snap.matched === '13', snap.matched);

  // 关键：标签抓对了没有
  const labels = await page.evaluate(() => {
    const out = {};
    for (const id of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v9', 'v12', 'v13']) {
      const r = Array.from(document.querySelectorAll('#tbl tbody tr')).find((tr) => tr.children[0].textContent.trim() === id);
      out[id] = r ? r.children[1].textContent.trim() : '(缺)';
    }
    return out;
  });
  check('v1 姓名', labels.v1 === '姓名', labels.v1);
  check('v2 手机号码', labels.v2 === '手机号码', labels.v2);
  check('v4 出生日期', labels.v4 === '出生日期', labels.v4);
  check('v7 紧急联络方式（词典缺口，应留给 AI）', labels.v7 === '紧急联络方式', labels.v7);
  check('v13 电话（污染对照，没被标成姓名）', labels.v13 === '电话', labels.v13);

  const payload = await page.evaluate(() => document.getElementById('payload').textContent);
  console.log('\n发给模型的内容片段：\n' + payload.slice(0, 700) + '\n  …');
  check('待发内容里带了 DOM 骨架', /第0层/.test(payload) && /第1层/.test(payload));
  check('待发内容里带了 resolvedExamples', /resolvedExamples/.test(payload));
  check('待发内容里不含表单里已填的值（哨兵）', payload.indexOf('13900001111') === -1, '哨兵出现了');
  check('待发内容里不含简历里的任何值',
    payload.indexOf('张三') === -1 && payload.indexOf('13800002222') === -1);
  check('无标签字段如实标记为 placeholder',
    (payload.match(/"labelSource": ?"placeholder"/g) || []).length >= 1);

  console.log('\n--- 执行填充 ---');
  await page.evaluate(() => document.getElementById('btn-fill').click());
  await page.waitForFunction(() => document.querySelectorAll('#fres tbody tr').length > 3, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 900));   // 越过受控组件的回滚周期

  const filled = await page.evaluate(() => {
    const g = (id) => (document.getElementById(id) || {}).value;
    const radio = document.querySelector('input[name="sex"]:checked');
    return {
      name: g('v1'), phone: g('v2'), email: g('v3'), birthday: g('v4'), city: g('v8'),
      wechat: g('v10'), untouched: g('v11'), gender: radio ? radio.value : null,
      rollbackNote: document.getElementById('rollback').textContent.trim(),
      failPills: document.querySelectorAll('#fres .pill.bad').length,
      okPills: document.querySelectorAll('#fres .pill.ok').length
    };
  });
  console.log('  表单现在的值：' + JSON.stringify({
    name: filled.name, phone: filled.phone, email: filled.email,
    birthday: filled.birthday, city: filled.city, wechat: filled.wechat, gender: filled.gender
  }));
  console.log('  ' + filled.rollbackNote);

  check('姓名写进 DOM', filled.name === '张三', filled.name);
  check('手机号写进 DOM', filled.phone === '13800002222', filled.phone);
  check('下拉框选中了', filled.city === '北京', filled.city);
  check('单选组选中了', filled.gender === '男', filled.gender);
  check('受控组件 900ms 后没被回滚', filled.wechat === 'zhangsan_wx', filled.wechat);
  check('填充结果里没有失败项', filled.failPills === 0, filled.failPills + ' 个失败');
  check('页面上原有的内容没被覆盖', filled.untouched === '13900001111', filled.untouched);

  console.log('\n--- 模拟前端状态变化后再扫（聚焦/填写/校验提示）---');
  await page.evaluate(() => document.getElementById('btn-mutate').click());
  await new Promise((r) => setTimeout(r, 700));
  const after = await page.evaluate(() => {
    const row = (id) => Array.from(document.querySelectorAll('#tbl tbody tr'))
      .find((tr) => tr.children[0].textContent.trim() === id);
    return {
      verdict: document.getElementById('s-verdict').textContent,
      badPills: document.querySelectorAll('#tbl .pill.bad').length,
      fpStatus: document.getElementById('fp-status').textContent,
      fpCls: document.getElementById('fp-status').className,
      v3: row('v3') ? row('v3').children[1].textContent.trim() : '(缺)',
      v5: row('v5') ? row('v5').children[1].textContent.trim() : '(缺)',
      v2: row('v2') ? row('v2').children[1].textContent.trim() : '(缺)'
    };
  });
  console.log('  ' + after.fpStatus);
  check('加了聚焦/填写/校验状态类后，标签依然全对',
    after.verdict === '全对' && after.badPills === 0, after.verdict + ' / 坏 ' + after.badPills);
  check('聚焦的那个字段标签没变', after.v3 === '电子邮箱', after.v3);
  check('填了值的那个字段标签没变', after.v2 === '手机号码', after.v2);
  check('**加了错误提示的字段标签没被「此项必填」污染**', after.v5 === '身份证号', after.v5);
  check('指纹全部一致（AI 缓存能命中，不会重复请求）',
    /全部一致/.test(after.fpStatus) && after.fpCls === 'ok', after.fpStatus);

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
