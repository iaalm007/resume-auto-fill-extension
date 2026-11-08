/**
 * 设置页 AI 动作测试：
 *   「测试连接」必须直接测接口，不能卡在后台链路上；
 *   后台死掉时要说清「接口是好的、是后台连不上」。
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

const LLM_REPLY = JSON.stringify([
  { id: 'probe', label: '手机号码', path: 'basic.phone', confidence: 0.92, reason: '骨架里写着手机号码' }
]);

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e && e.stack || e).slice(0, 400)));

  await page.evaluateOnNewDocument((llmReply) => {
    const store = {
      rj_ai_config: { enabled: true, baseUrl: 'http://fake.local/v1', model: 'fake-model', apiKey: 'sk-test' },
      rj_ai_cache: { fp_old: { path: 'basic.name', confidence: 0.9, at: 1 } },
      rj_active_resume: 'r_test',
      rj_resume_r_test: {
        id: 'r_test', name: '测试简历', createdAt: 1, updatedAt: 1,
        profile: {
          basic: { name: '张三', gender: '', birthday: '', phone: '', email: '', idCard: '', location: '', wechat: '', politicalStatus: '' },
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
    const answer = (value, cb, delay) => {
      if (typeof cb === 'function') return setTimeout(() => cb(value), delay || 0);
      return new Promise((r) => setTimeout(() => r(value), delay || 0));
    };

    window.__STORE__ = store;
    window.__SENT_TO_BG__ = [];
    window.__BG_MODE__ = 'down';          // 默认：后台连不上
    window.__FETCH_CALLS__ = [];

    window.chrome = {
      runtime: {
        lastError: undefined,
        getManifest: () => ({ version: 'test' }),
        openOptionsPage: () => {},
        sendMessage: (msg, cb) => {
          window.__SENT_TO_BG__.push(msg && msg.type);
          if (msg && msg.type === 'RJ_PING_BG') {
            if (window.__BG_MODE__ === 'down') {
              window.chrome.runtime.lastError = {
                message: 'Could not establish connection. Receiving end does not exist.'
              };
              setTimeout(() => { cb(undefined); window.chrome.runtime.lastError = undefined; }, 0);
              return;
            }
            return answer({ ok: true, at: 1 }, cb, 0);
          }
          return answer({ ok: true }, cb, 0);
        }
      },
      tabs: { query: (q, cb) => answer([{ id: 1 }], cb, 0), sendMessage: (i, m, cb) => answer({ ok: true }, cb, 0) },
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
        ok: true, status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ choices: [{ message: { content: llmReply } }] })
      });
    };
  }, LLM_REPLY);

  const URL = 'file:///' + path.join(EXT, 'options.html').replace(/\\/g, '/');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => {
    const el = document.getElementById('ai-baseurl');
    return el && el.value && el.value.length > 0;     // 等配置回填完（说明初始化完成）
  }, { timeout: 15000 });

  const clickAndWait = async (sel) => {
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      el.click();
    }, sel);
    await page.waitForFunction(() => {
      const t = document.getElementById('ai-status').textContent || '';
      return t && !/测试中/.test(t);
    }, { timeout: 12000 });
    return page.evaluate(() => {
      const el = document.getElementById('ai-status');
      return { text: el.textContent, cls: el.className };
    });
  };

  console.log('--- 后台连不上时点「测试连接」---');
  await page.evaluate(() => { window.__BG_MODE__ = 'down'; window.__FETCH_CALLS__ = []; });
  const r1 = await clickAndWait('#btn-ai-test');
  console.log('  状态栏：' + r1.text + '   [' + r1.cls + ']');

  check('接口确实被直接调用了（不绕后台）',
    (await page.evaluate(() => window.__FETCH_CALLS__.length)) === 1,
    '实际 ' + (await page.evaluate(() => window.__FETCH_CALLS__.length)) + ' 次');
  check('没有把 RJ_AI_TEST 丢给后台（这条是回归点）',
    !(await page.evaluate(() => window.__SENT_TO_BG__.includes('RJ_AI_TEST'))),
    JSON.stringify(await page.evaluate(() => window.__SENT_TO_BG__)));
  check('报出了接口是正常的', /接口正常/.test(r1.text), r1.text);
  check('读出了模型返回的判定', /basic\.phone/.test(r1.text), r1.text);
  check('同时点明了后台连不上', /后台连不上/.test(r1.text), r1.text);
  check('给出了可执行动作', /chrome:\/\/extensions/.test(r1.text), r1.text);
  check('用醒目但非失败的颜色（working）', /working/.test(r1.cls), r1.cls);
  check('不再出现那句没信息量的原文',
    r1.text.indexOf('Could not establish connection') === -1, r1.text);

  console.log('\n--- 后台正常时点「测试连接」---');
  await page.evaluate(() => { window.__BG_MODE__ = 'up'; });
  const r2 = await clickAndWait('#btn-ai-test');
  console.log('  状态栏：' + r2.text + '   [' + r2.cls + ']');
  check('显示为成功', /ok/.test(r2.cls), r2.cls);
  check('说明后台正常', /后台正常/.test(r2.text), r2.text);
  check('仍报出接口正常', /接口正常/.test(r2.text), r2.text);

  console.log('\n--- 接口失败时要说真实原因 ---');
  await page.evaluate(() => {
    window.fetch = () => Promise.resolve({
      ok: false, status: 401,
      headers: { get: () => null },
      text: () => Promise.resolve('invalid api key')
    });
  });
  const r3 = await clickAndWait('#btn-ai-test');
  console.log('  状态栏：' + r3.text + '   [' + r3.cls + ']');
  check('报 401 而不是后台问题', /401/.test(r3.text) && !/后台连不上/.test(r3.text), r3.text);
  check('翻译成能照做的说法', /API Key 无效|过期/.test(r3.text), r3.text);
  check('标记为失败', /err/.test(r3.cls), r3.cls);

  console.log('\n--- 429 速率限制：说清原因，且不连点 ---');
  const ZHIPU_429 = '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}';
  await page.evaluate((body) => {
    window.__FETCH_CALLS__ = [];
    window.fetch = (url) => {
      window.__FETCH_CALLS__.push(url);
      // 故意慢一点，好在飞行中检查按钮状态
      return new Promise((resolve) => setTimeout(() => resolve({
        ok: false, status: 429,
        headers: { get: () => null },
        text: () => Promise.resolve(body)
      }), 400));
    };
  }, ZHIPU_429);

  await page.evaluate(() => document.getElementById('btn-ai-test').click());
  await new Promise((r) => setTimeout(r, 120));
  const midFlight = await page.evaluate(() => ({
    disabled: document.getElementById('btn-ai-test').disabled,
    status: document.getElementById('ai-status').textContent
  }));
  check('测试期间按钮被禁用（防连点把自己打限流）', midFlight.disabled === true, JSON.stringify(midFlight));
  check('飞行中显示「测试中…」', /测试中/.test(midFlight.status), midFlight.status);

  await page.waitForFunction(() => {
    const t = document.getElementById('ai-status').textContent || '';
    return t && !/测试中/.test(t);
  }, { timeout: 12000 });
  const r429 = await page.evaluate(() => ({
    text: document.getElementById('ai-status').textContent,
    cls: document.getElementById('ai-status').className,
    disabled: document.getElementById('btn-ai-test').disabled,
    fetches: window.__FETCH_CALLS__.length
  }));
  console.log('  状态栏：' + r429.text + '   [' + r429.cls + ']');
  check('按钮恢复可用', r429.disabled === false);
  check('429 只说一次（不重试白烧配额）', r429.fetches === 1, '实际 ' + r429.fetches + ' 次');
  check('说清是速率限制', /速率限制|429/.test(r429.text), r429.text);
  // 业务码 1302 = 账户维度的速率限制（并发/请求过密）。
  // 注意**不许**出现「欠费」——官方把欠费单列成 1113，1302 从来不是额度问题
  // （早先的断言写反了，见 tests/unit/ai-test.js 里的说明）。
  check('1302 说成「并发 / 速率限制」，不给「欠费」的误导',
    /并发|速率限制/.test(r429.text) && !/欠费/.test(r429.text), r429.text);
  check('429 文案带上接口原话', /接口原话/.test(r429.text), r429.text);

  console.log('\n--- 「清空缓存」也应直接完成 ---');
  await page.evaluate(() => { window.__SENT_TO_BG__ = []; });
  const r4 = await clickAndWait('#btn-ai-clear');
  console.log('  状态栏：' + r4.text);
  check('提示已清空', /缓存已清空/.test(r4.text), r4.text);
  check('缓存真的被清空了（storage 里为空）',
    Object.keys(await page.evaluate(() => window.__STORE__.rj_ai_cache)).length === 0,
    JSON.stringify(await page.evaluate(() => window.__STORE__.rj_ai_cache)));
  check('没有走后台', !(await page.evaluate(() => window.__SENT_TO_BG__.includes('RJ_AI_CLEAR_CACHE'))),
    JSON.stringify(await page.evaluate(() => window.__SENT_TO_BG__)));

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
