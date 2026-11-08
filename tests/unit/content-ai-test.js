/**
 * 内容侧集成测试：走真实的 RJ_SCAN 消息链路，检查交给 AI 层的数据长什么样。
 * 产物 plan.json 会喂给 ai-test.js 去拼真实提示词，形成端到端闭环。
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');
const OUT = path.join(__dirname, 'plan.json');

const PII = '13900001111';     // 只存在于输入框 value 里的哨兵，绝不能出现在发给模型的数据里

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="form-item"><div class="label">姓名</div><div class="control"><div><input id="k1" placeholder="请输入" value="${PII}" /></div></div></div>
<div class="form-item"><div class="label">手机号码</div><div class="control"><div><input id="k2" placeholder="请输入" /></div></div></div>
<div class="form-item"><div class="label">性别</div><div class="control"><div class="opts"><label><input type="radio" name="sex" value="M" checked />男</label><label><input type="radio" name="sex" value="F" />女</label></div></div></div>
<div class="form-item"><div class="control"><div><input id="k3" placeholder="请输入" value="${PII}" /></div></div></div>
<div class="form-item"><div class="control"><div><textarea id="k4" placeholder="请输入">${PII}</textarea></div></div></div>
</body></html>`;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e).slice(0, 300)));

  // 最小 chrome 桩：让 content script 能在普通页面里跑起来。
  // 必须在导航前注册 —— evaluateOnNewDocument 只在「新文档」生效，
  // setContent 是往当前文档里写，之后 reload 又会把内容冲成空白页。
  await page.evaluateOnNewDocument(() => {
    window.__LISTENER__ = null;
    window.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => { window.__LISTENER__ = fn; } },
        getManifest: () => ({ version: 'test' })
      },
      storage: {
        local: {
          get: (keys, cb) => cb({}),
          set: (obj, cb) => { if (cb) cb(); }
        }
      }
    };
  });

  const PAGE_FILE = path.join(__dirname, 'ai-page.html');
  fs.writeFileSync(PAGE_FILE, HTML);
  await page.goto('file:///' + PAGE_FILE.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded' });

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

  const hasListener = await page.evaluate(() => typeof window.__LISTENER__ === 'function');
  check('content script 已注册消息监听', hasListener);
  if (!hasListener) { await browser.close(); process.exit(1); }

  const res = await page.evaluate(() => new Promise((resolve) => {
    const done = window.__LISTENER__({ type: 'RJ_SCAN' }, null, resolve);
    if (!done) resolve({ ok: false, error: '监听器没接管' });
  }));

  check('RJ_SCAN 成功返回', res && res.ok, res && res.error);
  if (!res || !res.ok) { await browser.close(); process.exit(1); }

  const plan = res.plan || [];
  console.log('\n扫到 ' + plan.length + ' 个字段：');
  plan.forEach((p) => {
    console.log('  · ' + (p.label || '(空)').padEnd(6) +
      ' src=' + String(p.labelSource).padEnd(14) +
      ' → ' + String(p.suggestedPath || '(未匹配)').padEnd(14) +
      ' skeleton=' + ((p.aiFeatures && p.aiFeatures.skeleton) ? p.aiFeatures.skeleton.length + '层' : '无'));
  });

  const pending = plan.filter((p) => !p.suggestedPath);
  const resolved = plan.filter((p) => p.suggestedPath);

  check('有字段被规则解出（resolvedExamples 才有内容）', resolved.length >= 3, '共 ' + resolved.length);
  check('有字段未命中（才需要 AI）', pending.length >= 2, '共 ' + pending.length);

  console.log('\n--- resolvedExamples ---');
  console.log(JSON.stringify(res.resolvedExamples, null, 1));
  check('resolvedExamples 带上了 labelSource（模型据此类比写法）',
    (res.resolvedExamples || []).every((e) => !!e.labelSource) && (res.resolvedExamples || []).length > 0);

  console.log('\n--- 未命中字段的骨架 ---');
  pending.forEach((p) => {
    console.log('  [' + p.label + ']');
    (p.aiFeatures.skeleton || []).forEach((l) => console.log('    ' + l));
  });

  check('未命中字段都带了 skeleton', pending.every((p) =>
    p.aiFeatures.skeleton && p.aiFeatures.skeleton.length), '有字段没带骨架');
  check('已命中字段不带 skeleton（省 token）',
    resolved.every((p) => !p.aiFeatures.skeleton),
    resolved.filter((p) => p.aiFeatures.skeleton).map((p) => p.label).join(','));

  // 隐私回归：整份待发数据里不能出现只存在于 value 里的哨兵
  const payload = JSON.stringify({
    fields: pending.map((p) => p.aiFeatures),
    examples: res.resolvedExamples
  });
  check('待发数据里不含输入框的值（哨兵 ' + PII + '）',
    payload.indexOf(PII) === -1, '哨兵出现了');
  check('待发数据里不含 value / currentValue 字段',
    !/"value"\s*:/.test(payload) && !/"currentValue"\s*:/.test(payload));

  const weakPending = pending.filter((p) => p.labelSource === 'placeholder' || p.labelSource === 'none');
  check('未命中字段的标签来源确实是不可信的', weakPending.length === pending.length,
    pending.map((p) => p.labelSource).join(','));

  fs.writeFileSync(OUT, JSON.stringify({
    fields: pending.map((p) => p.aiFeatures),
    examples: res.resolvedExamples
  }, null, 2));
  console.log('\n已写出 ' + OUT);

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
