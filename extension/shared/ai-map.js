/**
 * AI 兜底匹配的核心逻辑（后台 Service Worker 与测试都复用这一份）。
 *
 * 职责：规则层没命中的字段，连同它们的 DOM 骨架一起交给模型判断。
 *
 * 为什么要把 DOM 骨架也发出去：规则层失败最常见的原因不是「词典缺词」，
 * 而是「标签根本没提取到」—— 页面上每个框都只有 placeholder="请输入"。
 * 这种情况只发 label 是没用的，模型看到的是一堆「请输入」，照样判断不出来。
 *
 * 依赖：__RJ_AI__（配置）、__RJ_STORE__（schema 白名单）、chrome.storage.local、fetch。
 *
 * 隐私约定：只发「页面上的字段标签与 DOM 结构」。
 *   不发输入框里的任何 value、也不发简历内容 —— 前者是为了防模型被用户自己的数据带偏
 *   （表单里预填了「张三」，模型就倾向于把这个框判成 basic.name）。
 */
(function (root) {
  if (root.__RJ_AI_MAP__) return;

  var CACHE_KEY = 'rj_ai_cache';
  var CACHE_MAX = 600;
  // 「简历里没有这个字段」这种**否定结论**只在一天内算数。
  //
  // 不定 TTL 的话它就是个单向门：用户看到「简历里没有对应字段」，
  // 去资料页把它补上，回来重扫 —— 缓存照旧命中，永远显示没有，只能手动清缓存。
  // 正向结论（有路径）不需要过期：路径本身不会因为时间而变错。
  var NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

  // 并发：一次同时最多发几个请求。
  //
  // 设成 1 而不是 2，是因为**官方限流的口径就是「并发数」**：智谱的速率限制文档
  // 只定义了这一个维度（「并发数 = 同一时刻正在处理中的请求数量」），
  // 上限按「用户权益等级 + 具体模型」而定，撞业务码 1302 基本就是并发打满。
  // 而这件事我们是**跨上下文**做的：后台 SW 一份信号量、每个直连的弹窗/标签页各一份
  // —— 2 个标签页各发 1 个，账户维度就是 2 并发，照样超。
  // 串行的代价只是慢一点（多个标签页 ≈ 依次排队），换来的是不再无谓地撞 1302。
  var MAX_CONCURRENT = 1;
  var MAX_RETRY = 3;
  var RETRY_BASE_MS = 800;
  // 服务端给了 Retry-After 时，只在这个时间内才值得等；超过就别干等了，直接告诉用户
  var MAX_RETRY_AFTER_MS = 5000;

  // 路径 -> 给模型看的含义。
  //
  // 数组型字段（教育/工作/项目经历）用 [*] 表示「第几段」，**由模型原样返回模板**：
  // 段号只能靠页面上字段的先后顺序算（内容脚本按锚点切块），模型看不到整页顺序，
  // 让它自己写序号必然错位。弹窗拿到模板后会回内容脚本解析成 education.1.school。
  var FIELD_LABELS = {
    'basic.name': '姓名',
    'basic.gender': '性别',
    'basic.birthday': '出生日期 / 生日',
    'basic.phone': '手机号 / 联系电话',
    'basic.email': '电子邮箱',
    'basic.idCard': '身份证号 / 证件号码',
    'basic.location': '现居城市 / 所在城市 / 居住地',
    'basic.wechat': '微信号',
    'basic.politicalStatus': '政治面貌',
    'basic.expectedCity': '期望工作城市 / 意向城市（注意：不等于现居城市）',
    'basic.expectedPosition': '期望职位 / 期望从事职业 / 意向岗位',
    'basic.expectedIndustry': '期望从事行业 / 意向行业',
    'basic.workYears': '工作年限 / 从业年限',
    'basic.currentSalary': '现月薪 / 当前薪资（税前）',
    'basic.expectedSalary': '期望月薪 / 期望薪资（税前）',
    'basic.availableFrom': '到岗时间 / 可入职时间',
    'skills': '专业技能（多项技能）',
    'selfEvaluation': '自我评价 / 自我介绍 / 个人简介',

    // ---- 重复区块：教育 / 工作 / 项目 ----
    // 注意路径里的 [*] 要原样输出，不要写具体序号。
    'education[*].school': '学校名称（教育经历）',
    'education[*].major': '专业名称（教育经历）',
    'education[*].degree': '学历 / 学位（教育经历）',
    'experience[*].company': '公司名称 / 工作单位（工作经历）',
    'experience[*].title': '职位名称 / 岗位（工作经历）',
    'projects[*].name': '项目名称（项目经历）',
    '[*].startDate': '开始时间（教育/工作/项目共用，属于哪一段由页面顺序决定）',
    '[*].endDate': '结束时间 / 毕业时间（共用）',
    '[*].description': '工作职责 / 项目描述（共用）',
    '[*].role': '项目职务 / 担任角色（共用）'
  };

  var SYSTEM_PROMPT =
    '你是招聘网站表单字段的映射助手。用户维护着一份结构化简历，' +
    '你要判断页面上的输入框应该填简历里的哪个字段。\n' +
    '\n' +
    '输入里各字段的含义：\n' +
    '- labelSource 表示标签是从哪里提取到的。' +
    '值为 placeholder / none 时，说明这个网页的标签没被提取到，' +
    'label 里那个词（多半是「请输入」）没有意义，' +
    '此时必须靠 skeleton 推断它在问什么，并把结论写进输出的 label 字段。' +
    '其它值时 label 可信，直接用它判断即可。\n' +
    '- skeleton 是该输入框从自身往上每一层的 DOM 骨架，例如：\n' +
    '    第0层 <input.el-input__inner> 前兄弟[无] 自身文本=""\n' +
    '    第1层 <div.el-form-item> 前兄弟[div="姓名"] 自身文本=""\n' +
    '  「前兄弟」是同级前面元素的文本，标签通常就在其中；' +
    '「自身文本」是这一层剥掉所有控件后剩下的文字。\n' +
    '- resolvedExamples 是同一个页面上已经被规则成功解出的字段，' +
    '它展示了这个网站把标签写在哪、怎么写，可以用来类比。\n' +
    '\n' +
    '规则：\n' +
    '1. 只输出 JSON 数组，不要任何解释、前后缀或代码块标记。\n' +
    '2. path 只能取「简历可用字段」里列出的路径之一；确实没有对应字段时用 null。\n' +
    '3. confidence 是 0 到 1 的小数，表示你的把握程度。\n' +
    '4. 注意区分：姓名不要错认成公司名/项目名；联系电话不要错认成紧急联系人电话；' +
    '邮箱不要错认成邮编；学校名不要错认成公司名。\n' +
    '5. 不要臆测。skeleton 里找不到可靠依据时，path 给 null 并给出较低的 confidence。\n' +
    '6. 路径里带 [*] 的是「教育 / 工作 / 项目经历」这类重复区块的字段：' +
    '遇到就把模板原样返回（例如 "education[*].school"），' +
    '**不要自己写第几段** —— 段号由页面顺序决定，你写了的会被丢弃。';

  /** 数组路径的块名：'education[*].school' → 'education'；'[*].startDate' → '*'；其它 → null */
  function arrayBlockOf(path) {
    var s = String(path || '');
    var m = /^([A-Za-z]+)\[\*\]\./.exec(s);
    if (m) return m[1];
    if (s.indexOf('[*]') === 0) return '*';
    return null;
  }

  /** 只允许映射到 schema 里真实存在的路径，防止模型编造 */
  function allowedPaths() {
    var schema = root.__RJ_STORE__ && root.__RJ_STORE__.DEFAULT_PROFILE;
    if (!schema) return [];
    return Object.keys(FIELD_LABELS).filter(function (path) {
      var block = arrayBlockOf(path);
      if (block === '*') {
        // 中性字段（开始/结束时间、职责）：只要简历里有任意一类经历就能用
        return ['education', 'experience', 'projects'].some(function (k) {
          return Array.isArray(schema[k]);
        });
      }
      if (block) return Array.isArray(schema[block]);

      var parts = path.split('.');
      if (parts.length === 1) return Object.prototype.hasOwnProperty.call(schema, parts[0]);
      return !!(schema[parts[0]] &&
        Object.prototype.hasOwnProperty.call(schema[parts[0]], parts[1]));
    });
  }

  /** 只把这些信息发给模型（不含任何 value） */
  function slimField(f) {
    var out = {
      id: String(f.id || ''),
      label: String(f.label || '').slice(0, 60),
      labelSource: String(f.labelSource || 'none').slice(0, 20),
      placeholder: String(f.placeholder || '').slice(0, 60),
      htmlName: String(f.htmlName || '').slice(0, 60),
      type: String(f.type || '').slice(0, 30),
      options: Array.isArray(f.options)
        ? f.options.slice(0, 8).map(function (o) { return String(o).slice(0, 20); })
        : []
    };
    if (Array.isArray(f.skeleton) && f.skeleton.length) {
      out.skeleton = f.skeleton.slice(0, 6).map(function (s) { return String(s).slice(0, 160); });
    }
    return out;
  }

  function buildSystemPrompt() { return SYSTEM_PROMPT; }

  function buildUserPrompt(fields, examples) {
    var lines = allowedPaths().map(function (path) {
      return path + ' = ' + FIELD_LABELS[path];
    });
    var exampleLines = (examples || []).slice(0, 12).map(function (e) {
      return '{"label":"' + String(e.label || '').slice(0, 30) +
        '","labelSource":"' + String(e.labelSource || 'none') +
        '","type":"' + String(e.type || '') + '"}';
    });
    return '【简历可用字段】（路径 = 含义）\n' + lines.join('\n') +
      (exampleLines.length
        ? '\n\n【本页已被规则解出的字段（用来类比这个网站的标签写法）】\n[' +
          exampleLines.join(',') + ']'
        : '') +
      '\n\n【需要判断的输入框】\n' + JSON.stringify(fields) +
      '\n\n【输出格式】\n' +
      '[{"id":"rj_3","label":"紧急联系人手机号","path":null,"confidence":0.9,' +
      '"reason":"标签是紧急联系人手机号，简历里没有对应字段"}]' +
      '\n注意：每个输入框都要给出一条结果；path 只能取上面列出的路径之一，或 null。';
  }

  // ------------------------------------------------------------------ 并发与重试

  var running = 0;
  var waiting = [];

  /** 简易信号量：同时最多 MAX_CONCURRENT 个请求在跑，其余排队 */
  function withSlot(task) {
    return new Promise(function (resolve, reject) {
      waiting.push({ task: task, resolve: resolve, reject: reject });
      pump();
    });
  }

  function pump() {
    while (running < MAX_CONCURRENT && waiting.length) {
      var item = waiting.shift();
      running++;
      Promise.resolve().then(item.task).then(
        function (v) { running--; item.resolve(v); pump(); },
        function (e) { running--; item.reject(e); pump(); }
      );
    }
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // ------------------------------------------------------------------ 频率闸
  //
  // 上面那个信号量管的是「**同时**几个请求在跑」，但它有个盲区：并发上限是
  // **账户维度**的，而我们的信号量是**每个上下文一份**（后台 SW、每个直连的弹窗各算各的）
  // —— 多开几个标签页，账户维度就不止 1 个并发了。
  // 所以这里再补一层按「每分钟总量」的闸，作为第二层刹车。
  //
  // 说明：这道闸**不是照官方数值设的**。官方速率限制文档只定义了「并发数」这一个口径，
  // 没有给 RPM / TPM（至少那一页没有）。它的价值是：① 撞过一次后别再持续往见底的配额上打；
  // ② 多上下文时兜一层总量。而且必须放在 chrome.storage 里：
  //   - 放在内存里只在「所有请求都走后台 SW」时有效；
  //     后台一旦被回收（空闲 30 秒），或者弹窗降级成**本页直连**，每个标签页就各算各的。
  //   - 放进存储才能做到「跨标签页 + 跨 SW 重启」同一个额度。
  //
  // 冷却期是最后一道保险：撞到 429 之后写一个静默期，
  // 所有上下文（含直连的标签页）读到它都会停下来，避免持续往见底的配额上打。

  var RATE_KEY = 'rj_ai_rate';
  var COOLDOWN_KEY = 'rj_ai_cooldown';
  var RATE_WINDOW_MS = 60000;
  var MAX_PER_MINUTE = 8;

  function storageGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
    });
  }

  function storageSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  }

  /** 当前处于冷却期则返回它，否则 null */
  function readCooldown() {
    return storageGet([COOLDOWN_KEY]).then(function (o) {
      var c = o[COOLDOWN_KEY];
      if (!c || !c.until || Date.now() >= c.until) return null;
      return c;
    });
  }

  /**
   * 领一个「本分钟的名额」。
   * @returns {Promise<{ok:boolean, waitMs?:number, cooldown?:boolean}>}
   *
   * 已知不足：跨标签页的 read-modify-write 不是原子的，多个标签页同一瞬间
   * 开弹窗时可能略微超出上限几个。这里不引入分布式锁（成本不划算），
   * 真正的兜底是下面的 429 冷却 —— 一旦真被限流，所有上下文立刻一起停。
   */
  function takeRateSlot() {
    return readCooldown().then(function (cd) {
      if (cd) return { ok: false, cooldown: true, waitMs: cd.until - Date.now() };
      return storageGet([RATE_KEY]).then(function (o) {
        var s = o[RATE_KEY];
        var now = Date.now();
        if (!s || !s.windowStart || now - s.windowStart >= RATE_WINDOW_MS) {
          s = { windowStart: now, count: 0 };
        }
        if (s.count >= MAX_PER_MINUTE) {
          return { ok: false, waitMs: RATE_WINDOW_MS - (now - s.windowStart) };
        }
        s.count++;
        var data = {};
        data[RATE_KEY] = s;
        return storageSet(data).then(function () { return { ok: true }; });
      });
    });
  }

  /** 撞到 429（或本地限流）后写静默期，让**所有**上下文一起停下来 */
  function markRateLimited(ms) {
    var data = {};
    data[COOLDOWN_KEY] = { until: Date.now() + (ms || RATE_WINDOW_MS), at: Date.now() };
    return storageSet(data);
  }

  function clearRateLimit() {
    return storageSet({ rj_ai_rate: null, rj_ai_cooldown: null });
  }

  function formatWait(ms) {
    return Math.max(1, Math.ceil(ms / 1000));
  }

  /** 被本地闸拦下时的说明。刻意不带「速率限制 / 429」这些词 ——
   *  那句话是给「接口报的错」用的，混在一起会让人分不清是谁拦的。 */
  function throttleMessage(slot) {
    var sec = formatWait(slot && slot.waitMs);
    if (slot && slot.cooldown) {
      return '接口刚返回过限流，本地已静默 ' + sec + ' 秒（所有标签页共用这段冷却），稍后再试。';
    }
    return '本分钟已发满 ' + MAX_PER_MINUTE + ' 次请求，本地限流生效，约 ' + sec +
      ' 秒后可再试。这一层是为了避免把接口的每分钟配额打满（尤其同时开着多个标签页时）。';
  }

  /**
   * 只有「服务端错误 / 网络失败 / 超时」值得自动重试。
   * 4xx 参数类错误重试没意义；429 单独处理，见下。
   */
  function isRetryable(e) {
    if (!e) return false;
    if (typeof e.status === 'number') return e.status !== 429 && e.status >= 500;
    var m = String(e.message || '');
    return /超时|Failed to fetch|NetworkError|network|请求失败/.test(m);
  }

  function callWithRetry(cfg, fields, examples, attempt) {
    attempt = attempt || 1;
    return callLLM(cfg, fields, examples).catch(function (e) {
      // 429 是速率限制，不是网络抖动：一秒内重试必然还是 429，
      // 而且每次重试都在继续消耗本就见底的配额 —— 越重试越糟。
      // 所以默认**不重试**，把错误直接交出去让界面告诉用户「等一下再试」。
      // 唯一例外：服务端明确给了 Retry-After，且等得起。
      if (e && e.status === 429) {
        if (e.retryAfterMs != null && e.retryAfterMs <= MAX_RETRY_AFTER_MS && attempt < MAX_RETRY) {
          // 服务端明确说了「等这么久就还行」：只等这一小会儿再试一次。
          // 这一步**不写冷却** —— 写了会把自己也锁在外面，重试根本没机会发出去。
          return sleep(e.retryAfterMs).then(function () {
            return callWithRetry(cfg, fields, examples, attempt + 1);
          });
        }
        // 不再重试了：写一个静默期。这是唯一能覆盖「弹窗降级直连、每个标签页各算各的」
        // 那种情况的手段 —— 存储里的冷却，所有上下文都读得到。
        return markRateLimited().then(function () { throw e; });
      }
      if (!isRetryable(e) || attempt >= MAX_RETRY) throw e;
      // 指数退避 + 抖动，避免多个标签页同时重试撞在一起
      var wait = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
      return sleep(Math.min(wait, 10000)).then(function () {
        return callWithRetry(cfg, fields, examples, attempt + 1);
      });
    });
  }

  /**
   * 智谱在 **HTTP 429 这一个状态码**下面挂了一大家子业务错误码，
   * 光看 429 会把它们当成同一个问题、给出南辕北辙的建议。
   * 表来源：官方错误码表 https://docs.bigmodel.cn/cn/faq/api-code
   *         与速率限制说明 https://docs.bigmodel.cn/cn/api/rate-limit
   *
   * 最容易搞错的三条：
   *   1302 = **账户维度**的速率限制（并发数到上限 / 请求过密）→ 降低并发、排队
   *   1305 = **平台维度**的过载（「该模型当前访问量过大」，与你的调用无关）→ 等，拉长重试间隔
   *   1113 = 账户欠费 → 充值，等多久都没用
   * 说明：这张表是智谱的。若换成别的服务商，正好撞上同号，请以「接口原话」为准。
   */
  var API_CODES = {
    '1000': '身份验证失败：检查 API Key 是否填对。',
    '1001': '请求头里没带鉴权信息：接口地址可能不是 OpenAI 兼容路径。',
    '1003': '鉴权 Token 已过期，请重新生成 API Key。',
    '1005': '该账号开启了二次认证，需要先完成二次认证。',
    '1113': '账户已欠费，请充值后重试。这一条**等多久都没用**。',
    '1220': '当前账号无权访问这个接口：检查 Key 是否具备该模型的权限。',
    '1261': '请求内容过长（Prompt 超长）：本页未匹配的字段太多，先少选几个再试。',
    '1301': '内容安全拦截：输入里可能包含了敏感内容。',
    '1302': '账户已达速率限制（**账户维度**）：当前模型的**并发数**到了上限，' +
      '或短时间内请求过密。降低并发、让请求排队，或稍等一下再试。' +
      '并发额度按「用户权益等级」和具体模型而定，可在服务商控制台的「速率限制」页查看，' +
      '需要提升可提交速率限制调整申请。' +
      '另外注意：同一把 API Key 如果还有别的程序在用，占的是**同一个账户**的并发额度。',
    '1305': '模型侧当前访问量过大（**平台维度**）——**这不是你账号的问题**，换账号也一样。' +
      '稍后重试即可，并且要把重试间隔拉长，别高频重试。',
    '1308': '已达到本周期用量上限，额度会在接口给出的时间点自动重置。',
    '1309': '套餐已到期，续订后即可恢复。',
    '1310': '已达到每周 / 每月用量上限，额度会在接口给出的时间点自动重置。',
    '1311': '当前套餐未开放这个模型的权限。',
    '1313': '使用模式不符合公平使用策略，请求频率已被限制，需到个人中心申请解除。',
    '1314': '企业套餐已失效，请联系企业管理员。',
    '1315': '这把 API Key 只限企业编程套餐场景使用，需要换成对应产品类型的 Key。',
    '1316': '已达到 5 小时用量上限，且主账号余额不足，无法超额按量付费。',
    '1317': '已达到 7 天用量上限，且主账号余额不足，无法超额按量付费。',
    '1318': '已达到 5 小时用量上限，且已达子账号月消费上限。',
    '1319': '已达到 7 天用量上限，且已达子账号月消费上限。',
    '1320': '已达到 5 小时用量上限，且已达企业级月消费上限。',
    '1321': '已达到 7 天用量上限，且已达企业级月消费上限。'
  };

  /** 从错误正文里抠出业务错误码（智谱形如 {"error":{"code":"1302",...}}） */
  function businessCode(t) {
    var s = String(t || '');
    var m = s.match(/["']?code["']?\s*[:=]\s*["']?(\d{4})["']?/i);
    if (m) return m[1];
    // 有的中转 / 代理会把 code 字段吃掉、只留 message —— 那就按已知码逐个找
    for (var k in API_CODES) {
      if (new RegExp('\\b' + k + '\\b').test(s)) return k;
    }
    return '';
  }

  /**
   * 把接口错误翻译成用户能照着做的说法。
   * 各家返回的错误体格式都不一样（智谱是 {"error":{"code":"1302",...}}），
   * 所以**先按业务码判**，再看 HTTP 状态码与关键词兜底。
   *
   * 为什么顺序不能反：429 下面挂着「并发超了 / 平台过载 / 欠费 / 额度用尽 / 套餐到期」
   * 这些**处置方式完全不同**的原因。早先这里只看 429，于是把「每次都限流」猜成
   * 「多半是免费额度用尽或账户欠费」—— 而官方把欠费单列成 1113、额度用尽单列成
   * 1308/1310，1302 从来就不是额度问题。猜错方向比不说更糟：用户会跑去充值，
   * 而真正该做的是降并发。
   *
   * 无论走哪条分支，都把接口原话带上 —— 那是唯一的证据。
   */
  function explainError(errorText) {
    var t = String(errorText || '');
    var raw = (t.match(/接口返回 HTTP \d+[：:]([\s\S]*)$/) || [])[1] || '';
    var tail = function () { return raw ? '　接口原话：' + raw.slice(0, 150) : ''; };
    var httpStatus = (t.match(/接口返回 HTTP (\d+)/) || [])[1] || '';

    var code = businessCode(t);
    if (code && API_CODES[code]) {
      return '接口返回 HTTP ' + (httpStatus || '?') + '，业务码 ' + code + '：' +
        API_CODES[code] + tail();
    }

    if (/\b429\b|速率限制|频率|rate.?limit|too many requests/i.test(t)) {
      // 没有业务码时的兜底。这里**刻意不猜**「额度用尽 / 欠费」——
      // 那些情况服务端有专门的错误码，猜错了会把用户引到反方向。
      return '接口触发速率限制（HTTP 429）。先按「请求太快」处理：等一下再试，' +
        '并降低并发（别同时开多个窗口一起扫）。如果持续如此，到服务商控制台看' +
        '「速率限制 / 用量」页：是并发额度、套餐周期额度、还是余额问题 —— ' +
        '不同原因服务端会给不同的业务错误码，别只盯着 429。' + tail();
    }
    if (/\b401\b|unauthorized|invalid.*(api)?key|api key/i.test(t)) {
      return 'API Key 无效或已过期（401），请到服务商控制台重新生成。' + tail();
    }
    if (/\b403\b|forbidden|无权限|余额|quota/i.test(t)) {
      return '接口拒绝访问（403）：可能是 Key 没有该模型权限，或账户余额不足。' + tail();
    }
    if (/\b404\b|not found|模型不存在|model/i.test(t)) {
      return '接口或模型名不对（404）：检查「接口地址」是不是该服务商的 OpenAI 兼容地址、' +
        '「模型」名字是否拼写正确。';
    }
    if (/超时/.test(t)) {
      return '请求超时：接口没在限定时间内响应。检查网络，或把超时时间调大。';
    }
    if (/Failed to fetch|NetworkError|请求失败/i.test(t)) {
      return '请求发不出去：检查网络、接口地址是否可访问（本地服务需要先启动）。';
    }
    return t;
  }

  function callLLM(cfg, fields, examples) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (controller) timer = setTimeout(function () { controller.abort(); }, cfg.timeoutMs);

    var body = {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(fields, examples) }
      ]
    };

    return fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) {
        var status = r.status;
        var retryAfter = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
        return r.text().then(function (t) {
          var err = new Error('接口返回 HTTP ' + status + '：' + t.slice(0, 180));
          err.status = status;                                  // 供重试判断
          var sec = Number(retryAfter);
          if (isFinite(sec) && sec > 0) err.retryAfterMs = sec * 1000;
          throw err;
        });
      }
      return r.json();
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? '请求超时' : ('请求失败：' + ((e && e.message) || e)));
    }).then(function (json) {
      var c = json && json.choices && json.choices[0] &&
        ((json.choices[0].message && json.choices[0].message.content) || json.choices[0].text);
      if (!c) throw new Error('模型没有返回内容');
      return String(c);
    });
  }

  /**
   * 从模型输出里抠出 JSON 数组，并按白名单校验（模型编的路径一律丢弃）。
   * 注意：path 为 null 的条目**也要保留** —— 里面的 label 有价值
   * （「这个框其实在问紧急联系人手机号」），要写进缓存供下次显示。
   */
  function parseMapping(text, idSet) {
    var raw = String(text);
    var fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1];
    var a = raw.indexOf('[');
    var b = raw.lastIndexOf(']');
    if (a === -1 || b === -1 || b < a) throw new Error('模型没有返回 JSON 数组');

    var arr;
    try {
      arr = JSON.parse(raw.slice(a, b + 1));
    } catch (e) {
      throw new Error('模型返回的 JSON 解析失败');
    }
    if (!Array.isArray(arr)) throw new Error('模型返回的不是数组');

    var allow = {};
    allowedPaths().forEach(function (p) { allow[p] = 1; });

    var out = {};
    arr.forEach(function (item) {
      if (!item || typeof item.id !== 'string' || !idSet[item.id]) return;
      var path = item.path;
      var ok = (typeof path === 'string' && allow[path]) ? path : null;
      var conf = Number(item.confidence);
      if (!isFinite(conf)) conf = ok ? 0.6 : 0.3;
      out[item.id] = {
        path: ok,
        // 模型编造的路径：记下来只为诊断，不会拿来填
        invalidPath: (path && !ok) ? String(path).slice(0, 60) : null,
        label: String(item.label || '').slice(0, 40),
        confidence: Math.max(0, Math.min(1, conf)),
        reason: String(item.reason || 'AI 判断').slice(0, 60)
      };
    });
    return out;
  }

  // ------------------------------------------------------------------ 缓存

  /** 这条缓存还能不能用。否定结论会过期，肯定结论长期有效 */
  function isHitUsable(hit) {
    if (!hit) return false;
    if (hit.path) return true;
    return (Date.now() - (hit.at || 0)) <= NEGATIVE_TTL_MS;
  }

  function getCache() {
    return storageGet([CACHE_KEY]).then(function (o) { return o[CACHE_KEY] || {}; });
  }

  function putCache(cache) {
    var keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort(function (a, b) { return (cache[a].at || 0) - (cache[b].at || 0); });
      keys.slice(0, keys.length - CACHE_MAX).forEach(function (k) { delete cache[k]; });
    }
    var data = {};
    data[CACHE_KEY] = cache;
    return storageSet(data);
  }

  /**
   * 这批字段里有几个已经在缓存里了。**只读存储、不联网**。
   *
   * 用途：弹窗据此判断「这次自动跑 AI 会不会真的联网」——
   *   - 全都在缓存里：跑一次是**免费且有用**的（能把上次学到的真标签显示出来），放心跑
   *   - 有冷字段：才需要考虑拦一下，否则「反复开弹窗」就是反复发请求
   */
  function countCached(fields) {
    var list = (fields || []).filter(function (f) { return f && f.fingerprint; });
    if (!list.length) return Promise.resolve({ total: 0, cached: 0 });
    return getCache().then(function (cache) {
      var n = 0;
      // 判定口径必须和 handleMap 完全一致，否则会出现
      // 「弹窗以为全在缓存里、放心地跑了一次，结果真的联网了」
      list.forEach(function (f) { if (isHitUsable(cache[f.fingerprint])) n++; });
      return { total: list.length, cached: n };
    });
  }

  function clearCache() {
    return new Promise(function (resolve) {
      var data = {};
      data[CACHE_KEY] = {};
      chrome.storage.local.set(data, function () { resolve(); });
    });
  }

  // ------------------------------------------------------------------ 主流程

  /**
   * @param {Array} fields [{ id, fingerprint, label, labelSource, placeholder, htmlName, type, options, skeleton }]
   * @param {Object} [ctx]  { examples: [{label, labelSource, type}] }
   * @returns {Promise<{ok, mapping, cached, asked, skipped?, error?}>}
   *
   * mapping[id] = { path: string|null, label, confidence, reason, source }
   *   path 为 null 也保留条目 —— 弹窗要拿 label 显示「这个框其实在问什么」。
   */
  function handleMap(fields, ctx) {
    ctx = ctx || {};
    return root.__RJ_AI__.get().then(function (cfg) {
      if (!root.__RJ_AI__.isUsable(cfg)) {
        return { ok: true, mapping: {}, cached: 0, asked: 0, skipped: 'AI 未启用或配置不完整' };
      }

      // 指纹是缓存键。弱标签字段的指纹里已经混了「站点 + 结构签名」，
      // 所以这份缓存天然是站点级的：同一个网站第二次访问直接命中，不再发请求。
      var list = (fields || []).filter(function (f) { return f && f.id && f.fingerprint; });
      if (!list.length) return { ok: true, mapping: {}, cached: 0, asked: 0 };

      return getCache().then(function (cache) {
        var mapping = {};
        var toAsk = [];
        var cachedCount = 0;

        list.forEach(function (f) {
          var hit = cache[f.fingerprint];
          // 过期的否定结论要重新问：用户很可能刚把缺的信息补进简历
          if (hit === undefined || !isHitUsable(hit)) { toAsk.push(f); return; }
          cachedCount++;
          mapping[f.id] = {
            path: hit.path || null,
            label: hit.label || '',
            confidence: hit.confidence != null ? hit.confidence : 0.6,
            reason: 'AI 判断（缓存）',
            source: 'ai'
          };
        });

        if (!toAsk.length) return { ok: true, mapping: mapping, cached: cachedCount, asked: 0 };

        var batch = toAsk.slice(0, cfg.maxFieldsPerCall);
        return withSlot(function () {
          // 领名额放在**真正要发的那一刻**，而不是排队时 ——
          // 还在队列里等的请求还没发出去，不该先占掉本分钟的额度。
          return takeRateSlot().then(function (slot) {
            if (!slot.ok) {
              var err = new Error(throttleMessage(slot));
              err.code = 'local-throttle';
              err.waitMs = slot.waitMs;
              throw err;
            }
            return callWithRetry(cfg, batch.map(slimField), ctx.examples);
          });
        }).then(function (text) {
          var idSet = {};
          batch.forEach(function (f) { idSet[f.id] = 1; });
          var got = parseMapping(text, idSet);

          var invalid = 0;
          batch.forEach(function (f) {
            var m = got[f.id] || null;
            mapping[f.id] = m
              ? { path: m.path, label: m.label, confidence: m.confidence, reason: m.reason, source: 'ai' }
              : null;
            if (m && m.invalidPath) invalid++;
            // 没轮到的字段不写缓存，否则下次会被当成「问过了但没答案」
            cache[f.fingerprint] = m
              ? { path: m.path, label: m.label, confidence: m.confidence, at: Date.now() }
              : { path: null, label: '', confidence: 0, at: Date.now() };
          });

          return putCache(cache).then(function () {
            return {
              ok: true,
              mapping: mapping,
              cached: cachedCount,
              asked: batch.length,
              invalidPath: invalid,
              truncated: toAsk.length > batch.length
            };
          });
        });
      });
    }).catch(function (e) {
      // 同样不能让 Promise 拒掉。走后台时有 reply() 兜着，但弹窗直连时没有 ——
      // 拒掉就成了没有兜底的 rejected promise，界面上只会停在「分析中…」不动。
      // code 要带出去：界面据此区分「接口报的错」和「本地闸拦下的」，两者的说法不一样。
      return {
        ok: false,
        error: String((e && e.message) || e),
        code: (e && e.code) || null,
        cached: 0,
        asked: 0
      };
    });
  }

  function testConnection() {
    return root.__RJ_AI__.get().then(function (cfg) {
      if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
        return { ok: false, error: '请先填写接口地址、模型和 API Key' };
      }
      // 故意用一个「标签不可信」的样本：这正是 AI 层存在的意义，
      // 能连上说明整条链路（含骨架输入）是可用的。
      var probe = [{
        id: 'probe', label: '请输入', labelSource: 'placeholder', placeholder: '请输入',
        htmlName: 'mobile', htmlId: '', type: 'text', options: [],
        skeleton: [
          '第0层 <input.el-input__inner> 前兄弟[无] 自身文本=""',
          '第1层 <div.el-form-item> 前兄弟[div="手机号码"] 自身文本=""'
        ]
      }];
      // 故意**不领频率名额**：这是用户手动点的一次性诊断，而且他往往正是
      // 因为「老被限流」才来测的 —— 把测试也一起挡掉，等于什么都没告诉他。
      // 不过真撞上 429 时 callWithRetry 照样会写冷却，所以它反而能帮到后面的扫描。
      return withSlot(function () {
        return callWithRetry(cfg, probe, []);
      }).then(function (text) {
        var got = parseMapping(text, { probe: 1 });
        return {
          ok: true,
          model: cfg.model,
          sample: got.probe || null,
          raw: String(text).slice(0, 200)
        };
      });
    }).catch(function (e) {
      // 必须转成 { ok:false } 返回，不能让 Promise 拒掉。
      // 这条路径是被界面上「测试连接」直接 await 的：一旦 reject，就成了没有兜底的
      // rejected promise —— 用户看到的是按钮永远停在「测试中…」，
      // 而真正的错误（401 / 模型名写错 / 网络不通）反而完全看不到。
      return { ok: false, error: String((e && e.message) || e) };
    });
  }

  root.__RJ_AI_MAP__ = {
    FIELD_LABELS: FIELD_LABELS,
    allowedPaths: allowedPaths,
    buildUserPrompt: buildUserPrompt,
    buildSystemPrompt: buildSystemPrompt,
    slimField: slimField,
    parseMapping: parseMapping,
    callLLM: callLLM,
    callWithRetry: callWithRetry,
    isRetryable: isRetryable,
    explainError: explainError,
    handleMap: handleMap,
    testConnection: testConnection,
    countCached: countCached,
    clearCache: clearCache,
    // 频率闸：给测试用，也给「清空缓存」旁边留一个手动复位口子
    MAX_PER_MINUTE: MAX_PER_MINUTE,
    RATE_WINDOW_MS: RATE_WINDOW_MS,
    takeRateSlot: takeRateSlot,
    readCooldown: readCooldown,
    markRateLimited: markRateLimited,
    clearRateLimit: clearRateLimit,
    throttleMessage: throttleMessage
  };
})(typeof self !== 'undefined' ? self : this);
