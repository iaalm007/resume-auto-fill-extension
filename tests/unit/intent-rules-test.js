/**
 * 新增的「求职意向」字段验证：
 *   1. 规则层能不能命中真实投递页上的那 7 个标签
 *   2. 「期望工作城市」不能落到 basic.location（现居城市）上 —— 这是实测发现的错配
 *   3. 编辑页能存能读（FIELDS 绑定是否真的生效）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const puppeteer = require('puppeteer-core');

const EXT = path.resolve(__dirname, '..', '..', 'extension');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

// ---------------------------------------------------------------- 第一部分：规则
function loadMatcher() {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  const ctx = vm.createContext(sandbox);
  ['content/config.js', 'content/matcher.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f });
  });
  return sandbox;
}

function fieldOf(label) {
  return {
    id: 'x', tag: 'input', type: 'text', labelText: label, labelSource: 'sibling(d2)',
    attrs: { placeholder: '请输入', name: '', id: '', autocomplete: '' },
    options: []
  };
}

// 真实页面上抓到的标签 -> 期望匹配到的路径
const CASES = [
  ['期望工作城市', 'basic.expectedCity'],
  ['期望职位', 'basic.expectedPosition'],
  ['期望岗位', 'basic.expectedPosition'],
  ['期望从事职业', 'basic.expectedPosition'],
  ['期望行业', 'basic.expectedIndustry'],
  ['期望从事行业', 'basic.expectedIndustry'],
  ['工作年限', 'basic.workYears'],
  ['现月薪(税前)', 'basic.currentSalary'],
  ['期望月薪(税前)', 'basic.expectedSalary'],
  ['期望薪资', 'basic.expectedSalary'],
  ['到岗时间', 'basic.availableFrom'],
  ['入职时间', 'basic.availableFrom'],
  // 不能被打乱的既有映射
  ['现居住地', 'basic.location'],
  ['所在城市', 'basic.location'],
  ['现居城市', 'basic.location'],
  ['姓名', 'basic.name'],
  ['手机号码', 'basic.phone'],
  ['邮箱', 'basic.email'],
  ['出生日期', 'basic.birthday'],
  ['证件号码', 'basic.idCard'],
  ['微信号', 'basic.wechat'],
  ['政治面貌', 'basic.politicalStatus'],
  ['自我评价', 'selfEvaluation']
];

// 必须**不**匹配到这些路径（否则会填错）
const MUST_NOT = [
  ['期望工作城市', 'basic.location'],
  ['期望城市', 'basic.location'],
  ['期望月薪(税前)', 'basic.currentSalary'],
  ['现月薪(税前)', 'basic.expectedSalary'],
  ['期望从事行业', 'basic.expectedPosition'],
  ['期望从事职业', 'basic.expectedIndustry']
];

(async () => {
  console.log('--- 规则层：真实标签 -> 路径 ---');
  const sb = loadMatcher();
  const M = sb.__RJ_MATCHER__, CFG = sb.__RJ_CONFIG__;
  check('matcher / config 已加载', !!M && !!CFG);

  CASES.forEach(([label, want]) => {
    const got = M.matchField(fieldOf(label), CFG.fieldRules);
    check('「' + label + '」-> ' + want, got && got.path === want,
      got ? got.path + ' (' + got.reason + ')' : '未命中');
  });

  console.log('\n--- 反向：不许落到别的路径上 ---');
  MUST_NOT.forEach(([label, bad]) => {
    const got = M.matchField(fieldOf(label), CFG.fieldRules);
    check('「' + label + '」不该是 ' + bad, !got || got.path !== bad,
      got ? got.path : '未命中');
  });

  console.log('\n--- schema：新字段是否进了默认简历 ---');
  const schema = JSON.parse(JSON.stringify(sb.__RJ_STORE__ ? {} : {}));
  void schema;
  const psSandbox = {};
  psSandbox.self = psSandbox; psSandbox.window = psSandbox; psSandbox.console = console;
  psSandbox.chrome = { storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() } } };
  psSandbox.setTimeout = setTimeout;
  const psCtx = vm.createContext(psSandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'shared/profile-store.js'), 'utf8'), psCtx,
    { filename: 'profile-store.js' });
  const DEF = psSandbox.__RJ_STORE__.DEFAULT_PROFILE;
  ['expectedCity', 'expectedPosition', 'expectedIndustry', 'workYears',
    'currentSalary', 'expectedSalary', 'availableFrom'].forEach((k) => {
    check('DEFAULT_PROFILE.basic.' + k + ' 存在', Object.prototype.hasOwnProperty.call(DEF.basic, k));
  });

  console.log('\n--- AI 路径清单（allowedPaths）是否包含新字段 ---');
  const aiSandbox = {};
  aiSandbox.self = aiSandbox; aiSandbox.window = aiSandbox; aiSandbox.console = console;
  aiSandbox.setTimeout = setTimeout; aiSandbox.clearTimeout = clearTimeout;
  aiSandbox.AbortController = AbortController;
  aiSandbox.__RJ_AI__ = { get: () => Promise.resolve({}), MAX_FIELDS: 40 };
  aiSandbox.__RJ_STORE__ = { DEFAULT_PROFILE: DEF };
  const aiCtx = vm.createContext(aiSandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'shared/ai-map.js'), 'utf8'), aiCtx,
    { filename: 'ai-map.js' });
  const allowed = aiSandbox.__RJ_AI_MAP__.allowedPaths();
  console.log('  allowedPaths（' + allowed.length + '）: ' + allowed.join(', '));
  check('allowedPaths 包含 basic.expectedCity', allowed.indexOf('basic.expectedCity') !== -1);
  check('allowedPaths 包含 basic.expectedSalary', allowed.indexOf('basic.expectedSalary') !== -1);
  check('allowedPaths 包含 basic.availableFrom', allowed.indexOf('basic.availableFrom') !== -1);
  // 经历区块已经支持：AI 可以映射到数组字段，但**只能用 [*] 模板**。
  // 具体第几段由内容脚本按 DOM 顺序算 —— 模型自己写序号必然错位。
  check('allowedPaths 纳入教育经历（模板路径）', allowed.indexOf('education[*].school') !== -1);
  check('allowedPaths 纳入工作经历与中性命段',
    allowed.indexOf('experience[*].company') !== -1 && allowed.indexOf('[*].startDate') !== -1);
  check('数组路径一律是 [*] 模板，不带具体序号',
    allowed.every((p) => !/\[\d+\]/.test(p)));

  // ------------------------------------------------------------ 第二部分：编辑页
  console.log('\n--- 编辑页：填进去 -> 保存 -> 读回来 ---');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message || e).slice(0, 200)));
  await page.evaluateOnNewDocument(() => {
    const store = {};
    const pick = (keys) => {
      if (keys === null || keys === undefined) return Object.assign({}, store);
      const arr = Array.isArray(keys) ? keys : [keys];
      const out = {};
      arr.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      return out;
    };
    const answer = (v, cb, d) => (typeof cb === 'function'
      ? setTimeout(() => cb(v), d || 0) : new Promise((r) => setTimeout(() => r(v), d || 0)));
    window.chrome = {
      runtime: { lastError: undefined, getManifest: () => ({ version: 'test' }), openOptionsPage: () => {},
        sendMessage: (m, cb) => answer({ ok: true }, cb, 0) },
      tabs: { query: (q, cb) => answer([], cb, 0) },
      scripting: { executeScript: () => Promise.resolve([]) },
      storage: { local: {
        get: (keys, cb) => answer(pick(keys), cb, 0),
        set: (o, cb) => { Object.assign(store, o); return answer(undefined, cb, 0); }
      } }
    };
    window.__STORE__ = store;
  });
  await page.goto('file:///' + path.join(EXT, 'options.html').replace(/\\/g, '/'),
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.getElementById('expectedCity'), { timeout: 10000 });
  // 页面初始化会异步载入简历并回填表单 —— 太早写值会被它冲掉，等它稳定下来
  await new Promise((r) => setTimeout(r, 2500));

  const ids = ['expectedCity', 'expectedPosition', 'expectedIndustry', 'workYears',
    'currentSalary', 'expectedSalary', 'availableFrom'];
  const vals = {
    expectedCity: '北京', expectedPosition: '后端开发工程师', expectedIndustry: '互联网',
    workYears: '3 年', currentSalary: '20k', expectedSalary: '25k', availableFrom: '一个月内'
  };
  await page.evaluate((ids, vals) => {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      el.value = vals[id];
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, ids, vals);
  await new Promise((r) => setTimeout(r, 300));
  // 写后自检：值必须还在，否则说明后面还有一次回填把我的输入清了
  const stillThere = await page.evaluate((ids) => ids.map((id) => {
    const el = document.getElementById(id);
    return id + '=' + (el ? el.value : '(无)');
  }), ids);
  console.log('  保存前输入框内容：' + stillThere.join('  '));

  // 点「保存资料」。必须按 id 点 —— 按文字找「保存」会先命中 AI 设置区那个
  // #btn-ai-save（它只写 rj_ai_config），结果就是资料根本没存，测试却以为是保存失败了。
  const saved = await page.evaluate(() => {
    const b = document.getElementById('btn-save');
    if (!b) return { error: '没找到 #btn-save' };
    b.click();
    return { ok: true, text: (b.textContent || '').trim() };
  });
  if (saved.error) { console.log('  ' + JSON.stringify(saved)); }
  await new Promise((r) => setTimeout(r, 1200));

  const stored = await page.evaluate(() => {
    const s = window.__STORE__ || {};
    const key = Object.keys(s).find((k) => /^rj_resume_/.test(k));
    if (!key) return { keys: Object.keys(s) };
    return { basic: (s[key].profile || {}).basic || {}, key: key };
  });
  console.log('  存下来的 basic = ' + JSON.stringify(stored.basic));
  ids.forEach((id) => {
    check('已保存 ' + id + ' = ' + vals[id], stored.basic && stored.basic[id] === vals[id],
      stored.basic && stored.basic[id]);
  });
  check('没有未捕获的页面异常', errs.length === 0, errs.join(' | '));

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
