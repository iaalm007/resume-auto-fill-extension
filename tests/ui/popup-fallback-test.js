/**
 * 弹窗 AI 的降级路径：后台不可用时，弹窗本页直连。
 * 关键是要证明「后台死了功能照样能用」，并且走的是同一套提示词与隐私边界。
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');

const PII = '13900001111';   // 只存在于 value 里的哨兵

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const scanPayload = (withPii) => ({
  ok: true,
  url: 'https://job.example.com/apply',
  title: '某公司 - 投递表单',
  total: 2, matched: 1,
  resolvedExamples: [{ label: '姓名', labelSource: 'sibling(d2)', type: 'text' }],
  plan: [
    {
      id: 'rj_1', label: '姓名', labelSource: 'sibling(d2)', type: 'text', selector: '#n',
      required: true, currentValue: '', empty: true, options: [],
      suggestedPath: 'basic.name', suggestedValue: '张三', confidence: 0.82,
      reason: 'label匹配 "姓名"', source: 'rule',
      aiFeatures: { id: 'rj_1', fingerprint: 'fp_name', label: '姓名', labelSource: 'sibling(d2)', placeholder: '请输入', type: 'text', options: [] }
    },
    {
      id: 'rj_2', label: '请输入', labelSource: 'placeholder', type: 'text', selector: '#x',
      required: false, currentValue: '', empty: true, options: [],
      suggestedPath: null, suggestedValue: '', confidence: 0, reason: '', source: null,
      aiFeatures: Object.assign({
        id: 'rj_2', fingerprint: 'fp_weak', label: '请输入', labelSource: 'placeholder',
        placeholder: '请输入', type: 'text', options: [], skeleton: ['第0层 <input> 前兄弟[无]']
      }, withPii ? { value: PII, currentValue: PII } : {})
    }
  ]
});

const AI_REPLY = JSON.stringify([
  { id: 'rj_2', label: '紧急联系人手机号', path: 'basic.phone', confidence: 0.9, reason: '骨架里写着手机号码' }
]);

async function run(mode) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 200)));

  await page.evaluateOnNewDocument((scan, reply, bgMode) => {
    const store = {
      rj_ai_config: { enabled: true, baseUrl: 'http://fake.local/v1', model: 'fake-model', apiKey: 'sk-test' },
      rj_active_resume: 'r_test',
      rj_resume_r_test: {
        id: 'r_test', name: '测试简历', createdAt: 1, updatedAt: 1,
        profile: {
          basic: { name: '张三', gender: '', birthday: '', phone: '13800000000', email: '', idCard: '', location: '', wechat: 'zhangsan_wx', politicalStatus: '' },
          education: [], experience: [], projects: [], skills: [], selfEvaluation: ''
        }
      }
    };
    const pick = (keys) => {
      if (keys === null || keys === undefined) return Object.assign({}, store);
      const arr = Array.isArray(keys) ? keys : [keys];
      const out = {};
      arr.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      return out;
    };
    const answer = (value, cb, d) => (typeof cb === 'function'
      ? setTimeout(() => cb(value), d || 0)
      : new Promise((r) => setTimeout(() => r(value), d || 0)));

    window.__FETCH_CALLS__ = [];
    window.__BG_MODE__ = bgMode;

    window.chrome = {
      runtime: {
        lastError: undefined,
        getManifest: () => ({ version: 'test' }),
        openOptionsPage: () => {},
        sendMessage: (msg, cb) => {
          if (msg && msg.type === 'RJ_AI_MAP' && window.__BG_MODE__ === 'down') {
            window.chrome.runtime.lastError = {
              message: 'Could not establish connection. Receiving end does not exist.'
            };
            setTimeout(() => { cb(undefined); window.chrome.runtime.lastError = undefined; }, 0);
            return;
          }
          if (msg && msg.type === 'RJ_AI_MAP') return answer({ ok: true, asked: 1, cached: 0, mapping: JSON.parse(reply).reduce((a, m) => (a[m.id] = { path: m.path, label: m.label, confidence: m.confidence, reason: m.reason, source: 'ai' }, a), {}) }, cb, 10);
          return answer({ ok: true }, cb, 0);
        }
      },
      tabs: {
        query: (q, cb) => answer([{ id: 1, url: scan.url }], cb, 0),
        sendMessage: (id, msg, cb) => {
          if (msg && msg.type === 'RJ_PING') return answer({ ok: true }, cb, 0);
          if (msg && msg.type === 'RJ_SCAN') return answer(scan, cb, 10);
          if (msg && msg.type === 'RJ_DIAG') return answer({ ok: true, diag: { fields: [] } }, cb, 0);
          return answer({ ok: true }, cb, 0);
        }
      },
      scripting: { executeScript: () => Promise.resolve([]) },
      storage: {
        local: {
          get: (keys, cb) => answer(pick(keys), cb, 0),
          set: (obj, cb) => { Object.assign(store, obj); return answer(undefined, cb, 0); }
        }
      }
    };

    window.fetch = (url, opts) => {
      window.__FETCH_CALLS__.push({ url: url, body: opts && opts.body });
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: () => Promise.resolve({ choices: [{ message: { content: reply } }] })
      });
    };
  }, scanPayload(true), AI_REPLY, mode);

  const URL = 'file:///' + path.join(EXT, 'popup.html').replace(/\\/g, '/');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('.row[data-id="rj_2"] .badge.ai') !== null,
    { timeout: 12000 }
  );

  const snap = await page.evaluate(() => {
    const r2 = document.querySelector('.row[data-id="rj_2"]');
    return {
      fname: (r2.querySelector('.fname') || {}).textContent,
      val: (r2.querySelector('.val') || {}).value,
      path: r2.dataset.path,
      fetched: window.__FETCH_CALLS__.length,
      fetchUrl: window.__FETCH_CALLS__[0] ? window.__FETCH_CALLS__[0].url : null,
      fetchBody: window.__FETCH_CALLS__[0] ? window.__FETCH_CALLS__[0].body : null
    };
  });

  await browser.close();
  return { snap, pageErrors };
}

(async () => {
  console.log('--- 后台不可用：应当退到本页直连 ---');
  const down = await run('down');
  console.log('  行内容：label="' + down.snap.fname + '" value="' + down.snap.val + '" path=' + down.snap.path);
  check('AI 结果照样应用了（标签被换真）', down.snap.fname === '紧急联系人手机号', down.snap.fname);
  check('值取到了', down.snap.val === '13800000000', down.snap.val);
  check('映射写入了', down.snap.path === 'basic.phone', down.snap.path);
  check('本页确实直连了接口', down.snap.fetched === 1, '实际 ' + down.snap.fetched + ' 次');
  check('打到了正确的地址', /\/chat\/completions$/.test(down.snap.fetchUrl || ''), down.snap.fetchUrl);
  check('提示词里带了 DOM 骨架', /第0层/.test(down.snap.fetchBody || ''));
  check('提示词里带了 resolvedExamples（与走后台时一致）',
    /已被规则解出的字段/.test(down.snap.fetchBody || ''));
  check('请求体里不含输入框的值（哨兵）',
    (down.snap.fetchBody || '').indexOf(PII) === -1, '哨兵出现了');
  check('没有未捕获的页面异常', down.pageErrors.length === 0, down.pageErrors.join(' | '));

  console.log('\n--- 后台可用：应当走后台，不动用直连 ---');
  const up = await run('up');
  console.log('  行内容：label="' + up.snap.fname + '" value="' + up.snap.val + '" path=' + up.snap.path);
  check('AI 结果应用了', up.snap.fname === '紧急联系人手机号' && up.snap.path === 'basic.phone',
    up.snap.fname + ' / ' + up.snap.path);
  check('没有走直连（弹窗自己不调接口）', up.snap.fetched === 0, '实际 ' + up.snap.fetched + ' 次');
  check('没有未捕获的页面异常', up.pageErrors.length === 0, up.pageErrors.join(' | '));

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
