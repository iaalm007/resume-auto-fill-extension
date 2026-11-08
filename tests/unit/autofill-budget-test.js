/**
 * 重扫自动补齐的自我约束（autoFillPending）。
 *
 * 要证明三件事：
 *   1. 只补「填充后新出现」的字段 —— 填充前就在页面上的空字段，即使规则认得也不碰
 *      （否则就是替用户把他在弹窗里没勾的字段也填了）；
 *   2. 每轮有数量上限 + 时间预算，超了停下并把剩余量交还（pendingLeft），绝不闷头跑几分钟；
 *   3. 自定义组件（el-select 这类）不自动补 —— 慢的就是它们，交给用户点。
 *
 * 这三条是被真实事故逼出来的：空表单 + 全页扫填，一次要几分钟且不可中断。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');

const ROW = (id, label) =>
  `<div class="row"><span class="lbl">${label}</span><input id="${id}" class="ctl" placeholder="请输入" /></div>`;

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

const PROFILE = {
  basic: {
    name: '张三', gender: '', birthday: '2002-02-01', phone: '13900001111',
    email: 'a@b.com', idCard: '610000200202020000', location: '西安',
    wechat: 'wx_zhang', politicalStatus: '群众',
    expectedCity: '北京', expectedPosition: '测试开发', expectedIndustry: '互联网',
    workYears: '3年', currentSalary: '20k', expectedSalary: '25k', availableFrom: '一个月内'
  },
  education: [{ school: '陕西科技大学', major: '软件工程', degree: '硕士', startDate: '2024-09', endDate: '2027-07' }],
  experience: [],
  projects: [],
  skills: [],
  selfEvaluation: ''
};

async function newPage(browser, html, stubFn) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e).slice(0, 300)));
  // chrome 桩必须在导航前注册（evaluateOnNewDocument 只对「新文档」生效）
  await page.evaluateOnNewDocument(stubFn);
  const file = path.join(os.tmpdir(), 'rj-budget-' + Math.random().toString(36).slice(2) + '.html');
  fs.writeFileSync(file, html);
  await page.goto('file:///' + file.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded' });
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
  await page.evaluate((p) => {
    window.__RJ_STORE__.getProfile = () => Promise.resolve(JSON.parse(JSON.stringify(p)));
  }, PROFILE);
  return page;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  // chrome 桩：必须注册在「新文档」上，所以配合 file:// 导航
  const stub = () => {
    window.__LISTENER__ = null;
    window.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => { window.__LISTENER__ = fn; } },
        getManifest: () => ({ version: 'test' })
      },
      storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => { if (cb) cb(); } } }
    };
  };

  // ---------------------------------------------------------------- 1. baseline 保护
  console.log('--- 1. 不碰填充前就存在的空字段 ---');
  {
    const html = `<!doctype html><html><body>
      ${ROW('name', '姓名')}
      ${ROW('phone', '手机号码')}
    </body></html>`;
    const page = await newPage(browser, html, stub);
    const scan = await send(page, { type: 'RJ_SCAN' });
    const phone = scan.plan.filter((p) => p.label === '手机号码')[0];
    const name = scan.plan.filter((p) => p.label === '姓名')[0];
    // 只填姓名，手机不勾
    await send(page, {
      type: 'RJ_FILL',
      items: [{ id: name.id, label: '姓名', path: 'basic.name', value: '张三' }],
      skipSelectors: {}
    });
    const got = await page.evaluate((pid) => {
      const el = document.getElementById('phone');
      const e = window.__RJ_SCANNER__.getEntry(pid);
      const n = e && (e.el || (e.group && e.group[0]));
      return { phoneValue: el ? el.value : '', phoneEmpty: window.__RJ_SCANNER__.isEmptyField ? null : null };
    }, phone.id);
    check('手机号码（填充前就存在）不被自动补齐', got.phoneValue === '', '实际 "' + got.phoneValue + '"');
    await page.close();
  }

  // ---------------------------------------------------------------- 2. 上限 + 组件跳过
  console.log('\n--- 2. 新字段补 16 个上限 + 组件不补 ---');
  {
    const labels20 = ['电子邮箱', '出生日期', '身份证号', '微信号', '政治面貌',
      '期望工作城市', '期望职位', '期望行业', '工作年限', '期望薪资'].reduce((a, l) => a.concat([l, l]), []);
    const spawn = labels20.map((l, i) =>
      ROW('e' + i, l)).join('\n') +
      '<div class="row"><span class="lbl">学历</span><div class="el-select"><input id="degree" class="el-input__inner" placeholder="请选择" /></div></div>';

    const html = `<!doctype html><html><body>
      ${ROW('name', '姓名')}
      <div id="spawn"></div>
      <script>
        document.getElementById('name').addEventListener('input', function () {
          if (window.__SPAWNED__) return;
          window.__SPAWNED__ = true;
          document.getElementById('spawn').innerHTML = ${JSON.stringify(spawn)};
        });
      </script>
    </body></html>`;
    const page = await newPage(browser, html, stub);
    const scan = await send(page, { type: 'RJ_SCAN' });
    const name = scan.plan.filter((p) => p.label === '姓名')[0];

    const res = await send(page, {
      type: 'RJ_FILL',
      items: [{ id: name.id, label: '姓名', path: 'basic.name', value: '张三' }],
      skipSelectors: {}
    });

    const autoOk = (res.report || []).filter((r) => r.auto && r.ok).length;
    check('两轮合计只自动补 16 个（每轮上限 8）', autoOk === 16, '实际 ' + autoOk);
    check('剩下的新字段记进 pendingLeft', res.pendingLeft === 4, '实际 ' + res.pendingLeft);

    const states = await page.evaluate(() => {
      const filled = [];
      for (let i = 0; i < 20; i++) {
        const el = document.getElementById('e' + i);
        if (el && el.value) filled.push(i);
      }
      return { filledCount: filled.length, degree: document.getElementById('degree').value };
    });
    check('被填的都是普通输入框（16 个）', states.filledCount === 16, '实际 ' + states.filledCount);
    check('自定义组件（学历 el-select）不被自动补', states.degree === '', '实际 "' + states.degree + '"');
    await page.close();
  }

  await browser.close();
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('运行异常：' + String((e && e.stack) || e).slice(0, 800));
  process.exit(1);
});
