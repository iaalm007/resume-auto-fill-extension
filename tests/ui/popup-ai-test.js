/**
 * 弹窗 AI 集成测试：用桩数据跑真实 popup.html / popup.js，
 * 检查 AI 结果怎么落到界面上 —— 假标签是否被换成真标签、值是否正确回填。
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const SCAN = {
  ok: true,
  url: 'https://job.example.com/apply',
  title: '某公司 - 投递表单',
  total: 3,
  matched: 1,
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
        id: 'rj_2', fingerprint: 'fp_weak_no_path', label: '请输入', labelSource: 'placeholder',
        placeholder: '请输入', type: 'text', options: [], skeleton: ['第0层 <input> 前兄弟[无]']
      }
    },
    {
      id: 'rj_3', label: '请输入', labelSource: 'placeholder', type: 'text', selector: '#y',
      required: false, currentValue: '', empty: true, options: [],
      suggestedPath: null, suggestedValue: '', confidence: 0, reason: '', source: null,
      aiFeatures: {
        id: 'rj_3', fingerprint: 'fp_weak_with_path', label: '请输入', labelSource: 'placeholder',
        placeholder: '请输入', type: 'text', options: [], skeleton: ['第0层 <input> 前兄弟[无]']
      }
    }
  ]
};

const AI_REPLY = {
  ok: true, asked: 2, cached: 0, invalidPath: 0,
  mapping: {
    rj_2: { path: null, label: '紧急联系人手机号', confidence: 0.9, reason: '简历里没有对应字段', source: 'ai' },
    rj_3: { path: 'basic.wechat', label: '个人主页', confidence: 0.7, reason: '标签是个人主页', source: 'ai' }
  }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e && e.stack || e).slice(0, 800)));
  page.on('console', (m) => { if (/error/i.test(m.text())) console.log('  [console]', m.text().slice(0, 200)); });

  await page.evaluateOnNewDocument((scan, aiReply) => {
    const store = {
      rj_ai_config: { enabled: true, baseUrl: 'http://fake.local/v1', model: 'fake-model', apiKey: 'sk-test' },
      rj_active_resume: 'r_test',
      rj_resume_r_test: {
        id: 'r_test', name: '测试简历', createdAt: 1, updatedAt: 1,
        profile: {
          basic: { name: '张三', gender: '', birthday: '', phone: '', email: '', idCard: '', location: '', wechat: 'zhangsan_wx', politicalStatus: '' },
          education: [], experience: [], projects: [], skills: ['JavaScript'], selfEvaluation: ''
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
    window.__SENT__ = [];
    window.__CALLS__ = [];
    // 同时兼容「回调式」和「Promise 式」调用 —— chrome.* 两套签名都存在
    const answer = (value, cb, delay) => {
      if (typeof cb === 'function') return setTimeout(() => cb(value), delay || 0);
      return new Promise((r) => setTimeout(() => r(value), delay || 0));
    };
    window.chrome = {
      runtime: {
        lastError: undefined,
        getManifest: () => ({ version: 'test' }),
        openOptionsPage: () => {},
        sendMessage: (msg, cb) => {
          window.__SENT__.push(msg);
          window.__CALLS__.push('runtime.sendMessage ' + (msg && msg.type) + ' cb=' + typeof cb);
          if (msg && msg.type === 'RJ_AI_MAP') return answer(aiReply, cb, 10);
          return answer({ ok: true }, cb, 0);
        }
      },
      tabs: {
        query: (q, cb) => answer([{ id: 1, url: scan.url }], cb, 0),
        sendMessage: (id, msg, cb) => {
          window.__CALLS__.push('tabs.sendMessage ' + (msg && msg.type) + ' cb=' + typeof cb);
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
  }, SCAN, AI_REPLY);

  const URL = 'file:///' + path.join(EXT, 'popup.html').replace(/\\/g, '/');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // 等 AI 结果贴上来
  await page.waitForFunction(
    () => document.querySelector('.row[data-id="rj_3"] .badge.ai') !== null,
    { timeout: 10000 }
  );

  const snap = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.row'));
    const of = (id) => {
      const r = document.querySelector('.row[data-id="' + id + '"]');
      if (!r) return null;
      return {
        fname: (r.querySelector('.fname') || {}).textContent,
        val: (r.querySelector('.val') || {}).value,
        meta: (r.querySelector('.row-meta') || {}).textContent,
        hasAiBadge: !!r.querySelector('.badge.ai'),
        hasNoLabelBadge: !!r.querySelector('.badge.nolabel'),
        aiMatched: r.classList.contains('ai-matched'),
        checked: !!(r.querySelector('.inc') || {}).checked,
        path: r.dataset.path
      };
    };
    return {
      rowCount: rows.length,
      rj1: of('rj_1'), rj2: of('rj_2'), rj3: of('rj_3'),
      statMatched: document.getElementById('stat-matched').textContent,
      statFillable: document.getElementById('stat-fillable').textContent,
      aiStripHidden: document.getElementById('ai-strip').hidden,
      sent: window.__SENT__.length,
      sentAi: (window.__SENT__.find((m) => m.type === 'RJ_AI_MAP') || {}),
      weakBadges: document.querySelectorAll('.badge.nolabel').length
    };
  });

  console.log('\n' + JSON.stringify(snap, null, 1).slice(0, 1800) + '\n');

  check('渲染出 3 行', snap.rowCount === 3, '实际 ' + snap.rowCount);
  check('发起了 AI 请求', snap.sentAi && snap.sentAi.type === 'RJ_AI_MAP');

  console.log('--- 场景一：模型认出含义但简历里没有对应字段 ---');
  check('假标签「请输入」被换成真标签', snap.rj2.fname === '紧急联系人手机号', snap.rj2.fname);
  check('「标签未识别」角标已移除', !snap.rj2.hasNoLabelBadge);
  check('打上了 AI 角标', snap.rj2.hasAiBadge);
  check('不填值（简历里没有对应内容）', snap.rj2.val === '', JSON.stringify(snap.rj2.val));
  check('仍然保持未匹配（不会被误填）', !snap.rj2.path, snap.rj2.path);
  check('meta 说明了原因', /简历里没有对应字段/.test(snap.rj2.meta || ''), snap.rj2.meta);

  console.log('--- 场景二：模型给出可用映射 ---');
  check('路径被写入', snap.rj3.path === 'basic.wechat', snap.rj3.path);
  check('值从简历里取出并填入', snap.rj3.val === 'zhangsan_wx', JSON.stringify(snap.rj3.val));
  check('真标签替换了假标签', snap.rj3.fname === '个人主页', snap.rj3.fname);
  check('行标记为 ai-matched', snap.rj3.aiMatched);
  check('默认勾选（空字段 + 有值）', snap.rj3.checked);
  check('meta 显示映射路径', /basic\.wechat/.test(snap.rj3.meta || ''), snap.rj3.meta);

  check('统计：命中匹配 = 2', snap.statMatched === '2', snap.statMatched);
  // rj_1（规则命中且简历里有值）与 rj_3（AI 命中）各算一个待填充
  check('统计：待填充 = 2', snap.statFillable === '2', snap.statFillable);
  check('AI 完成后进度条收起', snap.aiStripHidden === true);
  check('假标签角标全部清除', snap.weakBadges === 0, '还剩 ' + snap.weakBadges + ' 个');

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
