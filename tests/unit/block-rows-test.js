/**
 * 重复区块（教育/工作/项目经历）：段号分配 + 自动点「+ 添加」加行。
 *
 * 要证明的三件事：
 *   1. 段号只由 DOM 顺序决定 —— 同名的「开始时间」不会被算到隔壁块里；
 *   2. 简历里的段数比页面上的行多时，会点添加按钮把行加出来，然后把新行填上；
 *   3. AI 给的数组模板（education[*].school）能回内容脚本解析成具体段号。
 *
 * 走的是真实消息链路（RJ_SCAN / RJ_FILL / RJ_RESOLVE_PATHS），不直接调内部函数 ——
 * 这三条逻辑一旦分叉，症状是「填串了段」，只有走完整链路才测得出来。
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');

const ROW = (id, label) =>
  `<div class="row"><span class="lbl">${label}</span><input id="${id}" class="ctl" placeholder="请输入" /></div>`;

const EDU_ROW = (n) => `
  <div class="edu-row">
    ${ROW('s' + n, '学校名称')}
    ${ROW('m' + n, '专业名称')}
    ${ROW('d' + n, '学历')}
    ${ROW('b' + n, '开始时间')}
    ${ROW('e' + n, '结束时间')}
  </div>`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="form">
  <div class="row"><span class="lbl">姓名</span><input id="name" class="ctl" placeholder="请输入" /></div>
  <div class="row"><span class="lbl">手机号码</span><input id="phone" class="ctl" placeholder="请输入" /></div>

  <div class="edu-section" id="edu-section">
    ${EDU_ROW(1)}
    <div class="edu-extra"></div>
    <!-- 故意不用 <button>：实测北森投递页就是这么写的（styled-components 哈希类名的 div） -->
    <div class="sc-lbhJGD cUSWND" id="add-edu" style="cursor:pointer"><span>添加教育经历</span></div>
  </div>

  <div class="exp-section" id="exp-section">
    <div class="row"><span class="lbl">公司名称</span><input id="c1" class="ctl" placeholder="请输入" /></div>
    <div class="row"><span class="lbl">职位名称</span><input id="j1" class="ctl" placeholder="请输入" /></div>
    <div class="sc-iNGGcK bbODky" id="add-exp" style="cursor:pointer"><span>添加工作经历</span></div>
  </div>
</div>
<script>
  // 模拟站点：点「+ 添加」就多渲染一行空的经历
  var seq = 1;
  document.getElementById('add-exp').addEventListener('click', function () {
    window.__ADDED_EXP__ = (window.__ADDED_EXP__ || 0) + 1;
  });
  document.getElementById('add-edu').addEventListener('click', function () {
    seq++;
    var row = document.createElement('div');
    row.className = 'edu-row';
    ['学校名称:s', '专业名称:m', '学历:d', '开始时间:b', '结束时间:e'].forEach(function (pair) {
      var parts = pair.split(':');
      var cell = document.createElement('div');
      cell.className = 'row';
      var lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = parts[0];
      var input = document.createElement('input');
      input.id = parts[1] + seq;
      input.className = 'ctl';
      input.placeholder = '请输入';
      cell.appendChild(lbl);
      cell.appendChild(input);
      row.appendChild(cell);
    });
    document.querySelector('.edu-extra').appendChild(row);
  });
</script>
</body></html>`;

const PROFILE = {
  basic: { name: '张三', gender: '男', birthday: '', phone: '13900001111', email: '', idCard: '', location: '', wechat: '', politicalStatus: '', expectedCity: '', expectedPosition: '', expectedIndustry: '', workYears: '', currentSalary: '', expectedSalary: '', availableFrom: '' },
  education: [
    { school: '第一大学', major: '计算机', degree: '本科', startDate: '2018-09', endDate: '2022-06', description: '' },
    { school: '第二大学', major: '软件工程', degree: '硕士', startDate: '2022-09', endDate: '2025-06', description: '' },
    { school: '第三大学', major: '人工智能', degree: '博士', startDate: '2025-09', endDate: '至今', description: '' }
  ],
  experience: [{ company: '某公司', title: '开发工程师', startDate: '2023-07', endDate: '至今', description: '写代码' }],
  projects: [],
  skills: [],
  selfEvaluation: ''
};

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

function send(page, msg) {
  return page.evaluate((m) => new Promise((resolve) => {
    const took = window.__LISTENER__(m, null, resolve);
    if (!took) resolve({ ok: false, error: '监听器没接管 ' + m.type });
  }), msg);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e && e.stack || e).slice(0, 500)));

  await page.evaluateOnNewDocument(() => {
    window.__LISTENER__ = null;
    window.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => { window.__LISTENER__ = fn; } },
        getManifest: () => ({ version: 'test' })
      },
      storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => { if (cb) cb(); } } }
    };
  });

  // 必须用真实导航：evaluateOnNewDocument 只在「新文档」生效，
  // setContent 是往当前 about:blank 里写，chrome 桩会缺席（表现为 onMessage undefined）
  const pageFile = path.join(require('os').tmpdir(), 'rj-block-rows-' + process.pid + '.html');
  fs.writeFileSync(pageFile, HTML);
  await page.goto('file:///' + pageFile.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded' });

  for (const f of [
    'shared/profile-store.js',
    'content/config.js',
    'content/scanner.js',
    'content/filler.js',
    'content/matcher.js',
    'content/main.js'
  ]) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), 'utf8') });
  }

  // 简历直接注入：跳过 chrome.storage 那套，测的是段号与填值
  await page.evaluate((p) => {
    window.__RJ_STORE__.getProfile = () => Promise.resolve(JSON.parse(JSON.stringify(p)));
  }, PROFILE);

  const ok = await page.evaluate(() => typeof window.__LISTENER__ === 'function');
  check('content script 已注册消息监听', ok);
  if (!ok) { await browser.close(); process.exit(1); }

  // ---------------------------------------------------------------- 1. 扫描
  console.log('--- 扫描：段号分配 ---');
  const scan1 = await send(page, { type: 'RJ_SCAN' });
  check('扫描返回 ok', scan1 && scan1.ok, scan1 && scan1.error);

  const byLabel = {};
  (scan1.plan || []).forEach((p) => { byLabel[p.label] = p; });

  check('学校名称 → education.0.school',
    byLabel['学校名称'] && byLabel['学校名称'].suggestedPath === 'education.0.school',
    byLabel['学校名称'] && byLabel['学校名称'].suggestedPath);
  check('专业名称 → education.0.major',
    byLabel['专业名称'] && byLabel['专业名称'].suggestedPath === 'education.0.major',
    byLabel['专业名称'] && byLabel['专业名称'].suggestedPath);
  check('开始时间 → education.0.startDate（归到当前块）',
    byLabel['开始时间'] && byLabel['开始时间'].suggestedPath === 'education.0.startDate',
    byLabel['开始时间'] && byLabel['开始时间'].suggestedPath);
  check('公司名称 → experience.0.company',
    byLabel['公司名称'] && byLabel['公司名称'].suggestedPath === 'experience.0.company',
    byLabel['公司名称'] && byLabel['公司名称'].suggestedPath);

  // ---------------------------------------------------------------- 1.5 按钮识别
  console.log('\n--- 加行按钮识别：div/span 也要算可点 ---');
  const trig = await page.evaluate(() => {
    const S = window.__RJ_SCANNER__, M = window.__RJ_MATCHER__, CFG = window.__RJ_CONFIG__;
    const fields = S.scanAll();
    const anchorOf = (tpl) => {
      let hit = null;
      fields.forEach((f) => { const m = M.matchField(f, CFG.fieldRules); if (m && m.path === tpl) hit = f; });
      const e = hit ? S.getEntry(hit.id) : null;
      return e ? (e.el || (e.group && e.group[0])) : null;
    };
    const edu = S.findAddTrigger(anchorOf('education[*].school'), 'education');
    const exp = S.findAddTrigger(anchorOf('experience[*].company'), 'experience');
    return {
      edu: edu && edu.textContent.trim(), eduTag: edu && edu.tagName,
      exp: exp && exp.textContent.trim()
    };
  });
  check('教育块找到「添加教育经历」（而且它不是 <button>）',
    trig.edu === '添加教育经历' && trig.eduTag !== 'BUTTON', JSON.stringify(trig));
  check('工作块找到「添加工作经历」，不会串到教育块',
    trig.exp === '添加工作经历', JSON.stringify(trig));

  // 边界：扩展只往表单里填内容，**暂存/保存/提交一个都不点**。
  // 页面上只有这类按钮时，宁可返回 null（报「没找到添加按钮」），也不能替用户保存。
  console.log('\n--- 只有「暂存/提交/添加附件」时，不许当成加行按钮 ---');
  const p2 = await browser.newPage();
  await p2.setContent(`<!doctype html><html><body>
    <div class="form-item"><input id="only" class="ctl" placeholder="请输入" /></div>
    <div style="cursor:pointer">暂存</div>
    <div style="cursor:pointer">保存草稿</div>
    <div style="cursor:pointer">预览并提交</div>
    <div style="cursor:pointer">添加附件</div>
    <div style="cursor:pointer">上传简历</div>
  </body></html>`, { waitUntil: 'domcontentloaded' });
  for (const f of ['content/config.js', 'content/scanner.js', 'content/matcher.js']) {
    await p2.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), 'utf8') });
  }
  const blocked = await p2.evaluate(() => {
    const S = window.__RJ_SCANNER__;
    const t = S.findAddTrigger(document.getElementById('only'), 'education');
    return t ? String(t.textContent || '').trim() : null;
  });
  check('暂存 / 保存 / 预览并提交 / 添加附件 / 上传简历 都不会被当成加行按钮',
    blocked === null, '实际选中了「' + blocked + '」');
  await p2.close();

  // ---------------------------------------------------------------- 2. 自动加行
  console.log('\n--- 填写：行不够就点添加 ---');
  const items = (scan1.plan || [])
    .filter((p) => p.empty && p.suggestedPath && p.suggestedValue)
    .map((p) => ({ id: p.id, label: p.label, path: p.suggestedPath, value: p.suggestedValue }));

  const fill = await send(page, { type: 'RJ_FILL', items: items, skipSelectors: {} });
  check('填写返回 ok', fill && fill.ok, fill && fill.error);
  check('自动加了 2 行（简历 3 段 - 页面 1 行）', fill.addedRows === 2, '实际 ' + fill.addedRows);

  const rows = await page.evaluate(() => document.querySelectorAll('.edu-row').length);
  check('页面上确有 3 行教育经历', rows === 3, '实际 ' + rows);

  const values = await page.evaluate(() => {
    const out = {};
    ['s', 'm', 'd', 'b', 'e'].forEach((k) => {
      out[k] = [];
      for (let i = 1; i <= 3; i++) {
        const el = document.getElementById(k + i);
        out[k].push(el ? el.value : null);
      }
    });
    return out;
  });
  check('第 1 行填的是第 1 段', values.s[0] === '第一大学' && values.m[0] === '计算机',
    values.s[0] + '/' + values.m[0]);
  check('第 2 行填的是第 2 段', values.s[1] === '第二大学' && values.m[1] === '软件工程',
    values.s[1] + '/' + values.m[1]);
  check('第 3 行填的是第 3 段', values.s[2] === '第三大学' && values.m[2] === '人工智能',
    values.s[2] + '/' + values.m[2]);
  check('第 3 行的开始时间正确', values.b[2] === '2025-09', values.b[2]);

  const wrongBlock = await page.evaluate(() => !!window.__ADDED_EXP__);
  check('没有点错块的「添加工作经历」', !wrongBlock);

  const autoReport = (fill.report || []).filter((r) => r.auto && r.ok);
  check('新行的字段以「自动补齐」形式记录',
    autoReport.some((r) => r.path === 'education.2.school'),
    autoReport.map((r) => r.path).join(','));

  // ---------------------------------------------------------------- 3. AI 模板解析
  console.log('\n--- AI 数组模板 → 具体段号 ---');
  // 造一个规则认不出、位置在第二段里的字段，模拟「模型认出来了」的场景
  const neutralId = await page.evaluate(() => {
    const extra = document.querySelector('.edu-extra');
    const row = document.createElement('div');
    row.className = 'edu-row';
    row.innerHTML = '<div class="row"><input id="ai-x" class="ctl" placeholder="请输入" /></div>';
    extra.appendChild(row);
    const scan = window.__RJ_SCANNER__.scanAll();
    const f = scan.filter((x) => x.attrs.id === 'ai-x')[0];
    return f ? f.id : null;
  });
  check('造出的无标签字段被扫到', !!neutralId, neutralId);

  const resolved = await send(page, {
    type: 'RJ_RESOLVE_PATHS',
    paths: neutralId ? JSON.parse('{"' + neutralId + '":"education[*].degree"}') : {}
  });
  check('解析返回 ok', resolved && resolved.ok, resolved && resolved.error);
  const rp = resolved.paths && resolved.paths[neutralId];
  check('模板 education[*].degree → 具体段号（不是模板原样）',
    rp && /^education\.\d+\.degree$/.test(rp.path), rp && rp.path);
  check('解析出的值与简历里那一段一致',
    rp && PROFILE.education[Number(rp.path.split('.')[1])].degree === rp.value,
    rp && rp.path + ' -> ' + rp.value);

  // 模板指向不存在的 id 时不该报错，也不该凭空造条目
  const bogus = await send(page, { type: 'RJ_RESOLVE_PATHS', paths: { 'rj_nope': 'education[*].school' } });
  check('未知字段 id 被安静忽略', bogus.ok && !bogus.paths.rj_nope);

  await browser.close();
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('运行异常：' + String((e && e.stack) || e).slice(0, 800));
  process.exit(1);
});
