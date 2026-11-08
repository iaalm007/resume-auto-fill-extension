/**
 * 「自动跑 AI」节流测试。
 *
 * 要证明的事：**反复打开弹窗不再等于反复发请求。**
 * 做法是模拟「打开弹窗 N 次」—— 每次开一个独立页面（≈ 弹窗各自的生命周期），
 * 但把 chrome.storage 的内容在页面之间**带过去**（弹窗关了存储还在）。
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');
const ORIGIN = 'https://job.example.com';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const SCAN = {
  ok: true, url: ORIGIN + '/apply', title: '某公司 - 投递表单', total: 3, matched: 1,
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
      aiFeatures: {
        id: 'rj_2', fingerprint: 'fp_weak_a', label: '请输入', labelSource: 'placeholder',
        placeholder: '请输入', type: 'text', options: [], skeleton: ['第0层 <input> 前兄弟[无]']
      }
    },
    {
      id: 'rj_3', label: '请输入', labelSource: 'placeholder', type: 'text', selector: '#y',
      required: false, currentValue: '', empty: true, options: [],
      suggestedPath: null, suggestedValue: '', confidence: 0, reason: '', source: null,
      aiFeatures: {
        id: 'rj_3', fingerprint: 'fp_weak_b', label: '请输入', labelSource: 'placeholder',
        placeholder: '请输入', type: 'text', options: [], skeleton: ['第0层 <input> 前兄弟[无]']
      }
    }
  ]
};

const AI_REPLY = {
  ok: true, asked: 2, cached: 0, invalidPath: 0,
  mapping: {
    rj_2: { path: null, label: '紧急联系人手机号', confidence: 0.9, reason: '简历里没有', source: 'ai' },
    rj_3: { path: 'basic.wechat', label: '个人主页', confidence: 0.7, reason: '标签是个人主页', source: 'ai' }
  }
};

/** 每次「打开弹窗」都新建一个页面，但存储内容从上一轮带过来 */
async function openPopup(browser, storeSeed) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e && e.stack || e).slice(0, 600)));

  await page.evaluateOnNewDocument((seed, scan, aiReply) => {
    // 存储要能被读回：把真实内容挂在 window 上，测试在页面之间搬运它
    window.__STORE__ = JSON.parse(JSON.stringify(seed));
    const store = window.__STORE__;
    const pick = (keys) => {
      if (keys === null || keys === undefined) return Object.assign({}, store);
      const arr = Array.isArray(keys) ? keys : [keys];
      const out = {};
      arr.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      return out;
    };
    window.__AI_SENT__ = 0;
    const answer = (value, cb, delay) => (typeof cb === 'function'
      ? setTimeout(() => cb(value), delay || 0) : new Promise((r) => setTimeout(() => r(value), delay || 0)));

    window.chrome = {
      runtime: {
        lastError: undefined,
        getManifest: () => ({ version: 'test' }),
        openOptionsPage: () => {},
        sendMessage: (msg, cb) => {
          if (msg && msg.type === 'RJ_AI_MAP') { window.__AI_SENT__++; return answer(aiReply, cb, 5); }
          return answer({ ok: true }, cb, 0);
        }
      },
      tabs: {
        query: (q, cb) => answer([{ id: 1, url: scan.url }], cb, 0),
        sendMessage: (id, msg, cb) => {
          if (msg && msg.type === 'RJ_PING') return answer({ ok: true }, cb, 0);
          if (msg && msg.type === 'RJ_SCAN') return answer(scan, cb, 5);
          if (msg && msg.type === 'RJ_FILL') return answer({ ok: true, report: [] }, cb, 5);
          if (msg && msg.type === 'RJ_DIAG') return answer({ ok: true, diag: { fields: [] } }, cb, 0);
          return answer({ ok: true }, cb, 0);
        }
      },
      scripting: { executeScript: () => Promise.resolve([]) },
      storage: {
        local: {
          get: (keys, cb) => answer(pick(keys), cb, 0),
          set: (obj, cb) => { Object.keys(obj).forEach((k) => { store[k] = obj[k]; }); return answer(undefined, cb, 0); }
        }
      }
    };
  }, storeSeed, SCAN, AI_REPLY);

  await page.goto('file:///' + path.join(EXT, 'popup.html').replace(/\\/g, '/'),
    { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 900));       // 等 init 里的 scan + AI 走完

  const snap = await page.evaluate(() => ({
    aiSent: window.__AI_SENT__,
    store: JSON.parse(JSON.stringify(window.__STORE__)),
    note: (function () {
      const el = document.getElementById('ai-note');
      const t = document.getElementById('ai-note-text');
      return { hidden: el.hidden, text: t ? t.textContent : '' };
    })(),
    runBtnHidden: (function () {
      const b = document.getElementById('btn-ai-run');
      return b ? b.hidden : null;
    })(),
    rows: document.querySelectorAll('.row').length
  }));
  return { page, snap };
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

  let store = {
    rj_ai_config: { enabled: true, baseUrl: 'http://fake.local/v1', model: 'fake-model', apiKey: 'sk-test' },
    rj_active_resume: 'r_test',
    rj_resume_r_test: {
      id: 'r_test', name: '测试简历', createdAt: 1, updatedAt: 1,
      profile: {
        basic: { name: '张三', gender: '', birthday: '', phone: '', email: '', idCard: '', location: '', wechat: 'zhangsan_wx', politicalStatus: '' },
        education: [], experience: [], projects: [], skills: [], selfEvaluation: ''
      }
    }
  };

  // ---------- 1. 首次打开：应该自动跑 ----------
  console.log('--- 1. 首次打开弹窗（缓存冷、没有自动记录）---');
  let r = await openPopup(browser, store);
  console.log('    AI 请求次数=' + r.snap.aiSent + '  说明条="' + r.snap.note.text.slice(0, 70) + '"');
  check('首次打开会自动跑 AI（发 1 次请求）', r.snap.aiSent === 1, 'sent=' + r.snap.aiSent);
  check('渲染出了字段行', r.snap.rows === 3, 'rows=' + r.snap.rows);
  check('写入自动记录', !!(r.snap.store.rj_ai_auto && r.snap.store.rj_ai_auto[ORIGIN]),
    JSON.stringify(r.snap.store.rj_ai_auto));
  store = r.snap.store;
  await r.page.close();

  // ---------- 2. 立刻再打开一次：不该再联网 ----------
  console.log('\n--- 2. 紧接着再打开（缓存仍冷、10 分钟内）---');
  r = await openPopup(browser, store);
  console.log('    AI 请求次数=' + r.snap.aiSent + '  说明条="' + r.snap.note.text.slice(0, 90) + '"');
  check('**不再自动发请求**（这就是「反复开弹窗」的修复点）', r.snap.aiSent === 0, 'sent=' + r.snap.aiSent);
  check('说明条明确告知「先不重复请求」', /先不重复请求/.test(r.snap.note.text), r.snap.note.text);
  check('说明条给出待判断的字段数', /有 2 个字段规则没认出/.test(r.snap.note.text), r.snap.note.text);
  check('「让 AI 判断」按钮露出来了', r.snap.runBtnHidden === false, 'hidden=' + r.snap.runBtnHidden);
  store = r.snap.store;

  // ---------- 3. 点「让 AI 判断」：显式触发要能跑 ----------
  console.log('\n--- 3. 点「让 AI 判断」（显式触发，应跳过节流）---');
  await r.page.click('#btn-ai-run');
  await new Promise((x) => setTimeout(x, 900));
  const afterClick = await r.page.evaluate(() => ({
    aiSent: window.__AI_SENT__,
    note: document.getElementById('ai-note-text').textContent
  }));
  console.log('    AI 请求次数=' + afterClick.aiSent + '  说明条="' + afterClick.note.slice(0, 80) + '"');
  check('显式触发确实发了请求', afterClick.aiSent === 1, 'sent=' + afterClick.aiSent);
  store = await r.page.evaluate(() => JSON.parse(JSON.stringify(window.__STORE__)));
  await r.page.close();

  // ---------- 4. 再过一次：仍然不该自动跑 ----------
  console.log('\n--- 4. 手动跑完之后再开一次 ---');
  r = await openPopup(browser, store);
  check('手动跑过之后仍然不自动重复请求', r.snap.aiSent === 0, 'sent=' + r.snap.aiSent);
  store = r.snap.store;
  await r.page.close();

  // ---------- 5. 记录过期（11 分钟前）：应该恢复自动跑 ----------
  console.log('\n--- 5. 把自动记录改成 11 分钟前（超过 10 分钟窗口）---');
  store.rj_ai_auto[ORIGIN] = { at: Date.now() - 11 * 60 * 1000 };
  r = await openPopup(browser, store);
  check('窗口过期后恢复自动跑', r.snap.aiSent === 1, 'sent=' + r.snap.aiSent);
  store = r.snap.store;
  await r.page.close();

  // ---------- 6. 缓存全是热的：应当免费地跑（不算冷字段）----------
  console.log('\n--- 6. 缓存已覆盖全部待判断字段（应当照样自动跑，因为不联网）---');
  store.rj_ai_auto[ORIGIN] = { at: Date.now() };      // 刚跑过
  store.rj_ai_cache = {
    fp_weak_a: { path: null, label: '紧急联系人手机号', confidence: 0.9, at: Date.now() },
    fp_weak_b: { path: 'basic.wechat', label: '个人主页', confidence: 0.7, at: Date.now() }
  };
  r = await openPopup(browser, store);
  check('缓存全热时不受节流限制（跑一次是免费的）', r.snap.aiSent === 1, 'sent=' + r.snap.aiSent);
  check('不会显示「先不重复请求」', !/先不重复请求/.test(r.snap.note.text), r.snap.note.text);
  await r.page.close();

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
