/**
 * 诊断日志：往页面控制台打 [RJ] 前缀的日志，同时在内存里留一份环形缓冲。
 *
 * 缓冲的用途：出问题时在弹窗里点「复制诊断信息」，把完整现场（扫描结果 + 日志 +
 * 未匹配字段的 HTML）一次拿走，不用让用户去翻 DevTools。
 */
(function () {
  if (window.__RJ_LOG__) return;

  var MAX = 300;
  var buf = [];

  function fmt(v) {
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function log(tag, data) {
    var line = stamp() + '  ' + tag + (data === undefined ? '' : '  ' + fmt(data));
    buf.push(line);
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    try { console.log('[RJ] ' + line); } catch (e) { /* ignore */ }
  }

  window.__RJ_LOG__ = {
    log: log,
    all: function () { return buf.slice(); },
    clear: function () { buf.length = 0; }
  };
})();
