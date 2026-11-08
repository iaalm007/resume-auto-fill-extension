/**
 * 感知层：扫描页面可填控件，为每个字段抽取「特征包」。
 * 特征包 = 定位信息(selector) + 语义线索(label/placeholder/name/id/autocomplete) + 控件元信息(type/options/required)
 */
(function () {
  if (window.__RJ_SCANNER__) return;

  var FILLABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  var SKIP_INPUT_TYPES = {
    hidden: 1, submit: 1, button: 1, reset: 1, image: 1, file: 1, password: 1
  };

  var registry = new Map();
  var seq = 0;
  var MAX_INPUTS = 400;

  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  /** 去掉「必填星号」这类纯装饰，否则会得到「*姓名」这种不好看的假标签 */
  function tidyLabel(s) {
    return cleanText(String(s == null ? '' : s)
      .replace(/^[*＊※·•\s]+/g, '')
      .replace(/[*＊※\s]+$/g, ''));
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    var style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function isFillable(el) {
    if (!el || !el.tagName) return false;
    if (el.disabled) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      if (SKIP_INPUT_TYPES[t]) return false;
    } else if (tag === 'textarea' || tag === 'select') {
      if (el.readOnly) return false;
    } else if (!el.isContentEditable) {
      return false;
    }
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return isVisible(el);
  }

  var LABEL_MAX = 30;
  var CONTROL_SELECTOR = 'input,select,textarea,[contenteditable]';

  /**
   * 判断一个节点是否「像标签」而不是「相邻字段的容器」。
   * 关键是那条 querySelector 守卫：如果里面还有别的控件，说明它是另一个字段的框，
   * 把它当标签就会张冠李戴（比如把「姓名」当成「电话」的标签）。
   */
  /** 至少要有一个真正的字，否则是「*」「：」「—」这类装饰 */
  function hasRealChar(t) {
    return /[\u4e00-\u9fa5A-Za-z0-9]/.test(t);
  }

  /**
   * 校验提示 / 填写说明不是字段名。
   * 「此项必填」「格式不正确」「最多 200 字」这类文字就贴在输入框旁边，
   * 取邻近文本时极易被当成标签；更麻烦的是它们会随校验状态出现/消失，
   * 顺带把字段指纹也搞得不稳定（缓存跟着失效）。
   */
  function isNoiseLabel(t) {
    if (/^(请|此项|该项|此字段|该字段|必填|选填|格式|输入|最多|最少|至少|不超过|示例|例[:：])/.test(t)) return true;
    return t.length <= 10 && /(必填|选填|不能为空|格式不正确|不合法|最多|最少|至少|示例)/.test(t);
  }

  /**
   * 只取节点「自己的」文字 —— 直接子文本节点，不要后代元素的文字。
   *
   * 为什么这么讲究：容器里往往还塞着别的东西，最典型的是校验提示
   * （`.fi > .ctl > .err-tip「此项必填」`）。整块读 textContent 的话，
   * 一个没有标签的输入框会被标成「此项必填」，而带标签的会变成
   * 「身份证号此项必填」这种拼接串 —— 前者是错标签，后者过不了噪声过滤，
   * 两种都会让字段指纹跟着校验状态变来变去，AI 缓存全部失效。
   */
  function ownText(node) {
    var parts = [];
    Array.prototype.forEach.call(node.childNodes || [], function (n) {
      if (n.nodeType === 3) parts.push(n.nodeValue);   // 3 = TEXT_NODE
    });
    return cleanText(parts.join(' '));
  }

  /**
   * 看起来像「已经填好的值」而不是字段名：日期、纯数字、字数比、邮箱、手机号。
   * 自定义组件会把当前选中值渲染成纯文本，上爬时极易被当成标签
   *（实测：「出生日期」被读成「2002-02-01」、「起止时间」被读成「2024-09」）。
   */
  function looksLikeValue(t) {
    if (/^\d{4}\s*[-/年.]\s*\d{1,2}(([-/月.])\s*\d{1,2}日?)?$/.test(t)) return true;  // 2024-09 / 2002-02-01
    if (/^\d+\s*\/\s*\d+\s*字?$/.test(t)) return true;                                 // 0/2000 字数统计
    if (/^[\d\s\-+/:：._]+$/.test(t)) return true;                                     // 纯数字与符号
    if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return true;                              // 邮箱
    if (/^1[3-9]\d{9}$/.test(t)) return true;                                          // 手机号
    return false;
  }

  /**
   * 自定义复杂组件（下拉 / 日期选择 / 级联 / 上传…）的内部结构。
   *
   * 这些组件会把「当前选中值」渲染成自己内部的兄弟节点，于是上爬找标签时
   * 会把**组件自己的值**当成字段名。实测北森的表单：
   *   学历   -> 「硕士研究生」
   *   出生日期 -> 「2002-02-01」
   *   手机号 -> 「中国大陆」（被国家码组件带偏）
   * 所以组件内部只上爬、不取兄弟，必须爬到「表单条目」那一层才认标签。
   */
  var WIDGET_CLASS = /(^|[-_])(select|picker|dropdown|cascader|autocomplete|combobox|input|textarea|upload|checkbox|radio|switch|slider|tag|stepper)([-_]|$)/i;

  function isWidgetPart(node) {
    var c = (node.getAttribute && node.getAttribute('class')) || '';
    return c ? WIDGET_CLASS.test(String(c)) : false;
  }

  function labelTextOf(node) {
    if (!node || node.nodeType !== 1) return '';
    var tag = (node.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'iframe' ||
        tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') return '';
    if (node.querySelector && node.querySelector(CONTROL_SELECTOR)) return '';
    var t = cleanText(node.textContent);
    if (!t || t.length > LABEL_MAX) return '';
    if (!hasRealChar(t) || isNoiseLabel(t) || looksLikeValue(t)) return '';
    return t;
  }

  /**
   * 逐层向上爬，在「每一级祖先的前一个兄弟」里找标签。
   *
   * 为什么必须爬层：真实站点的 label 往往不是 input 自己的兄弟，而是它「包裹层」的兄弟：
   *   <div class="form-item">                       ← Ant Design / Element UI 都是这个形状
   *     <label>姓名</label>                          ← 和 .control 同级，和 input 隔了两层
   *     <div class="control"><div class="inner"><input placeholder="请输入"></div></div>
   *   </div>
   * 只看 input.previousElementSibling 必然落空，于是退化成 placeholder「请输入」。
   */
  function labelFromAncestors(el, maxDepth, maxControls) {
    // 允许 3 个控件：一个表单条目里合法地存在多个控件
    //（典型是「国家码 + 手机号」并排），但整块表单的控件远多于这个数。
    if (maxControls == null) maxControls = 3;
    var node = el;
    for (var depth = 0; node && depth <= maxDepth; depth++) {
      // 爬到「包含多个控件」的容器就停：那一层已经不属于这个字段自己了，
      // 它的前兄弟是章节标题、页头之类的东西，不是标签。
      // 实测不设这道闸，一个没有标签的输入框会被标成页面的 <h1>「投递申请」。
      // 单选/复选组是例外（它们本来就横跨多个控件），用 maxControls=Infinity 放行。
      if (depth > 0) {
        var inner = node.querySelectorAll ? node.querySelectorAll(CONTROL_SELECTOR) : [];
        if (inner.length > maxControls) break;
      }

      // 还在自定义组件内部时，兄弟是组件自己的一部分（比如它显示的当前值），不能当标签。
      // 只上爬、不取兄弟，爬到表单条目那一层才认。
      if (!(depth > 0 && isWidgetPart(node))) {
        var prev = node.previousElementSibling;
        while (prev) {
          var t = labelTextOf(prev);
          if (t) return { text: t, source: 'sibling(d' + depth + ')' };
          // 只有 input 自己那一层才允许回看多个兄弟（<span>*</span><span>姓名</span><input>）。
          // 爬到包裹层之后如果继续回看，就会一路走回文档开头，
          // 把页面上任意一段前文的短文本当成标签（实测会误抓到几十个元素外的 label）。
          if (depth > 0) break;
          prev = prev.previousElementSibling;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  /** 祖先容器自身文本：剥掉里面的控件后剩下的（覆盖 <div>姓名<input></div> 这类写法） */
  function labelFromContainer(el, maxDepth) {
    var node = el.parentElement;
    for (var d = 0; node && d <= maxDepth; d++) {
      var tag = (node.tagName || '').toLowerCase();
      if (tag === 'body' || tag === 'html') break;

      // 和「上爬找前兄弟」那条路一样，容器里出现别的控件就停：
      // 说明这里已经不是这个字段自己的框了，里面的文字是**别的字段的标签**。
      // 不设这道闸，一个没有标签的输入框会一路爬到整块表单，
      // 把表单里第一个字段的标签认成自己的 —— 实测三个无标签字段全被标成了「姓名」，
      // 指纹还完全相同，于是模型的同一个答案被套到所有字段上。
      if (d > 0) {
        var inner = node.querySelectorAll ? node.querySelectorAll(CONTROL_SELECTOR) : [];
        if (inner.length > 3) break;
      }

      // 只认这一层自己的文字（<div>姓名<input></div>），后代元素里的字不算 ——
      // 校验提示、字数统计这些都藏在后代元素里，读进来就成假标签了
      var t = ownText(node);
      if (t && t.length <= LABEL_MAX && hasRealChar(t) &&
          !isNoiseLabel(t) && !looksLikeValue(t)) {
        return { text: t, source: 'container(d' + d + ')' };
      }
      node = node.parentElement;
    }
    return null;
  }

  /** 显式语义线索：aria-label / aria-labelledby / label[for] / 包裹式 label */
  function explicitLabel(el) {
    var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (cleanText(ariaLabel)) return { text: cleanText(ariaLabel), source: 'aria-label' };

    var labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      var t = labelledby.split(/\s+/).map(function (id) {
        var n = document.getElementById(id);
        return n ? n.textContent : '';
      }).join(' ');
      if (cleanText(t)) return { text: cleanText(t), source: 'aria-labelledby' };
    }

    if (el.id) {
      try {
        var byFor = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
        if (byFor && cleanText(byFor.textContent)) {
          return { text: cleanText(byFor.textContent), source: 'label[for]' };
        }
      } catch (e) { /* ignore */ }
    }

    var wrap = el.closest ? el.closest('label') : null;
    if (wrap) {
      var clone = wrap.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('input,textarea,select,button'), function (n) { n.remove(); });
      var wt = cleanText(clone.textContent);
      if (wt) return { text: wt, source: 'wrap-label' };
    }
    return null;
  }

  /** label 推断：多级兜底；同时回传「文本来自哪一级」，诊断和弹窗都要用 */
  function resolveLabel(el) {
    var r = resolveLabelRaw(el);
    r.text = tidyLabel(r.text);
    return r;
  }

  function resolveLabelRaw(el) {
    var hit = explicitLabel(el);
    if (hit) return hit;

    // 深度给到 8：复杂组件库（北森 Phoenix、AntD 的 Select 等）在
    // 真实输入框和「表单条目」之间会夹好几层包装（input > li > ul > .select > .layer > .form-item__control），
    // 4 层根本够不着真正写着标签的那一层。
    // 敢给这么深，是因为上面那两道闸（多控件就停、组件内部不取兄弟）已经把过度推断挡住了。
    var bySib = labelFromAncestors(el, 8);
    if (bySib) return bySib;

    var byBox = labelFromContainer(el, 5);
    if (byBox) return byBox;

    var ph = cleanText(el.getAttribute && el.getAttribute('placeholder'));
    return { text: ph, source: ph ? 'placeholder' : 'none' };
  }

  function getLabel(el) {
    return resolveLabel(el).text;
  }

  /**
   * 单选/复选的「选项文本」。
   * 这条路**不能**往上爬祖先的兄弟节点 —— 那只会抓到整组的问题文本（如「性别」）
   * 或上一个选项（如给「女」标成「男」）。只在自己所在的那一层容器里找。
   */
  function resolveOptionLabel(el) {
    var hit = explicitLabel(el);
    if (hit) return hit;

    var p = el.parentElement;
    if (p) {
      var controls = p.querySelectorAll ? p.querySelectorAll(CONTROL_SELECTOR) : [];
      // 容器里只有它这一个控件，才说明「这个容器 = 这个选项自己的框」
      if (controls.length === 1) {
        var clone = p.cloneNode(true);
        Array.prototype.forEach.call(clone.querySelectorAll('input,select,textarea,button'), function (n) { n.remove(); });
        var t = cleanText(clone.textContent);
        if (t && t.length <= LABEL_MAX) return { text: t, source: 'option-box' };
      }
    }
    var v = cleanText(el.value);
    return { text: v, source: v ? 'value' : 'none' };
  }

  function getOptionLabel(el) {
    return resolveOptionLabel(el).text;
  }

  /**
   * 诊断用：把一个控件「周边语境」打成人能读的几行。
   *
   * 为什么必须带上祖先：标签通常根本不长在 input 身上，而在外面某一层的前一个兄弟里。
   * 只 dump input 自己的 outerHTML，看到的就是 `<input placeholder="请输入">`，
   * 完全推不出标签为什么没找到。这里把每一级祖先及其前兄弟文本列出来，
   * 一眼就能看出是「压根没有标签」还是「有标签但被某一级规则拒了」。
   */
  /**
   * 取节点里「安全」的可读文本：先剥掉所有控件再读。
   *
   * 为什么不能用 textContent 直接读：骨架是要发给模型的。
   *   - <textarea> 的文本内容**就是用户输入的值**，clone.textContent 会把用户打的字原样带出去；
   *   - 控件自身（input/select/textarea）一律返回空串，因为它们的「文本」不是标签而是内容。
   * 骨架只需要标签和结构，这些内容对它毫无用处，但对隐私是致命的。
   */
  function safeText(node) {
    if (!node || node.nodeType !== 1) return '';
    var tag = (node.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return '';
    var clone = node.cloneNode(true);
    Array.prototype.forEach.call(
      clone.querySelectorAll('input,textarea,select,button,[contenteditable]'),
      function (x) { x.remove(); }
    );
    return cleanText(clone.textContent);
  }

  function describeContext(el) {
    var lines = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var tag = (node.tagName || '').toLowerCase();
      if (tag === 'body' || tag === 'html') break;

      var cls = '';
      try {
        var c = node.getAttribute && node.getAttribute('class');
        if (c) cls = '.' + cleanText(c).split(' ').slice(0, 3).join('.');
      } catch (e) { /* ignore */ }

      var prevs = [];
      var prev = node.previousElementSibling;
      var n = 0;
      while (prev && n < 3) {
        var pt = safeText(prev);   // 不能用 textContent：兄弟里若含 textarea 会带出用户输入
        prevs.push((prev.tagName || '').toLowerCase() + '=' + JSON.stringify(pt.slice(0, 40)) +
          (pt.length > LABEL_MAX ? '(过长)' : '') +
          (prev.querySelector && prev.querySelector(CONTROL_SELECTOR) ? '(含控件)' : ''));
        prev = prev.previousElementSibling;
        n++;
      }

      // 自身文本 = 这一层剥掉所有控件后剩下的字。
      // <div>姓名<input></div> 这类结构只有这里才有线索，光看前兄弟是空手而归。
      var own = safeText(node);

      lines.push('第' + depth + '层 <' + tag + cls + '>' +
        ' 前兄弟[' + (prevs.length ? prevs.join(' | ') : '无') + ']' +
        (own ? ' 自身文本="' + own.slice(0, 40) + '"' : ''));
      node = node.parentElement;
      depth++;
    }
    return lines;
  }

  /**
   * 单选/复选组的「问题」标签。
   * 注意：不能直接取父节点文本——<label><input>男</label> 的父节点文本是选项本身（"男"）。
   * 需要向上爬，并在每一层先剥离所有控件及其包裹 label，直到剩下「问题文本」。
   */
  function getGroupLabel(group) {
    return tidyLabel(getGroupLabelRaw(group));
  }

  function getGroupLabelRaw(group) {
    var first = group[0];

    var fs = first.closest ? first.closest('fieldset') : null;
    if (fs) {
      var legend = fs.querySelector('legend');
      if (legend && cleanText(legend.textContent)) return cleanText(legend.textContent);
    }

    // 1) 和普通字段共用一套逻辑：逐层向上找「祖先的前一个兄弟」里的短文本。
    //    之所以能安全复用，是因为 labelTextOf 会跳过「里面还有控件」的节点，
    //    因此不会把相邻选项 <label><input>女</label> 误当成问题文本。
    //    这里不能写死跳过 <label> 标签 —— Ant Design 的问题文本恰恰就在 <label> 里。
    //    maxControls 传 Infinity：整组选项本来就在同一个容器里，不能按「多控件就停」处理。
    var bySib = labelFromAncestors(first, 8, Infinity);
    if (bySib) return bySib.text;

    // 2) 退路：从「整组选项的容器」往上爬，逐层剥离选项后看剩下什么文本。
    //    起点不能是 first.parentElement —— 那一层往往是「选项自己的框」
    //    （如 <label><input>是</label>），剥掉 input 后剩下的就是选项名「是」，
    //    会被当成问题文本，导致该组被误标，并让所有「选项相同」的组指纹撞在一起。
    var node = groupContainer(first, group);
    var depth = 0;
    while (node && depth < 5) {
      var clone = node.cloneNode(true);
      // 先整块删掉「里面含控件的 label」—— 那就是一个个选项
      Array.prototype.forEach.call(clone.querySelectorAll('label'), function (lab) {
        if (lab.querySelector('input,select,textarea,button')) lab.remove();
      });
      Array.prototype.forEach.call(clone.querySelectorAll('input,select,textarea,button'), function (n) {
        n.remove();
      });
      var t = cleanText(clone.textContent);
      if (t && t.length <= 24) return t;
      node = node.parentElement;
      depth++;
    }
    return '';
  }

  /** 「整组选项的容器」：第一个包住组里全部控件的祖先（找不到就退回父节点） */
  function groupContainer(first, group) {
    if (!group || group.length < 2) return first.parentElement;
    var node = first.parentElement;
    while (node) {
      var inner = node.querySelectorAll ? node.querySelectorAll('input,select,textarea') : [];
      if (inner.length >= group.length) return node;
      node = node.parentElement;
    }
    return first.parentElement;
  }

  /** 生成尽量稳定的定位选择器（仅作为 id 失效后的兜底） */
  function buildSelector(el) {
    if (el.id) {
      var byId = '#' + CSS.escape(el.id);
      try {
        if (document.querySelectorAll(byId).length === 1) return byId;
      } catch (e) { /* ignore */ }
    }
    var name = el.getAttribute && el.getAttribute('name');
    if (name) {
      var sel = el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\"') + '"]';
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) { /* ignore */ }
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  /**
   * 找出「包裹这个 input 的自定义组件根」。
   *
   * 为什么需要它：组件库的下拉（Element 的 el-select、AntD 的 ant-select、
   * 北森的 phoenix-select…）内部都放着一个真 input，但**往这个 input 写值是无效的** ——
   * 值归组件自己的状态管，组件会把我们写进去的值直接丢掉（实测北森就是这样：
   * 写入后读回为空）。要填它只能模拟点击、在弹出的浮层里选。
   *
   * 判定只认「类名 / role 像选择器」的容器，普通表单容器（form-item）不算 ——
   * 否则会把普通输入框误判成组件，白白绕远路。
   * 取**最外层**的匹配者：内层（如 phoenix-select__inputWrapper）不含显示值，
   * 组件根才既能点、又能读出「用户看到的值」。
   */
  function componentRootOf(el) {
    var node = el;
    var best = null;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      var role = '';
      var cls = '';
      try {
        role = String(node.getAttribute && node.getAttribute('role') || '');
        cls = String(node.getAttribute && node.getAttribute('class') || '');
      } catch (e) { /* ignore */ }

      var matches = role === 'combobox' ||
        /(^|[-_ ])(select|picker|cascader|dropdown)/i.test(cls) ||
        /__(select|picker)|--(select|picker)/i.test(cls);

      if (matches) {
        best = {
          root: node,
          kind: /picker/i.test(cls) || role === 'combobox' ? 'picker' : 'select'
        };
      } else if (best) {
        // 一旦断开就不再往上找了 —— 再往上会爬到整个表单容器上
        break;
      }
      node = node.parentElement;
      depth++;
    }
    return best;
  }

  /** 元素自己是不是「显示着」的：隐藏/不占位的辅助节点不算 */
  function isShown(n) {
    if (!n || n.nodeType !== 1) return true;
    var s;
    try { s = getComputedStyle(n); } catch (e) { return true; }
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    return true;
  }

  /**
   * 读「组件显示出来的值」。
   *
   * 下拉选中后，值在组件自己的状态里，`input.value` 往往**还是空的** ——
   * 直接拿 input.value 判断「有没有填上」会一律判成没填上。
   *
   * 所以从组件根取文本，并且**只取「显示着」的节点**，剥掉三类不是值的东西：
   *   - placeholder（「请选择」这类提示。类名大小写各库不一，统一小写后匹配）
   *   - 内部的 input / textarea（它们的 value 不是展示值）
   *   - **隐藏的辅助节点**：组件库常放一个 visibility:hidden 的元素来量文字宽度，
   *     里面是同一份文本。不排除它的话读出来就是「3年3年」（实测就是这么翻车的）
   */
  function componentDisplayText(root) {
    if (!root || root.nodeType !== 1) return '';
    var out = [];

    function walk(n) {
      var tag = (n.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' ||
          tag === 'script' || tag === 'style') return;

      var cls = '';
      try { cls = String(n.getAttribute && n.getAttribute('class') || '').toLowerCase(); } catch (e) { /* ignore */ }
      if (cls.indexOf('placeholder') !== -1) return;
      if (!isShown(n)) return;

      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.nodeType === 3) out.push(c.nodeValue);
        else if (c.nodeType === 1) walk(c);
      }
    }

    walk(root);
    return cleanText(out.join(' '));
  }

  function getValue(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      var o = el.selectedOptions && el.selectedOptions[0];
      return o ? (o.value || '') : '';
    }
    if (el.isContentEditable) return cleanText(el.textContent);
    // 自定义组件：优先信「组件显示出来的文本」。取不到才退回 input.value
    var comp = componentRootOf(el);
    if (comp) {
      var disp = componentDisplayText(comp.root);
      if (disp) return disp;
    }
    return el.value || '';
  }

  /**
   * 字段指纹：AI 映射结果的缓存键。
   * 刻意**不包含** DOM 的 id / name —— 那些各站各写（比如 input-1234），
   * 带上就永远命不中缓存了。用 label + placeholder + 类型 + 候选项，
   * 这样「姓名」这种字段在所有网站之间可以共用一条缓存。
   */
  function fingerprint(parts) {
    var raw = parts.filter(Boolean).join('|').toLowerCase().replace(/\s+/g, '');
    var h = 5381;
    for (var i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
    return 'fp_' + h.toString(36);
  }

  /** 标签只是 placeholder 兜底时，它是一段没有信息量的文本（「请输入」），不可信 */
  function isWeakLabel(source) {
    return source === 'placeholder' || source === 'none';
  }

  /**
   * 结构签名：只由「标签名 + 类名 + 同级序号」拼成，**刻意不含 id / name**。
   *
   * 用途是给「标签不可信」的字段做缓存键的区分度。为什么不用 id：
   * 招聘站上的 id 常是自动生成的（`input-1234`、`el-id-8f2`），每次渲染都变，
   * 掺进缓存键就永远命不中，等于白花 token 反复问。
   */
  /**
   * 会随交互状态变化的 class（聚焦 / 校验 / 已填写 / 展开 …）。
   * 它们绝不能进结构签名：用户一聚焦、一填写，签名就变，指纹跟着变，
   * AI 缓存就永远命不中 —— 每次扫描都白问一次模型，配额很快见底。
   * （AntD / Element UI 这类框架恰恰最爱往元素上加减状态类。）
   */
  var VOLATILE_CLASS = /(focus|hover|activ|error|invalid|valid|check|select|open|clos|disabl|loading|fill|empty|touch|dirty|enter|leave|expand|collaps|hidden|show|visib|warn|success|fail|current|animat|transition|value)/i;

  function stableClasses(node) {
    try {
      var c = node.getAttribute && node.getAttribute('class');
      if (!c) return '';
      return cleanText(c).split(' ')
        .filter(function (x) { return x && !VOLATILE_CLASS.test(x); })
        .slice(0, 2)
        .join('.');
    } catch (e) { return ''; }
  }

  function structuralSignature(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var tag = (node.tagName || '').toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      var cls = '';
      var sc = stableClasses(node);
      if (sc) cls = '.' + sc;
      var seg = tag + cls;
      var parent = node.parentElement;
      if (parent) {
        // 一律带上序号。只在「有多个同类兄弟」时才加的话，页面上任何一处新增元素
        // 都会让原本唯一的那个元素突然长出 :nth(1)（实测：插一条校验提示就会让
        // 上一个字段的签名变化），签名一变缓存就失效。永远带上，位置没挪签名就不变。
        var sameTag = Array.prototype.filter.call(parent.children, function (x) {
          return x.tagName === node.tagName;
        });
        seg += ':nth(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent;
      depth++;
    }
    return parts.join('>');
  }

  /**
   * 字段指纹 = AI 映射结果的缓存键。
   * 标签可信时只用「标签 + placeholder + 类型 + 候选项」，这样「姓名」这类字段
   * 可以在所有网站之间共用一条缓存。
   *
   * 但标签不可信时**必须**掺入结构签名：那种情况下页面上所有未识别字段的标签都是
   * 「请输入」，算出来的指纹完全一样 —— 而 ai-map.js 是直接拿指纹当缓存键的，
   * 于是第一个字段问完模型，答案会被套到其余所有字段上（正确的手机号被填成姓名）。
   */
  function buildFingerprint(labelText, labelSource, placeholder, type, optionsText, el) {
    return fingerprint([
      labelText, placeholder, type, optionsText,
      // 弱标签必须带上「站点 + 结构签名」：
      //   带结构 —— 区分同页的不同字段（否则标签都是「请输入」，指纹全一样）；
      //   带站点 —— 两个网站用同一套 UI 框架时 class 名和层级会完全相同，
      //             不带站点就会把 A 站的判断套到 B 站上。
      isWeakLabel(labelSource) ? pageOrigin() + '#' + structuralSignature(el) : ''
    ]);
  }

  function pageOrigin() {
    try { return String(location.origin || ''); } catch (e) { return ''; }
  }

  /** 说明一个候选控件为什么被跳过 —— 真实站点上「没扫到」多半卡在这里 */
  function rejectReason(el) {
    if (el.disabled) return 'disabled';
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      if (SKIP_INPUT_TYPES[t]) return 'type=' + t;
    }
    if (el.readOnly) return 'readonly';
    if (el.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    if (!isVisible(el)) return 'not-visible';
    return 'unknown';
  }

  function collect(root, out, stats) {
    if (!root || out.length >= MAX_INPUTS) return;
    Array.prototype.forEach.call(root.querySelectorAll(FILLABLE_SELECTOR), function (el) {
      stats.seen++;
      if (out.length < MAX_INPUTS && isFillable(el)) {
        out.push(el);
      } else {
        stats.rejected++;
        if (stats.reasons.length < 25) {
          var label = '';
          try { label = getLabel(el) || ''; } catch (e) { label = ''; }
          stats.reasons.push(
            (label || '(无名)').slice(0, 30) +
            ' [' + (el.type || el.tagName.toLowerCase()) + '] <- ' + rejectReason(el)
          );
        }
      }
    });
    // 穿透同源 iframe（跨源 iframe 需要 all_frames，见 README 的 TODO）
    Array.prototype.forEach.call(root.querySelectorAll('iframe'), function (frame) {
      try {
        var inner = frame.contentDocument;
        if (inner && inner.body) collect(inner.body, out, stats);
      } catch (e) {
        stats.crossOriginFrames++;
      }
    });
  }

  function buildSimpleField(el, tag, type) {
    var options = [];
    if (tag === 'select') {
      options = Array.prototype.map.call(el.options, function (o) {
        return { value: o.value, text: cleanText(o.textContent) };
      });
    }
    var labelInfo = resolveLabel(el);
    var labelText = labelInfo.text;
    // 自定义组件：直接写 input.value 是无效的，得走「点开浮层选」这条路
    var comp = componentRootOf(el);
    var field = {
      id: 'rj_' + (++seq),
      tag: tag,
      type: type,
      selector: buildSelector(el),
      attrs: {
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
        placeholder: el.getAttribute('placeholder') || '',
        autocomplete: el.getAttribute('autocomplete') || ''
      },
      labelText: labelText,
      labelSource: labelInfo.source,
      required: !!(el.required || el.getAttribute('aria-required') === 'true'),
      options: options,
      value: getValue(el),
      editable: !el.readOnly && !el.disabled,
      // 是自定义组件时记下类型（select / picker），弹窗据此提示「需模拟选择」
      component: comp ? comp.kind : ''
    };
    field.fingerprint = buildFingerprint(
      labelText, labelInfo.source, field.attrs.placeholder, type,
      options.map(function (o) { return o.text; }).join('/'), el
    );
    registry.set(field.id, { kind: 'simple', el: el, field: field, component: comp });
    return field;
  }

  function buildChoiceField(el, type) {
    var name = el.getAttribute('name');
    var group = [el];
    if (name && el.form && el.form.elements[name]) {
      var list = el.form.elements[name];
      var arr = (list && typeof list.length !== 'undefined') ? Array.prototype.slice.call(list) : [list];
      group = arr.filter(function (n) { return n.type === type; });
    } else if (name) {
      group = Array.prototype.filter.call(document.getElementsByName(name), function (n) {
        return n.type === type;
      });
    }
    if (!group.length) group = [el];

    var options = group.map(function (n) {
      return { value: n.value, text: getOptionLabel(n) || n.value };
    });
    var checked = group.filter(function (n) { return n.checked; }).map(function (n) { return n.value; });

    var groupLabel = getGroupLabel(group);

    var field = {
      id: 'rj_' + (++seq),
      tag: 'input',
      type: type + '-group',
      selector: buildSelector(el),
      attrs: {
        name: name || '',
        id: el.getAttribute('id') || '',
        placeholder: '',
        autocomplete: ''
      },
      labelText: groupLabel,
      labelSource: groupLabel ? 'group' : 'none',
      required: group.some(function (n) { return !!n.required; }),
      options: options,
      value: checked.join(','),
      editable: true
    };
    field.fingerprint = buildFingerprint(
      groupLabel, field.labelSource, '', type + '-group',
      options.map(function (o) { return o.text; }).join('/'), el
    );
    registry.set(field.id, { kind: 'group', group: group, field: field });
    return field;
  }

  /**
   * 找出「里面已经没有原生控件」的自定义组件根。
   *
   * 为什么要单独补一趟：组件库的下拉/选择器在**空**的时候内部会放一个真 input，
   * 一旦有了值就把那个 input **删掉**（实测北森 phoenix-select 与地区选择器都是如此）。
   * 于是「已经填好的字段」在扫描结果里整个消失 —— 偏偏这正是用户最想核对的那些。
   *
   * 只收「自己就是最外层组件根，且内部没有任何控件」的，避免与控件那一趟重复计数。
   */
  function collectComponentOnly(elements) {
    var out = [];
    var all = document.querySelectorAll(
      '[class*="select"],[class*="Select"],[class*="picker"],[class*="cascader"],[role="combobox"]');
    Array.prototype.forEach.call(all, function (n) {
      if (elements.length + out.length >= MAX_INPUTS) return;
      var info = componentRootOf(n);
      if (!info || info.root !== n) return;              // 不是最外层那一层，跳过
      if (n.querySelector(CONTROL_SELECTOR)) return;     // 有控件的，控件那一趟已经收过了
      if (!isVisible(n)) return;
      out.push(n);
    });
    return out;
  }

  function scanAll(root) {
    registry.clear();
    seq = 0;
    var elements = [];
    var stats = { seen: 0, rejected: 0, reasons: [], crossOriginFrames: 0 };
    collect(root || document, elements, stats);
    // 补上「填好值之后内部已无控件」的自定义组件
    var compOnly = collectComponentOnly(elements);
    if (compOnly.length) {
      stats.componentOnly = compOnly.length;
      compOnly.forEach(function (n) { elements.push(n); });
    }

    if (window.__RJ_LOG__) {
      window.__RJ_LOG__.log('scanner', {
        candidates: stats.seen,
        accepted: elements.length,
        rejected: stats.rejected,
        crossOriginFrames: stats.crossOriginFrames
      });
      if (stats.reasons.length) window.__RJ_LOG__.log('scanner.rejected', stats.reasons);
    }

    var fields = [];
    var seenChoice = {};
    elements.forEach(function (el) {
      var tag = el.tagName.toLowerCase();
      var type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
      if (type === 'radio' || type === 'checkbox') {
        var name = el.getAttribute('name');
        if (name) {
          var k = type + '::' + name;
          if (seenChoice[k]) return;
          seenChoice[k] = 1;
        }
        fields.push(buildChoiceField(el, type));
        return;
      }
      fields.push(buildSimpleField(el, tag, type));
    });
    return fields;
  }

  function isEmptyField(field) {
    if (field.type === 'radio-group' || field.type === 'checkbox-group') {
      var entry = registry.get(field.id);
      if (!entry) return true;
      return !entry.group.some(function (n) { return n.checked; });
    }
    return !String(field.value || '').trim();
  }

  // ------------------------------------------------- 「+ 添加」按钮（重复区块加行）
  //
  // 投递页上的教育/工作/项目经历都是「一行的一组控件 + 一个添加按钮」。
  // 页面默认只渲染一行，而简历里往往有三段 —— 不把行加出来，第 2、3 段无处可填。
  // 这里只负责找到那个按钮；点不点、点完有没有多出一行，由 filler / main 判断，
  // 因为「找不到按钮」和「点了没反应」是两种完全不同的失败，日志里必须分得开。

  var ADD_TEXT_RE = /^(?:\+|＋)?\s*(?:添加|新增|增加|继续添加|再加|添加一[段条项]?)/;
  var BLOCK_WORD = {
    education: /教育|学历|院校|学习经历/,
    experience: /工作|任职|实习|履历|职业经历/,
    projects: /项目/
  };

  function triggerTextOf(n) {
    var t = n.tagName === 'INPUT' ? (n.value || '') : (n.textContent || '');
    if (!t) {
      t = (n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('title'))) || '';
    }
    return cleanText(t);
  }

  /**
   * 是不是「能点的东西」。
   *
   * 这里**不能**只认 button / a / role=button —— 实测北森投递页的「添加教育经历」
   * 是 `<div class="sc-lbhJGD"><span>添加教育经历</span></div>`，
   * 一层 styled-components 的哈希类名，既不是按钮也没有 role。
   * 只认语义标签的后果是「按钮明明在页面上、而且看得见」，却报「没找到添加按钮」。
   * 所以补两条旁证：cursor: pointer、以及类名里带 add/btn/button。
   */
  function looksClickable(n) {
    if (!n || !n.tagName) return false;
    if (n.disabled) return false;
    if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return false;
    var tag = n.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input') return true;
    if (n.getAttribute && n.getAttribute('role') === 'button') return true;

    var cls = String((n.className && (n.className.baseVal || n.className)) || '');
    if (/(?:^|[-_])(?:btn|button|add|plus|link|operate|action)/i.test(cls)) return true;

    try {
      if (window.getComputedStyle(n).cursor === 'pointer') return true;
    } catch (e) { /* 拿不到样式就当不可点 */ }
    return false;
  }

  /**
   * 页面里所有「文字像添加按钮」的元素。
   *
   * 为什么要遍历整页而不是只在锚点祖先里找：实测那块按钮在经历区块的**标题栏**、
   * 或者整个区块容器的末尾，从「学校名称」输入框往上爬 8 层都碰不到它。
   * 代价是要遍历 DOM，所以先用两条便宜的条件把范围砍下来：
   *   · 子元素超过 3 个的一定是大容器，不是按钮；
   *   · 里面还有 input/select/textarea 的是字段容器，不是按钮。
   */
  function addCandidatesIn(root) {
    var out = [];
    var nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.children && n.children.length > 3) continue;
      if (n.querySelector && n.querySelector('input,select,textarea')) continue;
      var t = triggerTextOf(n);
      if (!isAddText(t)) continue;
      if (!isVisible(n)) continue;
      if (!looksClickable(n)) continue;
      out.push({ el: n, text: t });
    }
    return out;
  }

  /** 同类元素嵌套（div > div > span 都是「添加教育经历」）时，只留最外层那个 */
  function outermost(list) {
    var pick = [];
    list.forEach(function (c) {
      var swapped = false;
      for (var i = 0; i < pick.length; i++) {
        if (pick[i].text === c.text && c.el.contains(pick[i].el)) { pick[i] = c; swapped = true; }
      }
      if (swapped) return;
      var inside = pick.some(function (p) { return p.text === c.text && p.el.contains(c.el); });
      if (!inside) pick.push(c);
    });
    return pick.map(function (c) { return c.el; });
  }

  /**
   * 文本像不像「添加」，且不是会把用户数据弄没/弄定型的操作。
   *
   * 黑名单里除了「删除/清空」，还必须包含**暂存 / 保存 / 提交 / 预览**：
   * 扩展的边界是「只往表单里填内容」，保存与提交永远归用户。
   * 这一点不能只写在 README 里 —— 页面上「添加并暂存」这种按钮一旦被当成添加按钮，
   * 就等于扩展替用户做了保存，属于越过边界，而且用户完全不知情。
   */
  // 后半段是「别的添加」：添加附件 / 上传简历 / 添加证书 —— 这些点了不是加一行经历，
  // 其中上传类还会弹出系统文件选择框，点错了非常突兀
  var NOT_ADD_RE = /删除|移除|清空|重置|取消|暂存|保存|提交|预览|放弃|关闭|返回|下一步|上一步|附件|上传|简历|文件|图片|照片|头像|证书/;

  function isAddText(t) {
    if (!t || t.length > 16) return false;
    if (NOT_ADD_RE.test(t)) return false;
    return ADD_TEXT_RE.test(t);
  }

  /**
   * 找「加一行」的按钮。
   * @param {Element} anchorEl 这一块最后一个锚点字段（学校名称/公司名称/项目名称）
   * @param {string} blockType education / experience / projects
   */
  /** 在锚点之后找最近的一个；没有就退到之前最近的一个 */
  function nearestToAnchor(anchorEl, list) {
    if (!anchorEl) return list[0] || null;
    var after = null;
    var before = null;
    list.forEach(function (n) {
      if (anchorEl.compareDocumentPosition(n) & 4) {          // n 在锚点之后
        if (!after || (after.compareDocumentPosition(n) & 4)) after = n;
      } else if (n.compareDocumentPosition(anchorEl) & 4) {   // n 在锚点之前
        if (!before || (n.compareDocumentPosition(before) & 4)) before = n;
      }
    });
    return after || before || null;
  }

  function findAddTrigger(anchorEl, blockType) {
    var word = BLOCK_WORD[blockType] || null;
    var cands = outermost(addCandidatesIn(document));
    if (!cands.length) return null;

    // 「添加教育经历 / 添加工作经历 / 添加项目经历」三个长得一模一样，只能靠块关键词分。
    // 只要有一个带关键词的，就绝不退到通用「添加」上 —— 那等于赌。
    var withWord = cands.filter(function (n) { return word && word.test(triggerTextOf(n)); });
    if (withWord.length) return nearestToAnchor(anchorEl, withWord);

    // 没有块关键词的网站上，按钮通常就写着「添加 / 新增」：
    // 只有一个才敢直接用；有多个就按位置取锚点之后最近的那个（不是就放弃，
    // 加错块比不加更糟：用户会看到一行空白的公司名称，还得自己删）。
    if (cands.length === 1) return cands[0];
    return nearestToAnchor(anchorEl, cands);
  }

  window.__RJ_SCANNER__ = {
    scanAll: scanAll,
    isEmptyField: isEmptyField,
    getLabel: getLabel,
    resolveLabel: resolveLabel,
    describeContext: describeContext,
    getValue: getValue,
    componentRootOf: componentRootOf,
    componentDisplayText: componentDisplayText,
    findAddTrigger: findAddTrigger,
    getEntry: function (id) { return registry.get(id); },
    selectorOf: function (id) {
      var e = registry.get(id);
      return e ? e.field.selector : '';
    }
  };
})();
