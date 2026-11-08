/**
 * 编排层：接收 popup 指令，执行「扫描 → 匹配 → 填写 → 重扫」的 ReAct 循环。
 * 消息协议：
 *   RJ_PING  -> { ok: true }
 *   RJ_SCAN  -> { ok, url, title, total, matched, plan[] }
 *   RJ_FILL  -> { ok, report[], plan[], total, matched }
 *   RJ_DIAG  -> 诊断快照（扫描结果 + 日志 + 未匹配字段的 HTML），供用户一键复制反馈
 */
(function () {
  if (window.__RJ_LOADED__) return;
  window.__RJ_LOADED__ = true;

  var CONFIG = window.__RJ_CONFIG__;
  var SCAN = window.__RJ_SCANNER__;
  var FILL = window.__RJ_FILLER__;
  var M = window.__RJ_MATCHER__;
  var STORE = window.__RJ_STORE__;
  var LOG = window.__RJ_LOG__;

  var THRESHOLD = CONFIG.autoFillThreshold;

  // 留一份现场，供 RJ_DIAG 打包
  var lastPlan = [];
  var lastFillReport = [];

  function log(tag, data) {
    if (LOG) LOG.log(tag, data);
  }

  function valueFor(profile, path) {
    var v = M.getByPath(profile, path);
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(',');
    return String(v);
  }

  /** 取回字段对应的 DOM 元素（组则取第一个控件） */
  function elementOf(id) {
    var e = SCAN.getEntry(id);
    if (!e) return null;
    return e.el || (e.group && e.group[0]) || null;
  }

  /**
   * 规则没命中的字段才会带 DOM 骨架 —— 它能帮模型找到标签，但也占 token，
   * 所以只给真正需要的字段，已经命中的不给。
   */
  function aiFeaturesOf(f, labelSource, withSkeleton) {
    var feature = {
      id: f.id,
      fingerprint: f.fingerprint || '',
      label: f.labelText || '',
      // 标签来源：模型据此判断「这个 label 可不可信」，不可信时得靠骨架推断
      labelSource: labelSource || 'none',
      placeholder: f.attrs.placeholder || '',
      htmlName: f.attrs.name || '',
      htmlId: f.attrs.id || '',
      type: f.type || '',
      options: (f.options || []).map(function (o) { return o.text; })
    };
    if (!withSkeleton) return feature;
    var el = elementOf(f.id);
    if (el) {
      try { feature.skeleton = SCAN.describeContext(el); } catch (e) { /* 拿不到就不给 */ }
    }
    return feature;
  }

  /**
   * 按 DOM 顺序给字段排序。
   *
   * 为什么要这一步：重复块是「第几段」靠字段在页面上出现的先后算的。
   * 而 SCAN.scanAll() 的顺序在**填过值之后会变** —— 自定义组件填了值会把内部那个
   * 真 input 删掉，补扫再把它追加到列表末尾。不按 DOM 重排的话，
   * 第二次点「自动填写」就可能把第 2 段的值填进第 1 段。
   */
  function domSort(fields) {
    var items = fields.map(function (f, i) {
      var e = SCAN.getEntry(f.id);
      var el = e ? (e.el || (e.group && e.group[0])) : null;
      return { f: f, el: el, i: i };
    });
    items.sort(function (a, b) {
      if (!a.el || !b.el || a.el === b.el) return a.i - b.i;
      var r = a.el.compareDocumentPosition(b.el);
      if (r & 4) return -1;   // DOCUMENT_POSITION_FOLLOWING
      if (r & 2) return 1;    // DOCUMENT_POSITION_PRECEDING
      return a.i - b.i;
    });
    return items.map(function (x) { return x.f; });
  }

  // 每一类块用哪个字段当「这一段从这里开始」的锚点。
  // 必须和 config.js 里 anchor: true 的那几条规则保持一致。
  var BLOCK_ANCHOR_FIELD = { education: 'school', experience: 'company', projects: 'name' };

  /** 'education[*].school' → 'education'；'[*].startDate' → '*'；普通路径 → null */
  function blockOfTemplate(tpl) {
    var s = String(tpl || '');
    var m = /^([A-Za-z]+)\[\*\]\./.exec(s);
    if (m) return m[1];
    if (s.indexOf('[*]') === 0) return '*';
    return null;
  }

  function isAnchorTemplate(tpl, block) {
    var m = /^([A-Za-z]+)\[\*\]\.([A-Za-z]+)$/.exec(String(tpl || ''));
    if (!m) return false;
    if (block && m[1] !== block) return false;
    return BLOCK_ANCHOR_FIELD[m[1]] === m[2];
  }

  /**
   * 重复块的段号分配器：靠「锚点字段」按 DOM 顺序切块。
   *
   * 页面上的顺序长这样（实测北森投递页）：
   *   学校名称 专业名称 学历 开始时间 结束时间 | 学校名称 … | 公司名称 职位名称 开始时间 结束时间
   *   | 工作职责 | 项目名称 职务 开始时间 结束时间 | 项目描述
   *
   * 「开始时间」在三种块里都叫这个名字，光看标签没法知道属于哪一段 ——
   * 所以路径里只写 [*]，由这里按顺序定：
   *   · 遇到锚点（学校名称/公司名称/项目名称）→ 该类型段号 +1，并把「当前块」切成它
   *   · 之后的中性字段（开始/结束时间、职责、描述、职务）记到「当前块」上
   *
   * 为什么要做成「有状态的游标」而不是一个纯函数：同一份段号逻辑现在有三个调用方
   * （生成 plan、重扫自动补齐、解析 AI 给的数组模板），三处若各写一遍，
   * 迟早会出现「弹窗里显示第 2 段、实际填进第 1 段」这种最难查的错位。
   */
  function blockCursor(profile) {
    var idx = { education: -1, experience: -1, projects: -1 };
    var cur = null;

    return {
      /**
       * 模板 → 具体路径。
       * @returns {{path: string|null, value: string, block: string|null, index: number, note?: string}}
       */
      resolve: function (tpl) {
        tpl = String(tpl || '');
        if (tpl.indexOf('[*]') === -1) {
          return { path: tpl, value: valueFor(profile, tpl), block: null, index: -1 };
        }
        var b = blockOfTemplate(tpl);
        if (!b) {
          return { path: null, value: '', block: null, index: -1, note: '（重复块：路径写法不认识）' };
        }
        if (b !== '*') {
          if (isAnchorTemplate(tpl)) idx[b]++;
          cur = b;
        }
        if (!cur || idx[cur] < 0) {
          return { path: null, value: '', block: cur, index: -1, note: '（重复块：找不到所属的块）' };
        }

        var i = idx[cur];
        // '[*].startDate' → 'experience.0.startDate'；'education[*].school' → 'education.0.school'
        // 注意第二行必须补上那个点 —— 直接 replace 成 '0' 会得到 education0.school，
        // getByPath 取不到值，表现为「公司名称/学校名称明明简历里有，却填不进去」。
        var path = tpl.indexOf('[*]') === 0
          ? tpl.replace('[*]', cur + '.' + i)
          : tpl.replace('[*]', '.' + i);
        return { path: path, value: valueFor(profile, path), block: cur, index: i };
      },
      /** 这一类块在页面上已经出现过的段数（锚点个数） */
      rows: function (b) { return idx[b] + 1; },
      current: function () { return cur; }
    };
  }

  function resolveBlockPaths(plan, matches, profile) {
    var cursor = blockCursor(profile);
    plan.forEach(function (p, n) {
      var m = matches[n];
      if (!m) return;
      var r = cursor.resolve(m.path);
      if (r.path === null) {
        p.reason = (p.reason || '') + (r.note || '（重复块：找不到所属的块）');
        return;
      }
      // 普通字段在第一轮已经取好值了，这里重算一次是等价的，不用区分
      p.suggestedPath = r.path;
      p.suggestedValue = r.value;
      if (r.index < 0) return;

      // 「至今」原样留着：filler 认得它，会去勾日期旁边的「至今」勾选框
      if (/^(至今|现在|今|present|now)$/i.test(String(r.value).trim())) {
        p.reason = (p.reason || '') + '（「至今」→ 勾选日期旁的「至今」）';
      } else if (!r.value) {
        p.reason = (p.reason || '') + '（简历里没有第 ' + (r.index + 1) + ' 段）';
      }
    });
    return cursor;
  }

  function buildPlan(profile) {
    var fields = domSort(SCAN.scanAll());
    // 本页已被规则解出的字段，抽成「这个网站怎么写字」的样例给模型做类比
    var resolvedExamples = [];
    var matches = [];

    var plan = fields.map(function (f) {
      var m = M.matchField(f, CONFIG.fieldRules);
      matches.push(m);
      if (m) {
        resolvedExamples.push({
          label: f.labelText || '',
          labelSource: f.labelSource || 'none',
          type: f.type || ''
        });
      }
      // 带 [*] 的是重复块，具体路径要等整页排完序才知道，这里先留空
      var simple = m && String(m.path).indexOf('[*]') === -1;
      return {
        id: f.id,
        label: f.labelText || f.attrs.placeholder || f.attrs.name || '(未命名字段)',
        labelSource: f.labelSource || 'none',
        tag: f.tag,
        type: f.type,
        selector: f.selector,
        required: f.required,
        currentValue: f.value || '',
        empty: SCAN.isEmptyField(f),
        options: f.options || [],
        suggestedPath: simple ? m.path : null,
        suggestedValue: simple ? valueFor(profile, m.path) : '',
        confidence: m ? m.confidence : 0,
        reason: m ? m.reason : '',
        source: m ? m.source : null,
        // 供弹窗把「规则没命中的字段」交后台做 AI 兜底映射
        fingerprint: f.fingerprint || '',
        // withSkeleton：只有规则没命中的字段才带 DOM 骨架（占 token，已命中的不给）
        aiFeatures: aiFeaturesOf(f, f.labelSource, !m)
      };
    });

    var cursor = resolveBlockPaths(plan, matches, profile);

    return {
      plan: plan,
      resolvedExamples: resolvedExamples,
      // 页面上每类块已经有几段 —— 「要不要点添加按钮加行」全靠这个数
      blockRows: {
        education: cursor.rows('education'),
        experience: cursor.rows('experience'),
        projects: cursor.rows('projects')
      }
    };
  }

  async function handleScan() {
    var profile = await STORE.getProfile();
    var built = buildPlan(profile);
    var plan = built.plan;
    lastPlan = plan;

    var matched = plan.filter(function (p) { return !!p.suggestedPath; });
    var unmatched = plan.filter(function (p) { return !p.suggestedPath; });

    log('scan', {
      url: location.href,
      total: plan.length,
      matched: matched.length,
      unmatched: unmatched.length
    });
    // 未匹配的字段单独列一行，方便直接看出词典缺了什么词
    if (unmatched.length) {
      log('scan.unmatched', unmatched.map(function (p) {
        return (p.label || '(无名)') + '[' + p.type + ']' +
          ' src=' + p.labelSource +
          (p.aiFeatures.placeholder ? ' ph="' + p.aiFeatures.placeholder + '"' : '') +
          (p.aiFeatures.htmlName ? ' name=' + p.aiFeatures.htmlName : '');
      }));
    }
    // 标签不可信的字段单独标出来 —— 「全是请输入」就是这一类的典型
    var weak = plan.filter(function (p) {
      return p.labelSource === 'placeholder' || p.labelSource === 'none';
    });
    if (weak.length) {
      log('scan.weakLabel', weak.map(function (p) {
        return (p.label || '(无名)') + ' <- ' + (p.aiFeatures.skeleton || ['(无骨架)'])[0];
      }));
    }

    return {
      ok: true,
      url: location.href,
      title: document.title,
      total: plan.length,
      matched: plan.filter(function (p) { return !!p.suggestedPath && !!p.suggestedValue; }).length,
      // 给模型做类比的「本页已成功解出的字段」样例
      resolvedExamples: built.resolvedExamples,
      plan: plan
    };
  }

  // 重扫补齐的自我约束。为什么必须有上限，是拿真实事故换来的：
  // 一个空投递表单上，autoFillPending 会想把**所有**空字段挨个填掉，
  // 其中地区选择器、学历下拉、起止日期这些自定义组件**一个就要几十秒**，
  // 加起来几分钟都填不完，期间没有进度、也没法取消，CDP 一超时看着像死循环。
  var MAX_AUTO_PER_ROUND = 8;      // 一轮最多自动补几个
  var AUTO_BUDGET_MS = 8000;       // 一轮的时间预算（单个字段不可打断，只能「开始下一个之前」查）

  /** 填充前拍一张「页面上已经有哪些字段」的快照，用来区分「新出现的字段」 */
  function snapshotSelectors() {
    var set = {};
    SCAN.scanAll().forEach(function (f) { set[f.selector] = 1; });
    return set;
  }

  /**
   * 重扫补齐：只填**填充后才新出现**的字段（比如点「添加」加出来的那一行）。
   *
   * 为什么必须限定「新出现」而不是「页面所有空字段」：
   *   用户在弹窗里已经决定了要填哪些、不填哪些 —— 那些他取消勾选的、或者
   *   本来就没选的字段，不该因为「规则能认出」就替他都填了。之前的实现就是
   *   全页扫填，把这条「人在环路」的边界吃掉了。
   *
   * 三个硬约束（缺一不可）：
   *   · baseline：填充前就存在的字段，一律不碰；
   *   · f.component：自定义组件不碰 —— 慢的正是它们，交给用户自己点；
   *   · 条数 + 时间预算：超了停下，剩下的记进 left 交还弹窗，绝不闷头跑几分钟。
   *
   * 段号这块照样有两个容易写错、错了很难发现的地方：
   *   1. 必须按 DOM 顺序重排（domSort）。补扫出来的新字段在 scanAll 里是追加到末尾的，
   *      不重排的话「第 2 段」会被算成第 3 段。
   *   2. 段号游标要对**所有命中规则的字段**推进，包括页面上已经有值的那些 ——
   *      跳过它们会让后面的块整体错位。
   */
  async function autoFillPending(profile, skipSelectors, baseline) {
    var fields = domSort(SCAN.scanAll());
    var cursor = blockCursor(profile);
    var tasks = [];
    fields.forEach(function (f) {
      var m = M.matchField(f, CONFIG.fieldRules);
      if (!m) return;

      // 先解析：锚点字段即使已经填好，也要让它把段号推进到下一段
      var r = cursor.resolve(m.path);
      if (!r.path || !r.value) return;
      if (baseline && baseline[f.selector]) return;      // 填充前就在，不是新字段
      if (skipSelectors && skipSelectors[f.selector]) return;
      if (f.component) return;                           // 自定义组件：慢，且容易失败，交给用户
      if (!SCAN.isEmptyField(f)) return;
      if (m.confidence < THRESHOLD) return;
      tasks.push({ id: f.id, value: r.value, label: f.labelText, path: r.path, auto: true });
    });

    var results = [];
    var deadline = Date.now() + AUTO_BUDGET_MS;
    for (var i = 0; i < tasks.length; i++) {
      if (results.length >= MAX_AUTO_PER_ROUND || Date.now() > deadline) {
        return { results: results, left: tasks.length - i };
      }
      var t = tasks[i];
      var r2 = await FILL.fillOne(t);
      results.push(Object.assign({}, t, r2));
    }
    return { results: results, left: 0 };
  }

  // 一次最多替用户点几次「+ 添加」。上限存在的意义不是省事：
  // 点错了会往表单里塞一堆空行，用户还得手动删，比没填更糟。
  var MAX_ADD_ROWS = 3;

  /**
   * 简历里有几段，页面上就有几行 —— 不够就点「+ 添加」把行加出来。
   *
   * 为什么要这一步：投递页默认只渲染 1 行空的经历，而简历里往往有 3 段。
   * 不把行加出来，第 2、3 段连「填哪里」都没有 —— 这是「六成字段填不了」的主因。
   *
   * 做法是「加一行、重扫一次」：加完之后光看返回成功没用，
   * 页面上到底多没多一行只能靠重扫数锚点来确认（有些按钮点了是展开弹层，不是加行）。
   */
  async function ensureBlockRows(profile, report, touched) {
    var blocks = ['education', 'experience', 'projects'];
    var addedRows = 0;

    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      // 用户本次没打算填这一类经历，就别替他加行 ——
      // 加出来的空行会留在他的投递表单里，还得手动删；这比「少填一段」更烦人。
      if (touched && !touched[b]) continue;
      var want = (profile[b] || []).length;
      if (!want) continue;

      for (var guard = 0; guard < MAX_ADD_ROWS; guard++) {
        var fields = domSort(SCAN.scanAll());
        var cursor = blockCursor(profile);
        var anchorId = null;
        fields.forEach(function (f) {
          var m = M.matchField(f, CONFIG.fieldRules);
          if (!m) return;
          cursor.resolve(m.path);                       // 推进段号
          if (isAnchorTemplate(m.path, b)) anchorId = f.id;
        });

        var have = cursor.rows(b);
        if (have >= want) break;

        var r = await FILL.addBlockRow(anchorId, b);
        log('fill.addBlock', { block: b, have: have, want: want, ok: r.ok, error: r.error || null });

        if (!r.ok) {
          report.push({
            label: b + ' 第 ' + (have + 1) + ' 段（自动加行）',
            path: b + '.' + have,
            value: '',
            ok: false,
            error: r.error,
            auto: true,
            added: true
          });
          break;
        }

        await FILL.sleep(450);                          // 等组件把新行渲染出来
        addedRows++;

        // 加完立刻核一次：数目没变说明按钮没生效，别再连点
        var after = blockCursor(profile);
        domSort(SCAN.scanAll()).forEach(function (f) {
          var m = M.matchField(f, CONFIG.fieldRules);
          if (m) after.resolve(m.path);
        });
        if (after.rows(b) <= have) {
          report.push({
            label: b + ' 第 ' + (have + 1) + ' 段（自动加行）',
            path: b + '.' + have,
            value: '',
            ok: false,
            error: '点了「' + (r.trigger || '添加') + '」，但页面上没有多出一行',
            auto: true,
            added: true
          });
          break;
        }
      }
    }
    return addedRows;
  }

  async function handleFill(msg) {
    var profile = await STORE.getProfile();
    var items = msg.items || [];
    var skipSelectors = msg.skipSelectors || {};
    var report = [];

    // 0) 填充前先拍快照：重扫补齐只管「之后新出现」的字段，不碰用户没选的
    var baseline = snapshotSelectors();

    // 1) 填充用户在 popup 中确认过的字段
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var r = await FILL.fillOne(it);
      report.push({
        id: it.id,
        label: it.label,
        path: it.path,
        value: it.value,
        ok: r.ok,
        error: r.error || null,
        auto: false
      });
    }

    // 2) 先补行：简历里的段数比页面上的行多时，点「+ 添加」把行加出来。
    //    必须排在重扫补齐之前 —— 新行是空的，正好交给下一步的 autoFillPending 去填。
    //    只对「这次真的要填」的块加行：没打算填经历却凭空多出几行空白，
    //    对用户来说是个需要手动收拾的麻烦。
    var touched = {};
    items.forEach(function (it) {
      ['education', 'experience', 'projects'].forEach(function (b) {
        if (String(it.path || '').indexOf(b + '.') === 0) touched[b] = 1;
      });
    });
    var addedRows = await ensureBlockRows(profile, report, touched);

    // 3) 重扫循环：处理「填了某字段才出现的新字段」（最多 2 轮，避免死循环）
    var rounds = 0;
    var pendingLeft = 0;
    while (rounds < 2) {
      rounds++;
      await FILL.sleep(250);
      var auto = await autoFillPending(profile, skipSelectors, baseline);
      pendingLeft = auto.left;
      if (!auto.results.length) break;
      auto.results.forEach(function (x) {
        report.push({
          id: x.id,
          label: x.label,
          path: x.path,
          value: x.value,
          ok: x.ok,
          error: x.error || null,
          auto: true
        });
      });
    }

    lastFillReport = report;
    var okN = report.filter(function (x) { return x.ok; }).length;
    log('fill', {
      total: report.length, ok: okN, fail: report.length - okN,
      auto: report.filter(function (x) { return x.auto; }).length,
      addedRows: addedRows
    });
    report.filter(function (x) { return !x.ok; }).forEach(function (x) {
      log('fill.fail', { label: x.label, path: x.path, error: x.error });
    });

    var scan = await handleScan();
    return {
      ok: true,
      report: report,
      addedRows: addedRows,
      pendingLeft: pendingLeft,
      plan: scan.plan,
      total: scan.total,
      matched: scan.matched
    };
  }

  /**
   * 把 AI 返回的数组模板（education[*].school）解析成具体路径（education.1.school）。
   *
   * 为什么这件事必须回到内容脚本里做：第几段只能由**页面上字段的先后顺序**决定，
   * 而弹窗里只有一份 plan 快照，拿不到最新的 DOM 顺序。
   * 走一条消息、在这里重扫一遍，弹窗那边就不用维护第二份段号逻辑。
   */
  async function handleResolvePaths(msg) {
    var tpls = msg.paths || {};
    var profile = await STORE.getProfile();
    var fields = domSort(SCAN.scanAll());
    var cursor = blockCursor(profile);
    var out = {};

    fields.forEach(function (f) {
      var tpl = tpls[f.id];
      if (!tpl) {
        // 规则已命中的字段同样要推进段号，否则 AI 那几段的序号会偏
        var m = M.matchField(f, CONFIG.fieldRules);
        if (m) cursor.resolve(m.path);
        return;
      }
      var r = cursor.resolve(tpl);
      out[f.id] = {
        path: r.path,
        value: r.value,
        block: r.block || null,
        index: r.index,
        reason: r.note || ''
      };
    });

    log('resolvePaths', { asked: Object.keys(tpls).length, resolved: Object.keys(out).length });
    return { ok: true, paths: out };
  }

  // ---------------------------------------------------------------- 诊断

  function elOf(id) {
    var e = SCAN.getEntry(id);
    if (!e) return null;
    return e.el || (e.group && e.group[0]) || null;
  }

  function buildDiag() {
    var plan = lastPlan || [];
    var matched = plan.filter(function (p) { return p.suggestedPath; });
    var unmatched = plan.filter(function (p) { return !p.suggestedPath; });

    return {
      at: new Date().toISOString(),
      version: (function () {
        try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
      })(),
      page: { url: location.href, title: document.title },
      summary: {
        total: plan.length,
        matched: matched.length,
        unmatched: unmatched.length
      },
      // 注意：不含简历里的任何值，只标「有没有值」，避免把个人信息复制出去
      fields: plan.map(function (p) {
        return {
          id: p.id,
          label: p.label,
          labelSource: p.labelSource,
          type: p.type,
          required: p.required,
          pageEmpty: p.empty,
          path: p.suggestedPath,
          confidence: p.confidence,
          reason: p.reason,
          source: p.source,
          resumeHasValue: !!String(p.suggestedValue || '').trim(),
          attrs: {
            name: p.aiFeatures && p.aiFeatures.htmlName,
            id: p.aiFeatures && p.aiFeatures.htmlId,
            placeholder: p.aiFeatures && p.aiFeatures.placeholder
          }
        };
      }),
      // 未匹配字段：先给「周边语境」（标签到底在不在这附近），再附原始 HTML。
      // 只看 input 自己的 outerHTML 推不出原因 —— 标签通常在外层的前一个兄弟里。
      unmatchedDetail: unmatched.map(function (p) {
        var el = elOf(p.id);
        var html = '';
        try {
          html = el && el.outerHTML ? String(el.outerHTML).replace(/\s+/g, ' ').slice(0, 240) : '';
        } catch (e) { html = ''; }
        var context = [];
        try {
          context = el ? SCAN.describeContext(el) : [];
        } catch (e) { context = ['describeContext 失败: ' + e]; }
        return {
          label: p.label,
          labelSource: p.labelSource,
          type: p.type,
          placeholder: p.aiFeatures && p.aiFeatures.placeholder,
          html: html,
          context: context
        };
      }),
      fillReport: (lastFillReport || []).map(function (x) {
        return { label: x.label, path: x.path, ok: x.ok, auto: x.auto, error: x.error };
      }),
      logs: LOG ? LOG.all() : []
    };
  }

  /**
   * 清空指定字段（按扫描出来的 id）。
   *
   * 为什么单独一条消息、而不是「发 RJ_FILL 但 value 传空」：
   * 那样对普通输入框有效，对**组件**却是静默失败 —— 往组件内部 input 写空字符串
   * 读回确实是空的，组件自己的状态没变、显示值照样在。
   * 所以清空必须走 FILL.clearOne 的显式路径。
   * （这条也给「填错了想撤回」用。）
   */
  async function handleClear(msg) {
    var ids = msg.ids || [];
    var report = [];
    for (var i = 0; i < ids.length; i++) {
      var entry = SCAN.getEntry(ids[i]);
      var label = '';
      try { label = (entry && entry.field && entry.field.labelText) || ''; } catch (e) { /* ignore */ }
      var r = entry ? await FILL.clearOne(entry) : { ok: false, error: '找不到该字段' };
      report.push({ id: ids[i], label: label, ok: r.ok, via: r.via || null, error: r.error || null });
      await FILL.sleep(120);
    }
    log('clear', {
      total: report.length,
      ok: report.filter(function (x) { return x.ok; }).length
    });
    var scan = await handleScan();
    return {
      ok: true,
      report: report,
      plan: scan.plan,
      total: scan.total,
      matched: scan.matched
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'RJ_PING') {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'RJ_SCAN') {
      handleScan().then(sendResponse, function (e) { sendResponse({ ok: false, error: String(e) }); });
      return true;
    }
    if (msg.type === 'RJ_FILL') {
      handleFill(msg).then(sendResponse, function (e) { sendResponse({ ok: false, error: String(e) }); });
      return true;
    }
    if (msg.type === 'RJ_RESOLVE_PATHS') {
      handleResolvePaths(msg).then(sendResponse, function (e) { sendResponse({ ok: false, error: String(e) }); });
      return true;
    }
    if (msg.type === 'RJ_CLEAR') {
      handleClear(msg).then(sendResponse, function (e) { sendResponse({ ok: false, error: String(e) }); });
      return true;
    }
    if (msg.type === 'RJ_DIAG') {
      try {
        sendResponse({ ok: true, diag: buildDiag() });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
  });
})();
