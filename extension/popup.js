/* popup：人在环路的确认与触发 UI（含 AI 兜底建议 + 新信息回填） */
(function () {
  var $ = function (s) { return document.querySelector(s); };

  var CONTENT_FILES = [
    'shared/profile-store.js',
    'content/debug.js',
    'content/config.js',
    'content/scanner.js',
    'content/filler.js',
    'content/matcher.js',
    'content/main.js'
  ];

  var STORE = window.__RJ_STORE__;
  var AI = window.__RJ_AI__;

  var state = {
    tabId: null,
    lastResult: null,
    pageTitle: '',
    pageUrl: '',
    profile: null,
    scanning: false,
    token: 0,          // 每次扫描 +1，用来丢弃过期的异步结果
    pendingAdditions: {},  // 填充后待回填到简历的「路径 -> 值」
    lastAi: null,          // 最近一次 AI 兜底的情况，进诊断包
    // 上一次自动填写成功的字段（记 selector，撤销时用）。撤销必须按 selector 找回
    // **当前**的 id —— 字段 id 是「本次扫描的序号」，填完重扫就会变（见 undoFill）。
    lastFill: null
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast ' + (kind || ''); }, 3400);
  }

  function setAiStrip(show, text) {
    var el = $('#ai-strip');
    el.hidden = !show;
    if (text) $('#ai-strip-text').textContent = text;
  }

  /**
   * AI 的常态说明条。
   * 为什么不弹 toast 就算完：AI 没启用时会静默跳过，用户看到的就是
   * 「扫描结果和以前一模一样」，完全不知道是没开、还是开了但认不出。
   * 这两件事必须一直摆在界面上。
   * 顺带把「去设置」按钮的显隐也管上 —— 只有需要用户动手时才显示。
   */
  function setAiNote(text, kind, showAction, showRun) {
    var el = $('#ai-note');
    var run = $('#btn-ai-run');
    if (!text) {
      el.hidden = true;
      $('#ai-note-text').textContent = '';
      if (run) run.hidden = true;
      return;
    }
    el.hidden = false;
    el.className = 'ai-note' + (kind ? ' ' + kind : '');
    $('#ai-note-text').textContent = text;
    $('#btn-ai-note').hidden = !showAction;
    if (run) run.hidden = !showRun;
  }

  // 自动跑 AI 的节流记录：同一个站点短时间内只自动跑一次。
  // 和 ai-map.js 里的「每分钟配额」是两件事 ——
  //   那边是保护接口（别把配额打满），这边是别让「反复开弹窗」变成一个隐形的请求放大器。
  var AUTO_KEY = 'rj_ai_auto';
  var AUTO_MIN_INTERVAL_MS = 10 * 60 * 1000;

  function originOf(url) {
    try { return new URL(url).origin; } catch (e) { return String(url || ''); }
  }

  function readStore(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (r) { resolve(r || {}); });
    });
  }

  function writeStore(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  }

  /** 这个站点最近自动跑过吗？跑过就拦一下，改成让用户显式点 */
  async function readAutoGate(origin) {
    if (!origin) return { blocked: false };
    var o = await readStore([AUTO_KEY]);
    var rec = (o[AUTO_KEY] || {})[origin];
    if (!rec || !rec.at) return { blocked: false };
    var ago = Date.now() - rec.at;
    if (ago >= AUTO_MIN_INTERVAL_MS) return { blocked: false };
    return { blocked: true, agoText: Math.max(1, Math.round(ago / 60000)) + ' 分钟' };
  }

  async function markAutoRan(origin) {
    if (!origin) return;
    var o = await readStore([AUTO_KEY]);
    var all = o[AUTO_KEY] || {};
    all[origin] = { at: Date.now() };
    // 顺手清掉很久没动的站点，别让这个键无限长
    Object.keys(all).forEach(function (k) {
      if (Date.now() - (all[k].at || 0) > AUTO_MIN_INTERVAL_MS * 6) delete all[k];
    });
    var data = {};
    data[AUTO_KEY] = all;
    await writeStore(data);
  }

  // ------------------------------------------------------------------ 基础

  function getActiveTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0]);
      });
    });
  }

  function ping(id) {
    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(id, { type: 'RJ_PING' }, function (res) {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(!!(res && res.ok));
      });
    });
  }

  async function ensureContentScript(id) {
    if (await ping(id)) return true;

    // 先清掉上一次注入留下的模块守卫。
    // 扩展重载之后，页面里跑的还是旧代码：它的 chrome.runtime 已经失效（所以 ping 不通），
    // 但 window.__RJ_SCANNER__ 这些「已经加载过就别重复加载」的守卫还留在页面上 ——
    // 不清掉的话，新代码会被守卫挡住直接 return，表现为「补注入了却依然连不通」，
    // 只能让用户手动刷新页面。清一次就彻底解决了。
    try {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: function () {
          ['__RJ_STORE__', '__RJ_LOG__', '__RJ_CONFIG__', '__RJ_SCANNER__',
            '__RJ_FILLER__', '__RJ_MATCHER__', '__RJ_LOADED__'].forEach(function (k) {
            try { delete window[k]; } catch (e) { /* ignore */ }
          });
        }
      });
    } catch (e) { /* 拿不到页面就算了，下面照样尝试注入 */ }

    try {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: CONTENT_FILES });
    } catch (e) {
      return false;
    }
    await new Promise(function (r) { setTimeout(r, 150); });
    return await ping(id);
  }

  function setHint(text) {
    $('#list').innerHTML = '<div class="empty">' + esc(text) + '</div>';
    $('#page-title').textContent = text;
  }

  function getByPath(obj, path) {
    return String(path).split('.').reduce(function (o, k) {
      return (o == null ? undefined : o[k]);
    }, obj);
  }

  function valueOfPath(path) {
    if (!state.profile || !path) return '';
    var v = getByPath(state.profile, path);
    if (v == null) return '';
    return Array.isArray(v) ? v.join(',') : String(v);
  }

  async function loadProfile() {
    try {
      var r = await STORE.getActiveResume();
      state.profile = r.profile;
    } catch (e) {
      state.profile = null;
    }
  }

  // ------------------------------------------------------------ 简历下拉框

  async function loadResumes() {
    var data = await STORE.listResumes();
    var sel = $('#resume-select');
    sel.innerHTML = '';
    data.resumes.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name + (r.hasName ? '' : '（未填写）');
      sel.appendChild(o);
    });
    sel.value = data.activeId;

    var active = data.resumes.filter(function (r) { return r.id === data.activeId; })[0];
    $('#resume-warn').hidden = !!(active && active.hasName);
    return data;
  }

  // ---------------------------------------------------------------- 扫描

  async function scan() {
    if (state.scanning) return;
    state.scanning = true;
    var token = ++state.token;
    state.scanningDone = false;

    var tab = await getActiveTab();
    if (token !== state.token) { state.scanning = false; return; }
    if (!tab || !tab.id) { state.scanning = false; setHint('无法获取当前标签页'); return; }
    state.tabId = tab.id;

    hideAddBar();
    setAiStrip(false);
    setAiNote('');          // 每次重新扫描先清掉上一轮的结论
    $('#list').innerHTML = '<div class="empty">扫描中…</div>';
    $('#page-title').textContent = '正在连接页面…';

    var ready = await ensureContentScript(state.tabId);
    if (token !== state.token) { state.scanning = false; return; }
    if (!ready) { state.scanning = false; setHint('当前页面不支持扫描（如浏览器内置页 / 扩展商店页）'); return; }

    var res;
    try {
      res = await chrome.tabs.sendMessage(state.tabId, { type: 'RJ_SCAN' });
    } catch (e) {
      state.scanning = false;
      setHint('与页面通信失败，请刷新页面后重试');
      return;
    }
    if (token !== state.token) { state.scanning = false; return; }

    state.scanning = false;
    if (!res || !res.ok) { setHint((res && res.error) || '扫描失败'); return; }

    state.lastResult = res;
    state.pageTitle = res.title || res.url || '';
    state.pageUrl = res.url || '';
    state.scanningDone = true;
    render();

    maybeRunAi(token);
  }

  // ------------------------------------------------------------ AI 兜底

  /**
   * 请求 AI 映射：**优先走后台，后台不在就本页直连**。
   *
   * 为什么要有这个降级：MV3 的 Service Worker 会被回收，某些环境下甚至一直注册不上
   * （表现为「Receiving end does not exist」）。但这不该让整个功能不可用 ——
   * 后台在这里只提供两样东西：跨标签页的统一并发限流、以及缓存读写，
   * 而缓存本来就存在 chrome.storage.local 里，本页直连照样共享。
   *
   * 代价说清楚：直连时多个标签页各发各的，跨页面的总量控制没有了；
   * 而且弹窗被关掉会中断请求（后台则不受影响）。所以仍然优先走后台。
   */
  async function askAi(fields, examples) {
    var res = await window.__RJ_BG__.send({
      type: 'RJ_AI_MAP', fields: fields, examples: examples
    });
    if (res.ok || res.code !== 'no-receiver') {
      return Object.assign({}, res, { via: 'bg' });
    }

    // 「后台没有接收方」不是业务错误，退到直连
    if (!window.__RJ_AI_MAP__) {
      return Object.assign({}, res, { via: 'none' });
    }
    var direct = await window.__RJ_AI_MAP__.handleMap(fields, { examples: examples });
    return Object.assign({}, direct, { via: 'direct', bgError: res.error });
  }

  /**
   * @param {number} token  用来丢弃过期的异步结果
   * @param {boolean} force 用户**显式**点了「让 AI 判断」时传 true，跳过自动节流
   */
  async function maybeRunAi(token, force) {
    if (!AI) {
      state.lastAi = { enabled: false, reason: 'ai-config.js 未加载' };
      setAiNote('AI 模块未加载，请重新加载扩展。', 'err', false);
      return;
    }
    var cfg = await AI.get();
    if (token !== state.token) return;
    if (!AI.isUsable(cfg)) {
      state.lastAi = {
        enabled: false,
        reason: cfg.enabled ? '配置不完整（地址/模型/Key）' : '未启用',
        baseUrl: cfg.baseUrl, model: cfg.model, hasKey: !!cfg.apiKey
      };
      if (!cfg.enabled) {
        // 最常见的情况：Key 配好了、测试连接也通了，但「启用」没勾 —— AI 一直没跑过
        setAiNote('AI 兜底未启用：规则认不出的字段（比如标签只写着「请输入」的）不会被处理。' +
          '到「资料设置 → AI 辅助匹配」勾选「启用」即可。', 'warn', true);
      } else {
        setAiNote('AI 已勾选启用，但配置不完整（接口地址 / 模型 / API Key 至少缺一项）。',
          'warn', true);
      }
      return;
    }

    var plan = (state.lastResult && state.lastResult.plan) || [];
    var pending = plan.filter(function (p) {
      return !p.suggestedPath && p.aiFeatures && p.aiFeatures.fingerprint;
    });
    if (!pending.length) {
      state.lastAi = { enabled: true, pending: 0 };
      setAiNote('');          // 没有需要 AI 判断的字段，不必打扰
      return;
    }

    var fields = pending.map(function (p) { return p.aiFeatures; });
    var origin = originOf(state.pageUrl);

    // 自动跑之前先判断「这一趟会不会真的联网」：
    //   缓存全是热的 → 跑一次是**免费且有用**的（能把上次学到的真标签显示回来），直接跑；
    //   有冷字段 → 就得拦一下。因为弹窗一打开就 scan()，不拦的话
    //   「反复开关弹窗」就等于反复发请求，而用户在界面上完全看不到这件事在发生。
    if (!force) {
      // 注意模块名：AI 是 __RJ_AI__（配置），countCached 在 __RJ_AI_MAP__（映射）里。
      // 拿不到就按「全是冷字段」保守处理 —— 那样首次仍会自动跑，之后被节流挡住。
      var MAP = window.__RJ_AI_MAP__;
      var cov = (MAP && MAP.countCached)
        ? await MAP.countCached(fields)
        : { total: fields.length, cached: 0 };
      if (token !== state.token) return;
      var cold = cov.total - cov.cached;
      if (cold > 0) {
        var gate = await readAutoGate(origin);
        if (token !== state.token) return;
        if (gate.blocked) {
          state.lastAi = { enabled: true, ok: true, deferred: cold, cached: cov.cached };
          setAiNote('有 ' + cold + ' 个字段规则没认出（' + cov.cached +
            ' 个已有结论）。自动分析刚跑过（' + gate.agoText +
            '前），先不重复请求 —— 需要的话点右边。', 'warn', false, true);
          return;
        }
      }
    }

    setAiStrip(true, 'AI 兜底分析中（' + pending.length + ' 个未匹配字段）…');
    await markAutoRan(origin);        // 自动、手动都刷新节流窗口

    var res = await askAi(
      fields,
      // 本页已被规则解出的字段：让模型看到「这个网站把标签写在哪」，好做类比
      (state.lastResult && state.lastResult.resolvedExamples) || []
    );

    if (token !== state.token) return;
    setAiStrip(false);

    if (!res.ok) {
      state.lastAi = {
        enabled: true, ok: false, via: res.via, code: res.code || null,
        error: res.error, attempts: res.attempts || 1, asked: pending.length
      };
      // 后台类错误（拿不到接收方等）走 friendly；接口类错误（429/401/超时）走 explainError
      var why = res.code
        ? window.__RJ_BG__.friendly(res)
        : window.__RJ_AI_MAP__.explainError(res.error);
      // 本地闸拦下和「接口报错」要分开说：前者不是故障，是主动踩了刹车，
      // 用户不需要去排查配置，只需要等一下。混在一起会让人以为扩展坏了。
      if (res.code === 'local-throttle') {
        setAiNote('AI 本次未运行：' + why, 'warn', false);
        toast(why, 'warn');
        return;
      }
      setAiNote('AI 分析未完成：' + why, 'err', false);
      toast('AI 分析未完成：' + why, 'warn');
      return;
    }
    // 数组字段模型只给模板（education[*].school），段号得回页面里按 DOM 顺序算
    var mapping = await resolveAiBlocks(res.mapping || {});
    if (token !== state.token) return;
    res.mapping = mapping;
    var r = applyAi(mapping);
    state.lastAi = {
      enabled: true, ok: true, via: res.via,
      applied: r.applied, named: r.named,
      asked: res.asked, cached: res.cached,
      invalidPath: res.invalidPath || 0, truncated: !!res.truncated
    };
    // 后台不可用时不弹 toast 打扰，但要在诊断包里留下痕迹
    if (res.via === 'direct') state.lastAi.bgError = res.bgError;

    // 常态说明：不管成没成都要说清楚 AI 到底做了什么，否则「没什么区别」。
    // 刻意按「模型返回了什么」来统计，而不是按「这次改动了几行」——
    // 重新扫描时行早就填好了，applyAi 不会再动它们，按改动数说就会误报成「什么都没认出来」。
    var mapKeys = Object.keys(res.mapping || {});
    var withPath = mapKeys.filter(function (k) { return res.mapping[k] && res.mapping[k].path; }).length;
    var withLabel = mapKeys.filter(function (k) { return res.mapping[k] && res.mapping[k].label; }).length;

    var tails = [];
    // 这一条是防「配额被打满」的关键反馈：缓存命中就说明本次没有联网
    if (res.cached) tails.push(res.cached + ' 条命中缓存，本次没联网');
    if (res.via === 'direct') tails.push('后台不可用，已在本页直连');
    var tail = tails.length ? '（' + tails.join('；') + '）' : '';

    if (!withPath && !withLabel) {
      setAiNote('AI 分析了 ' + pending.length + ' 个字段，但都没能对应到简历里的内容' +
        ' —— 可能是简历里确实没有这些信息，也可能这些字段模型也认不出。' + tail,
        'warn', false);
    } else {
      var parts = [withPath ? '给出 ' + withPath + ' 条可用映射' : '没有可填的映射'];
      if (withLabel) parts.push('另认出 ' + withLabel + ' 个字段的含义（简历里暂无对应内容）');
      setAiNote('AI 分析了 ' + pending.length + ' 个字段：' + parts.join('，') +
        (tail ? ' ' + tail : ''), withPath ? 'ok' : '', false);
    }
    if (r.applied) {
      toast('AI 补充匹配了 ' + r.applied + ' 个字段' +
        (r.named ? '，另识别出 ' + r.named + ' 个字段的含义' : ''), 'ok');
    } else if (r.named) {
      toast('AI 识别出 ' + r.named + ' 个字段的含义（简历里暂无对应内容）', 'ok');
    }
  }

  // ---------------------------------------------------------------- 诊断

  function askContent(msg) {
    return new Promise(function (resolve) {
      if (!state.tabId) return resolve({ ok: false, error: '还没有扫描过页面' });
      try {
        chrome.tabs.sendMessage(state.tabId, msg, function (res) {
          if (chrome.runtime.lastError) {
            var raw = chrome.runtime.lastError.message;
            var code = window.__RJ_BG__.classify(raw);
            return resolve({
              ok: false,
              code: code,
              // 这句原文对用户没意义：它其实只是说「这个页面里没有我们的脚本」
              error: code === 'no-receiver'
                ? '页面脚本未注入（页面可能刚刷新过），点一次「重新扫描」即可'
                : raw
            });
          }
          resolve(res || { ok: false, error: '页面无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
        function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  async function copyDiag() {
    var btn = $('#btn-diag');
    btn.disabled = true;

    var res = await askContent({ type: 'RJ_DIAG' });
    var diag = (res && res.ok && res.diag)
      ? res.diag
      : { diagError: (res && res.error) || '未能从页面取到诊断信息' };

    diag.ai = state.lastAi;
    // 内容脚本那边只有规则结果；AI 补上的路径在弹窗这侧，合并进去才完整
    var planById = {};
    ((state.lastResult && state.lastResult.plan) || []).forEach(function (p) { planById[p.id] = p; });
    (diag.fields || []).forEach(function (f) {
      var p = planById[f.id];
      if (p && p.suggestedPath && p.suggestedPath !== f.path) {
        f.pathAfterAi = p.suggestedPath;
        f.sourceAfterAi = p.source || 'ai';
      }
    });
    diag.popupState = {
      tabId: state.tabId,
      pageUrl: state.pageUrl,
      hasProfile: !!state.profile,
      activeResumeHasName: !!(state.profile && state.profile.basic && state.profile.basic.name)
    };

    var text = JSON.stringify(diag, null, 2);
    var ok = await writeClipboard(text);
    btn.disabled = false;

    if (ok) {
      toast('诊断信息已复制（' + text.length + ' 字符），粘贴给我即可', 'ok');
    } else {
      $('#diag-box').value = text;
      $('#diag-overlay').hidden = false;
      $('#diag-box').focus();
      $('#diag-box').select();
    }
  }

  /**
   * 把 AI 给的数组模板解析成具体路径。
   *
   * 模型只该返回 education[*].school 这种模板 —— 它看不到整页字段的先后顺序，
   * 自己写序号必然错位（「开始时间」在三种块里同名，光看字段分不出来）。
   * 所以这里把模板交回内容脚本，让它和规则已命中的字段一起按 DOM 顺序分配段号。
   * 内容脚本联系不上时宁可置空：模板路径填不进去不算填错，写错段才是事故。
   */
  async function resolveAiBlocks(mapping) {
    var tpls = {};
    Object.keys(mapping || {}).forEach(function (id) {
      var m = mapping[id];
      if (m && m.path && m.path.indexOf('[*]') !== -1) tpls[id] = m.path;
    });
    if (!Object.keys(tpls).length) return mapping;

    var res = await askContent({ type: 'RJ_RESOLVE_PATHS', paths: tpls });
    if (!res || !res.ok || !res.paths) {
      Object.keys(tpls).forEach(function (id) {
        if (mapping[id]) {
          mapping[id].path = null;
          mapping[id].reason = '重复块：页面没响应，无法确定是第几段';
        }
      });
      return mapping;
    }

    Object.keys(res.paths).forEach(function (id) {
      var r = res.paths[id];
      var m = mapping[id];
      if (!m) return;
      if (!r.path) {
        // 模板本身没错，只是页面上还没有能归位的块（比如一行经历都没渲染出来）
        m.path = null;
        m.reason = r.reason || '重复块：找不到所属的块';
        return;
      }
      m.path = r.path;
    });
    return mapping;
  }

  /** 把「这个是假标签」的角标换成模型推断出的真标签 */
  function upgradeLabel(row, label, confidence) {
    var title = row.querySelector('.row-title');
    if (!title) return;
    var fname = title.querySelector('.fname');
    if (fname) fname.textContent = label;
    // dataset.label 是「缺失要素」清单里记的名字，不跟着换会记成「请输入」
    row.dataset.label = label;
    var weak = title.querySelector('.badge.nolabel');
    if (weak) weak.remove();                       // 已经有真标签了
    if (!title.querySelector('.badge.ai')) {
      var b = document.createElement('span');
      b.className = 'badge conf ai';
      b.textContent = 'AI ' + Math.round((confidence || 0) * 100) + '%';
      title.appendChild(b);
    }
  }

  function aiBadge(row, confidence) {
    var title = row.querySelector('.row-title');
    if (!title || title.querySelector('.badge.ai')) return;
    var b = document.createElement('span');
    b.className = 'badge conf ai';
    b.textContent = 'AI ' + Math.round((confidence || 0) * 100) + '%';
    title.appendChild(b);
  }

  /**
   * 把 AI 结果贴到已有行上（不整页重渲染，避免丢掉用户已经改过的内容）。
   * 规则已命中、或用户已经手动动过的行，一律不动。
   *
   * 返回 { applied, named }：
   *   applied —— 补上了可用映射的字段数
   *   named   —— 模型认出了「这个框在问什么」但简历里没有对应字段的字段数。
   *              这类同样有价值：把假标签「请输入」换成真标签，用户才知道该不该手填。
   */
  function applyAi(mapping) {
    var planById = {};
    ((state.lastResult && state.lastResult.plan) || []).forEach(function (p) { planById[p.id] = p; });

    var applied = 0;
    var named = 0;

    Array.prototype.slice.call(document.querySelectorAll('.row')).forEach(function (row) {
      var m = mapping[row.dataset.id];
      if (!m) return;
      if (row.dataset.path) return;                 // 规则已命中
      if (row.dataset.touched === '1') return;      // 用户已改过

      var item = planById[row.dataset.id];
      var weakLabel = !!(item &&
        (item.labelSource === 'placeholder' || item.labelSource === 'none'));

      // 情形一：模型认出了含义，但简历里没有对应字段 —— 不填值，只把标签换真的
      if (!m.path) {
        if (m.label && weakLabel) {
          upgradeLabel(row, m.label, m.confidence);
          row.querySelector('.row-meta').innerHTML =
            '<span class="nomatch">' + esc(m.reason || '简历里没有对应字段') + '</span>';
          named++;
        }
        return;
      }

      // 情形二：有映射 —— 填路径、填值，顺带把假标签换掉
      var rv = valueOfPath(m.path);
      row.dataset.path = m.path;
      row.dataset.ai = '1';
      row.dataset.resumeEmpty = String(rv).trim() ? '0' : '1';

      if (item) {
        item.suggestedPath = m.path;
        item.suggestedValue = rv;
        item.source = 'ai';
        item.confidence = m.confidence;
      }

      var input = row.querySelector('.val');
      if (!input.value) input.value = rv;

      row.classList.remove('unmatched');
      row.classList.add('ai-matched');

      if (m.label && weakLabel) upgradeLabel(row, m.label, m.confidence);
      else aiBadge(row, m.confidence);

      row.querySelector('.row-meta').innerHTML =
        '→ <code>' + esc(m.path) + '</code>' +
        '<span class="reason">' + esc(m.reason || 'AI 判断') + '</span>';

      if (row.dataset.empty === '1' && rv) row.querySelector('.inc').checked = true;
      applied++;
    });

    if (applied || named) { updateStats(); updateCounts(); }
    return { applied: applied, named: named };
  }

  // ---------------------------------------------------------------- 渲染

  function updateStats() {
    if (!state.lastResult) return;
    var plan = state.lastResult.plan || [];
    $('#stat-total').textContent = state.lastResult.total || 0;
    $('#stat-matched').textContent = plan.filter(function (p) { return p.suggestedPath; }).length;
    $('#stat-fillable').textContent = plan.filter(function (p) {
      return p.empty && p.suggestedPath && p.suggestedValue;
    }).length;
  }

  function render() {
    if (!state.lastResult) return;
    $('#page-title').textContent = state.pageTitle || state.lastResult.url || '';
    updateStats();

    var plan = state.lastResult.plan || [];
    var onlyMatched = $('#only-matched').checked;
    var rows = plan.filter(function (p) { return !onlyMatched || p.suggestedPath; });

    var list = $('#list');
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<div class="empty">没有找到可填写的字段</div>';
      updateCounts();
      return;
    }
    rows.forEach(function (p) { list.appendChild(renderRow(p)); });
    updateCounts();
  }

  function renderRow(p) {
    var row = document.createElement('div');
    row.className = 'row' + (p.suggestedPath ? '' : ' unmatched');
    row.dataset.id = p.id;
    row.dataset.selector = p.selector;
    row.dataset.path = p.suggestedPath || '';
    row.dataset.label = p.label;
    row.dataset.empty = p.empty ? '1' : '0';
    row.dataset.resumeEmpty = (p.suggestedPath && !String(p.suggestedValue || '').trim()) ? '1' : '0';
    row.dataset.touched = '0';
    row.dataset.ai = '0';

    var conf = Math.round((p.confidence || 0) * 100);
    var confClass = conf >= 80 ? 'high' : conf >= 60 ? 'mid' : 'low';

    // 标签只剩 placeholder 兜底时，说明页面上没抓到真正的 label，
    // 这时显示的「请输入」是假标签，匹配必然不准 —— 必须让用户看见这一点
    var weakLabel = p.labelSource === 'placeholder' || p.labelSource === 'none';

    var head = document.createElement('div');
    head.className = 'row-head';
    head.innerHTML =
      '<input type="checkbox" class="inc" />' +
      '<div class="row-title">' +
        '<span class="fname">' + esc(p.label) + '</span>' +
        (p.required ? '<span class="badge req">必填</span>' : '') +
        '<span class="badge type">' + esc(p.type) + '</span>' +
        (weakLabel ? '<span class="badge nolabel" title="页面上没抓到真正的标签，当前显示的是 placeholder">标签未识别</span>' : '') +
        (p.suggestedPath ? '<span class="badge conf ' + confClass + '">' + conf + '%</span>' : '') +
      '</div>';
    row.appendChild(head);

    var meta = document.createElement('div');
    meta.className = 'row-meta';
    if (p.suggestedPath) {
      meta.innerHTML = '→ <code>' + esc(p.suggestedPath) + '</code>' +
        '<span class="reason">' + esc(p.reason || '') + '</span>';
    } else {
      meta.innerHTML = '<span class="nomatch">未匹配到简历字段（可手动填入）</span>';
    }
    row.appendChild(meta);

    var input = document.createElement('input');
    input.className = 'val';
    input.type = 'text';
    input.value = p.suggestedValue || '';
    if (p.options && p.options.length) {
      input.placeholder = '可选：' + p.options.slice(0, 6).map(function (o) { return o.text; }).join(' / ');
    } else {
      input.placeholder = '输入要填入的值';
    }
    row.appendChild(input);

    if (p.currentValue) {
      var hint = document.createElement('div');
      hint.className = 'row-hint';
      hint.textContent = '页面已有内容：' + p.currentValue;
      row.appendChild(hint);
    }

    var cb = head.querySelector('.inc');
    cb.checked = !!(p.empty && p.suggestedPath && p.suggestedValue);
    cb.addEventListener('change', function () {
      row.dataset.touched = '1';
      updateCounts();
    });
    input.addEventListener('input', function () {
      row.dataset.touched = '1';
      updateCounts();
    });
    return row;
  }

  /**
   * 算「现在点一下能填几个」，并据此更新主按钮与说明条。
   *
   * 交互目标只有一句话：**扫描 → 自动填写 → 结束**，不让用户挨个勾。
   * 所以符合条件的行默认全部勾好（勾选框只留给想排除个别字段的人用），
   * 主按钮上直接写数字；一项都没有时按钮变灰，并说明「为什么不是全部」——
   * 不解释的话，用户只会以为功能坏了。
   *
   * 注意这里**不看置信度**：弹窗里有你在看结果，属于「有人确认」的路径；
   * 需要阈值的是 content 侧那条「用户没看就自动补齐」的流程（config.autoFillThreshold）。
   */
  function updateCounts() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('.row'));
    var ready = 0, matchedRows = 0, hasContent = 0, noValue = 0, excluded = 0;

    rows.forEach(function (row) {
      if (!row.dataset.path) return;          // 未匹配的行不计入统计
      matchedRows++;
      var cb = row.querySelector('.inc');
      var val = String((row.querySelector('.val') || {}).value || '');
      if (row.dataset.empty === '0') { hasContent++; return; }   // 页面已有内容：不覆盖
      if (!val.trim()) { noValue++; return; }                     // 简历里没有这个值
      if (!cb || !cb.checked) { excluded++; return; }             // 被手动取消了勾选
      ready++;
    });

    var btn = $('#btn-fill');
    btn.textContent = ready ? ('自动填写 ' + ready + ' 项') : '没有可填字段';
    btn.disabled = ready === 0;

    var undo = $('#btn-undo');
    undo.hidden = !(state.lastFill && state.lastFill.length);

    var reasons = [];
    if (hasContent) reasons.push(hasContent + ' 项页面已有内容（不会覆盖）');
    if (noValue) reasons.push(noValue + ' 项简历里没有对应值');
    if (excluded) reasons.push(excluded + ' 项你取消了勾选');

    var hint = $('#fill-hint');
    if (ready) {
      hint.hidden = false;
      $('#fill-hint-text').textContent = '点一次「自动填写」即可' +
        (reasons.length ? '；另有 ' + reasons.join('、') + '。' : '。');
    } else if (matchedRows) {
      hint.hidden = false;
      $('#fill-hint-text').textContent = '没有可填的字段：' + reasons.join('、') +
        (noValue ? '。去「资料设置」把这些值补上，再回来扫一次。' : '。');
    } else if (rows.length) {
      hint.hidden = false;
      $('#fill-hint-text').textContent =
        '规则没认出任何字段。可以到「资料设置」配好 AI 兜底（由模型从 DOM 结构推断），' +
        '或点右上角「诊断」把页面结构发出来。';
    } else {
      hint.hidden = true;
    }
  }

  // ---------------------------------------------------------------- 填充

  function hideAddBar() {
    $('#add-bar').hidden = true;
  }

  /** 这次填充里，简历中原本为空、需要补进去的「路径 -> 值」 */
  function collectAdditions() {
    var add = {};
    Array.prototype.slice.call(document.querySelectorAll('.row')).forEach(function (row) {
      var cb = row.querySelector('.inc');
      if (!cb.checked) return;
      var path = row.dataset.path;
      var val = row.querySelector('.val').value.trim();
      if (!path || !val) return;
      if (row.dataset.resumeEmpty !== '1') return;   // 简历里已有值，不覆盖
      add[path] = val;
    });
    return add;
  }

  /** 这次表单问到、但简历里是空的字段（用于累计「缺失要素」） */
  function collectMissing() {
    var seen = {};
    var out = [];
    Array.prototype.slice.call(document.querySelectorAll('.row')).forEach(function (row) {
      var path = row.dataset.path;
      if (!path || row.dataset.resumeEmpty !== '1') return;
      if (seen[path]) return;
      seen[path] = 1;
      out.push({ path: path, label: row.dataset.label, url: state.pageUrl });
    });
    return out;
  }

  async function fill() {
    if (!state.tabId) { toast('请先扫描页面', 'warn'); return; }

    var items = [];
    var skipSelectors = {};
    Array.prototype.slice.call(document.querySelectorAll('.row')).forEach(function (row) {
      var cb = row.querySelector('.inc');
      var val = row.querySelector('.val').value;
      if (cb.checked) {
        if (val !== '') {
          items.push({
            id: row.dataset.id,
            label: row.dataset.label,
            path: row.dataset.path,
            value: val
          });
        }
      } else if (row.dataset.path) {
        skipSelectors[row.dataset.selector] = 1;
      }
    });

    if (!items.length) { toast('没有可填的字段', 'warn'); return; }

    var additions = collectAdditions();
    var missing = collectMissing();

    var btn = $('#btn-fill');
    btn.disabled = true;
    btn.textContent = '填充中…';

    var res = null;
    try {
      res = await chrome.tabs.sendMessage(state.tabId, {
        type: 'RJ_FILL', items: items, skipSelectors: skipSelectors
      });
    } catch (e) {
      res = null;
    }
    btn.disabled = false;

    if (!res || !res.ok) {
      updateCounts();
      toast('填充失败：' + ((res && res.error) || '与页面通信中断'), 'err');
      return;
    }

    // 记录「表单问了但简历里没有」的信息（只记不问，用户点保存才回填）
    if (missing.length) {
      try { await STORE.recordMissing(missing); } catch (e) { /* 记录失败不影响填充 */ }
    }

    var okReport = res.report.filter(function (r) { return r.ok; });
    var okCount = okReport.length;
    var failCount = res.report.length - okCount;

    // 记下这次填了哪些字段（给「撤销」用）。必须在 render() **之前**取 selector：
    // render 会把列表整段重建，之后 DOM 上就找不到这些行了。
    // 「重扫循环自动补上的项」在 DOM 里没有对应的行，所以再按 label 回查新 plan 一次 ——
    // 不然这些字段填了却撤不掉，比不填更糟。
    var freshPlan = res.plan || [];
    state.lastFill = okReport.map(function (r) {
      var row = document.querySelector('.row[data-id="' + r.id + '"]');
      var sel = row ? row.dataset.selector : '';
      if (!sel) {
        var p = freshPlan.filter(function (x) {
          return String(x.label || '') === String(r.label || '');
        })[0];
        sel = p ? p.selector : '';
      }
      return { label: r.label, selector: sel };
    }).filter(function (x) { return x.selector; });

    state.lastResult = { ok: true, url: state.pageUrl, title: state.pageTitle, total: res.total, matched: res.matched, plan: res.plan };
    render();

    var n = Object.keys(additions).length;
    if (n) {
      state.pendingAdditions = additions;
      $('#add-bar-text').textContent = '有 ' + n + ' 条简历里还没有的信息，要补进去吗？';
      $('#add-bar').hidden = false;
    }

    // 自动加行要在提示里说出来：页面上凭空多了几行经历，
    // 不解释的话用户会以为是网站自己渲染出来的，甚至怀疑填串了
    var addedTail = res.addedRows ? ('，另自动加了 ' + res.addedRows + ' 行经历') : '';
    // 预算没填完的新字段也说出来：让用户知道「再点一次」能继续，而不是以为漏填了
    var leftTail = res.pendingLeft ? ('；另有 ' + res.pendingLeft + ' 个新字段待补（再点一次）') : '';

    if (failCount) {
      toast('已填写 ' + okCount + ' 个' + addedTail + '，' + failCount +
        ' 个失败（可重新扫描重试）', 'warn');
    } else {
      // 明确说「不会替你保存」：这不是客套话 —— 暂存/提交按钮扩展一个都不点，
      // 页面上填的东西还在内存里，用户一刷新就没了
      toast('已填写 ' + okCount + ' 个字段' + addedTail + leftTail +
        '，请核对后自行暂存/提交（扩展不会替你保存）', 'ok');
    }
  }

  /**
   * 撤销上一次自动填写（把这次填进去的值清掉，页面回到填之前的样子）。
   *
   * 关键坑：**不能拿上次的字段 id 去清**。字段 id 是「本次扫描里的序号」，
   * 而填完之后页面结构会变（自定义组件填上值后内部 input 会被移除），
   * 重扫后同一个字段的 id 就不一样了 —— 用旧 id 要么清不到、要么清错对象。
   * 所以这里先重扫一次，用 **selector** 找回当前 id，再发 RJ_CLEAR。
   */
  async function undoFill() {
    if (!state.lastFill || !state.lastFill.length) return;
    var btn = $('#btn-undo');
    var oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '撤销中…';

    try {
      var scanRes = await chrome.tabs.sendMessage(state.tabId, { type: 'RJ_SCAN' });
      var plan = (scanRes && scanRes.plan) || [];
      var want = {};
      state.lastFill.forEach(function (x) { if (x.selector) want[x.selector] = 1; });
      var ids = plan.filter(function (p) { return want[p.selector]; })
        .map(function (p) { return p.id; });

      if (!ids.length) {
        toast('已找不到刚才填的字段（页面可能变了），可以重新扫描一次', 'warn');
        return;
      }

      var res = await chrome.tabs.sendMessage(state.tabId, { type: 'RJ_CLEAR', ids: ids });
      if (!res || !res.ok) {
        toast('撤销失败：' + ((res && res.error) || '与页面通信中断'), 'err');
        return;
      }

      var okN = (res.report || []).filter(function (r) { return r.ok; }).length;
      var badN = (res.report || []).length - okN;
      state.lastFill = null;
      state.lastResult = {
        ok: true, url: state.pageUrl, title: state.pageTitle,
        total: res.total, matched: res.matched, plan: res.plan
      };
      render();
      toast(badN
        ? ('已撤回 ' + okN + ' 项，' + badN + ' 项没撤回（可能需要手动清一下）')
        : ('已撤回 ' + okN + ' 项，页面已回到填写前'), badN ? 'warn' : 'ok');
    } catch (e) {
      toast('撤销失败：' + String((e && e.message) || e), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
      updateCounts();
    }
  }

  // ------------------------------------------------------------ 新信息回填

  async function saveAdditions() {
    var paths = Object.keys(state.pendingAdditions);
    if (!paths.length) { hideAddBar(); return; }

    var r = await STORE.patchActiveProfile(state.pendingAdditions);
    hideAddBar();
    state.pendingAdditions = {};

    if (!r) { toast('回填失败：没有找到当前简历', 'err'); return; }

    await loadProfile();
    toast('已补进「' + r.name + '」的 ' + paths.length + ' 个字段', 'ok');
    await scan();          // 重新扫描，简历变空/变有的标记会跟着更新
  }

  // ---------------------------------------------------------------- 启动

  document.addEventListener('DOMContentLoaded', async function () {
    $('#btn-scan').addEventListener('click', scan);
    $('#btn-fill').addEventListener('click', fill);
    $('#btn-undo').addEventListener('click', undoFill);
    $('#btn-options').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
    $('#only-matched').addEventListener('change', render);
    $('#btn-add-save').addEventListener('click', saveAdditions);
    $('#btn-add-skip').addEventListener('click', function () {
      hideAddBar();
      state.pendingAdditions = {};
    });

    $('#btn-ai-note').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
    // 显式触发：跳过自动节流。频率闸（每分钟配额）照旧管着，绕不过去。
    $('#btn-ai-run').addEventListener('click', function () { maybeRunAi(state.token, true); });
    $('#btn-diag').addEventListener('click', copyDiag);
    $('#btn-diag-close').addEventListener('click', function () { $('#diag-overlay').hidden = true; });
    try { $('#ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* ignore */ }

    $('#resume-select').addEventListener('change', async function () {
      await STORE.setActiveResume(this.value);
      await loadResumes();
      await loadProfile();
      await scan();
      toast('已切换到该简历');
    });

    try {
      var data = await loadResumes();
      var active = data.resumes.filter(function (r) { return r.id === data.activeId; })[0];
      if (!active || !active.hasName) {
        toast('当前简历资料为空，请到「资料设置」填写', 'warn');
      }
      await loadProfile();
    } catch (e) { /* ignore */ }

    await scan();
  });
})();
