/**
 * 真实投递页 · 端到端填充 —— 门禁用例
 * ============================================================================
 * 这是「业务准入」测试：**每次改动后、继续下一步之前，这条必须过。**
 *
 * 它跑的是**真的扩展、真的页面**（不是手工注入脚本）：
 *   用 CDP 保证调试浏览器里装着磁盘上的最新代码 → 从扩展自己的页面发消息驱动它
 *   （RJ_SCAN / RJ_FILL / RJ_CLEAR）→ 断言 → 清理干净。
 *
 * 覆盖四件事：
 *   A 感知与匹配：字段扫得到、「期望工作城市」不会串到「现居城市」、月薪不互换
 *   B 组件执行：自定义下拉/地区选择器能真的选上（这是最容易坏的一环）
 *   C 端到端：按简历填空白字段，且读回值正确
 *   D 安全红线：页面上**原有内容**的字段，全程一个字符都不能变
 *
 * 设计原则（都是被坑出来的）：
 *   · **自己造状态**：不假设页面现在是什么样，用到的字段先清空再填，跑完还原/清掉。
 *   · **失败也要还原**：清理放在 finally 里，断言失败不会把测试值留在用户表单上。
 *   · **清理优先走扩展**；扩展清不掉的（CSS :hover 的清除图标——合成事件触发不了），
 *     用 CDP 真实鼠标兜底，并在结果里标明用了哪条路。
 *
 * 用法：
 *   node real-site/form-fill.test.js            跑一遍（跑完清理）
 *   node real-site/form-fill.test.js --keep     跑完不清理（排查用；记得自己清）
 *
 * 退出码：0 通过 / 1 失败 / 2 没跑成（环境不具备，会说明原因）
 */
const fs = require('fs');
const path = require('path');
const C = require('../lib/cdp.js');
const E = require('../lib/extension.js');

// ---------------------------------------------------------------- 配置

const RESUME_PDF = path.resolve(__dirname, '..', '..', 'resume.pdf');
const FORM_RE = /zhiye\.com/;
const KEEP = process.argv.indexOf('--keep') !== -1;

// 组件执行那一段要用的「确定性测试值」：不依赖简历里有没有这一项，
// 否则一堆人跑出来都是「没东西可测」，等于没测。
const COMPONENT_PROBE = {
  label: /期望工作城市|期望城市|意向城市/,
  value: '北京'
};

// restore 里的特殊标记：这条填的是一个勾选框（「至今」），不是输入值。
// 清理时既不「清空该字段」（同名块会被殃及），也不「填回原值」，交给勾选还原那一步。
const PRESENT_MARK = '__present__';

// 注入顺序由 lib/extension.js 统一给（和 popup.js 一致，顺序错了模块之间会拿不到彼此）
const CONTENT_FILES = E.CONTENT_FILES;

// ---------------------------------------------------------------- 断言与输出

const results = [];

/** 「没跑成」专用。用异常而不是标记，原因见 skip() 的注释 */
class SkipError extends Error { }

function check(name, ok, extra) {
  results.push({ name: name, ok: !!ok, extra: extra || '' });
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + name + (ok || !extra ? '' : '   -> ' + extra));
}

function note(text) {
  results.push({ name: text, ok: true, extra: '', soft: true });
  console.log('  ·  ' + text);
}

/**
 * 提前中止（环境不具备，这条用例没验证任何东西）。
 *
 * **故意用抛出异常**：一开始是「设个标记然后 return」，结果中途跳过时——
 * 末尾的汇总和 process.exit 也一起被跳过了 —— 脚本以**退出码 0** 结束，
 * 在 CI 眼里和「通过」一模一样。门禁绝不能有这种误导。
 * 抛异常能保证 finally 里的清理和末尾的汇总一定执行，并以退出码 2 收场。
 */
function skip(reason) {
  throw new SkipError(reason);
}

const sleep = C.sleep;

// ---------------------------------------------------------------- 扩展侧驱动

function extEval(conn, expr, awaitPromise) {
  return C.evaluate(conn, expr, awaitPromise);
}

/**
 * 给投递页发消息（用扩展的 tabs.sendMessage，走的就是真实消息通道）。
 *
 * 超时**重试一次**：页面主线程被占住时命令就不回来（实测触发点：清空地区选择器之后
 * 站点要重画 99 个省 / 区，能占用十几秒到几十秒），而这类占用是暂时的 ——
 * 实测卡住一次之后，页面过一会儿又能正常响应。
 * 这里三种消息都是幂等的（扫描 / 按同一值填充 / 清空），重试不会产生重复副作用。
 */
async function toPage(ext, tabId, payload) {
  try {
    return await toPageOnce(ext, tabId, payload);
  } catch (e) {
    const m = String((e && e.message) || '');
    if (!/超时/.test(m)) throw e;
    note('一次页面通信超时（' + (payload.type || '?') + '），等 3 秒重试一次');
    await sleep(3000);
    return await toPageOnce(ext, tabId, payload);
  }
}

async function toPageOnce(ext, tabId, payload) {
  const r = await extEval(ext,
    'chrome.tabs.sendMessage(' + tabId + ', ' + JSON.stringify(payload) + ')' +
    '.then(function (r) { return { res: r }; }, function (e) { return { err: String(e) }; })',
    true);
  if (!r || r.err) throw new Error('和页面通信失败：' + ((r && r.err) || '无返回'));
  return r.res;
}

async function ping(ext, tabId) {
  const r = await extEval(ext,
    'chrome.tabs.sendMessage(' + tabId + ', {type:"RJ_PING"})' +
    '.then(function (r) { return { res: r }; }, function (e) { return { err: String(e) }; })',
    true).catch(function () { return { err: 'evaluate failed' }; });
  return !!(r && r.res && r.res.ok);
}

/** 和 popup 的 ensureContentScript 同源：先清模块守卫再补注入，保证跑的是当前代码 */
async function ensureContentScript(ext, tabId) {
  if (await ping(ext, tabId)) return true;
  await extEval(ext,
    'chrome.scripting.executeScript({ target: { tabId: ' + tabId + ' }, func: function () {' +
    '  ["__RJ_STORE__","__RJ_LOG__","__RJ_CONFIG__","__RJ_SCANNER__",' +
    '   "__RJ_FILLER__","__RJ_MATCHER__","__RJ_LOADED__"].forEach(function (k) {' +
    '    try { delete window[k]; } catch (e) {} });' +
    '} }).then(function () { return "ok"; }, function (e) { return "err:" + e.message; })',
    true).catch(function () { /* 拿不到页面就算了，下面照样注入 */ });
  const inj = await extEval(ext,
    'chrome.scripting.executeScript({ target: { tabId: ' + tabId + ' }, files: ' +
    JSON.stringify(CONTENT_FILES) + ' })' +
    '.then(function () { return "ok"; }, function (e) { return "err:" + e.message; })',
    true).catch(function (e) { return 'err:' + e.message; });
  if (String(inj).indexOf('err') === 0) return false;
  await sleep(400);
  return await ping(ext, tabId);
}

// 扩展页面的开/关（含「等 chrome.storage 真的可用」那个坑）都在 lib/extension.js 里，
// 别的真实站点用例也能直接用，不必各写一份。

// ---------------------------------------------------------------- 页面侧（主世界）辅助

const FIND_COMPONENT = function (label) {
  var root = null;
  document.querySelectorAll('[class*="form-item"]').forEach(function (item) {
    if (root) return;
    var t = String(item.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.indexOf(label) !== 0) return;
    var c = item.querySelector('[class*="select"],[class*="picker"],[class*="cascader"]');
    if (c) root = c;
  });
  if (!root) return null;
  root.scrollIntoView({ block: 'center' });
  var r = root.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};

/**
 * 找「这个字段的组件里」当前可点的清除图标。
 *
 * 必须**限定在这个字段的组件内部**。早先的写法是全文档扫 `[class*=clear/close]`，
 * 那是错的：页面上任何一个关闭按钮（浮层关闭、提示条关闭）都可能被点到，
 * 点到无关东西的后果不可预料。所以先按标签定位到组件，再在它里面找。
 */
const VISIBLE_CLEAR_BTN = function (label) {
  var want = String(label).replace(/\s+/g, ' ').trim();
  var root = null;
  var items = document.querySelectorAll('[class*="form-item"]');
  for (var i = 0; i < items.length && !root; i++) {
    var t = String(items[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (t.indexOf(want) !== 0) continue;
    root = items[i].querySelector('[class*="select"],[class*="picker"],[class*="cascader"]');
  }
  if (!root) return null;
  var found = null;
  root.querySelectorAll('*').forEach(function (n) {
    if (found) return;
    var cls = String(n.getAttribute('class') || '').toLowerCase();
    if (cls.indexOf('clear') === -1) return;
    if (cls.indexOf('hide') !== -1) return;
    var s = getComputedStyle(n);
    var r = n.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || r.width < 2 || r.height < 2) return;
    found = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  return found;
};

/**
 * 用真实鼠标清空一个组件。
 * 为什么测试里要干这件事：组件的「清除图标」是靠 CSS `:hover` 显示的，
 * 而 CSS :hover **合成不了** —— 扩展派发的 mouseover 不让浏览器认为指针在元素上。
 * CDP 的 Input.dispatchMouseEvent 产生的是可信事件，能真正触发 :hover。
 * 所以这是「测试能做、扩展做不到」的兜底，结果里会标明。
 */
async function realMouseClear(formConn, label) {
  const pos = await C.evaluate(formConn,
    '(' + FIND_COMPONENT.toString() + ')(' + JSON.stringify(label) + ')');
  if (!pos) return { ok: false, error: '页面上找不到「' + label + '」的组件' };
  await sleep(350);
  await C.mouseMove(formConn, pos.x, pos.y);
  await sleep(450);
  const btn = await C.evaluate(formConn,
    '(' + VISIBLE_CLEAR_BTN.toString() + ')(' + JSON.stringify(label) + ')');
  if (!btn) return { ok: false, error: '悬停后没有出现可见的清除图标' };
  await C.mouseClick(formConn, btn.x, btn.y);
  await sleep(750);
  await C.mousePark(formConn);
  return { ok: true };
}

// ---------------------------------------------------------------- 主流程

const plan = { byLabel: {}, all: [] };

function indexPlan(scanRes) {
  plan.all = (scanRes && scanRes.plan) || [];
  plan.byLabel = {};
  plan.all.forEach(function (p) {
    var k = String(p.label || '').replace(/\s+/g, ' ').trim();
    if (!plan.byLabel[k]) plan.byLabel[k] = p;
  });
  return plan.all;
}

function pick(re) {
  for (var i = 0; i < plan.all.length; i++) {
    if (re.test(String(plan.all[i].label || ''))) return plan.all[i];
  }
  return null;
}

/**
 * 按标签找字段。
 *
 * 为什么一律按标签、不按 id：字段 id 是「本次扫描里的序号」（rj_1、rj_2…），
 * 而**填了值的自定义组件会把内部那个真 input 删掉**，由扫描器的补扫在列表**末尾**
 * 重新收进来 —— 于是同一个字段在两次扫描里的 id 不一样。
 * 按 id 查会在重扫后一律查不到，表现为「读回为空」，看起来像填充失败，
 * 其实是查了个已经不存在的东西（这个坑真踩了）。
 * 标签就和用户看到的一致，稳定得多。
 */
function entryByLabel(label) {
  const want = String(label == null ? '' : label).replace(/\s+/g, ' ').trim();
  if (!want) return null;
  for (var i = 0; i < plan.all.length; i++) {
    if (String(plan.all[i].label || '').replace(/\s+/g, ' ').trim() === want) return plan.all[i];
  }
  return null;
}

/** 按标签取当前值；null = 扫描里找不到这个字段 */
function valOf(label) {
  const e = entryByLabel(label);
  return e ? String(e.currentValue == null ? '' : e.currentValue) : null;
}

/** 按标签取字段（找不到返回 null） */
function fieldOf(label) {
  return entryByLabel(label);
}

/**
 * 页面侧快照：把「当前有值的字段」按 **DOM 顺序 + 同名第几次出现** 记下来。
 *
 * 为什么安全红线不能像别处一样「按标签记」：投递页里「专业名称 / 学历 / 开始时间 /
 * 项目名称」在重复块里各出现两次，标签完全相同。而扫描器列表的顺序会变
 * （填了值的自定义组件会把内部 input 删掉、由补扫收到列表末尾），
 * 于是同一个标签两次读到的是**不同的块** —— 实测就是这样误报的：
 * 「专业名称:计算机科学与技术→软件工程、学历:本科→硕士研究生」，
 * 看着像把用户数据改坏了，其实两个块各自好好的，只是比错了对象。
 * 更糟的是反向：真被改动时也可能因为恰好比到同一个块而看不出来。
 *
 * DOM 顺序是稳定的（块不会自己重排），所以「标签 + 第 n 次出现」才是可比的键。
 */
const DOM_SNAPSHOT = function () {
  function txt(n) { return String(n.textContent || '').replace(/\s+/g, ' ').trim(); }
  var out = [];
  var seen = {};
  var boxes = document.querySelectorAll('[class*="form-item"]');
  for (var i = 0; i < boxes.length; i++) {
    var box = boxes[i];
    // 注意：**不能**用「里面还有 form-item」来判定容器 —— 页面上连标签元素自己的 class
    // 都叫 form-item-label，那个判据会把所有字段都干掉（实测：快照 0 个字段，门禁假通过）。
    // 改成看控件数量：一个字段容器里只有 1 个控件（单选组是多控件，单独放行）。
    var els = box.querySelectorAll('input,textarea');
    var real = [];
    for (var j = 0; j < els.length; j++) {
      var t0 = els[j].type;
      if (t0 === 'hidden' || t0 === 'file') continue;
      real.push(els[j]);
    }
    var groupish = real.length > 1;
    for (var g = 0; g < real.length; g++) {
      var ty = real[g].type;
      if (ty !== 'radio' && ty !== 'checkbox') { groupish = false; break; }
    }
    if (real.length > 1 && !groupish) continue;     // 多个普通控件 = 外层容器，跳过

    var labEl = box.querySelector('[class*="label"],[class*="title"]');
    var label = labEl ? txt(labEl) : '';
    if (!label) continue;
    var parts = [];
    for (var k = 0; k < real.length; k++) {
      var el = real[k];
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (el.checked) parts.push('[' + String(el.value || 'on') + ']');
        continue;
      }
      var v = String(el.value == null ? '' : el.value).trim();
      if (v) parts.push(v);
    }
    if (!parts.length) {
      // 自定义下拉/日期：真 input 可能已被组件接管，只剩显示文本
      var shown = box.querySelector('[class*="select"] [class*="value"],[class*="picker"] [class*="value"],[class*="select-text"]');
      if (shown && !shown.querySelector('input,textarea')) {
        var t = txt(shown);
        if (t && !/^(请选择|请输入)/.test(t)) parts.push(t);
      }
    }
    // 空字段也要记！只记「有值的」会让第 n 次的计数随「某个字段从空变有值」而平移：
    // 实测把工作块的开始时间填上后，后面所有「开始时间#n」整体错位一格，
    // 于是 D 段报「项目块的日期被改了」—— 项目块其实一个字符都没动。
    seen[label] = (seen[label] || 0) + 1;
    out.push({
      key: label + '#' + seen[label],
      label: label,
      nth: seen[label],
      value: parts.join(' | ').slice(0, 160)
    });
  }
  return out;
};

/** 取页面侧快照，返回 { '标签#n': {key,label,nth,value} }；读不到返回 null */
async function domSnapshot(conn) {
  const rows = await C.evaluate(conn, '(' + DOM_SNAPSHOT.toString() + ')()')
    .catch(function () { return null; });
  if (!rows) return null;
  const map = {};
  rows.forEach(function (r) { map[r.key] = r; });
  return map;
}

/**
 * 直接从页面上读「这个字段显示出来的值」，不经过扫描器。
 * 用途：和扫描器的读法**交叉核对** —— 万一扫描器某个版本读不到已填值的组件，
 * 光看它会得到「填充失败」的误判（或反过来，把没填上判成填上了）。
 */
const DOM_DISPLAY = function (label) {
  var want = String(label).replace(/\s+/g, ' ').trim();
  var item = null;
  var boxes = document.querySelectorAll('[class*="form-item"], [class*="fields-col"], li');
  for (var i = 0; i < boxes.length && !item; i++) {
    var t = String(boxes[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (t.indexOf(want) !== 0) continue;
    if (t.length > want.length + 160) continue;      // 太大的容器不是「一个字段」
    item = boxes[i];
  }
  if (!item) return null;
  var parts = [];
  var all = item.querySelectorAll('*');
  for (var j = 0; j < all.length; j++) {
    var n = all[j];
    if (n.children && n.children.length) continue;
    var cls = String(n.getAttribute('class') || '').toLowerCase();
    if (cls.indexOf('placeholder') !== -1) continue;
    var s = getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    var v = String(n.textContent || '').replace(/\s+/g, ' ').trim();
    if (!v || v === want) continue;
    v = v.replace(want, '').replace(/^[:：\s*]+/, '');
    if (v) parts.push(v);
  }
  return parts.join(' ').trim();
};

/**
 * 页面侧读值（失败返回 null，不影响断言主流程）。
 * 连接对象要从外面传进来 —— 写这个函数时踩过：模块级函数直接引用 IIFE 里的 `form`，
 * 到调用时才爆 ReferenceError: form is not defined，而报错位置离原因看着挺远。
 */
async function domValue(conn, label) {
  return await C.evaluate(conn,
    '(' + DOM_DISPLAY.toString() + ')(' + JSON.stringify(label) + ')'
  ).catch(function () { return null; });
}

/**
 * 按 selector 直接读控件的值（不经过扫描器，也不经过标签）。
 *
 * 为什么需要它：重复块里「开始时间」有 5 个，按标签读永远拿到第一个（教育块1）。
 * C 段填的可能是工作块那个，读回却拿教育块1 的值 —— 实测就是这样报了
 * 「开始时间 期望 2026-07 实际 2024-09」的假失败。
 * selector 是扫描时按 dom 结构生成的，指向的是**那一个**控件。
 */
async function domValueBySelector(conn, selector, nth) {
  if (!selector) return null;
  // selector 可能对应多个重复块（同一 selector 的第 n 个才是目标控件）
  return await C.evaluate(conn,
    '(function () { var list = document.querySelectorAll(' + JSON.stringify(selector) + ');' +
    ' var el = list[' + (nth || 0) + '];' +
    ' return el ? String(el.value == null ? "" : el.value).trim() : null; })()'
  ).catch(function () { return null; });
}

/**
 * 页面侧：按「标签 + 该标签第几次出现」读字段的显示值。
 * 重复块里同名标签有好几个，这是唯一稳定的定位方式（selector 不唯一，见 C 段的注释）。
 */
const DOM_VALUE_BY_LABEL = function (label, nth) {
  var boxes = document.querySelectorAll('[class*="form-item"]');
  var n = 0;
  for (var i = 0; i < boxes.length; i++) {
    var lab = boxes[i].querySelector('[class*="label"],[class*="title"]');
    if (!lab) continue;
    var name = String(lab.textContent || '').replace(/\s+/g, ' ').trim();
    if (name !== label) continue;
    if (n !== nth) { n++; continue; }
    var inp = boxes[i].querySelector('input');
    var v = inp ? String(inp.value || '').trim() : '';
    if (!v) {
      var shown = boxes[i].querySelector('[class*="select"] [class*="value"],[class*="picker"] [class*="value"],[class*="select-text"]');
      if (shown) v = String(shown.textContent || '').trim();
    }
    return v || '';
  }
  return null;
};

/** 页面侧：所有「至今」勾选框的勾选状态（结束时间是「至今」时，填的不是日期而是这个框） */
const PRESENT_STATE = function () {
  // 注意：文字节点自己的类名就是 phoenix-checkbox__text，用 closest 会返回它自己，
  // 于是 checked 永远是 false（踩过）。要往上找到真正的 div.phoenix-checkbox。
  function boxOf(n) {
    var p = n.parentElement;
    for (var d = 0; d < 3 && p; d++) {
      var c = String(p.className || '');
      if (/checkbox/i.test(c) && !/__text|__label|checkbox-text/i.test(c)) return p;
      p = p.parentElement;
    }
    return n.parentElement;
  }
  var out = [];
  var spans = document.querySelectorAll('[class*="checkbox__text"],[class*="checkbox-text"]');
  for (var i = 0; i < spans.length; i++) {
    var t = String(spans[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (!/^(至今|现在)$/.test(t)) continue;
    var box = boxOf(spans[i]);
    // 状态看 span.phoenix-checkbox__realInput 的 --checked 类：
    // 真实 input 的 checked 永远是 false（组件用 span 画外观），别用它判断
    var real = box ? box.querySelector('[class*="realInput"]') : null;
    var cls = box ? String(box.className || '').toLowerCase() : '';
    var inp = box ? box.querySelector('input[type=checkbox]') : null;
    var checkedByReal = real
      ? /--checked|__checked/.test(String(real.className || ''))
      : (cls.indexOf('checked') !== -1 || !!(inp && inp.checked));
    out.push({ text: t, checked: checkedByReal });
  }
  return out;
};

/** 页面侧：取消第 idx 个「至今」的勾选（清理用）。返回是否真的点了 */
const PRESENT_UNCHECK = function (idx) {
  var spans = document.querySelectorAll('[class*="checkbox__text"],[class*="checkbox-text"]');
  var n = -1;
  for (var i = 0; i < spans.length; i++) {
    if (!/^(至今|现在)$/.test(String(spans[i].textContent || '').replace(/\s+/g, ' ').trim())) continue;
    n++;
    if (n !== idx) continue;
    var box = spans[i].parentElement;
    for (var d = 0; d < 3 && box; d++) {
      var c = String(box.className || '');
      if (/checkbox/i.test(c) && !/__text|__label|checkbox-text/i.test(c)) break;
      box = box.parentElement;
    }
    if (!box) return false;
    // 点外层 div.phoenix-checkbox 才有效；input.click() 对它没用（状态画在 span 上）
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    box.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }
  return false;
};

(async () => {
  console.log('=== 真实投递页 · 端到端填充（门禁）===\n');

  // ---- 0. 前置 ----
  let version;
  try {
    version = await C.httpJson('/json/version');
  } catch (e) {
    return skip('调试浏览器连不上 127.0.0.1:9222。' +
      '先启动带调试端口的 Chrome（见 tests/README.md），并把投递页打开、登录好。');
  }
  console.log('浏览器：' + String(version.Browser || '').slice(0, 60));

  let list = await C.targets();
  const formTab = list.filter(function (t) {
    return t.type === 'page' && FORM_RE.test(String(t.url));
  })[0];
  if (!formTab) {
    return skip('没找到投递页标签（URL 需含 zhiye.com）。把投递页打开再跑。');
  }
  console.log('投递页：' + String(formTab.url).slice(0, 80));

  const browser = await C.browser();

  // ---- 1. 扩展：必须装着，而且必须是磁盘上的当前代码 ----
  //
  // 这里曾经用过 chrome.runtime.reload() 去「刷新代码」，结果把扩展刷成了 DISABLED
  // （Chrome 对通过 CDP 装进来的扩展会标 unsupportedDeveloperExtension），
  // 所有扩展页面变成 ERR_BLOCKED_BY_CLIENT。别再走那条路，原因见 lib/extension.js 顶部注释。
  let loaded;
  try {
    loaded = await E.ensureLoaded(browser, list);
  } catch (e) {
    return skip('装扩展失败：' + String((e && e.message) || e).slice(0, 100));
  }
  const extId = loaded.id;
  console.log('扩展 ID：' + extId + (loaded.how === 'just-loaded' ? '（刚装上，必然是当前代码）' : '（已装着）'));

  let ext;
  try {
    ext = await E.openPage(browser, extId);
  } catch (e) {
    return skip('扩展页面打不开 —— 通常是扩展被 Chrome 禁用了（DISABLED 状态）。' +
      '到 chrome://extensions 把「简历自动投递助手」的开关打开，' +
      '或删掉它再「加载已解压的扩展程序」选 extension/ 目录。' +
      '（别用 chrome.runtime.reload 去刷 —— 那正好会把扩展变成禁用状态）');
  }

  const st = await E.state(ext);
  const diskV = E.diskVersion();
  if (String(st.version) !== String(diskV)) {
    return skip('装着的扩展是旧代码：已装 ' + st.version + '，磁盘 ' + diskV + '。' +
      '先刷新扩展再跑这条用例 —— 两种都行：' +
      '① `node tools/ext-state.js --reload`（会自动刷新并核对版本）；' +
      '② 到 chrome://extensions 点一下「重新加载」。' +
      '（别用 chrome.runtime.reload —— 那会把扩展弄成 DISABLED）');
  }
  console.log('扩展版本：' + st.version + '（与磁盘一致 ✓）\n');

  // ---- 2. 简历就位 ----
  const readResume = function () {
    return extEval(ext, 'chrome.storage.local.get(null).then(function (o) {' +
      '  var id = o.rj_active_resume;' +
      '  var r = id ? o["rj_resume_" + id] : null;' +
      '  if (!r) { var k = Object.keys(o).filter(function (x) { return /^rj_resume_/.test(x); })[0];' +
      '    r = k ? o[k] : null; }' +
      '  if (!r) return null;' +
      '  return { name: r.profile.basic.name, phone: r.profile.basic.phone,' +
      '    email: r.profile.basic.email, birthday: r.profile.basic.birthday,' +
      '    location: r.profile.basic.location, expectedCity: r.profile.basic.expectedCity,' +
      '    workYears: r.profile.basic.workYears,' +
      '    edu: (r.profile.education || []).length, exp: (r.profile.experience || []).length,' +
      '    prj: (r.profile.projects || []).length };' +
      '})', true);
  };

  let resume = await readResume();
  if (!resume || !String(resume.name || '').trim()) {
    if (!fs.existsSync(RESUME_PDF)) {
      return skip('扩展存储里没有简历，而且找不到简历 PDF：' + RESUME_PDF +
        '。请把简历 PDF 放到项目根目录，或先在资料设置页填好简历。');
    }
    console.log('存储里没有简历，先导入：' + path.basename(RESUME_PDF));
    await ext.send('DOM.enable');
    const doc = await ext.send('DOM.getDocument', { depth: 1 });
    const q = await ext.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
    if (!q || !q.nodeId) return skip('资料设置页上没有 #import-file，无法自动导入');
    await ext.send('DOM.setFileInputFiles', { files: [RESUME_PDF], nodeId: q.nodeId });
    let status = '';
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      status = await extEval(ext, '(function () { var e = document.getElementById("import-status");' +
        ' return e ? e.textContent.replace(/\\s+/g, " ").trim() : ""; })()').catch(function () { return ''; });
      if (/已解析|失败|无法/.test(status)) break;
    }
    console.log('  解析：' + status.slice(0, 120));
    await extEval(ext, 'document.getElementById("btn-save").click()');
    let savedMsg = '';
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      savedMsg = await extEval(ext, '(function () { var e = document.getElementById("saved");' +
        ' return e ? e.textContent.trim() : ""; })()').catch(function () { return ''; });
      if (/保存|无改动/.test(savedMsg)) break;
    }
    resume = await readResume();
    check('导入的简历已落盘（存储里读得到姓名）', !!(resume && String(resume.name || '').trim()),
      '界面提示="' + savedMsg + '" 存储=' + JSON.stringify(resume && resume.name));
    if (!resume || !String(resume.name || '').trim()) return null;
  }
  note('简历：' + resume.name + ' / 教育 ' + resume.edu + ' · 工作 ' + resume.exp +
    ' · 项目 ' + resume.prj + '（期望城市=' + (resume.expectedCity || '未填') + '）');

  // ---- 3. 让页面跑上当前代码 ----
  const tabId = await extEval(ext,
    'chrome.tabs.query({ url: "*://*.zhiye.com/*" }).then(function (t) { return t[0] && t[0].id; })', true);
  if (!tabId) return skip('扩展看不到投递页标签');
  if (!(await ensureContentScript(ext, tabId))) {
    return skip('content script 注入失败（页面可能还没加载完，或权限被拒）。刷新投递页后重试。');
  }
  console.log('');

  const form = await C.page(formTab.webSocketDebuggerUrl);
  await C.mousePark(form);

  const closePanels = async function () {
    await C.evaluate(form, 'document.body.dispatchEvent(new KeyboardEvent("keydown", ' +
      '{ key: "Escape", bubbles: true }))').catch(function () { });
    await C.mousePark(form);
    await sleep(400);
  };

  // 清理计划。必须在 try 之外声明 —— finally 里要用，而 try 块内的 const 出了块就没了。
  //
  // 键用 **selector**，标签只作为兜底：投递页的重复块里「开始时间」有 5 个，
  // 按标签清理会永远命中第一个（教育块1）—— 实测就是这样把用户好好的
  // 2024-09 清掉、而真正该清的工作块留着的。selector 指向的是那一个控件。
  // 不按 id 的原因见 entryByLabel 的注释（填过值重扫后 id 会变）。
  const restore = {};       // selector -> { selector, label, value }；value 为 '' 表示原本就是空
  let base = {};            // 「原有内容」的基准：键是「标签#第几次出现」，安全红线跟它比
  let filledKeys = [];      // base 里原本有值的键 —— 只有这些字段必须一字不变
  let presentBefore = [];   // 动手之前，每个「至今」勾选框原本是什么状态（清理时要还原）

  try {
    // ================= A. 感知与匹配 =================
    console.log('--- A. 感知与匹配（只读）---');
    let scan = await toPage(ext, tabId, { type: 'RJ_SCAN' });
    indexPlan(scan);

    check('扫得到字段（≥10 个）', scan.total >= 10, 'total=' + scan.total);
    const matched = plan.all.filter(function (p) { return p.suggestedPath; });
    check('规则命中（≥1 个）', matched.length >= 1, 'matched=' + matched.length);

    // 防止「读错了键」这类**假通过**：如果标签全读不到，下面所有「按标签找字段」的断言
    // 都会静默跳过，用例照样报通过，而实际什么都没测。
    // （真踩过：plan 里的键叫 label，我读的是 labelText —— 于是「页面上没有期望工作城市」。）
    const labeled = plan.all.filter(function (p) {
      const t = String(p.label || '').trim();
      return t && t !== '(未命名字段)';
    });
    check('扫出来的字段带可读标签（≥10 个）', labeled.length >= 10,
      '带标签 ' + labeled.length + ' / 共 ' + plan.all.length + ' 个字段');

    const cityField = pick(COMPONENT_PROBE.label);
    if (cityField) {
      check('「' + cityField.label + '」映射到 basic.expectedCity（不是现居城市 basic.location）',
        cityField.suggestedPath === 'basic.expectedCity',
        '实际 = ' + cityField.suggestedPath);
    } else {
      note('页面上没有「期望工作城市」这类字段，跳过意向城市断言');
    }

    const cur = pick(/^现月薪|^当前月薪|^现有月薪/);
    const exp = pick(/^期望月薪|^期望薪资/);
    if (cur && exp) {
      check('现月薪 / 期望月薪 没有落到同一个路径',
        !(cur.suggestedPath && cur.suggestedPath === exp.suggestedPath),
        (cur.suggestedPath || '-') + ' vs ' + (exp.suggestedPath || '-'));
    }

    // 安全红线基准：页面侧按「DOM 顺序 + 第几次出现」快照，重复块里的同名字段才不会串
    base = (await domSnapshot(form)) || {};
    filledKeys = Object.keys(base).filter(function (k) { return String(base[k].value).trim(); });
    note('页面上原本就有内容的字段 ' + filledKeys.length + ' 个（全程不得改动）：' +
      filledKeys.map(function (k) { return base[k].key + '=' + base[k].value; }).join('  ').slice(0, 180));

    // ================= B. 组件执行 =================
    console.log('\n--- B. 组件执行（确定性：清空 → 填「' + COMPONENT_PROBE.value + '」→ 还原）---');
    if (!cityField) {
      note('没有可用的组件字段，跳过这一段');
    } else {
      const cityLabel = cityField.label;
      // 按 selector 记录「最后要还原成什么」。原值可能非空（用户自己填过），那就得填回去
      restore[cityLabel + '#0'] = {
        selector: cityField.selector || '',
        nth: 0,
        label: cityLabel,
        labelOrd: 0,
        value: String(cityField.currentValue || '')
      };

      await closePanels();
      let r = await toPage(ext, tabId, { type: 'RJ_CLEAR', ids: [cityField.id] });
      indexPlan(r);
      let clearVia = (r.report && r.report[0] && r.report[0].via) || '';
      let now = valOf(cityLabel);
      if (now === null || String(now).trim()) {
        // 扩展清不掉（清除图标靠 CSS :hover）→ 真实鼠标兜底
        const rm = await realMouseClear(form, cityLabel).catch(function () { return { ok: false }; });
        await closePanels();
        indexPlan(await toPage(ext, tabId, { type: 'RJ_SCAN' }));
        now = valOf(cityLabel);
        clearVia = rm.ok ? 'real-mouse' : ('失败:' + rm.error);
      }
      check('组件能被清空（清空路径：' + clearVia + '）', now !== null && !String(now).trim(),
        '扫描读回 = ' + JSON.stringify(now));

      // 清空后重扫，字段可能换了 id，按标签重新拿一个
      const target = fieldOf(cityLabel) || cityField;
      await closePanels();
      r = await toPage(ext, tabId, {
        type: 'RJ_FILL',
        items: [{ id: target.id, label: cityLabel, path: target.suggestedPath || '', value: COMPONENT_PROBE.value }],
        skipSelectors: {}
      });
      indexPlan(r);
      const rep = (r.report || [])[0] || {};
      // 两个独立来源各读一遍：扫描器读的、页面上显示的。
      // 只看扫描器的话，一旦感知层读不到「已填值的组件」，会把成功误判成失败（反过来也危险）。
      const byScanner = valOf(cityLabel);
      const byDom = await domValue(form, cityLabel);
      const shows = function (x) { return String(x == null ? '' : x).indexOf(COMPONENT_PROBE.value) !== -1; };
      const detail = '扫描器读回=' + JSON.stringify(byScanner) +
        '  页面上显示=' + JSON.stringify(byDom) +
        '  via=' + (rep.via || '-') + '  错误=' + (rep.error || '无');
      check('组件被填入「' + COMPONENT_PROBE.value + '」（页面上确实显示出来了）',
        shows(byDom) || shows(byScanner), detail);
      check('扫描器能读回已填值的组件（不是空壳 input）', shows(byScanner), detail);
    }

    // ================= C. 端到端：按简历填空 =================
    console.log('\n--- C. 端到端（只填空字段，值取自简历）---');
    await closePanels();
    scan = await toPage(ext, tabId, { type: 'RJ_SCAN' });
    indexPlan(scan);

    const items = [];
    const skipSelectors = {};
    // selector **不保证唯一**：投递页 39 个字段只有 29 个不同的 selector，
    // 两个教育块的「学校名称」拿到的是同一个。所以要再带上「同一个 selector 的第几个」，
    // 否则读回和清理都会认错块 —— 实测就是这样把教育块1 的结束时间清掉的。
    // 定位重复块的键用「标签 + 该标签第几次出现」，**不用 selector**：
    // 实测 selector 在这页大量重复（39 个字段只有 29 个不同 selector），
    // 而且同一个 selector 的第 n 个在两次扫描之间还会错位 —— 正是这样把
    // 「工作块的结束时间」认成了「教育块1 的结束时间」，一清就把用户的 2027-07 清没了。
    // 标签序号只要同名字段集合不变就稳定，且重置成本低。
    const labelSeen = {};
    plan.all.forEach(function (p) {
      if (!p.suggestedPath) return;
      const v = String(p.suggestedValue == null ? '' : p.suggestedValue);
      const lb = String(p.label || '').replace(/\s+/g, ' ').trim();
      labelSeen[lb] = (labelSeen[lb] || 0) + 1;
      const labelOrd = labelSeen[lb] - 1;
      // 和弹窗同一套规则：只动「页面为空 + 简历里有值」的字段
      if (p.empty && v.trim() && lb) {
        items.push({
          id: p.id, label: lb, path: p.suggestedPath, value: v,
          selector: p.selector, selectorNth: 0, labelOrd: labelOrd
        });
        const rk = lb + '#' + labelOrd;
        if (!restore[rk]) {
          // 「至今」填的是一个勾选框，不是输入值 —— 清理时绝不能去「清空这个日期字段」，
          // 那会把同名的别块（项目块/教育块）清掉。它由「还原至今勾选」那一步专门处理。
          restore[rk] = {
            selector: p.selector || '', nth: 0, label: lb, labelOrd: labelOrd,
            value: /^(至今|现在|今|present|now)$/i.test(v) ? PRESENT_MARK : ''
          };
        }
      } else if (p.selector) {
        skipSelectors[p.selector] = 1;
      }
    });

    if (!items.length) {
      note('当前页面上没有「空的 + 简历里有值」的字段，这一段没被真正执行' +
        '（想让它有事可做：把页面上某个可填字段清空后重跑）');
    } else {
      console.log('  将填入 ' + items.length + ' 个：' +
        items.map(function (i) { return i.label + '←' + i.value; }).join('，').slice(0, 140));
      // 填之前先记下「至今」的原始状态，免得清理时把用户自己勾的取消掉
      presentBefore = ((await C.evaluate(form, '(' + PRESENT_STATE.toString() + ')()')
        .catch(function () { return []; })) || []).map(function (x) { return x.checked; });
      const r = await toPage(ext, tabId, { type: 'RJ_FILL', items: items, skipSelectors: skipSelectors });
      indexPlan(r);

      const okList = (r.report || []).filter(function (x) { return x.ok; });
      const badList = (r.report || []).filter(function (x) { return !x.ok; });
      note('填充报告：成功 ' + okList.length + ' · 失败 ' + badList.length +
        (badList.length ? '（' + badList.map(function (x) { return x.label + ':' + (x.error || '?'); }).join('；').slice(0, 140) + '）' : ''));

      // 逐字段核对：读回值必须和期望一致。
      // 优先按 selector 读那一个控件 —— 按标签读在重复块里会拿到同名的另一个块。
      const wrong = [];
      const presentItems = [];
      for (const it of items) {
        // 「至今」不是填进控件的值，而是一个勾选框 —— 换一种核对方式
        if (/^(至今|现在)$/.test(String(it.value).trim())) { presentItems.push(it); continue; }
        let got = await domValueBySelector(form, it.selector, it.selectorNth);
        if (got === null) got = valOf(it.label);
        if (got === null) { wrong.push(it.label + '=字段消失'); continue; }
        if (String(got).indexOf(String(it.value)) === -1) {
          wrong.push(it.label + ' 期望"' + String(it.value).slice(0, 20) + '" 实际"' + String(got).slice(0, 20) + '"');
        }
      }
      check('填入的值读回后与期望一致（' + (items.length - presentItems.length) + ' 个字段）',
        wrong.length === 0, wrong.join('；').slice(0, 200));

      if (presentItems.length) {
        const st = await C.evaluate(form, '(' + PRESENT_STATE.toString() + ')()')
          .catch(function () { return []; });
        const on = (st || []).filter(function (x) { return x.checked; }).length;
        check('结束时间「至今」已勾上勾选框', on >= 1,
          '页面里 ' + (st || []).length + ' 个「至今」，已勾 ' + on + ' 个');
      }
      check('至少有一个字段真的填进去了', okList.length >= 1, '成功 ' + okList.length + ' 个');
    }

    // C2：确定性端到端 —— 挑一个「简历里有值 + 普通输入框」的字段，先清空，
    // 再让扩展按简历把它填回来。为什么要多这一步：页面上常常一个空字段都没有
    // （账号预填了、或者上次跑过），C 段就空转了 —— 而**空转的门禁等于没有门禁**，
    // 所以这里主动造出一个空字段，保证这一路（简历 → 规则 → 写入 → 读回）每次都被真正走到。
    const probe = (function () {
      for (var i = 0; i < plan.all.length; i++) {
        const p = plan.all[i];
        const v = String(p.suggestedValue == null ? '' : p.suggestedValue);
        if (!p.suggestedPath || !v.trim()) continue;
        if (p.tag !== 'input' || p.component) continue;
        if (p.type === 'file' || p.type === 'radio' || p.type === 'checkbox') continue;
        if (!String(p.label || '').trim()) continue;
        return p;
      }
      return null;
    })();

    if (!probe) {
      note('找不到「简历里有值 + 普通输入框」的字段，端到端这一段跳过' +
        '（简历里至少要有姓名 / 手机 / 邮箱这类信息）');
    } else {
      const lb = String(probe.label).replace(/\s+/g, ' ').trim();
      const want = String(probe.suggestedValue);
      const probeKey = lb + '#0';
      if (!restore[probeKey]) {
        restore[probeKey] = {
          selector: probe.selector || '', nth: 0, label: lb, labelOrd: 0,
          value: String(probe.currentValue || '')
        };
      }
      const keepValue = restore[probeKey].value;
      console.log('  用「' + lb + '」走端到端：清空 → 按简历填回「' + want + '」');

      await closePanels();
      indexPlan(await toPage(ext, tabId, { type: 'RJ_CLEAR', ids: [probe.id] }));
      const cleared = valOf(lb);
      check('端到端：先把「' + lb + '」清空', cleared !== null && !String(cleared).trim(),
        '清空后 = ' + JSON.stringify(cleared));

      const e2 = fieldOf(lb);
      if (!e2) {
        check('端到端：清空后还能找到「' + lb + '」', false, '重扫后扫描里没有这个字段了');
      } else {
        const r2 = await toPage(ext, tabId, {
          type: 'RJ_FILL',
          items: [{ id: e2.id, label: lb, path: e2.suggestedPath, value: want }],
          skipSelectors: {}
        });
        indexPlan(r2);
        const got = valOf(lb);
        const rep2 = (r2.report || [])[0] || {};
        check('端到端：「' + lb + '」按简历填回「' + want + '」并读回一致',
          String(got == null ? '' : got).indexOf(want) !== -1,
          '读回 = ' + JSON.stringify(got) + '  via=' + (rep2.via || '-') + '  错误=' + (rep2.error || '无'));
        note('这一段跑完会把「' + lb + '」还原成「' + keepValue + '」');
      }
    }

    // ================= D. 安全红线 =================
    console.log('\n--- D. 安全红线：原有内容不得被改动 ---');
    indexPlan(await toPage(ext, tabId, { type: 'RJ_SCAN' }));
    const nowSnap = await domSnapshot(form);
    const changed = [];
    if (!nowSnap) {
      changed.push('页面快照读不到（不能当通过）');
    } else {
      // 只核对「基准里原本就有值」的字段：C 段本来就要往空字段里填东西，
      // 空 → 有值是正常行为，不该算改动。
      filledKeys.forEach(function (k) {
        const b = base[k];
        const n = nowSnap[k];
        if (!n) { changed.push(b.key + '=页面里读不到了'); return; }
        if (n.value !== b.value) changed.push(b.key + ':"' + b.value + '"→"' + n.value + '"');
      });
      if (!filledKeys.length) changed.push('基准里没有任何有值的字段（红线形同虚设）');
    }
    check('页面上原有内容的 ' + filledKeys.length + ' 个字段一字未变', changed.length === 0,
      changed.join('；').slice(0, 300));

  } finally {
    // ================= 清理（必须在 finally 里）=================
    //
    // 每一步**单独容错**：清理过程中任何一步出错（最典型的是页面主线程被占住、
    // 命令超时）都不许中断后面的步骤 —— 尤其**不许因此跳过最后的残留检查**。
    // 这条是被真实故障逼出来的：有一次真实鼠标清空后命令超时，异常直接把残留检查
    // 跳过了，于是「到底清干净没有」变成了未知数。核对比动作重要。
    console.log('\n--- 清理 ---');

    /** 跑一步清理动作：出错只记一笔，不往外抛 */
    const stepSafe = async function (name, fn) {
      try {
        return await fn();
      } catch (e) {
        note('清理步骤「' + name + '」出错（不影响后面的核对）：' +
          String((e && e.message) || e).slice(0, 90));
        return null;
      }
    };

    if (KEEP) {
      console.log('  --keep：跳过清理。注意：测试值还留在页面上，记得自己清。');
    } else {
      const entries = Object.keys(restore).map(function (k) { return restore[k]; });
      if (entries.length) {
        // 按 selector 认字段（重复块里「开始时间」有 5 个，按标签会认错人）；
        // selector 失效才退回标签，并在结果里说明是哪一种。
        // 按「标签 + 第几次出现」认字段。为什么不用 selector：
        // 它在页面上不唯一，且两次扫描之间第 n 个会错位（把工作块认成教育块1，一清就清错）。
        const fieldFor = function (item) {
          let n = 0;
          for (let i = 0; i < plan.all.length; i++) {
            const p = plan.all[i];
            const pLabel = String(p.label || '').replace(/\s+/g, ' ').trim();
            if (pLabel !== item.label) continue;
            if (n === (item.labelOrd || 0)) return p;
            n++;
          }
          return entryByLabel(item.label);
        };
        const readItem = async function (item) {
          const byDom = await C.evaluate(form,
            '(' + DOM_VALUE_BY_LABEL.toString() + ')(' +
            JSON.stringify(item.label) + ',' + (item.labelOrd || 0) + ')'
          ).catch(function () { return null; });
          return byDom === null ? valOf(item.label) : byDom;
        };
        // 第一步：只清「原本就是空的」字段。
        //
        // 「原本有值」的字段**不要先清空再填回去** —— 那是白折腾，而且有风险：
        // 万一填回失败，用户原本好好的字段就被清空了（数据损失）。
        // 它们本来就该保持原样（C 段那条是「清空 → 按同值填回」，值跟原来一致，
        // 所以这里只需要在下面核对一下有没有被改动）。
        await stepSafe('收起浮层', closePanels);
        const toClear = entries.filter(function (it) { return !String(it.value || '').trim(); });
        const ids = toClear.map(function (it) {
          const e = fieldFor(it);
          return e ? e.id : null;
        }).filter(Boolean);
        if (ids.length) {
          await stepSafe('扩展清空', async function () {
            indexPlan(await toPage(ext, tabId, { type: 'RJ_CLEAR', ids: ids }));
          });
        }

        // 第二步：没清掉的用真实鼠标兜底（清除图标靠 CSS :hover，合成事件触发不了）
        for (const it of toClear) {
          await stepSafe('真实鼠标清空「' + it.label + '」', async function () {
            const now = await readItem(it);
            if (now !== null && !String(now).trim()) return;    // 扩展已经清掉了
            const rm = await realMouseClear(form, it.label);
            note(rm.ok
              ? '“' + it.label + '”扩展清不掉，改用真实鼠标兜底清空'
              : '“' + it.label + '”真实鼠标也没清掉：' + rm.error);
          });
        }
        await stepSafe('收起浮层', closePanels);
        await stepSafe('重新扫描', async function () {
          indexPlan(await toPage(ext, tabId, { type: 'RJ_SCAN' }));
        });

        // 第三步：原本非空（用户自己填过）的，要填回原值
        for (const it of entries) {
          const want = String(it.value || '');
          if (!want.trim() || want === PRESENT_MARK) continue;
          const now = await readItem(it);
          if (now === null || String(now).trim() === want.trim()) continue;
          await stepSafe('把「' + it.label + '」还原成原值', async function () {
            const e = fieldFor(it);
            if (!e) return;
            indexPlan(await toPage(ext, tabId, {
              type: 'RJ_FILL',
              items: [{ id: e.id, label: it.label, path: e.suggestedPath || '', value: want }],
              skipSelectors: {}
            }));
            const back = await readItem(it);
            check('“' + it.label + '”已还原成原值「' + want + '」',
              String(back == null ? '' : back).indexOf(want) !== -1, '实际 = ' + JSON.stringify(back));
          });
        }

        // 第三步半：把测试勾上的「至今」取消（原本就勾着的绝不动）
        await stepSafe('还原「至今」勾选', async function () {
          const nowSt = (await C.evaluate(form, '(' + PRESENT_STATE.toString() + ')()')
            .catch(function () { return []; })) || [];
          for (let i = 0; i < nowSt.length; i++) {
            if (nowSt[i].checked && presentBefore[i] === false) {
              const done = await C.evaluate(form, '(' + PRESENT_UNCHECK.toString() + ')(' + i + ')');
              note('取消「至今」勾选（第 ' + (i + 1) + ' 个）：' + (done ? 'ok' : '没点到'));
              await sleep(250);
            }
          }
        });

        // 第四步：残留检查。**无论前面哪一步出错都要跑到** ——
        // 「读不到 / 核不了」算失败，不能当通过。
        const residue = [];
        for (const it of entries) {
          const want = String(it.value || '');
          if (want === PRESENT_MARK) continue;      // 勾选框由「还原至今勾选」那一步负责
          const now = await readItem(it);
          if (now === null) { residue.push(it.label + '：扫描里找不到，无法确认是否干净'); continue; }
          if (String(now).trim() !== want.trim()) {
            residue.push(it.label + ' 期望' + JSON.stringify(want) + ' 实际' + JSON.stringify(now));
          }
        }
        check('清理后无残留（' + entries.length + ' 个字段）', residue.length === 0,
          residue.join('；').slice(0, 220) +
          (residue.length ? '　→ 这几个字段请手工核对一下' : ''));
      } else {
        note('没有需要还原的字段');
      }
    }

    // 关掉本用例开出来的扩展页面。绝不给用户的浏览器留标签 ——
    // 上一次留下的是几个 ERR_BLOCKED_BY_CLIENT 报错页，看着像扩展坏了。
    try { await E.closePages(); } catch (e) { /* ignore */ }
    try { if (ext) ext.close(); } catch (e) { /* ignore */ }
    try { form.close(); } catch (e) { /* ignore */ }
    try { browser.close(); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 汇总
  const failed = results.filter(function (r) { return !r.ok; });
  const passed = results.filter(function (r) { return r.ok && !r.soft; });
  console.log('\n============================');
  console.log('通过 ' + passed.length + ' / 失败 ' + failed.length);
  console.log(failed.length ? '❌ 真实投递页门禁未通过' : '✅ 真实投递页门禁通过');
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  const clean = async function () {
    await E.closePages().catch(function () { /* ignore */ });
  };
  if (e instanceof SkipError) {
    await clean();
    console.log('\n⚠️  未执行（SKIP）：' + e.message);
    console.log('这条用例**没有验证任何东西**，不要当成通过。');
    process.exit(2);
  }
  await clean();
  console.log('\n运行异常：' + String((e && e.stack) || e).slice(0, 600));
  process.exit(1);
});
