/**
 * 执行层：把值真正写进控件，并触发能被 React/Vue 感知的事件。
 * 关键点：受控组件直接 el.value = x 不生效，必须用原型上的原生 setter + 派发 input/change。
 */
(function () {
  if (window.__RJ_FILLER__) return;

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function setNativeValue(el, value) {
    var tag = el.tagName.toLowerCase();
    var proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  /** 是不是「能直写」的原生控件 —— div 之类不是（组件根会走到模拟选择那条路） */
  function isFormControl(el) {
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
  }

  function fillSelect(el, value) {
    var v = String(value).trim();
    var match = null;
    Array.prototype.some.call(el.options, function (o) {
      var text = (o.textContent || '').trim();
      if (o.value === v || text === v) { match = o; return true; }
      return false;
    });
    if (!match) {
      Array.prototype.some.call(el.options, function (o) {
        var text = (o.textContent || '').trim();
        if (v && (text.indexOf(v) !== -1 || v.indexOf(text) !== -1)) { match = o; return true; }
        return false;
      });
    }
    if (!match) return { ok: false, error: '下拉框中未找到匹配选项：' + v };
    el.focus();
    el.value = match.value;
    fire(el, 'input');
    fire(el, 'change');
    return { ok: el.value === match.value };
  }

  function fillContentEditable(el, value) {
    el.focus();
    // 尽量模拟真实输入：优先 execCommand，失败则直接写 textContent
    var done = false;
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done = document.execCommand('insertText', false, String(value));
    } catch (e) { done = false; }
    if (!done) el.textContent = String(value);
    fire(el, 'input');
    fire(el, 'change');
    return { ok: true };
  }

  function fillTextLike(el, value) {
    el.focus();
    setNativeValue(el, String(value));
    fire(el, 'input');
    fire(el, 'change');
    fire(el, 'blur');
    return { ok: String(el.value || '').length > 0 };
  }

  function splitValues(value) {
    if (Array.isArray(value)) return value.map(String).map(trim).filter(Boolean);
    return String(value).split(/[,，、;；|/]+/).map(trim).filter(Boolean);
  }
  function trim(s) { return String(s == null ? '' : s).trim(); }

  async function fillGroup(group, value) {
    var values = splitValues(value);
    if (!values.length) return { ok: false, error: '无候选值' };

    function optionText(n) {
      return trim(window.__RJ_SCANNER__.getLabel(n) || n.value);
    }
    function exactHit(n, v) {
      var text = optionText(n);
      return v === n.value || v === text;
    }
    function looseHit(n, v) {
      var text = optionText(n);
      return !!v && (text.indexOf(v) !== -1 || v.indexOf(text) !== -1);
    }

    var matched = 0;
    var already = 0;   // 本来就已是目标状态，也算成功（否则重复填充会误报失败）

    function trySet(n, hitFn) {
      if (!values.some(hitFn)) return;
      if (n.checked) { already++; return; }
      n.click();
      matched++;
    }

    // 第一轮：精确匹配（避免 "Java" 误命中 "JavaScript"）
    group.forEach(function (n) {
      trySet(n, function (v) { return exactHit(n, v); });
    });

    // 第二轮：仅在「既没改动也没已满足」时才做模糊匹配
    if (matched === 0 && already === 0) {
      group.forEach(function (n) {
        trySet(n, function (v) { return looseHit(n, v); });
      });
    }

    return { ok: matched > 0 || already > 0, matched: matched, already: already };
  }

  // ---------------------------------------------------------------- 自定义下拉
  //
  // 这一节解决的是「组件库自己的下拉填不进去」。往它的内部 input 写值是无效的
  // （值归组件状态管，组件会把我们写的值丢掉），只能模拟点击、在浮层里选。

  /** 合成一次鼠标事件。**必须带坐标** —— 组件常按坐标定位浮层 */
  function fireMouse(el, type) {
    var r = el.getBoundingClientRect();
    var opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
      button: 0, buttons: type === 'mousedown' ? 1 : 0
    };
    el.dispatchEvent(new MouseEvent(type, opts));
  }

  /**
   * 模拟点击。
   *
   * 实测（北森 phoenix-select 与它的三级地区选择器）：组件只要求**普通合成的 click**，
   * 并不要求 isTrusted=true 的可信事件 —— 这正是真实扩展也能驱动它们的原因。
   * 三种事件都发一遍：有的库在 mousedown 上展开，有的在 click 上选中。
   */
  function clickLike(el) {
    fireMouse(el, 'mousedown');
    fireMouse(el, 'mouseup');
    fireMouse(el, 'click');
  }

  function isVisible(n) {
    var r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s;
    try { s = getComputedStyle(n); } catch (e) { return false; }
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  }

  /**
   * 找出页面上「像浮层」的元素。
   *
   * 为什么不按类名找：每家的浮层类名都不一样（北森 common-unmodeled-layer、
   * Element el-select-dropdown、AntD ant-select-dropdown），写死就是 O(站点数)，
   * 而这次的目标恰恰是「不靠站点特定规则」。改用它作为浮层的三个物理特征：
   * 脱离文档流（absolute/fixed）+ 有层级（z-index）+ 够大。
   */
  function floatingPanels() {
    var out = [];
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var tag = (n.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style') continue;
      var s;
      try { s = getComputedStyle(n); } catch (e) { continue; }
      if (s.position !== 'absolute' && s.position !== 'fixed') continue;
      var z = parseInt(s.zIndex, 10);
      if (isNaN(z) || z < 10) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 80 || r.height < 48) continue;
      if (!isVisible(n)) continue;
      out.push(n);
    }
    return out;
  }

  /**
   * 在「像浮层的元素」里挑出**可能是下拉面板**的，按可信度排序。
   *
   * 只按「脱离文档流 + 有层级 + 够大」找会捞到站点自己的东西 ——
   * 实测这个页面顶部导航就被当成了面板（候选是「首页 / 校园招聘 / 社会招聘」）。
   * 所以再加两条判据：
   *   1. **必须贴着控件**：下拉都是紧挨着触发控件弹出来的，导航栏在页面顶部，一测就露馅
   *   2. **里面得有若干个短文本叶子**：选项列表的特征
   * 两者同时满足才算，宁缺毋滥 —— 认错面板会让填充点到导航上去。
   */
  function dropdownPanels(trigger) {
    var t = trigger.getBoundingClientRect();
    var ranked = [];
    floatingPanels().forEach(function (n) {
      if (n === trigger || n.contains(trigger) || trigger.contains(n)) return;
      var r = n.getBoundingClientRect();
      // 面板与控件的水平/垂直间隙（两个方向都算，兼容向上弹出的 placement-top）
      var dx = Math.max(0, r.left - (t.left + t.width), t.left - (r.left + r.width));
      var dy = Math.max(0, r.top - (t.top + t.height), t.top - (r.top + r.height));
      if (dx > 80 || dy > 100) return;              // 离得太远，不是它的面板
      var count = optionCandidates(n).length;
      if (count < 3) return;                        // 里面不像选项列表
      var z = parseInt(getComputedStyle(n).zIndex, 10) || 0;
      ranked.push({ n: n, z: z, count: count, area: r.width * r.height });
    });
    ranked.sort(function (a, b) {
      return (b.z - a.z) || (b.area - a.area);
    });
    return ranked.map(function (x) { return x.n; });
  }

  /**
   * 面板里「不是选项」的东西。必须排除，否则会点错目标。
   *
   * 实测踩到的两个：地区选择器里的**面包屑**（「北京市」，点它是回上一级）和
   * **页签**（「全国 / 全部省市」）—— 它们文本短，形态上和选项一模一样，
   * 光看「叶子节点 + 短文本」分不出来，只能按类名排除。
   *
   * 注意 tab 那个边界：必须写成 `tab` 后面跟分隔符或结尾。
   * 早期写成 `(^|[-_])tab`，它会**把 `-table` 也匹配掉** ——
   * 于是日历里整张日期表格的格子全被当成「页签」排除，
   * 面板被判定成「不是下拉」，日期字段一律报「点开后没有出现选项浮层」。
   */
  var AUX_RE = /(breadcrumb|(^|[-_])tab([-_]|$)|clear|disabled|placeholder)/i;

  /**
   * 浮层里像「选项」的元素：叶子节点（没有元素子节点）且文本不长。
   *
   * 排除要**连祖先一起看** —— 选项常常是 <div class="area-tab-item"><span>全国</span></div>
   * 这种形状，叶子 span 自己没有类名，只看它本身就是漏网之鱼。
   */
  function optionCandidates(panel) {
    var out = [];
    var all = panel.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.children && n.children.length) continue;
      if (!isVisible(n)) continue;
      var t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 30) continue;
      if (hasAuxAncestor(n, panel)) continue;
      out.push(n);
    }
    return out;
  }

  /** 从 n 往上到 panel（含）之间，有没有哪个祖先「不是选项」 */
  function hasAuxAncestor(n, panel) {
    var node = n;
    while (node && node !== panel.parentNode) {
      var cls = '';
      try { cls = String(node.getAttribute && node.getAttribute('class') || ''); } catch (e) { /* ignore */ }
      if (cls && AUX_RE.test(cls)) return true;
      if (node === panel) break;
      node = node.parentElement;
    }
    return false;
  }

  /**
   * 在候选里挑最匹配 target 的那个。
   * 顺序：完全相等 → 文本以 target 开头（「北京」→「北京市」）→ 包含 target。
   * 同档里取**文本最短**的：地区选择器上「北京」会同时命中「北京市」和「北京周边」，
   * 短的更接近用户本意。
   */
  function pickOption(cands, target) {
    var want = String(target || '').trim();
    if (!want) return null;
    var lower = want.toLowerCase();
    var exact = [], prefix = [], contains = [];
    cands.forEach(function (n) {
      var t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
      var tl = t.toLowerCase();
      if (tl === lower) exact.push({ n: n, len: t.length });
      else if (tl.indexOf(lower) === 0) prefix.push({ n: n, len: t.length });
      else if (tl.indexOf(lower) !== -1) contains.push({ n: n, len: t.length });
    });
    var pool = exact.length ? exact : (prefix.length ? prefix : contains);
    if (!pool.length) return null;
    pool.sort(function (a, b) { return a.len - b.len; });
    return pool[0].n;
  }

  /**
   * 清空一个字段。
   *
   * 为什么必须和「填值」分开，不能拿 fillOne(el, '') 代替：
   * 往**组件**的内部 input 写空字符串，读回是空的、看起来成功了，
   * 但组件自己的状态没变、显示值还在 —— 「清空」会静默失败，
   * 用户看到的就是「点了清空，值还在」。所以组件一律走 clearCustomSelect 那条显式路径。
   */
  async function clearOne(entry) {
    if (!entry) return { ok: false, error: '找不到该字段（页面可能已重绘，重新扫描即可）' };
    var el = entry.el;
    var field = entry.field || {};
    try {
      // 单选/复选组：取消勾选
      if (entry.group) {
        entry.group.forEach(function (n) {
          if (!n.checked) return;
          n.checked = false;
          fire(n, 'input');
          fire(n, 'change');
        });
        return {
          ok: entry.group.every(function (n) { return !n.checked; }),
          via: 'group'
        };
      }
      if (field.tag === 'select') {
        setNativeValue(el, '');
        fire(el, 'change');
        return { ok: !String(el.value || '').trim(), via: 'native-select' };
      }
      if (el.isContentEditable) {
        el.innerHTML = '';
        fire(el, 'input');
        return { ok: !String(el.textContent || '').trim(), via: 'contenteditable' };
      }
      var comp = entry.component || window.__RJ_SCANNER__.componentRootOf(el);
      if (comp) return await clearCustomSelect(el);

      setNativeValue(el, '');
      fire(el, 'input');
      fire(el, 'change');
      return { ok: !String(el.value || '').trim(), via: 'write-empty' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
    }
  }

  function tidy(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /**
   * 从「匹配到的文字」找到「真正该点的元素」。
   *
   * 树形 / 多选型的条目常常长这样：
   *   <div class="area-item-name">
   *     <span class="icon-container"><svg class="…CheckboxUnchecked"></span>
   *     <span class="area-text-label">东城区</span>
   *   </div>
   * 点**文字**是下钻到下一级，点**复选框**才是选中它 —— 实测北森的地区选择器就是这样：
   * 点文字怎么也选不上，点它前面的复选框立刻变成「已选地区 1/99」。
   * 普通下拉的选项没有复选框，自然退回「点文字」，不受影响。
   */
  function resolveClickTarget(leaf) {
    var leafText = tidy(leaf.textContent);
    var node = leaf;
    for (var i = 0; i < 2 && node && node.parentElement; i++) {
      node = node.parentElement;
      // 这一层得「就是个条目」：文字量和叶子差不多。
      // 否则它是个大容器，里面随便一个复选框（比如「全选」）都会被误当成这个选项的。
      if (tidy(node.textContent).length > leafText.length + 20) break;
      var cb = null;
      try {
        cb = node.querySelector('input[type="checkbox"],[role="checkbox"],' +
          '[class*="checkbox"],[class*="Checkbox"]');
      } catch (e) { cb = null; }
      if (cb && isVisible(cb)) return cb;
    }
    return leaf;
  }

  /** 面板底部的「确定 / 确认」—— 多选型组件勾完之后要靠它提交 */
  var CONFIRM_TEXT = /^(确定|确认|完成|确定选择|OK)$/;

  function findConfirm(panels) {
    for (var i = 0; i < panels.length; i++) {
      var all = panels[i].querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var n = all[j];
        if (n.children && n.children.length) continue;
        if (!CONFIRM_TEXT.test(tidy(n.textContent))) continue;
        if (!isVisible(n)) continue;
        // 禁用的「确定」点了没反应
        var cls = '';
        var pcls = '';
        try { cls = String(n.getAttribute('class') || '').toLowerCase(); } catch (e) { /* ignore */ }
        try {
          pcls = String((n.parentElement && n.parentElement.getAttribute('class')) || '').toLowerCase();
        } catch (e) { /* ignore */ }
        if (cls.indexOf('disabled') !== -1 || pcls.indexOf('disabled') !== -1) continue;
        return n;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ 日期选择器

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * 把「像日期的值」拆成年月日。支持简历里常见的几种写法：
   *   2024-09 / 2024/9 / 2024年9月 / 2024.09 / 2024-09-12 / 2024年9月12日
   * 返回 null 表示不是日期，那就走普通下拉那条路。
   * 只认「整串就是日期」，避免把「3年」这种误判成日期。
   */
  function parseDateParts(v) {
    var s = tidy(v);
    var m = s.match(/^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*(?:[-/月.]\s*(\d{1,2})\s*日?)?$/);
    if (!m) return null;
    var y = parseInt(m[1], 10);
    var mo = parseInt(m[2], 10);
    var d = m[3] ? parseInt(m[3], 10) : 0;
    if (y < 1900 || y > 2200) return null;
    if (mo < 1 || mo > 12) return null;
    if (d && (d < 1 || d > 31)) return null;
    return { y: y, m: mo, d: d };
  }

  /** 面板像不像日历（而不是选项列表） */
  function isCalendarPanel(panel) {
    try {
      return !!panel.querySelector(
        '[class*="calendar"],[class*="date-picker"],[class*="datepicker"],[class*="DatePicker"]');
    } catch (e) { return false; }
  }

  /** 日粒度还是月粒度：日期表格有 40 来个格子，月份表格只有 12 个 */
  function panelHasDayCells(panel) {
    try {
      return panel.querySelectorAll('[class*="cell"]').length > 20;
    } catch (e) { return false; }
  }

  /**
   * 核对组件显示值是不是目标日期。
   * 显示格式各库不一（1998-03-12 / 1998年3月12日 / 1998/3/12），
   * 所以按「年份 + 月份（补零或不补零都认）」来判，日粒度再带上日。
   */
  function dateMatches(shown, parts, needsDay) {
    var s = tidy(shown);
    if (!s || s.indexOf(String(parts.y)) === -1) return false;
    var monthOk = s.indexOf(pad2(parts.m)) !== -1 ||
      new RegExp('(^|[^0-9])' + parts.m + '([^0-9]|$)').test(s);
    if (!monthOk) return false;
    if (needsDay && parts.d) {
      var dayOk = s.indexOf(pad2(parts.d)) !== -1 ||
        new RegExp('(^|[^0-9])' + parts.d + '([^0-9]|$)').test(s);
      if (!dayOk) return false;
    }
    return true;
  }

  /** 面板当前显示的是哪一年（从年/年月标题里读） */
  function currentPanelYear(panel) {
    var nodes = panel.querySelectorAll('[class*="year-select"],[class*="ym-select"]');
    for (var i = 0; i < nodes.length; i++) {
      if (!isVisible(nodes[i])) continue;
      var m = tidy(nodes[i].textContent).match(/(\d{4})/);
      if (m) return parseInt(m[1], 10);
    }
    var m2 = tidy(panel.textContent).match(/(\d{4})\s*年/);
    return m2 ? parseInt(m2[1], 10) : null;
  }

  /** 找「上一年 / 下一年」这类翻页按钮（全部候选，按可见性过滤） */
  function findYearArrows(panel, dir) {
    var out = [];
    var nodes = panel.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var cls = '';
      try { cls = String(n.getAttribute('class') || ''); } catch (e) { continue; }
      if (!/year/i.test(cls)) continue;
      if (!new RegExp(dir + '(-|_|$)', 'i').test(cls)) continue;
      if (!/btn|arrow|icon|button/i.test(cls)) continue;
      if (!isVisible(n)) continue;
      out.push(n);
    }
    return out;
  }

  /**
   * 把面板拨到目标年份。
   * 一个年份可能有多个「下一年」按钮（日视图一个、月视图一个，隐藏的那个不可见），
   * 所以依次点候选，**点完看年份有没有真的变**，变了就继续，没变就换下一个。
   */
  async function navigateToYear(panel, year) {
    for (var i = 0; i < 40; i++) {
      var cur = currentPanelYear(panel);
      if (cur === null) return false;
      if (cur === year) return true;
      var cands = findYearArrows(panel, cur < year ? 'next' : 'prev');
      if (!cands.length) return false;
      for (var k = 0; k < cands.length && currentPanelYear(panel) === cur; k++) {
        clickLike(cands[k]);
        await sleep(200);
      }
      if (currentPanelYear(panel) === cur) return false;
    }
    return false;
  }

  function findLeafByText(root, texts) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.children && n.children.length) continue;
      if (!isVisible(n)) continue;
      if (texts.indexOf(tidy(n.textContent)) === -1) continue;
      return n;
    }
    return null;
  }

  /** 日期表格里「本月」的那一格。要排除上下月补进来的同数字格子 */
  function findDayCell(panel, day) {
    var cells = panel.querySelectorAll('[class*="cell"], td');
    for (var i = 0; i < cells.length; i++) {
      var n = cells[i];
      if (n.children && n.children.length) continue;
      if (tidy(n.textContent) !== String(day)) continue;
      if (!isVisible(n)) continue;
      var cls = '';
      try { cls = String(n.getAttribute('class') || ''); } catch (e) { /* ignore */ }
      if (/prev-month|next-month/i.test(cls)) continue;   // 上/下月补位
      if (/disabled/i.test(cls)) continue;
      return n;
    }
    return null;
  }

  function pressEnter(el) {
    ['keydown', 'keypress', 'keyup'].forEach(function (t) {
      el.dispatchEvent(new KeyboardEvent(t, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    });
  }

  /**
   * 日期 / 月份选择器的填充。
   *
   * 日历面板和普通下拉完全不同：里面没有「能按文字点中的选项」，只有
   * 翻页按钮 + 年/月/日格子。所以单开一条路，按可靠性从高到低试：
   *   1. **面板里那个日期输入框** —— AntD / Element / 北森 都会在面板顶部放一个
   *      可以直接输入的框。写值 + 回车最稳，也最不依赖 DOM 细节。
   *   2. **翻到目标年 + 点月（+ 点日）** —— 没有输入框时按「先到年、再到月、再到日」点。
   */
  async function fillDatePanel(panel, parts, read) {
    var dayLevel = panelHasDayCells(panel);

    // ---------- 路 1：面板里的日期输入框 ----------
    var input = null;
    try {
      var inputs = panel.querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        var t = (inputs[i].type || 'text').toLowerCase();
        if ((t === 'text' || t === 'search' || t === '') && isVisible(inputs[i])) {
          input = inputs[i];
          break;
        }
      }
    } catch (e) { input = null; }

    if (input) {
      var text = dayLevel
        ? (parts.y + '-' + pad2(parts.m) + '-' + pad2(parts.d || 1))
        : (parts.y + '-' + pad2(parts.m));
      // 只写 value 不生效：日历靠 input / change / 回车来解析这个框
      setNativeValue(input, text);
      fire(input, 'input');
      fire(input, 'change');
      pressEnter(input);
      await sleep(750);
      if (dateMatches(read(), parts, dayLevel)) {
        return { ok: true, via: 'date-input' };
      }
    }

    // ---------- 路 2：翻年 + 点月（+ 点日）----------
    if (!(await navigateToYear(panel, parts.y))) {
      return { ok: false, error: '日期面板里没能定位到 ' + parts.y + ' 年' };
    }

    var mo = findLeafByText(panel, [parts.m + '月', pad2(parts.m) + '月']);
    if (!mo) return { ok: false, error: '日期面板里没找到「' + parts.m + '月」' };
    clickLike(mo);
    await sleep(650);

    // 月粒度（或值本来就只有年月）到这里就该生效了
    if (!dayLevel || !parts.d) {
      return dateMatches(read(), parts, false)
        ? { ok: true, via: 'date-month-cell' }
        : { ok: false, error: '点了「' + parts.m + '月」但组件显示值没变' };
    }
    if (dateMatches(read(), parts, false)) return { ok: true, via: 'date-month-cell' };

    var day = findDayCell(panel, parts.d);
    if (!day) return { ok: false, error: '日期面板里没找到 ' + parts.d + ' 号' };
    clickLike(day);
    await sleep(650);
    return dateMatches(read(), parts, true)
      ? { ok: true, via: 'date-day-cell' }
      : { ok: false, error: '点了 ' + parts.d + ' 号但组件显示值没变' };
  }

  /**
   * 展开下拉面板，返回「可能是面板」的浮层列表。
   *
   * 为什么要点不止一次、间隔还要拉长（实测踩过）：
   *   - 面板是**开关式**的，已经开着时再点一下是把它关掉；
   *   - 页面上常还开着**别的字段**的面板，第一下点击会被组件拿去关那个；
   *   - 关闭有动画（北森的浮层带 slide-up-leave），**动画期间的点击会被忽略**。
   * 所以策略是：已经开着就直接用；否则点一下、等一等再看，最多三轮。
   */
  /**
   * 控件中心点上「实际位于最上层」的元素 —— 也就是用户真点下去会命中的那个。
   *
   * 为什么需要：组件的点击热区**不是**外层根，而且随状态变。
   * 空的时候热区是内部那个 input；一旦有了值，组件会把 input 换成别的结构，
   * 热区跟着变。只点外层根，在两种状态下表现不一致（实测时灵时不灵）。
   * elementFromPoint 直接把这个问题绕开了 —— 用户点哪就点哪。
   */
  function hotAreaOf(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) return el;
      var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && hit !== el && (el.contains(hit) || hit.contains(el))) return hit;
    } catch (e) { /* ignore */ }
    return el;
  }

  /**
   * 不做任何过滤，直接数 DOM 里「大尺寸的浮层」。
   * 和 floatingPanels / dropdownPanels 分开用，是为了区分两种完全不同的失败：
   *   「面板压根没渲染」 vs 「渲染了但被我的过滤条件筛掉」。
   * 不分开就只能在这两种猜测之间打转（这轮就为它绕了很久）。
   */
  function rawLayerCount() {
    var n = 0;
    try {
      var all = document.querySelectorAll(
        '[class*="unmodeled-layer"],[class*="dropdown"],[class*="popup"],[class*="picker"]');
      for (var i = 0; i < all.length; i++) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 150 && r.height > 120 && isVisible(all[i])) n++;
      }
    } catch (e) { /* ignore */ }
    return n;
  }

  async function openDropdown(trigger) {
    var panels = dropdownPanels(trigger);
    if (panels.length) {
      log('filler.open', { phase: 'already', panels: panels.length });
      return panels;
    }

    var cands = [];

    // 第一优先：组件自己的输入框。
    // 它是组件监听点击的目标，也是「用户会点的地方」—— 实测这一条最可靠。
    // （elementFromPoint 拿到的常常是覆盖在上面的展示节点，未必是热区）
    try {
      var own = trigger.querySelector('input,textarea');
      if (own && isVisible(own)) cands.push(own);
    } catch (e) { /* ignore */ }

    var hot = hotAreaOf(trigger);
    if (hot && hot !== trigger && cands.indexOf(hot) === -1) cands.push(hot);
    if (cands.indexOf(trigger) === -1) cands.push(trigger);

    // 组件内部那个「值区域」也试一下：有值时 input 被换掉，热区常常落在它身上
    try {
      var inner = trigger.querySelector(
        '[class*="inputWrapper"],[class*="__content"],[class*="selection"],[class*="trigger"]');
      if (inner && inner !== trigger && cands.indexOf(inner) === -1) cands.push(inner);
    } catch (e) { /* ignore */ }

    log('filler.open', {
      phase: 'begin',
      trigger: trigger.tagName.toLowerCase() + '.' + String(trigger.getAttribute('class') || '').split(' ')[0],
      candidates: cands.map(function (n) {
        return n.tagName.toLowerCase() + '.' + String(n.getAttribute('class') || '').split(' ')[0];
      })
    });

    // 多轮：第一轮常被「关掉别的字段的面板」或关闭动画吃掉。
    // 每点一下都重新判定，一旦打开就立刻停手 —— 面板是开关式的，多点会把它关回去。
    for (var round = 0; round < 3 && !panels.length; round++) {
      for (var i = 0; i < cands.length && !panels.length; i++) {
        var c = cands[i];
        var rc = c.getBoundingClientRect();
        clickLike(c);

        // 分层采样：面板可能是「慢一拍才挂上来」，也可能「挂上来又立刻被收掉」。
        // 只在一个时间点看一眼，这两种情况都会误判成「没开」。
        var marks = [];
        for (var s = 0; s < 3; s++) {
          await sleep(300);
          marks.push(rawLayerCount());
          panels = dropdownPanels(trigger);
          if (panels.length) break;
        }
        if (!panels.length) await sleep(600);
        if (!panels.length) panels = dropdownPanels(trigger);

        log('filler.open', {
          phase: 'click',
          round: round,
          target: c.tagName.toLowerCase() + '.' + String(c.getAttribute('class') || '').split(' ')[0],
          rect: Math.round(rc.width) + 'x' + Math.round(rc.height) +
            '@' + Math.round(rc.left) + ',' + Math.round(rc.top),
          rawAt300_600_900: marks,
          floatings: floatingPanels().length,
          panels: panels.length
        });
      }
    }
    return panels;
  }

  /**
   * 填自定义下拉：点开 → 在浮层里按文字找选项 → 点它 → 核对组件显示值。
   *
   * 两个坑，都是实测踩出来的：
   *   1. 面板是**开关式**的。它本来就开着时，再点一下是把它**关掉** ——
   *      于是「点开 → 找选项」必然落空（第一版就死在这里：抓到的是页面导航栏）。
   *      所以点之前先看有没有已经开着的面板，开着就直接用。
   *   2. 地区选择器这类是**多级**的（先省后市），一轮点开只解决一级，所以要循环。
   *      循环里若面板还开着，**别再点控件**（那会把它关掉），直接接着找下一级。
   */
  async function fillCustomSelect(el, value) {
    var want = String(value == null ? '' : value).trim();
    if (!want) return clearCustomSelect(el);

    // 全程用**组件根**，而不是 el。
    // 原因：组件一旦选中就重渲染，会把内部那个 input **直接删掉**（实测北森如此），
    // 此时旧的 el 引用已经脱离文档，用它去点、去读全都落空 ——
    // 第一版就栽在这里：值明明填进去了，校验却读到空，于是误报失败。
    // 组件根是稳定的，点击靠它、判值也靠它。
    var info = window.__RJ_SCANNER__.componentRootOf(el);
    var root = (info && info.root) || null;
    var trigger = root || el;
    var read = function () {
      if (root) return String(window.__RJ_SCANNER__.componentDisplayText(root) || '');
      return String(window.__RJ_SCANNER__.getValue(el) || '');
    };

    // 已经是目标值就不要再点 —— 面板是开关式的，再点一次反而会把已选项**取消**
    if (read().indexOf(want) !== -1) {
      return { ok: true, via: 'component-already-set' };
    }

    log('filler.fill', {
      want: want,
      trigger: trigger.tagName.toLowerCase() + '.' + String(trigger.getAttribute('class') || '').split(' ')[0],
      current: read()
    });

    var panels = dropdownPanels(trigger);

    for (var round = 0; round < 3; round++) {
      if (!panels.length) panels = await openDropdown(trigger);

      if (!panels.length) {
        return { ok: false, error: '点开后没有出现选项浮层（可能不是下拉，或组件没响应）' };
      }

      // 日期 / 月份选择器单独走一条路：它的面板里**没有「能按文字点中的选项」**，
      // 只有翻页按钮和年/月/日格子，用普通下拉那套永远找不到。用「值长什么样」来判断。
      var dateParts = parseDateParts(want);
      if (dateParts) {
        var calPanel = null;
        for (var ci = 0; ci < panels.length && !calPanel; ci++) {
          if (isCalendarPanel(panels[ci])) calPanel = panels[ci];
        }
        if (calPanel) {
          var rd = await fillDatePanel(calPanel, dateParts, read);
          return rd.ok ? rd : { ok: false, error: rd.error + '（日期选择器）' };
        }
      }

      var hit = null;
      var seen = 0;
      for (var i = 0; i < panels.length && !hit; i++) {
        var cands = optionCandidates(panels[i]);
        seen += cands.length;
        hit = pickOption(cands, want);
      }
      if (!hit) {
        return {
          ok: false,
          error: '浮层里没有匹配「' + want + '」的选项（共 ' + seen + ' 个候选）'
        };
      }

      clickLike(resolveClickTarget(hit));
      await sleep(700);

      if (read().indexOf(want) !== -1) {
        return { ok: true, via: 'component', rounds: round + 1 };
      }

      // 多选型的组件（地区选择器）勾选完**不会立刻生效**，得再点面板底部的「确定」。
      // 这一步是**终结**的：成了返回，不成也直接判失败 ——
      // 否则下一轮会把同一个选项再点一次，反而把勾选取消掉。
      var confirmBtn = findConfirm(panels);
      if (confirmBtn) {
        clickLike(confirmBtn);
        await sleep(800);
        if (read().indexOf(want) !== -1) {
          return { ok: true, via: 'component+confirm', rounds: round + 1 };
        }
        return { ok: false, error: '已勾选并点了「确定」，但组件显示值仍为空' };
      }

      // 没成：可能是多级选择器，面板已切到下一级 —— 下一轮不再点控件，直接接着找
      panels = dropdownPanels(trigger);
    }
    return { ok: false, error: '点中了选项，但组件显示值仍为空（可能级数更多或组件未响应）' };
  }

  /** 悬停。很多组件库的「清除」图标平时是隐藏的，鼠标移上去才出现 */
  function hoverLike(el) {
    var r = el.getBoundingClientRect();
    var opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2)
    };
    ['mouseover', 'mouseenter', 'mousemove'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, opts));
    });
  }

  /** 在组件里找一个「目前可点」的清除按钮 —— 带 hide 类的是隐藏状态，点了没用 */
  function findVisibleClear(root) {
    var found = null;
    Array.prototype.some.call(root.querySelectorAll('*'), function (n) {
      var c = '';
      try { c = String(n.getAttribute('class') || '').toLowerCase(); } catch (e) { return false; }
      if (c.indexOf('clear') === -1 && c.indexOf('close') === -1) return false;
      if (c.indexOf('hide') !== -1) return false;
      if (!isVisible(n)) return false;
      found = n;
      return true;
    });
    return found;
  }

  /**
   * 找清除按钮，可见的优先，找不到就退到「隐藏但确实是清除图标」的那个。
   *
   * 为什么需要隐藏的这一路：北森自研的 Phoenix 组件库把清除图标写成
   * `phoenix-select__clearIcon` 且**常驻 display:none**，只靠 CSS :hover 显示 ——
   * 而扩展里的合成 mouseover 触发不了 :hover（这条边界在 README 里记着）。
   * 但那个节点其实是活的：直接派发 click 就会走组件自己的清除逻辑，实测有效
   * （工作经历块的「开始时间」就是这么从 2026-07 清回空白的）。
   * 不补这条路，「撤销填写」对日期/下拉就是静默失败 —— 用户看到填进去了却撤不掉。
   *
   * 必须排除 clearfix：那是布局类，页面上遍地都是，认错会点到整块容器。
   */
  function findClearIcon(root) {
    var visible = findVisibleClear(root);
    if (visible) return { el: visible, hidden: false };
    var hidden = null;
    Array.prototype.some.call(root.querySelectorAll('[class*="clear"],[class*="Clear"]'), function (n) {
      var c = '';
      try { c = String(n.getAttribute('class') || ''); } catch (e) { return false; }
      if (/clearfix/i.test(c)) return false;
      if (!/clear(icon|Icon|--|_)/.test(c)) return false;
      hidden = n;
      return true;
    });
    return hidden ? { el: hidden, hidden: true } : null;
  }

  /**
   * 清空自定义下拉。两条路，按顺序试：
   *   1. 组件自己的「清除」图标（要悬停才出现）
   *   2. 多选型组件（地区选择器）**没有清除图标** —— 它靠面板里的「清空已选」+「确定」
   * 全程用组件根，理由同 fillCustomSelect：内部元素会被组件换掉。
   */
  async function clearCustomSelect(el) {
    var info = window.__RJ_SCANNER__.componentRootOf(el);
    var root = (info && info.root) || null;
    var trigger = root || el;
    var read = function () {
      if (root) return String(window.__RJ_SCANNER__.componentDisplayText(root) || '');
      return String(window.__RJ_SCANNER__.getValue(el) || '');
    };

    // 本来就是空的，没什么可清 —— 空字段走「清空」是正常路径，不该报失败
    if (!read().trim()) return { ok: true, via: 'component-already-empty' };
    if (!root) return { ok: false, error: '找不到组件根，无法清空' };

    // 路 1：清除图标（悬停后才出现，挂类名可能还要一帧，所以试两轮）
    for (var attempt = 0; attempt < 2; attempt++) {
      hoverLike(root);
      hoverLike(trigger);
      await sleep(300);
      var hit = findClearIcon(root);
      if (hit) {
        clickLike(hit.el);
        await sleep(500);
        if (!read().trim()) {
          return { ok: true, via: hit.hidden ? 'component-clear-icon' : 'component-clear' };
        }
      }
    }

    // 路 2：「清空已选」+「确定」
    var panels = await openDropdown(trigger);
    if (panels.length) {
      var clearAll = null;
      for (var i = 0; i < panels.length && !clearAll; i++) {
        var all = panels[i].querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
          var n = all[j];
          if (n.children && n.children.length) continue;
          if (!/^(清空已选|清空|清除全部|全部清除|清空全部)$/.test(tidy(n.textContent))) continue;
          if (!isVisible(n)) continue;
          clearAll = n;
          break;
        }
      }
      if (clearAll) {
        clickLike(clearAll);
        await sleep(550);
        var conf = findConfirm(panels);
        if (conf) {
          clickLike(conf);
          await sleep(750);
        }
        if (!read().trim()) return { ok: true, via: 'component-clear-all' };
      }
      // 清不掉也别把面板留在页面上
      try {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch (e) { /* ignore */ }
    }
    return { ok: false, error: '没能清空自定义下拉（既没有清除图标，也没有「清空已选」）' };
  }

  function log(tag, data) {
    if (window.__RJ_LOG__) window.__RJ_LOG__.log(tag, data);
  }

  /** 简历里表示「还在职/在读」的写法 */
  var PRESENT_RE = /^(至今|现在|今|present|now)$/i;

  /**
   * 勾选框到底勾上没有。
   *
   * **别信 input.checked**：phoenix 的 checkbox 用一个 span.phoenix-checkbox__realInput
   * 画外观，真实 input 的 checked 永远是 false（实测三个全是 false，但页面上明明勾着）。
   * 状态只体现在那个 span 的 `--checked` 类上（背景变蓝 rgb(47,84,235)）。
   * 一开始按 input.checked 判断，于是「已经勾上了」被当成「没勾」、勾上了又被报成失败。
   */
  function checkedLike(box) {
    var real = null;
    try { real = box.querySelector('[class*="realInput"]'); } catch (e) { real = null; }
    if (real) return /--checked|__checked/.test(String(real.className || ''));
    var c = '';
    try { c = String(box.className || '').toLowerCase(); } catch (e) { /* ignore */ }
    if (c.indexOf('checked') !== -1) return true;
    var inp = box.querySelector && box.querySelector('input[type=checkbox]');
    return !!(inp && inp.checked);
  }

  /**
   * 勾选「至今」。
   *
   * 结束时间旁边常有一个「至今」勾选框（工作/项目经历在用）。简历里结束时间是
   * 「至今」这种文本 —— 它填不进日期组件，硬填只会报错；正确动作是把旁边的框勾上。
   * 不处理它的后果很具体：工作经历那块会标红「必填」，用户以为扩展填坏了。
   *
   * 认哪个勾选框：从字段元素**由近到远**找最近的、带「至今」文字的勾选框容器。
   * 由近到远是关键 —— 页面上同时有 3 个「至今」（工作块 + 两个项目块），
   * 从文档里找必然认错块。
   */
  /** 找到与字段同一行、右侧最近的那个「至今」勾选框（找不到给 null） */
  function presentBoxNear(el) {
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { return null; }
    if (!r || (!r.width && !r.height)) return null;

    // 为什么按**屏幕位置**认，而不是按 DOM 层级找：
    // 北森的日期组件把 input 渲染在 phoenix-unmodeled-layer 这个浮层容器里，
    // 而「至今」勾选框在另一个子树（fields-col）—— 从 el 往上爬永远爬不到它。
    // 实测就是这么报「字段旁边没找到至今勾选框」的。
    // 同一行的两个东西，用垂直中心 + 水平距离配对最稳。
    var spans = document.querySelectorAll('[class*="checkbox__text"],[class*="checkbox-text"]');
    var best = null;
    var bestDx = 1e9;
    for (var i = 0; i < spans.length; i++) {
      if (!/^(至今|现在)$/.test(tidy(spans[i].textContent))) continue;
      var sr = null;
      try { sr = spans[i].getBoundingClientRect(); } catch (e) { continue; }
      if (!sr || (!sr.width && !sr.height)) continue;
      var dy = Math.abs((sr.top + sr.height / 2) - (r.top + r.height / 2));
      if (dy > 60) continue;                 // 不是同一行，是别的块
      if (sr.left < r.left) continue;        // 在左边，说明不是这个字段的
      var dx = sr.left - r.left;
      if (dx < bestDx) { bestDx = dx; best = spans[i]; }
    }
    if (!best) return null;

    // 注意别用 closest('[class*="checkbox"]')：文字节点自己的类名就是
    // phoenix-checkbox__text，closest 会返回它**自己**，点了个寂寞（实测点三次都没勾上）。
    return checkboxBoxOf(best);
  }

  function markPresent(el) {
    var box = presentBoxNear(el);
    if (!box) return false;
    if (checkedLike(box)) return true;       // 已经勾着了，别再点（再点就取消了）
    clickLike(box);
    return true;
  }

  /** 点完再确认一次：组件是受控的，类名要等一帧才更新 */
  function presentChecked(el) {
    var box = presentBoxNear(el);
    return box ? checkedLike(box) : false;
  }

  /** 从「文字节点」找到它所在的勾选框根（跳过文字节点自己） */
  function checkboxBoxOf(textNode) {
    var p = textNode.parentElement;
    for (var d = 0; d < 3 && p; d++) {
      var c = '';
      try { c = String(p.className || ''); } catch (e) { c = ''; }
      if (/checkbox/i.test(c) && !/__text|__label|checkbox-text/i.test(c)) return p;
      p = p.parentElement;
    }
    return textNode.parentElement;
  }

  async function fillOne(item) {
    var entry = window.__RJ_SCANNER__.getEntry(item.id);
    if (!entry) {
      log('filler.miss', { id: item.id, label: item.label, reason: '注册表里找不到该元素' });
      return { id: item.id, ok: false, error: '元素已失效，请重新扫描' };
    }

    // 「至今」不是日期值，走勾选框，不走日期组件
    if (PRESENT_RE.test(String(item.value == null ? '' : item.value).trim())) {
      var el0 = entry.el || (entry.group && entry.group[0]);
      var found = el0 ? markPresent(el0) : false;
      await sleep(400);
      var on = el0 ? presentChecked(el0) : false;   // 点完必须复查，不能「点了就当成功」
      log('filler.present', { label: item.label, found: found, checked: on });
      if (on) return { id: item.id, ok: true, via: 'present-checkbox' };
      return {
        id: item.id, ok: false,
        error: found ? '点了「至今」勾选框，但状态没变' : '字段旁边没找到「至今」勾选框'
      };
    }

    try {
      if (entry.kind === 'group') {
        var g = await fillGroup(entry.group, item.value);
        return Object.assign({ id: item.id }, g);
      }
      var field = entry.field;
      var el = entry.el;
      var r;
      if (field.tag === 'select') r = fillSelect(el, item.value);
      else if (el.isContentEditable) r = fillContentEditable(el, item.value);
      // 没有原生输入框的（组件根，如「已填好的地区选择器」内部已经没 input 了）
      // 不能走直写 —— 那是往 div 上套 input 的 setter，只会抛错
      else if (isFormControl(el)) r = fillTextLike(el, item.value);
      else r = { ok: false, error: '该字段是自定义组件，内部没有原生输入框' };
      await sleep(10);

      // 直接写值失败时，如果这个控件外面套着组件库的下拉，就走「点开浮层选」。
      // 为什么放在失败之后而不是之前：能直接写成功的（普通输入框、原生 select）
      // 就别绕远路；只有当组件把值丢掉了，才值得去模拟点击。
      if (!r.ok) {
        var comp = entry.component || window.__RJ_SCANNER__.componentRootOf(el);
        if (comp) {
          var rc = await fillCustomSelect(el, item.value);
          if (rc.ok) {
            r = rc;
          } else {
            r = { ok: false, error: rc.error + '；该字段是自定义下拉组件' };
          }
        }
      }

      if (!r.ok) {
        log('filler.fail', {
          id: item.id, label: item.label, path: item.path,
          type: field.tag + '/' + field.type,
          selector: field.selector, error: r.error || '写入后读回为空'
        });
      }
      return Object.assign({ id: item.id }, r);
    } catch (e) {
      log('filler.error', {
        id: item.id, label: item.label, path: item.path,
        selector: entry.field && entry.field.selector,
        error: String((e && e.message) || e)
      });
      return { id: item.id, ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * 点一次「+ 添加」，给重复块加一行。
   *
   * 这里刻意**不判断有没有加成功**：按钮点了可能没反应、可能展开的是弹层而不是新行、
   * 也可能新行要 1 秒后才渲染出来。判断「到底多没多一行」只能靠重扫数锚点，
   * 那是 main.js 的事。这里只把「点了什么」带回去，好让日志能区分
   * 「没找到按钮」和「点了一个没用的按钮」。
   */
  async function addBlockRow(anchorId, blockType) {
    var SCAN = window.__RJ_SCANNER__;
    var entry = anchorId ? SCAN.getEntry(anchorId) : null;
    var el = entry ? (entry.el || (entry.group && entry.group[0])) : null;

    var trigger = SCAN.findAddTrigger(el, blockType);
    if (!trigger) {
      return { ok: false, error: '页面上没找到「添加」按钮（这个站的写法不在已知套路里）' };
    }

    var text = (trigger.textContent || trigger.value ||
      (trigger.getAttribute && trigger.getAttribute('aria-label')) || '').trim();
    clickLike(trigger);
    await sleep(500);
    log('filler.addBlock', { block: blockType, trigger: String(text).slice(0, 20) });
    return { ok: true, via: 'add-button', trigger: String(text).slice(0, 20) };
  }

  window.__RJ_FILLER__ = {
    fillOne: fillOne,
    clearOne: clearOne,
    addBlockRow: addBlockRow,
    sleep: sleep,
    setNativeValue: setNativeValue,
    // 自定义下拉这条路单独暴露出来，方便诊断「点不开 / 找不到选项」卡在哪一步
    fillCustomSelect: fillCustomSelect,
    clearCustomSelect: clearCustomSelect,
    clickLike: clickLike,
    floatingPanels: floatingPanels,
    dropdownPanels: dropdownPanels,
    optionCandidates: optionCandidates,
    pickOption: pickOption
  };
})();
