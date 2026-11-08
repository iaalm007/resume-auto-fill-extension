/**
 * 与后台 Service Worker 通信的统一入口（popup / options 共用）。
 *
 * 为什么要单独包一层，而不是各处直接 chrome.runtime.sendMessage：
 *
 * MV3 的 Service Worker 空闲约 30 秒就被回收，扩展一重载、已打开的扩展页面立即失效。
 * 这两种情况下 sendMessage 都会报同一句话：
 *   "Could not establish connection. Receiving end does not exist."
 *
 * 这句话对用户毫无信息量，而且两种情况的处理方式完全不同：
 *   - 后台被回收 → 重发一次就能唤醒它（第一次唤醒时监听器还没注册完）
 *   - 页面已失效 → 重发多少次都没用，必须关掉重开
 * 所以这里先分类、再决定要不要重试，最后把原因翻译成人话。
 */
(function (root) {
  if (root.__RJ_BG__) return;

  var INVALIDATED = /Extension context invalidated|context invalidated/i;
  var NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;

  function classify(msg) {
    var m = String(msg || '');
    if (INVALIDATED.test(m)) return 'invalidated';
    if (NO_RECEIVER.test(m)) return 'no-receiver';
    return 'other';
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /** 发一次，不重试。用回调写法包一层，避免后台不在时抛未捕获的 Promise 拒绝 */
  function once(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          var err = chrome.runtime.lastError;
          if (err) {
            var m = String(err.message || err);
            return resolve({ ok: false, code: classify(m), error: m });
          }
          resolve(res || { ok: false, code: 'empty', error: '后台无响应' });
        });
      } catch (e) {
        var m2 = String((e && e.message) || e);
        resolve({ ok: false, code: classify(m2), error: m2 });
      }
    });
  }

  /**
   * 发消息给后台；只在「接收方不存在」时重试。
   * 注意不重试「message port closed」—— 那说明监听器收到了但没回，是代码问题，重试只会掩盖它。
   */
  function send(msg, opts) {
    opts = opts || {};
    var tries = opts.tries || 3;
    var base = opts.delay || 300;
    var attempt = 0;

    function go() {
      attempt++;
      return once(msg).then(function (r) {
        if (r.ok || r.code !== 'no-receiver' || attempt >= tries) {
          if (r.ok) r.attempts = attempt;
          return r;
        }
        return sleep(base * attempt).then(go);
      });
    }
    return go();
  }

  /** 把 chrome 的原始报错翻译成用户能照着做的说法 */
  function friendly(r) {
    if (!r) return '后台无响应';
    if (r.code === 'invalidated') {
      return '扩展刚被重新加载过，当前这个页面已经失效。请关掉本页面重新打开（或按 F5 刷新）。';
    }
    if (r.code === 'no-receiver') {
      return '连不上扩展后台。请到 chrome://extensions 对本扩展点一次「重新加载」，' +
        '然后关掉本页面重新打开。';
    }
    return r.error || '后台无响应';
  }

  root.__RJ_BG__ = {
    classify: classify,
    once: once,
    send: send,
    friendly: friendly
  };
})(typeof self !== 'undefined' ? self : this);
