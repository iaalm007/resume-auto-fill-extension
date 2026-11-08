/**
 * 量「测试连接」到底慢在哪。
 * 跑真实的 ai-map.testConnection，只把 fetch 换成可控制延迟/状态的桩。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.resolve(__dirname, '..', '..', 'extension');

function makeContext(cfg, fetchImpl) {
  const sandbox = {};
  sandbox.self = sandbox; sandbox.window = sandbox; sandbox.console = console;
  sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
  sandbox.AbortController = AbortController;
  sandbox.fetch = fetchImpl;
  const store = {};
  sandbox.chrome = {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
          setTimeout(() => cb(out), 0);
        },
        set: (obj, cb) => { Object.keys(obj).forEach((k) => { store[k] = obj[k]; }); setTimeout(() => cb && cb(), 0); }
      }
    }
  };
  sandbox.__RJ_AI__ = { get: () => Promise.resolve(cfg), isUsable: () => true };
  sandbox.__RJ_STORE__ = {
    DEFAULT_PROFILE: { basic: {}, education: [], experience: [], projects: [], skills: [], selfEvaluation: '' }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'shared/ai-map.js'), 'utf8'), ctx, { filename: 'ai-map.js' });
  return sandbox.__RJ_AI_MAP__;
}

/** delayMs：响应前等多久；status：HTTP 状态；failMode：'ok' | 'http' | 'timeout' */
function makeFetch(behavior) {
  const stats = { calls: 0 };
  const impl = function (url, opts) {
    stats.calls++;
    const signal = opts && opts.signal;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (behavior.failMode === 'timeout') {
          // 超时由 AbortController 触发，这里什么都不断言
          return;
        }
        if (behavior.failMode === 'http') {
          resolve({
            ok: false, status: behavior.status,
            headers: { get: () => null },
            text: () => Promise.resolve('{"error":{"code":"x","message":"boom"}}')
          });
          return;
        }
        resolve({
          ok: true, status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve({ choices: [{ message: { content: '[]' } }] })
        });
      }, behavior.delayMs);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  };
  impl.stats = stats;
  return impl;
}

async function run(name, behavior, cfgOverride) {
  const cfg = Object.assign({
    enabled: true, baseUrl: 'https://x/v4', model: 'glm-4.5-flash', apiKey: 'k',
    timeoutMs: 3000, maxFieldsPerCall: 40
  }, cfgOverride || {});
  const f = makeFetch(behavior);
  const M = makeContext(cfg, f);
  const t0 = Date.now();
  const r = await M.testConnection();
  const ms = Date.now() - t0;
  console.log('  ' + name);
  console.log('    结果 ok=' + r.ok + (r.ok ? '' : '  错误="' + String(r.error).slice(0, 60) + '"'));
  console.log('    **耗时 ' + (ms / 1000).toFixed(1) + 's**   实际发出 ' + f.stats.calls + ' 次请求');
  return { ms, calls: f.stats.calls };
}

(async () => {
  console.log('=== 单次超时设定 3 秒、最多重试 3 次（真实代码的默认结构）===\n');

  await run('① 正常响应（200ms 就回来）', { delayMs: 200, failMode: 'ok' });
  await run('② 服务端 500（每次都立刻失败）', { delayMs: 200, failMode: 'http', status: 500 });
  await run('③ 一直不响应、每次都撞满超时', { delayMs: 60000, failMode: 'timeout' });
  await run('④ 401 参数错误（不该重试）', { delayMs: 200, failMode: 'http', status: 401 });

  console.log('\n--- 同样的四组，但超时按真实默认的 15 秒 ---\n');
  const real = {};
  real.a = await run('① 正常响应（200ms）', { delayMs: 200, failMode: 'ok' }, { timeoutMs: 15000 });
  real.b = await run('④ 401 参数错误', { delayMs: 200, failMode: 'http', status: 401 }, { timeoutMs: 15000 });
  // ③ 用 15 秒真跑一次太久了，按结构推算
  const oneTimeout = 15000, backoff = 800 + 1600;
  console.log('\n  ③ 一直不响应时（15 秒超时）推算：');
  console.log('     3 次超时 ' + (oneTimeout * 3 / 1000) + 's + 退避 ' + (backoff / 1000) + 's = **约 ' +
    ((oneTimeout * 3 + backoff) / 1000) + 's**（还要加上抖动）');
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
