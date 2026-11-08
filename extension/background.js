/**
 * Service Worker：
 *   1. 首次安装时打开设置页
 *   2. 消息转发 —— 把 AI 兜底匹配的请求交给 shared/ai-map.js，并做统一错误包装
 *
 * 为什么 AI 调用放在后台而不是页面里：
 *   - content script 跑在目标网站的环境里，把 API key 放那里不合适；
 *   - 后台不受目标页面 CSP 约束；
 *   - 并发控制与缓存集中在后台 —— 多个标签页同时扫描时，由这里统一排队，
 *     不会各自为政地把接口打爆（限流、退避、信号量都在 ai-map.js 里）。
 *
 * 注意 MV3 的生命周期：Service Worker 空闲约 30 秒会被回收。
 * 有 fetch 在挂起时不会回收，所以「排队等槽位 + 请求中」这段时间是安全的；
 * 但跨标签页的请求队列是内存态的，SW 被回收后队列即清空 —— 这没关系，
 * 那些标签页下次扫描会重新发起。
 */
importScripts('shared/ai-config.js', 'shared/profile-store.js', 'shared/ai-map.js');

function reply(promise, sendResponse) {
  promise.then(sendResponse, function (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  // 监听器里同步抛错会让发送方一直等（表现为「message port closed」这类没头没尾的报错），
  // 所以统一兜住，回一条能看懂的错误。
  try {
    // 用 self. 前缀而不是裸标识符：importScripts 装的都是全局属性，写清楚更不易踩坑
    var AI_MAP = self.__RJ_AI_MAP__;
    if (!AI_MAP) {
      sendResponse({ ok: false, error: '后台脚本未正确加载（shared/ai-map.js 缺失或启动失败）' });
      return;
    }

    // 设置页用它探「后台是否活着」—— 接口通不通和后台通不通是两件事
    if (msg.type === 'RJ_PING_BG') {
      sendResponse({ ok: true, at: Date.now() });
      return;
    }

    if (msg.type === 'RJ_AI_MAP') {
      // examples = 本页已被规则解出的字段，给模型类比这个网站的标签写法用
      reply(AI_MAP.handleMap(msg.fields, { examples: msg.examples }), sendResponse);
      return true;
    }

    if (msg.type === 'RJ_AI_TEST') {
      reply(AI_MAP.testConnection(), sendResponse);
      return true;
    }

    if (msg.type === 'RJ_AI_CLEAR_CACHE') {
      reply(AI_MAP.clearCache().then(function () { return { ok: true }; }), sendResponse);
      return true;
    }
  } catch (e) {
    sendResponse({ ok: false, error: '后台处理 ' + msg.type + ' 时出错：' + ((e && e.message) || e) });
  }
});

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
