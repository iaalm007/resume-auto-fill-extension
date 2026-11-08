/**
 * 端到端验证：真实 Chrome + 真实 HTTP，把整条链路串起来跑。
 *
 *   投递表单页(真实 DOM)  ←→  内容脚本(scanner/filler/matcher)
 *          ↑ RJ_SCAN / RJ_FILL          ↓ 真实扫描结果
 *   弹窗页(真实 popup.html/js)  →  真实 HTTP 请求  →  本地假 OpenAI 接口
 *                              ↓
 *                        AI 结果落到弹窗 DOM  →  点填充  →  真实表单被改写
 *
 * 不依赖「加载扩展」——那个在 Chrome 155 上做不了（Extensions.loadUnpacked 不真装）。
 * 除了扩展打包本身，其余每一行都是生产代码。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', '..', 'extension');

const PII = '13900001111';    // 只存在于表单 value 里的哨兵
const RESUMED_PHONE = '13800002222';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

// ------------------------------------------------------------------ 测试用投递表单
const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>某公司 - 投递表单</title></head>
<body>
<h1>投递申请</h1>
<form>

  <!-- 1. 规则能命中：label 与输入框分离 -->
  <div class="form-item"><div class="label">姓名</div>
    <div class="control"><div><input id="f1" placeholder="请输入" /></div></div></div>

  <!-- 2. 词典缺口：「紧急联络方式」不含任何现有关键词，规则命中不了，需要 AI -->
  <div class="form-item"><div class="label">紧急联络方式</div>
    <div class="control"><div><input id="f2" placeholder="请输入" /></div></div></div>

  <!-- 3. 词典缺口：简历里根本没有「学历」这个字段，AI 应当认出含义但给出 null -->
  <div class="form-item"><div class="label">最高学历</div>
    <div class="control"><div><input id="f3" placeholder="请输入" /></div></div></div>

  <!-- 4. 词典缺口：「个人主页」无关键词，但可以对应到微信号 -->
  <div class="form-item"><div class="label">个人主页</div>
    <div class="control"><div><input id="f4" placeholder="请输入" /></div></div></div>

  <!-- 5. 页面上压根没有标签，以及一个用户已经填过的值（哨兵） -->
  <div class="form-item"><div class="control"><div>
    <input id="f5" placeholder="请输入" value="${PII}" /></div></div></div>

  <!-- 6. 受控组件：不派发 input 事件的话，400ms 后会被「框架」回滚 -->
  <div class="form-item"><div class="label">电子邮箱</div>
    <div class="control"><div><input id="f6" placeholder="请输入" /></div></div></div>

  <!-- 7. 单选组 -->
  <div class="form-item"><div class="label">性别</div>
    <div class="control"><div class="opts">
      <label><input type="radio" name="sex" value="男" />男</label>
      <label><input type="radio" name="sex" value="女" />女</label>
    </div></div></div>

</form>

<script>
  // 伪 React 受控组件：把 value 改回上一个渲染值。不派发 input 事件就会被回滚。
  (function () {
    var el = document.getElementById('f6');
    var committed = '';
    el.addEventListener('input', function () { committed = el.value; });
    setInterval(function () { if (el.value !== committed) el.value = committed; }, 400);
  })();
</script>
</body></html>`;

/**
 * 假模型：**真的读请求体**，按里面出现的字段给出映射。
 * 不能写死 id —— 真实字段 id 是 rj_*，写死的话会被白名单全部丢掉，
 * 那样测的就不是链路而是我自己的疏忽了。
 */
function fakeModelReply(body) {
  let fields = [];
  try {
    const parsed = JSON.parse(body);
    const user = parsed.messages.filter((m) => m.role === 'user')[0].content;
    const seg = user.split('【需要判断的输入框】')[1].split('【输出格式】')[0].trim();
    fields = JSON.parse(seg);
  } catch (e) { return []; }

  return fields.map((f) => {
    // 关键：只依据「这个字段自己的标签」。标签不可信时不许拿骨架里的邻近文本来猜 ——
    // 骨架的「前兄弟」里会带出别的字段的标签，照着猜必然张冠李戴。
    // （这一点也说明：真实提示词里那句「(含控件)」标记很重要，它就是在告诉模型那不是你的标签。）
    const weak = f.labelSource === 'placeholder' || f.labelSource === 'none';
    const own = weak ? '' : String(f.label || '');
    if (/紧急联络/.test(own)) {
      return { id: f.id, label: '', path: null, confidence: 0.9, reason: '问的是紧急联系人，简历里没有' };
    }
    if (/最高学历/.test(own)) {
      return { id: f.id, label: '', path: null, confidence: 0.85, reason: '简历里没有学历字段' };
    }
    if (/个人主页/.test(own)) {
      return { id: f.id, label: '', path: 'basic.wechat', confidence: 0.6, reason: '勉强对应微信号' };
    }
    return { id: f.id, label: '', path: null, confidence: 0.2, reason: '标签不可信，骨架里也没有可靠依据' };
  });
}

function startServer() {
  const llmRequests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        llmRequests.push(body);
        const reply = fakeModelReply(body);
        console.log('  [假模型] 收到 ' + reply.length + ' 个字段，回了 ' +
          reply.filter((r) => r.path).length + ' 条映射');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
      });
      return;
    }
    if (req.url === '/form.html' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FORM);
      return;
    }
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const abs = path.join(EXT, rel);
    if (!abs.startsWith(EXT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const type = rel.endsWith('.css') ? 'text/css'
      : rel.endsWith('.js') ? 'application/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(fs.readFileSync(abs));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, llmRequests, port: server.address().port })));
}

(async () => {
  const { server, llmRequests, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  console.log('本地服务：' + base + '\n');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

  // 两个页面共用同一份简历数据（模拟真实的 chrome.storage.local 共享）
  const resumes = {
    r_e2e: {
      id: 'r_e2e', name: '端到端', createdAt: 1, updatedAt: 1,
      profile: {
        basic: { name: '张三', gender: '男', birthday: '', phone: RESUMED_PHONE, email: 'zhangsan@example.com', idCard: '', location: '', wechat: 'zhangsan_wx', politicalStatus: '' },
        education: [], experience: [], projects: [], skills: [], selfEvaluation: ''
      }
    }
  };

  // ============================ 页面 A：投递表单 + 内容脚本
  const form = await browser.newPage();
  form.on('pageerror', (e) => console.log('  [form error]', String(e).slice(0, 200)));
  await form.evaluateOnNewDocument((resumes) => {
    // 真实环境里内容脚本和弹窗共享同一份 chrome.storage —— 桩也必须共用，
    // 否则内容脚本算 suggestedValue 时读到的是空简历，值全是空的。
    const store = { rj_active_resume: 'r_e2e', rj_resume_r_e2e: resumes.r_e2e };
    const pick = (keys) => {
      if (keys === null || keys === undefined) return Object.assign({}, store);
      const arr = Array.isArray(keys) ? keys : [keys];
      const out = {};
      arr.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      return out;
    };
    window.__LISTENER__ = null;
    window.chrome = {
      runtime: { onMessage: { addListener: (fn) => { window.__LISTENER__ = fn; } }, getManifest: () => ({ version: 'e2e' }) },
      storage: {
        local: {
          get: (keys, cb) => setTimeout(() => cb(pick(keys)), 0),
          set: (obj, cb) => { Object.assign(store, obj); setTimeout(() => cb && cb(), 0); }
        }
      }
    };
  }, resumes);
  await form.goto(base + '/form.html', { waitUntil: 'domcontentloaded' });
  for (const f of ['shared/profile-store.js', 'content/config.js', 'content/scanner.js',
    'content/filler.js', 'content/matcher.js', 'content/main.js']) {
    await form.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), 'utf8') });
  }

  const askForm = (msg) => form.evaluate(
    (m) => new Promise((res) => { const r = window.__LISTENER__(m, null, res); if (!r) res({ ok: false }); }), msg);

  const scan = await askForm({ type: 'RJ_SCAN' });
  check('表单页扫描成功', scan && scan.ok, scan && scan.error);
  console.log('\n真实扫描结果：');
  (scan.plan || []).forEach((p) => {
    console.log('  · ' + (p.label || '(空)').padEnd(14) + ' src=' + String(p.labelSource).padEnd(14) +
      ' → ' + String(p.suggestedPath || '(未命中)').padEnd(14) +
      (p.aiFeatures.skeleton ? ' 骨架 ' + p.aiFeatures.skeleton.length + ' 层' : ''));
  });
  const pending = (scan.plan || []).filter((p) => !p.suggestedPath);
  check('规则命中了姓名 / 电子邮箱 / 性别', (scan.plan || []).filter((p) => p.suggestedPath).length >= 3,
    '实际 ' + (scan.plan || []).filter((p) => p.suggestedPath).length);
  check('词典缺口字段未被规则命中（留给 AI）', pending.length >= 3, '实际 ' + pending.length);

  // ============================ 页面 B：真实弹窗
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => console.log('  [popup error]', String(e).slice(0, 300)));
  await popup.exposeFunction('__bridgeToForm__', (msg) => askForm(msg));
  await popup.evaluateOnNewDocument((resumes, baseUrl) => {
    const store = {
      rj_ai_config: { enabled: true, baseUrl: baseUrl + '/v1', model: 'e2e-model', apiKey: 'sk-e2e' },
      rj_active_resume: 'r_e2e',
      rj_resume_r_e2e: resumes.r_e2e
    };
    const pick = (keys) => {
      if (keys === null || keys === undefined) return Object.assign({}, store);
      const arr = Array.isArray(keys) ? keys : [keys];
      const out = {};
      arr.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      return out;
    };
    const answer = (v, cb, d) => (typeof cb === 'function' ? setTimeout(() => cb(v), d || 0)
      : new Promise((r) => setTimeout(() => r(v), d || 0)));

    window.chrome = {
      runtime: {
        lastError: undefined,
        getManifest: () => ({ version: 'e2e' }),
        openOptionsPage: () => {},
        // 故意让后台不可用 —— 顺便验证降级路径
        sendMessage: (msg, cb) => {
          if (msg && msg.type === 'RJ_AI_MAP') {
            window.chrome.runtime.lastError = {
              message: 'Could not establish connection. Receiving end does not exist.'
            };
            setTimeout(() => { cb(undefined); window.chrome.runtime.lastError = undefined; }, 0);
            return;
          }
          return answer({ ok: true }, cb, 0);
        }
      },
      tabs: {
        query: (q, cb) => answer([{ id: 1, url: baseUrl + '/form.html' }], cb, 0),
        // 两种调用形式都要支持：ping 用回调，scan/fill 用 await（无回调）
        sendMessage: (id, msg, cb) => {
          const p = window.__bridgeToForm__(msg).then((r) => (r && r.ok === undefined ? { ok: true } : r));
          if (typeof cb === 'function') { p.then(cb); return; }
          return p;
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
  }, resumes, base);

  await popup.goto(base + '/popup.html', { waitUntil: 'domcontentloaded' });
  await popup.waitForFunction(() => document.querySelectorAll('.row').length > 1, { timeout: 15000 });
  // 等 AI 结果贴上来
  await popup.waitForFunction(
    () => Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.badge.ai')),
    { timeout: 20000 });

  const rows = await popup.evaluate(() => Array.from(document.querySelectorAll('.row')).map((r) => ({
    id: r.dataset.id,
    label: (r.querySelector('.fname') || {}).textContent,
    value: (r.querySelector('.val') || {}).value,
    path: r.dataset.path,
    meta: (r.querySelector('.row-meta') || {}).textContent,
    checked: !!(r.querySelector('.inc') || {}).checked,
    aiMatched: r.classList.contains('ai-matched'),
    noLabelBadge: !!r.querySelector('.badge.nolabel'),
    aiBadge: !!r.querySelector('.badge.ai')
  })));
  console.log('\n弹窗渲染出的行：');
  rows.forEach((r) => console.log('  · ' + String(r.label).padEnd(16) + ' → ' + String(r.path || '(未匹配)').padEnd(14) +
    ' value="' + r.value + '"' + (r.checked ? ' [勾选]' : '') + (r.noLabelBadge ? ' [标签未识别]' : '')));

  console.log('\n--- 真实 HTTP 请求 ---');
  check('弹窗确实打了本地假接口（走的是真 fetch）', llmRequests.length === 1, '实际 ' + llmRequests.length + ' 次');
  const sent = llmRequests[0] || '';
  check('请求体里带了 DOM 骨架', /第0层/.test(sent));
  check('请求体里带了 resolvedExamples（参考本页写法）', /已被规则解出的字段/.test(sent));
  check('请求体里不含表单里已填的值（哨兵 ' + PII + '）', sent.indexOf(PII) === -1, '哨兵泄漏了');
  check('请求体里不含简历里的手机号', sent.indexOf(RESUMED_PHONE) === -1);
  // 提示词里的 JSON 是嵌在字符串里的，引号被转义过，先还原；
  // 还必须只截「需要判断的输入框」那一段 —— 输出格式里的示例也带一个 "id":"rj_3"
  const sentPlain = sent.replace(/\\"/g, '"');
  const fieldsSeg = sentPlain.split('【需要判断的输入框】')[1].split('【输出格式】')[0];
  const askedIds = fieldsSeg.match(/"id":"rj_\d+"/g) || [];
  check('只问了未命中的字段', askedIds.length === pending.length,
    '问了 ' + askedIds.length + ' 个，未命中 ' + pending.length + ' 个');
  check('已命中的字段没被送出去（省 token）',
    !/"id":"rj_\d+"[^}]*\}[^\]]*\]/.test(fieldsSeg.split('【')[0]) || fieldsSeg.indexOf('basic.name') === -1,
    fieldsSeg.slice(0, 80));

  console.log('\n--- AI 结果落到界面 ---');
  const byLabel = (t) => rows.filter((r) => r.label === t)[0];
  const c2 = rows.filter((r) => r.path === 'basic.wechat')[0];
  check('「个人主页」映射到 basic.wechat', !!c2, JSON.stringify(rows.map((r) => [r.label, r.path])));
  check('并从简历取值填入', c2 && c2.value === 'zhangsan_wx', c2 && c2.value);
  check('标记为 ai-matched 且默认勾选', c2 && c2.aiMatched && c2.checked, JSON.stringify(c2));

  const c1 = byLabel('紧急联络方式');
  check('模型判「简历里没有」的字段：不填值、不误标为已匹配',
    c1 && c1.value === '' && !c1.path && !c1.aiMatched, JSON.stringify(c1));
  const c3 = byLabel('最高学历');
  check('同样保持未匹配', c3 && c3.value === '' && !c3.path, JSON.stringify(c3));

  // 页面自己的标签可信时，不应被模型的转述覆盖
  check('页面本来的标签没被模型的转述改掉', !!c1 && c1.label === '紧急联络方式', c1 && c1.label);

  const c4 = rows.filter((r) => r.noLabelBadge)[0];
  check('页面上真没标签的那个字段仍标着「标签未识别」', !!c4,
    JSON.stringify(rows.map((r) => [r.label, r.noLabelBadge])));

  // 「AI 到底做了什么」必须摆在界面上 —— 否则用户看到的就是「没什么区别」
  const note = await popup.evaluate(() => {
    const el = document.getElementById('ai-note');
    return { hidden: el.hidden, cls: el.className, text: el.textContent };
  });
  console.log('  AI 说明条：' + note.text + '   [' + note.cls + ']');
  check('AI 说明条可见（不再静默）', note.hidden === false);
  check('说清了分析了几条、给出几条映射',
    /分析了 4 个字段/.test(note.text) && /给出 1 条可用映射/.test(note.text), note.text);
  check('说清了后台不可用走了直连', /本页直连/.test(note.text), note.text);
  check('首次运行不说「命中缓存」', !/命中缓存/.test(note.text), note.text);

  console.log('\n--- 再次扫描：缓存必须命中，不能再联网 ---');
  const reqBefore = llmRequests.length;
  await popup.evaluate(() => document.getElementById('btn-scan').click());
  await popup.waitForFunction(
    () => /命中缓存/.test(document.getElementById('ai-note').textContent || ''),
    { timeout: 25000 }
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const rerun = await popup.evaluate(() => ({
    text: document.getElementById('ai-note').textContent,
    cls: document.getElementById('ai-note').className
  }));
  console.log('  再次扫描后的说明条：' + rerun.text);
  check('第二次扫描没有新增 HTTP 请求（缓存真的生效）',
    llmRequests.length === reqBefore, '请求数 ' + reqBefore + ' -> ' + llmRequests.length);
  check('说明条明确告知「本次没联网」', /命中缓存.*没联网/.test(rerun.text), rerun.text);

  console.log('\n--- 一键交互：按钮自带数字，不用挨个勾 ---');
  const pre = await popup.evaluate(() => {
    const btn = document.getElementById('btn-fill');
    const hintEl = document.getElementById('fill-hint');
    return {
      btn: btn.textContent,
      disabled: btn.disabled,
      undoHidden: document.getElementById('btn-undo').hidden,
      hint: hintEl && !hintEl.hidden ? document.getElementById('fill-hint-text').textContent : '',
      checkedCount: Array.from(document.querySelectorAll('.row')).filter((r) => {
        const cb = r.querySelector('.inc');
        return cb && cb.checked && r.querySelector('.val').value !== '';
      }).length,
      // 匹配上了、但这次填不了的（页面已有内容 / 简历缺值 / 被取消勾选）
      skipped: Array.from(document.querySelectorAll('.row')).filter((r) => {
        if (!r.dataset.path) return false;
        const cb = r.querySelector('.inc');
        return !(cb && cb.checked && r.querySelector('.val').value !== '');
      }).length
    };
  });
  console.log('  按钮="' + pre.btn + '"  已预勾选 ' + pre.checkedCount + ' 项  提示="' + pre.hint + '"');
  const btnNum = /自动填写 (\d+) 项/.exec(pre.btn);
  check('主按钮直接写明能填几项（不用用户自己数）', !!btnNum, pre.btn);
  check('按钮上的数字 = 预勾选的行数', !!btnNum && Number(btnNum[1]) === pre.checkedCount,
    pre.btn + ' vs 预勾选 ' + pre.checkedCount);
  check('符合条件的行默认勾选（所以一键就能全填）', pre.checkedCount >= 2, '预勾选 ' + pre.checkedCount + ' 项');
  check('有可填字段时按钮可用', pre.disabled === false);
  check('填写前不显示「撤销」', pre.undoHidden === true);
  check('提示条给出了下一步动作（不是一片空白）', /自动填写/.test(pre.hint), pre.hint);
  // 只有「确实有跳过项」时才要求解释原因 —— 全部可填时没有原因可写，硬要求会误报
  check('有跳过项时提示条会说明原因（否则用户会以为功能坏了）',
    pre.skipped === 0 || /页面已有内容|简历里没有|取消/.test(pre.hint),
    '跳过 ' + pre.skipped + ' 项；提示="' + pre.hint + '"');

  console.log('\n--- 端到端闭环：点「自动填写」→ 真实表单被改写 ---');
  await popup.evaluate(() => document.getElementById('btn-fill').click());
  await popup.waitForFunction(() => /已填写/.test((document.getElementById('toast') || {}).textContent || ''),
    { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 900));   // 等受控组件的回滚周期过去

  const filled = await form.evaluate((pii) => {
    const g = (id) => (document.getElementById(id) || {}).value;
    const radio = document.querySelector('input[name="sex"]:checked');
    return {
      name: g('f1'), email: g('f6'), wechat: g('f4'), untouchedSentinel: g('f5'),
      sentinelStill: g('f5') === pii,
      gender: radio ? radio.value : null
    };
  }, PII);
  console.log('  表单现在的值：' + JSON.stringify(filled));
  check('姓名被真实写入 DOM', filled.name === '张三', filled.name);
  check('个人主页(微信号) 被写入 DOM', filled.wechat === 'zhangsan_wx', filled.wechat);
  check('受控组件 900ms 后没被回滚（事件派发正确）', filled.email === 'zhangsan@example.com', filled.email);
  check('单选组被选中', filled.gender === '男', filled.gender);
  check('页面上原有的内容没被覆盖', filled.sentinelStill === true, JSON.stringify(filled));

  console.log('\n--- 撤销：把这次填的撤回，页面回到填写前 ---');
  const undoVisible = await popup.evaluate(() => ({
    hidden: document.getElementById('btn-undo').hidden,
    text: document.getElementById('btn-undo').textContent
  }));
  check('填写后出现「撤销」按钮', undoVisible.hidden === false, JSON.stringify(undoVisible));

  await popup.evaluate(() => document.getElementById('btn-undo').click());
  await popup.waitForFunction(() => /已撤回|撤销失败/.test((document.getElementById('toast') || {}).textContent || ''),
    { timeout: 15000 });
  const undoToast = await popup.evaluate(() => (document.getElementById('toast') || {}).textContent);
  console.log('  提示：' + undoToast);
  check('撤销报的是成功', /已撤回 \d+ 项/.test(undoToast), undoToast);
  await new Promise((r) => setTimeout(r, 700));

  const afterUndo = await form.evaluate((pii) => {
    const g = (id) => (document.getElementById(id) || {}).value;
    const radio = document.querySelector('input[name="sex"]:checked');
    return {
      name: g('f1'), email: g('f6'), wechat: g('f4'),
      sentinelStill: g('f5') === pii,
      gender: radio ? radio.value : null
    };
  }, PII);
  console.log('  撤销后：' + JSON.stringify(afterUndo));
  check('撤销后姓名被清空', afterUndo.name === '', JSON.stringify(afterUndo.name));
  check('撤销后邮箱被清空', afterUndo.email === '', JSON.stringify(afterUndo.email));
  check('撤销后微信号被清空', afterUndo.wechat === '', JSON.stringify(afterUndo.wechat));
  check('撤销后单选组被取消勾选', afterUndo.gender === null, String(afterUndo.gender));
  check('撤销没有碰页面上原有的内容', afterUndo.sentinelStill === true, JSON.stringify(afterUndo));

  const undoGone = await popup.evaluate(() => document.getElementById('btn-undo').hidden);
  check('撤销完成后「撤销」按钮收起（不能连着撤两次）', undoGone === true);

  console.log('\n--- 没有可填的字段时：按钮变灰 + 说明为什么 ---');
  const zero = await popup.evaluate(() => {
    document.querySelectorAll('.row .inc').forEach((cb) => {
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
    });
    const btn = document.getElementById('btn-fill');
    const hintEl = document.getElementById('fill-hint');
    return {
      btn: btn.textContent,
      disabled: btn.disabled,
      hint: hintEl && !hintEl.hidden ? document.getElementById('fill-hint-text').textContent : ''
    };
  });
  console.log('  按钮="' + zero.btn + '"  提示="' + zero.hint + '"');
  check('一项都没选中时按钮变灰（避免点了没反应）', zero.disabled === true, JSON.stringify(zero));
  check('按钮文案明说「没有可填字段」', /没有可填字段/.test(zero.btn), zero.btn);
  check('提示条说明原因（这里是被手动取消勾选）', /取消/.test(zero.hint), zero.hint);

  console.log('\n============================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
