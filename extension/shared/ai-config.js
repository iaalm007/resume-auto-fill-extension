/**
 * AI 辅助匹配的配置。
 *
 * 刻意挂到 self 而不是 window：这样既能被扩展页面（popup / options）以普通 <script> 加载，
 * 也能被后台 Service Worker 用 importScripts() 复用同一份定义，不用维护两份默认值。
 *
 * 兼容任何 OpenAI 格式的 /chat/completions 接口：
 *   OpenAI / DeepSeek / 通义千问 / Moonshot / 智谱 / 本地 Ollama ...
 */
(function (root) {
  if (root.__RJ_AI__) return;

  var KEY = 'rj_ai_config';

  var DEFAULT = {
    enabled: false,
    // 默认用智谱的 flash：当前免费，不用绑卡充值。
    // 这个任务的用量极小（绝大多数字段走规则和缓存），flash 级别完全够；
    // 不要选带思考模式的旗舰模型（如 GLM-5.3），延迟和输出 token 都是十几倍，纯浪费。
    //
    // 选模型时除了「够用」，**必须看并发上限** —— 官方限流的口径就是并发数
    // （见 docs.bigmodel.cn/cn/api/rate-limit）。控制台「当前速率限制」页会逐个模型
    // 列出并发数，实测同一账户里有的模型只有 1~2、有的能到 20~50。
    // 选 1~2 那种，稍有一点重叠（弹窗直连与后台同时在跑、同一把 Key 还有别的程序在用、
    // 高峰期动态限流）就会报 1302；而 1302 的处置办法里，换一个并发额度更高的模型最省事。
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5-flash',
    apiKey: '',
    timeoutMs: 15000,      // 单次请求超时
    maxFieldsPerCall: 40   // 一次最多让模型处理多少个字段
  };

  function normalize(cfg) {
    var out = {};
    Object.keys(DEFAULT).forEach(function (k) {
      out[k] = (cfg && cfg[k] !== undefined && cfg[k] !== null) ? cfg[k] : DEFAULT[k];
    });
    out.baseUrl = String(out.baseUrl || '').replace(/\/+$/, '');
    out.model = String(out.model || '').trim();
    out.apiKey = String(out.apiKey || '').trim();
    out.timeoutMs = Math.max(3000, Math.min(60000, Number(out.timeoutMs) || DEFAULT.timeoutMs));
    out.maxFieldsPerCall = Math.max(1, Math.min(80, Number(out.maxFieldsPerCall) || DEFAULT.maxFieldsPerCall));
    out.enabled = !!out.enabled;
    return out;
  }

  function get() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([KEY], function (res) {
        resolve(normalize(res && res[KEY]));
      });
    });
  }

  function save(cfg) {
    var norm = normalize(cfg);
    return new Promise(function (resolve) {
      var data = {};
      data[KEY] = norm;
      chrome.storage.local.set(data, function () { resolve(norm); });
    });
  }

  /** 判断配置是否「可用」：开关打开 + 地址/模型/密钥都填了 */
  function isUsable(cfg) {
    cfg = cfg || {};
    return !!(cfg.enabled && cfg.baseUrl && cfg.model && cfg.apiKey);
  }

  root.__RJ_AI__ = {
    KEY: KEY,
    DEFAULT: DEFAULT,
    normalize: normalize,
    get: get,
    save: save,
    isUsable: isUsable
  };
})(typeof self !== 'undefined' ? self : this);
