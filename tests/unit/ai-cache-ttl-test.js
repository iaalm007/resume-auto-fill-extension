/**
 * AI 缓存：否定结论必须有有效期。
 *
 * 病根是一个很常见的用户路径：
 *   ① 扫描 → 模型说「这个框问的是紧急联系人，你简历里没有」→ 写进缓存
 *   ② 用户去资料页把紧急联系人补上
 *   ③ 回来重扫 → 缓存命中 → 仍然显示「简历里没有」，永远修不好，除非手动清缓存
 *
 * 所以「没有对应字段」这种否定结论只在 NEGATIVE_TTL_MS 内算数；
 * 肯定结论（有路径）长期有效 —— 路径不会因为时间而变错。
 *
 * 这里用 vm 直接把 ai-map.js 跑起来，用假的 fetch 数「到底联网了几次」。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.resolve(__dirname, '..', '..', 'extension');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const HOUR = 60 * 60 * 1000;
const NEG_TTL = 24 * HOUR;

function makeSandbox(cacheSeed) {
  const store = { rj_ai_cache: JSON.parse(JSON.stringify(cacheSeed)) };
  const box = {};
  box.self = box; box.window = box; box.console = console;
  box.setTimeout = setTimeout; box.clearTimeout = clearTimeout;
  box.AbortController = AbortController;
  box.JSON = JSON; box.Promise = Promise; box.Number = Number; box.Object = Object;
  box.Array = Array; box.String = String; box.Error = Error; box.Date = Date;
  box.isFinite = isFinite; box.encodeURIComponent = encodeURIComponent;

  box.calls = [];
  box.fetch = function (url, opts) {
    box.calls.push({ url: url, body: opts && opts.body });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: '[{"id":"f1","label":"紧急联系人","path":null,"confidence":0.9,"reason":"简历里没有"}]' } }]
      })
    });
  };

  box.chrome = {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (store[k] !== undefined) out[k] = JSON.parse(JSON.stringify(store[k]));
          });
          cb(out);
        },
        set: (obj, cb) => {
          Object.keys(obj).forEach((k) => { store[k] = JSON.parse(JSON.stringify(obj[k])); });
          if (cb) cb();
        }
      }
    }
  };

  const cfg = {
    enabled: true, baseUrl: 'https://example.test/v4', model: 'm',
    apiKey: 'k', timeoutMs: 5000, maxFieldsPerCall: 40
  };
  box.__RJ_AI__ = { get: () => Promise.resolve(cfg), isUsable: () => true };
  box.__RJ_STORE__ = {
    DEFAULT_PROFILE: { basic: { name: '' }, education: [], experience: [], projects: [], skills: [], selfEvaluation: '' }
  };

  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'shared/ai-map.js'), 'utf8'), box,
    { filename: 'ai-map.js' });
  box.store = store;
  return box;
}

const FIELD = [{
  id: 'f1', fingerprint: 'fp_same', label: '请输入', labelSource: 'placeholder',
  placeholder: '请输入', type: 'text', options: []
}];

(async () => {
  console.log('--- 否定结论：过期后必须重新问 ---');
  {
    const box = makeSandbox({
      fp_same: { path: null, label: '', confidence: 0, at: Date.now() - (NEG_TTL + HOUR) }
    });
    const r = await box.__RJ_AI_MAP__.handleMap(FIELD, {});
    check('过期的「简历里没有」被重新问一次', r.ok && r.asked === 1, JSON.stringify({ asked: r.asked, cached: r.cached }));
    check('确实发了一次请求', box.calls.length === 1, '实际 ' + box.calls.length);
    check('新结论写回缓存（带新的时间戳）',
      box.store.rj_ai_cache.fp_same && box.store.rj_ai_cache.fp_same.at > Date.now() - 60 * 1000,
      JSON.stringify(box.store.rj_ai_cache.fp_same));
  }

  console.log('\n--- 否定结论：有效期内不重复问 ---');
  {
    const box = makeSandbox({
      fp_same: { path: null, label: '', confidence: 0, at: Date.now() - HOUR }
    });
    const r = await box.__RJ_AI_MAP__.handleMap(FIELD, {});
    check('一天内的否定结论命中缓存', r.ok && r.asked === 0 && r.cached === 1,
      JSON.stringify({ asked: r.asked, cached: r.cached }));
    check('没有联网', box.calls.length === 0, '实际 ' + box.calls.length);

    const cov = await box.__RJ_AI_MAP__.countCached(FIELD);
    check('countCached 与 handleMap 口径一致（有效期内算命中）', cov.cached === 1,
      JSON.stringify(cov));
  }

  console.log('\n--- 肯定结论：不过期 ---');
  {
    const box = makeSandbox({
      fp_same: { path: 'basic.name', label: '姓名', confidence: 0.8, at: 1 }
    });
    const r = await box.__RJ_AI_MAP__.handleMap(FIELD, {});
    check('很早以前的正向映射仍然有效', r.ok && r.cached === 1 && r.asked === 0,
      JSON.stringify({ asked: r.asked, cached: r.cached }));
    check('没有联网', box.calls.length === 0, '实际 ' + box.calls.length);
    check('映射路径原样取出', r.mapping.f1 && r.mapping.f1.path === 'basic.name',
      JSON.stringify(r.mapping.f1));
  }

  console.log('\n--- countCached：过期否定不算命中 ---');
  {
    const box = makeSandbox({
      fp_same: { path: null, label: '', confidence: 0, at: Date.now() - (NEG_TTL + HOUR) }
    });
    const cov = await box.__RJ_AI_MAP__.countCached(FIELD);
    check('过期否定不计入 cached（否则弹窗会误判「不用联网」）', cov.cached === 0,
      JSON.stringify(cov));
  }

  console.log('\n--- 数组模板路径可被接受 ---');
  {
    const box = makeSandbox({});
    const allowed = box.__RJ_AI_MAP__.allowedPaths();
    check('education[*].school 在白名单里', allowed.indexOf('education[*].school') !== -1);
    const parsed = box.__RJ_AI_MAP__.parseMapping(
      '[{"id":"f1","label":"学校名称","path":"education[*].school","confidence":0.9,"reason":"教育经历"}]',
      { f1: 1 }
    );
    check('模型返回的数组模板不被当成编造路径',
      parsed.f1 && parsed.f1.path === 'education[*].school', JSON.stringify(parsed.f1));
    const bad = box.__RJ_AI_MAP__.parseMapping(
      '[{"id":"f1","label":"学校","path":"education[0].school","confidence":0.9}]', { f1: 1 });
    check('模型自己写序号的路径被丢弃（段号只能由页面顺序决定）',
      bad.f1 && bad.f1.path === null, JSON.stringify(bad.f1));
  }

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('运行异常：' + String((e && e.stack) || e).slice(0, 800));
  process.exit(1);
});
