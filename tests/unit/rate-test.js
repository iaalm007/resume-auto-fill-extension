/**
 * 频率闸测试：每分钟配额 + 429 冷却。
 *
 * 最要紧的一条是「跨上下文」：弹窗在后台不可用时会降级**本页直连**，
 * 此时每个标签页各有一份内存状态。所以额度必须存在 chrome.storage 里，
 * 并且两个独立的 vm 上下文（模拟两个标签页）读同一份存储时要能互相看见。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.resolve(__dirname, '..', '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

// ---------------------------------------------------------------- 环境搭台

/** 一份共享的 chrome.storage.local 桩（两个上下文共用它 = 同一份扩展存储） */
function makeStorage() {
  const store = {};
  return {
    store,
    api: {
      get(keys, cb) {
        const out = {};
        const arr = Array.isArray(keys) ? keys : [keys];
        arr.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) {
        Object.keys(obj).forEach((k) => { store[k] = obj[k]; });
        setTimeout(() => cb && cb(), 0);
      }
    }
  };
}

function makeFetch(state) {
  return function () {
    state.calls++;
    if (state.fail429) {
      return Promise.resolve({
        ok: false, status: 429,
        headers: { get: () => null },
        text: () => Promise.resolve('{"error":{"code":"1302","message":"rate limit reached"}}')
      });
    }
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({ choices: [{ message: { content: '[]' } }] })
    });
  };
}

const CFG = {
  enabled: true, baseUrl: 'https://example.com/v4', model: 'm', apiKey: 'k',
  timeoutMs: 5000, maxFieldsPerCall: 40
};

/** 建一个「上下文」（≈ 一个标签页 / 一次 Service Worker 生命周期） */
function makeContext(storageApi, fetchState) {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.AbortController = AbortController;
  sandbox.fetch = makeFetch(fetchState);
  sandbox.chrome = { storage: { local: storageApi } };
  sandbox.__RJ_AI__ = { get: () => Promise.resolve(CFG), isUsable: () => true };
  sandbox.__RJ_STORE__ = {
    DEFAULT_PROFILE: {
      basic: { name: '', phone: '', email: '' },
      education: [], experience: [], projects: [], skills: [], selfEvaluation: ''
    }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'shared/ai-map.js'), 'utf8'), ctx,
    { filename: 'ai-map.js' });
  return sandbox.__RJ_AI_MAP__;
}

const field = (i) => ({
  id: 'rj_' + i, fingerprint: 'fp_' + i,
  label: '待判断字段' + i, labelSource: 'placeholder', placeholder: '请输入',
  type: 'text', options: []
});

// ---------------------------------------------------------------- 开始

(async () => {
  const st = makeStorage();
  const f1 = { calls: 0, fail429: false };
  const A = makeContext(st.api, f1);
  const MAX = A.MAX_PER_MINUTE;

  console.log('配置：MAX_PER_MINUTE=' + MAX + '  RATE_WINDOW_MS=' + A.RATE_WINDOW_MS);

  // ---------- A. 配额 ----------
  console.log('\n--- A. 每分钟配额 ---');
  await A.clearRateLimit();
  f1.calls = 0;

  const results = [];
  for (let i = 0; i < MAX; i++) {
    results.push(await A.handleMap([field(i)], { examples: [] }));
  }
  check('前 ' + MAX + ' 次都放行', results.every((r) => r.ok), JSON.stringify(results.map((r) => r.ok)));
  check('实际发出 ' + MAX + ' 个请求', f1.calls === MAX, 'calls=' + f1.calls);

  const over = await A.handleMap([field(99)], { examples: [] });
  check('第 ' + (MAX + 1) + ' 次被本地拦下', over.ok === false, JSON.stringify(over));
  check('被拦时带 code=local-throttle', over.code === 'local-throttle', over.code);
  check('被拦时**没有**额外发请求', f1.calls === MAX, 'calls=' + f1.calls);
  check('文案说明是本地限流且给了等待秒数',
    /本地限流/.test(over.error) && /\d+\s*秒/.test(over.error), over.error);
  check('文案不会被 explainError 改写成「接口 429」的说法',
    A.explainError(over.error) === over.error, A.explainError(over.error));

  // ---------- B. 跨上下文共享（模拟两个标签页直连）----------
  console.log('\n--- B. 跨上下文共享额度（两个标签页直连）---');
  const f2 = { calls: 0, fail429: false };
  const B = makeContext(st.api, f2);        // 另起一个上下文，共用同一份存储
  const other = await B.handleMap([field(200)], { examples: [] });
  check('另一个上下文也被同一份额度拦住', other.ok === false && other.code === 'local-throttle',
    JSON.stringify(other));
  check('它也没有真的发请求', f2.calls === 0, 'calls=' + f2.calls);

  // ---------- C. 窗口滚动后恢复 ----------
  console.log('\n--- C. 窗口过期后恢复 ---');
  st.store.rj_ai_rate = { windowStart: Date.now() - A.RATE_WINDOW_MS - 1000, count: MAX };
  const afterWindow = await A.handleMap([field(201)], { examples: [] });
  check('窗口过期后重新放行', afterWindow.ok === true, JSON.stringify(afterWindow));

  // ---------- D. 429 → 冷却 ----------
  console.log('\n--- D. 接口 429 之后的全局冷却 ---');
  await A.clearRateLimit();
  f1.fail429 = true;
  const callsBefore429 = f1.calls;              // 前面几段累计过，这里要看**增量**
  const hit429 = await A.handleMap([field(300)], { examples: [] });
  check('429 时返回 ok=false', hit429.ok === false, JSON.stringify(hit429));
  check('429 **不重试**（只发一次，不去继续啃见底的配额）',
    f1.calls - callsBefore429 === 1, '增量=' + (f1.calls - callsBefore429));
  check('错误文案里认得这是限流', /限流|429|速率/.test(A.explainError(hit429.error)),
    A.explainError(hit429.error));

  const cd = await A.readCooldown();
  check('已写入冷却期', !!cd && cd.until > Date.now(), JSON.stringify(cd));

  f1.fail429 = false;
  const duringCd = await A.handleMap([field(301)], { examples: [] });
  check('冷却期内不再发请求', duringCd.ok === false && duringCd.code === 'local-throttle',
    JSON.stringify(duringCd));
  check('冷却文案点明「静默」', /静默/.test(duringCd.error), duringCd.error);

  const cdOther = await B.handleMap([field(302)], { examples: [] });
  check('另一个标签页同样被冷却挡住（这是跨页面的兜底）',
    cdOther.ok === false && cdOther.code === 'local-throttle', JSON.stringify(cdOther));

  // ---------- E. 复位 ----------
  console.log('\n--- E. 复位后可继续 ---');
  await A.clearRateLimit();
  const afterClear = await A.handleMap([field(303)], { examples: [] });
  check('清空限流状态后能再次发送', afterClear.ok === true, JSON.stringify(afterClear));

  // ---------- F. 缓存仍然免联网（别把省请求的能力弄坏）----------
  console.log('\n--- F. 缓存命中不占额度 ---');
  await A.clearRateLimit();
  const f3 = { calls: 0, fail429: false };
  const C = makeContext(st.api, f3);
  // 先让同一个字段被问过一次（会写进缓存）
  const one = field(400);
  await C.handleMap([one], { examples: [] });
  const callsAfterFirst = f3.calls;
  const again = await C.handleMap([one], { examples: [] });
  check('同一指纹第二次命中缓存', again.ok === true && again.cached === 1 && again.asked === 0,
    JSON.stringify({ cached: again.cached, asked: again.asked }));
  check('命中缓存时没有联网', f3.calls === callsAfterFirst, 'calls=' + f3.calls);

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
