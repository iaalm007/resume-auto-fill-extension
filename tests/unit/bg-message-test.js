/**
 * bg-message.js 测试：把「接收方不存在」和「页面已失效」分开处理，
 * 并确认原始报错被翻译成能照着做的说法。
 */
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '..', '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'shared/bg-message.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/** script: [{ lastError } | { reply } | { throwSync }]，用完最后一个就一直用它 */
function load(script) {
  const sandbox = {};
  const calls = [];
  const runtime = { lastError: undefined };
  let i = 0;

  runtime.sendMessage = (msg, cb) => {
    calls.push(msg);
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step.throwSync) throw new Error(step.throwSync);
    setTimeout(() => {
      if (step.lastError) {
        runtime.lastError = { message: step.lastError };
        cb(undefined);
        runtime.lastError = undefined;
      } else {
        cb(step.reply);
      }
    }, 3);
  };

  const fn = new Function('self', 'chrome', 'setTimeout', SRC);
  fn(sandbox, { runtime: runtime }, setTimeout);
  return { BG: sandbox.__RJ_BG__, calls };
}

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

(async () => {
  console.log('--- 分类：用户报的那句话 ---');
  const c0 = load([]);
  check('原句被判为 no-receiver', c0.BG.classify(NO_RECEIVER) === 'no-receiver');
  check('context invalidated 被判为 invalidated',
    c0.BG.classify('Extension context invalidated.') === 'invalidated');
  check('端口关闭不算可重试（那是代码问题）',
    c0.BG.classify('The message port closed before a response was received.') === 'other');
  const friendly = c0.BG.friendly({ code: 'no-receiver', error: NO_RECEIVER });
  console.log('  friendly(no-receiver) = ' + friendly);
  check('翻译后的说明里给出了可执行动作',
    /chrome:\/\/extensions/.test(friendly) && /重新加载/.test(friendly) && /重新打开/.test(friendly));

  console.log('\n--- 后台被回收：应当重试并成功 ---');
  const a = load([
    { lastError: NO_RECEIVER },
    { lastError: NO_RECEIVER },
    { reply: { ok: true, model: 'fake' } }
  ]);
  const r1 = await a.BG.send({ type: 'RJ_AI_TEST' }, { delay: 5 });
  check('第 3 次成功', r1.ok === true, JSON.stringify(r1));
  check('共发了 3 次', a.calls.length === 3, '实际 ' + a.calls.length);
  check('记录了尝试次数', r1.attempts === 3, '实际 ' + r1.attempts);

  console.log('\n--- 一直连不上：重试到上限后放弃 ---');
  const b = load([{ lastError: NO_RECEIVER }]);
  const r2 = await b.BG.send({ type: 'RJ_AI_TEST' }, { delay: 5 });
  check('最终失败', r2.ok === false);
  check('只重试到上限（3 次）', b.calls.length === 3, '实际 ' + b.calls.length);
  check('带上分类供上层判断', r2.code === 'no-receiver', r2.code);

  console.log('\n--- 页面已失效：不该重试 ---');
  const c = load([{ lastError: 'Extension context invalidated.' }]);
  const r3 = await c.BG.send({ type: 'RJ_AI_TEST' }, { delay: 5 });
  check('只发 1 次（重试也没用）', c.calls.length === 1, '实际 ' + c.calls.length);
  check('分类为 invalidated', r3.code === 'invalidated', r3.code);
  console.log('  friendly(invalidated) = ' + c.BG.friendly(r3));
  check('提示用户重开页面', /重新打开|刷新/.test(c.BG.friendly(r3)));

  console.log('\n--- 别的错误不重试 ---');
  const d = load([{ lastError: 'The message port closed before a response was received.' }]);
  const r4 = await d.BG.send({ type: 'RJ_AI_TEST' }, { delay: 5 });
  check('只发 1 次', d.calls.length === 1, '实际 ' + d.calls.length);
  check('原文保留（不冒充成别的问题）', r4.error.indexOf('message port closed') !== -1, r4.error);

  console.log('\n--- sendMessage 同步抛错也要兜住 ---');
  const e = load([{ throwSync: 'Extension context invalidated.' }]);
  const r5 = await e.BG.send({ type: 'RJ_AI_TEST' }, { delay: 5 });
  check('没抛出未捕获异常', !!r5 && r5.ok === false);
  check('分类正确', r5.code === 'invalidated', r5.code);

  console.log('\n--- 正常回复原样返回 ---');
  const f = load([{ reply: { ok: true, mapping: { rj_1: { path: 'basic.name' } } } }]);
  const r6 = await f.BG.send({ type: 'RJ_AI_MAP' }, { delay: 5 });
  check('回复透传', r6.ok && r6.mapping.rj_1.path === 'basic.name');
  check('只发 1 次', f.calls.length === 1);

  console.log('\n--- 后台回复为空 ---');
  const g = load([{ reply: undefined }]);
  const r7 = await g.BG.send({ type: 'RJ_AI_TEST' }, { delay: 5 });
  check('空回复也算失败且不重试', r7.ok === false && r7.code === 'empty' && g.calls.length === 1,
    JSON.stringify(r7));

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
