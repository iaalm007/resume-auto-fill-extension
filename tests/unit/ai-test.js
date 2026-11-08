/**
 * AI 层测试：提示词组装、白名单校验、缓存（站点级记忆）、429 退避重试、并发上限。
 * 用假的 fetch，不需要真的 API Key；并发/重试这些逻辑只有真跑才能验证。
 */
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '..', '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'shared/ai-map.js'), 'utf8');
const PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));

const PII = '13900001111';
const DEFAULT_PROFILE = {
  basic: { name: '', gender: '', birthday: '', phone: '', email: '', idCard: '', location: '', wechat: '', politicalStatus: '' },
  education: [], experience: [], projects: [], skills: [], selfEvaluation: ''
};

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/** 每个用例一个全新沙箱：模块状态（缓存、信号量）互不干扰 */
function loadAI(responses) {
  const store = {};
  const calls = [];
  const stats = { inFlight: 0, maxInFlight: 0 };

  const cfg = {
    enabled: true, baseUrl: 'http://fake.local/v1', model: 'fake-model',
    apiKey: 'sk-test', timeoutMs: 5000, maxFieldsPerCall: 40
  };

  const sandbox = {};
  const chromeStub = {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          keys.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
          setTimeout(() => cb(out), 0);
        },
        set: (obj, cb) => { Object.assign(store, obj); setTimeout(() => cb && cb(), 0); }
      }
    }
  };

  const fetchStub = (url, opts) => {
    calls.push({ url, body: opts.body });
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const script = (responses.shift && responses.shift()) || { status: 200, content: '[]' };
    return new Promise((resolve) => {
      setTimeout(() => {
        stats.inFlight--;
        resolve({
          ok: script.status >= 200 && script.status < 300,
          status: script.status,
          headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? (script.retryAfter || null) : null) },
          text: () => Promise.resolve(script.text || '{"error":"boom"}'),
          json: () => Promise.resolve({ choices: [{ message: { content: script.content } }] })
        });
      }, script.delay || 20);
    });
  };

  sandbox.__RJ_AI__ = {
    get: () => Promise.resolve(cfg),
    isUsable: (c) => !!(c && c.enabled && c.baseUrl && c.model && c.apiKey)
  };
  sandbox.__RJ_STORE__ = { DEFAULT_PROFILE: DEFAULT_PROFILE };

  const fn = new Function('self', 'chrome', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController', SRC);
  fn(sandbox, chromeStub, fetchStub, setTimeout, clearTimeout, AbortController);

  return { AI: sandbox.__RJ_AI_MAP__, calls, store, stats, cfg };
}

const OK_REPLY = JSON.stringify([
  { id: 'rj_4', label: '紧急联系人姓名', path: null, confidence: 0.88, reason: '问的是紧急联系人，简历里没有' },
  { id: 'rj_5', label: '个人主页', path: 'basic.wechat', confidence: 0.4, reason: '勉强对应微信号' }
]);

(async () => {
  console.log('--- 提示词组装 ---');
  const a = loadAI([]);
  const prompt = a.AI.buildUserPrompt(PLAN.fields.map(a.AI.slimField), PLAN.examples);
  check('提示词里带了 DOM 骨架', /第0层 </.test(prompt), '没有骨架');
  check('提示词里带了 resolvedExamples（供类比）', /已被规则解出的字段/.test(prompt) && /sibling\(d2\)/.test(prompt));
  check('提示词里带了路径白名单', /basic\.name = 姓名/.test(prompt));
  check('提示词里不含输入框的值', prompt.indexOf(PII) === -1, '哨兵出现了');
  check('系统提示词解释了 labelSource 的含义', /labelSource/.test(a.AI.buildSystemPrompt()));

  console.log('\n--- slimField 防御：即使传进来带了值也不发 ---');
  const withValue = a.AI.slimField(Object.assign({}, PLAN.fields[0], { value: PII, currentValue: PII }));
  check('value / currentValue 不会被带出去',
    JSON.stringify(withValue).indexOf(PII) === -1 && withValue.value === undefined);

  console.log('\n--- 白名单：模型编造的路径必须丢弃 ---');
  const parsed = a.AI.parseMapping(JSON.stringify([
    { id: 'a', path: 'basic.name', confidence: 0.9, label: '姓名' },
    { id: 'b', path: 'basic.notExist', confidence: 0.9 },          // 编造
    { id: 'c', path: null, confidence: 0.7, label: '紧急联系人电话' }, // 无对应字段
    { id: 'd', path: 'skills', confidence: 0.5 }
  ]), { a: 1, b: 1, c: 1, d: 1 });
  check('合法路径保留', parsed.a && parsed.a.path === 'basic.name');
  check('编造路径被丢弃且记录下来', parsed.b && parsed.b.path === null && !!parsed.b.invalidPath,
    JSON.stringify(parsed.b));
  check('path=null 的条目也保留（label 有价值）', parsed.c && parsed.c.path === null && parsed.c.label === '紧急联系人电话');
  check('数组型字段 skills 可用', parsed.d && parsed.d.path === 'skills');

  console.log('\n--- 主流程 + 站点级缓存 ---');
  const b = loadAI([{ status: 200, content: OK_REPLY }]);
  const fields = PLAN.fields.map((f) => Object.assign({}, f, { value: PII }));
  const r1 = await b.AI.handleMap(fields, { examples: PLAN.examples });
  check('第一次调用成功', r1.ok, r1.error);
  check('发出了 1 次请求', b.calls.length === 1, '实际 ' + b.calls.length);
  check('请求体里不含输入框的值', b.calls[0].body.indexOf(PII) === -1, '哨兵出现了');
  check('请求体里不含简历内容字段名', !/"path"\s*:/.test(b.calls[0].body));

  const first = fields[0].id;
  check('返回了映射', r1.mapping[first] && r1.mapping[first].path === null, JSON.stringify(r1.mapping[first]));
  check('模型给的真标签被带回', r1.mapping[first] && r1.mapping[first].label === '紧急联系人姓名');
  check('缓存写入了 label', b.store.rj_ai_cache[fields[0].fingerprint].label === '紧急联系人姓名',
    JSON.stringify(b.store.rj_ai_cache[fields[0].fingerprint]));

  const r2 = await b.AI.handleMap(fields, { examples: PLAN.examples });
  check('第二次不再发请求（站点级记忆生效）', b.calls.length === 1, '实际 ' + b.calls.length);
  check('第二次全部命中缓存', r2.cached === fields.length && r2.asked === 0,
    'cached=' + r2.cached + ' asked=' + r2.asked);
  check('缓存命中时 label 仍然带回', r2.mapping[first] && r2.mapping[first].label === '紧急联系人姓名',
    JSON.stringify(r2.mapping[first]));

  console.log('\n--- 429 速率限制：默认不重试（越重试越糟）---');
  const ZHIPU_429 = '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}';
  const c0 = loadAI([{ status: 429, text: ZHIPU_429 }, { status: 200, content: OK_REPLY }]);
  const r429 = await c0.AI.handleMap(PLAN.fields, { examples: [] });
  check('无 Retry-After 时只发 1 次、立即失败（不再白烧配额）',
    r429.ok === false && c0.calls.length === 1, '调用 ' + c0.calls.length + ' 次');
  check('错误里带着接口原文', /1302|429/.test(r429.error), r429.error);
  const advice = c0.AI.explainError(r429.error);
  console.log('  给用户的说法：' + advice);
  // HTTP 429 下面挂着处置方式**完全不同**的业务码，所以文案必须按业务码分支。
  // 依据：官方错误码表 docs.bigmodel.cn/cn/faq/api-code
  //   · 早先这里断言的写法是「429 文案要同时提到并发和额度/欠费」—— 那是错的：
  //     官方把欠费单列成 1113、额度用尽单列成 1308/1310，1302 从来不是额度问题。
  //     猜错方向会让用户跑去充值，而真正该做的是降并发。所以这里反过来断言：
  //     1302 的文案**不许**提欠费。
  check('1302 说成「账户速率限制 / 并发」，不给「欠费」的误导',
    /并发|速率限制/.test(advice) && !/欠费/.test(advice), advice);
  check('429 文案带上接口原话（那是唯一的证据）', /接口原话/.test(advice), advice);

  console.log('\n--- 429 下的不同业务码不能混为一谈 ---');
  [
    ['1305', '该模型当前访问量过大，请您稍后再试', /平台维度|不是你|账号的问题/, '平台过载（不代表账号有问题）'],
    ['1113', '您的账户已欠费，请充值后重试', /欠费/, '欠费（等多久都没用）'],
    ['1308', '已达到 100 次的使用上限。您的限额将在 2026-01-01 00:00 重置', /用量上限|重置/, '周期额度用尽（会自动重置）']
  ].forEach(function (c) {
    const text = '接口返回 HTTP 429：{"error":{"code":"' + c[0] + '","message":"' + c[1] + '"}}';
    const msg = c0.AI.explainError(text);
    // 打出来：这些就是用户实际会看到的字，评审时一眼能看出来对不对
    console.log('  ' + c[0] + ' → ' + msg.replace(/接口原话：[\s\S]*$/, '').trim());
    check('业务码 ' + c[0] + ' → ' + c[3], c[2].test(msg), msg);
  });
  const noCode = c0.AI.explainError('接口返回 HTTP 429：rate limit exceeded');
  check('没有业务码时只说「请求太快 / 降并发」，不猜欠费',
    /请求太快|降低并发/.test(noCode) && !/欠费/.test(noCode), noCode);

  console.log('\n--- 服务端明确给了 Retry-After 才等 ---');
  const c = loadAI([
    { status: 429, text: 'rate limited', retryAfter: '0.05' },
    { status: 200, content: OK_REPLY }
  ]);
  const r3 = await c.AI.handleMap(PLAN.fields, { examples: [] });
  check('Retry-After 很短时重试并成功', r3.ok && c.calls.length === 2, '调用 ' + c.calls.length + ' 次');
  check('重试后拿到正常映射', r3.mapping[PLAN.fields[0].id] && r3.mapping[PLAN.fields[0].id].label === '紧急联系人姓名');

  const cLong = loadAI([{ status: 429, text: 'rate limited', retryAfter: '120' }, { status: 200, content: OK_REPLY }]);
  const rLong = await cLong.AI.handleMap(PLAN.fields, { examples: [] });
  check('Retry-After 太长（120 秒）就不干等，直接交给用户',
    rLong.ok === false && cLong.calls.length === 1, '调用 ' + cLong.calls.length + ' 次');

  console.log('\n--- 其它接口错误的说法 ---');
  const e401 = await loadAI([{ status: 401, text: 'invalid api key' }]).AI.handleMap([], {});
  check('空字段列表直接返回，不发请求', e401.ok === true && e401.asked === 0);
  const t401 = loadAI([{ status: 401, text: 'invalid api key' }]);
  const x401 = await t401.AI.testConnection();
  check('401 翻译成「Key 无效或过期」', /API Key 无效|过期/.test(t401.AI.explainError(x401.error)),
    t401.AI.explainError(x401.error));
  const t404 = loadAI([{ status: 404, text: '{"error":"model not found"}' }]);
  const x404 = await t404.AI.testConnection();
  check('404 翻译成「接口地址或模型名不对」', /模型名|接口地址/.test(t404.AI.explainError(x404.error)),
    t404.AI.explainError(x404.error));

  console.log('\n--- 不该重试的错误 ---');
  const d = loadAI([{ status: 401, text: 'bad key' }, { status: 200, content: OK_REPLY }]);
  // 契约：handleMap 一律返回 {ok:false}，不抛异常（弹窗直连时没人兜底，抛出去就是卡死）
  const authRes = await d.AI.handleMap(PLAN.fields, { examples: [] });
  check('401 直接失败（返回 {ok:false} 而非抛异常）、不重试',
    !!authRes && authRes.ok === false && /401/.test(authRes.error) && d.calls.length === 1,
    JSON.stringify(authRes) + ' 调用 ' + d.calls.length + ' 次');
  check('isRetryable 判定正确',
    d.AI.isRetryable({ status: 503 }) && d.AI.isRetryable({ message: '请求超时' }) &&
    !d.AI.isRetryable({ status: 401 }) && !d.AI.isRetryable({ status: 400 }));
  // 429 的契约变了：它不算「可重试」，而是走单独的分支（只有 Retry-After 够短才等一次）
  check('429 不走通用重试分支（避免白烧配额）', d.AI.isRetryable({ status: 429 }) === false);

  console.log('\n--- 并发上限（多标签页同时扫描的场景）---');
  const e = loadAI(Array.from({ length: 6 }, () => ({ status: 200, content: OK_REPLY, delay: 60 })));
  const parallel = [0, 1, 2, 3, 4, 5].map((i) => e.AI.handleMap(
    [{ id: 'f' + i, fingerprint: 'fp_uniq_' + i, label: '请输入', labelSource: 'placeholder', type: 'text', skeleton: [] }],
    { examples: [] }
  ));
  const results = await Promise.all(parallel);
  check('6 个并发请求全部成功', results.every((r) => r.ok));
  check('同时在飞的请求不超过 2 个', e.stats.maxInFlight <= 2, '实际峰值 ' + e.stats.maxInFlight);
  check('6 个请求都发出去了', e.calls.length === 6, '实际 ' + e.calls.length);

  console.log('\n--- testConnection ---');
  const f = loadAI([{ status: 200, content: JSON.stringify([{ id: 'probe', label: '手机号码', path: 'basic.phone', confidence: 0.9 }]) }]);
  const conn = await f.AI.testConnection();
  check('连通性自检通过并认出了骨架里的标签', conn.ok && conn.sample && conn.sample.path === 'basic.phone',
    JSON.stringify(conn.sample));

  console.log('\n--- 接口报错时不能 reject（否则弹窗直连时会卡在「分析中…」）---');
  // 500 是可重试错误，MAX_RETRY=3 —— 必须给满 3 条，否则第 4 次会拿到兜底的成功响应
  const BOOM = [{ status: 500, text: 'boom' }, { status: 500, text: 'boom' }, { status: 500, text: 'boom' }];
  const h = loadAI(BOOM.slice());
  let rejected = false;
  let res5 = null;
  try { res5 = await h.AI.handleMap(PLAN.fields, { examples: [] }); } catch (e) { rejected = true; }
  check('handleMap 不 reject，而是返回 {ok:false}',
    !rejected && res5 && res5.ok === false, JSON.stringify(res5));
  check('错误信息可读', !!(res5 && /500/.test(res5.error)), res5 && res5.error);
  check('500 被重试到上限', h.calls.length === 3, '实际 ' + h.calls.length + ' 次');

  const h2 = loadAI(BOOM.slice());
  let rejected2 = false;
  let res6 = null;
  try { res6 = await h2.AI.testConnection(); } catch (e) { rejected2 = true; }
  check('testConnection 同样不 reject，且带回真实原因',
    !rejected2 && res6 && res6.ok === false && /500/.test(res6.error), JSON.stringify(res6));

  const h3 = loadAI([{ status: 401, text: 'bad key' }]);
  const res7 = await h3.AI.testConnection();
  check('401 立即失败、不重试', res7.ok === false && h3.calls.length === 1,
    JSON.stringify(res7) + ' 调用 ' + h3.calls.length + ' 次');

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
