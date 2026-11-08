/**
 * 简历解析器：纯文本 -> 结构化 Profile。
 *
 * 这是「本地规则版」解析：不依赖任何大模型和网络，靠正则 + 章节切分 + 版式启发式。
 * 目的是把简历里**高置信度**的信息先抓出来，剩下的交给导入校对界面让用户补。
 * 所有结果都会带一个置信度，UI 据此高亮「需要人工确认」的字段。
 *
 * 输入文本一般来自 file-text.js（PDF / DOCX / TXT）。
 */
(function () {
  if (window.__RJ_RESUME_PARSER__) return;

  // ------------------------------------------------------------ 章节定义

  var SECTION_DEFS = [
    { key: 'education', words: ['教育经历', '教育背景', '学习经历', '学历背景', '教育与培训', 'education'] },
    { key: 'experience', words: ['工作经历', '工作经验', '职业经历', '实习经历', '工作履历', 'experience', 'work experience'] },
    { key: 'projects', words: ['项目经历', '项目经验', '主要项目', 'projects', 'project experience'] },
    { key: 'skills', words: ['专业技能', '技能特长', '技能清单', '掌握技能', '个人技能', 'skills', 'skill'] },
    { key: 'selfEvaluation', words: ['自我评价', '自我介绍', '个人评价', '个人简介', '个人优势', '自我描述', 'summary', 'about me'] }
  ];

  var DEGREES = ['博士后', '博士', '硕士', '研究生', '本科', '学士', '大专', '专科', '高职', '高中', '中专', 'MBA', 'EMBA'];
  var CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州', '天津',
    '重庆', '长沙', '郑州', '青岛', '宁波', '东莞', '无锡', '合肥', '佛山', '厦门', '济南', '福州', '大连'];

  // ---------------------------------------------------------------- 工具

  function pad(n) {
    n = String(n || '').trim();
    if (!n) return '';
    return n.length < 2 ? '0' + n : n;
  }

  function fmtDate(y, m) {
    if (!y) return '';
    return m ? y + '-' + pad(m) : y;
  }

  function clean(s) {
    return String(s == null ? '' : s).replace(/\u00a0/g, ' ').trim();
  }

  function uniq(arr) {
    var seen = {};
    return arr.filter(function (x) {
      if (!x || seen[x]) return false;
      seen[x] = 1;
      return true;
    });
  }

  function isCJK(s) {
    return /[\u4e00-\u9fa5]/.test(s);
  }

  // ------------------------------------------------------------ 字符归一化

  /**
   * Unicode EquivalentUnifiedIdeograph 表（UAX #44）中 CJK 部首补充区（U+2E80–U+2EFF）的部分。
   * 格式：源码点[:目标] 或 源区间:目标; 多个用逗号分隔，均为十六进制。
   *
   * 为什么需要它：很多 PDF 的 ToUnicode 映射会把汉字输出成「部首」码点，
   * 例如「黄」变成 ⻩(U+2EE9)、「西」变成 ⻄(U+2EC4)。
   * 康熙部首区(U+2F00–U+2FDF) 用 NFKC 就能还原，但这一区 NFKC 不处理，必须手工映射。
   */
  var RADICAL_PAIRS =
    '2E81:5382,2E82:4E5B,2E83:4E5A,2E84:4E59,2E85:4EBB,2E86:5182,2E87:20628,2E88:5200,2E89:5202,' +
    '2E8A:535C,2E8B:353E,2E8C-2E8D:5C0F,2E8E:5140,2E8F:5C23,2E90:5C22,2E91:21BC2,2E92:5DF3,2E93:5E7A,' +
    '2E94:5F51,2E95:2B739,2E96:5FC4,2E97:5FC3,2E98:624C,2E99:6535,2E9B:65E1,2E9C:65E5,2E9D:6708,' +
    '2E9E:6B7A,2E9F:6BCD,2EA0:6C11,2EA1:6C35,2EA2:6C3A,2EA3:706C,2EA4-2EA5:722B,2EA6:4E2C,2EA7:725B,' +
    '2EA8:72AD,2EA9:738B,2EAA:24D14,2EAB:76EE,2EAC:793A,2EAD:793B,2EAE:25AD7,2EAF:7CF9,2EB0:7E9F,' +
    '2EB1:7F53,2EB2:7F52,2EB3:34C1,2EB4:5197,2EB5:2626B,2EB6:7F8A,2EB7:2634C,2EB8:2634B,2EB9:8002,' +
    '2EBA:8080,2EBB:807F,2EBC:8089,2EBD:26951,2EBE-2EC0:8279,2EC1:864E,2EC2:8864,2EC3:8980,2EC4:897F,' +
    '2EC5:89C1,2EC6:89D2,2EC7:278B2,2EC8:8BA0,2EC9:8D1D,2ECA:27FB7,2ECB:8F66,2ECC-2ECE:8FB6,2ECF:9091,' +
    '2ED0:9485,2ED1:9577,2ED2:9578,2ED3:957F,2ED4:95E8,2ED5:28E0F,2ED6:961D,2ED7:96E8,2ED8:9752,' +
    '2ED9:97E6,2EDA:9875,2EDB:98CE,2EDC:98DE,2EDD:98DF,2EDE:2967F,2EDF:98E0,2EE0:9963,2EE1:29810,' +
    '2EE2:9A6C,2EE3:9AA8,2EE4:9B3C,2EE5:9C7C,2EE6:9E1F,2EE7:5364,2EE8:9EA6,2EE9:9EC4,2EEA:9EFE,' +
    '2EEB:6589,2EEC:9F50,2EED:6B6F,2EEE:9F7F,2EEF:7ADC,2EF0:9F99,2EF1:9F9C,2EF2:4E80,2EF3:9F9F';

  var radicalMap = null;
  function getRadicalMap() {
    if (radicalMap) return radicalMap;
    radicalMap = {};
    RADICAL_PAIRS.split(',').forEach(function (item) {
      var p = item.split(':');
      if (p.length !== 2) return;
      var dst = parseInt(p[1], 16);
      if (p[0].indexOf('-') !== -1) {
        var ab = p[0].split('-');
        var a = parseInt(ab[0], 16), b = parseInt(ab[1], 16);
        for (var c = a; c <= b; c++) radicalMap[c] = dst + (c - a);
      } else {
        radicalMap[parseInt(p[0], 16)] = dst;
      }
    });
    return radicalMap;
  }

  /**
   * 归一化从 PDF/DOCX 提取出来的文本。
   * 这一步很关键：不做的话，从 PDF 抽出来的汉字可能落在「部首」码点上，
   * 所有基于 [\u4e00-\u9fa5] 的正则都会失配，导致什么都识别不出来。
   *
   * 1. NFKC —— 还原康熙部首（⼯ U+2F2F → 工）、全角字母数字标点、兼容汉字
   * 2. 部首补充区（U+2E80–U+2EFF）—— NFKC 不处理，用手工等价表（⻩ U+2EE9 → 黄）
   */
  function normalizeText(s) {
    var t = String(s == null ? '' : s).normalize('NFKC');
    var map = getRadicalMap();
    return t.replace(/[\u2E80-\u2EFF]/g, function (ch) {
      var v = map[ch.charCodeAt(0)];
      return v ? String.fromCodePoint(v) : ch;
    });
  }

  /** 把一整段的短行拼回段落（PDF 会把一句话拆成很多行） */
  function joinParagraph(lines) {
    var s = lines.map(clean).filter(Boolean).join('');
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return s.trim();
  }

  // ---------------------------------------------------- 章节切分

  /** 判断某一行是不是章节标题；返回 { key, rest } 或 null */
  function matchHeader(line) {
    var raw = clean(line);
    if (!raw) return null;

    // 去掉两侧的装饰符号：==专业技能== / 【教育背景】 / -- 工作经历 --
    var t = raw.replace(/^[\s=＝\-—–*•·#>【\[（(<《|]+/, '')
               .replace(/[\s=＝\-—–*•·#<】\]）)>》|]+$/, '');
    if (!t) return null;

    var low = t.toLowerCase();
    var best = null;

    for (var i = 0; i < SECTION_DEFS.length; i++) {
      var d = SECTION_DEFS[i];
      for (var j = 0; j < d.words.length; j++) {
        var w = d.words[j];
        var idx = low.indexOf(w.toLowerCase());
        if (idx === -1 || idx > 4) continue;   // 关键词必须靠近行首

        // 关键词后必须是分隔符 / 空白 / 行尾。
        // 否则「工作经验丰富，熟悉…」这种正文会被误判成章节标题。
        var next = t.charAt(idx + w.length);
        if (next && !/[\s:：\-—|/、,，.。;；)）\]】]/.test(next)) continue;

        // 同义词有包含关系时（skill / skills）取更长的那个
        if (!best || w.length > best.word.length) {
          best = { key: d.key, word: w, rest: t.slice(idx + w.length).replace(/^[\s:：\-—|/、,，]+/, '') };
        }
      }
    }
    return best ? { key: best.key, rest: best.rest } : null;
  }

  /** 把文本切成 [{key, lines}]，key 为 null 的是开头的基本信息区 */
  function splitSections(text) {
    var sections = [];
    var cur = { key: null, lines: [] };
    sections.push(cur);

    text.split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) { cur.lines.push(''); return; }

      var hit = matchHeader(line);
      if (hit) {
        cur = { key: hit.key, lines: [] };
        sections.push(cur);
        if (hit.rest) cur.lines.push(hit.rest);
        return;
      }
      cur.lines.push(raw);
    });
    return sections;
  }

  // ---------------------------------------------------- 基本字段抽取

  /** 按标签取值，兼容「姓名：张三」和「姓名 张三」两种写法 */
  function pickLabeled(text, labels, maxLen) {
    maxLen = maxLen || 30;
    for (var i = 0; i < labels.length; i++) {
      var esc = labels[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var re = new RegExp(esc + '\\s*[:：]?\\s*([^\\s:：,，;；|/()（）]{1,' + maxLen + '})');
      var m = text.match(re);
      if (m && clean(m[1])) return clean(m[1]);
    }
    return '';
  }

  function pickPhone(text) {
    var m = text.match(/(?:\+?86[\s-]?)?(1[3-9]\d[\s-]?\d{4}[\s-]?\d{4})/);
    return m ? m[1].replace(/[\s-]/g, '') : '';
  }

  function pickEmail(text) {
    var m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/);
    return m ? m[0].replace(/[.,;)]+$/, '') : '';
  }

  function pickIdCard(text) {
    var m = text.match(/(?:\d{17}[\dXx])(?![\dXx])/);
    return m ? m[0].toUpperCase() : '';
  }

  function pickBirthday(text) {
    var m = text.match(/(?:出生(?:日期|年月|时间)?|生日)\s*[:：]?\s*((?:19|20)\d{2})\s*[-/年.]\s*(\d{1,2})(?:\s*[-/月.]\s*(\d{1,2}))?/);
    if (m) return fmtDate(m[1], m[2]) + (m[3] ? '-' + pad(m[3]) : '');
    return '';
  }

  function pickGender(text) {
    var m = text.match(/(?:性别)\s*[:：]?\s*(男|女)/);
    if (m) return m[1];
    m = text.match(/(?:^|\s)(男|女)(?:\s|$|[,，;；])/);
    return m ? m[1] : '';
  }

  function pickPolitical(text) {
    var m = text.match(/(中共正式党员|中共预备党员|中共党员|预备党员|共青团员|无党派人士|民主党派|群众)/);
    return m ? m[1] : '';
  }

  function pickWechat(text) {
    var m = text.match(/(?:微信|WeChat|weixin)\s*(?:号)?\s*[:：]?\s*([A-Za-z0-9_-]{5,25})/i);
    return m ? m[1] : '';
  }

  function pickLocation(text) {
    var m = text.match(/(?:现居(?:地|城市|住址|地址)?|现住(?:地|址|城市)?|居住地|所在地|所在城市|期望城市|联系地址|家庭住址)\s*[:：]?\s*([\u4e00-\u9fa5]{2,10})/);
    if (m) return clean(m[1]);
    for (var i = 0; i < CITIES.length; i++) {
      if (text.indexOf(CITIES[i]) !== -1) return CITIES[i];
    }
    return '';
  }

  /** 姓名是最麻烦的：先找标签，再退回「首屏的 2-4 个汉字短行」 */
  var NAME_BLOCKLIST = ['个人简历', '求职简历', '应聘简历', '简历', '个人主页', '基本信息',
    '求职意向', '求职目标', '期望职位', '个人信息', '联系方式', '教育背景', '工作经历',
    '实习经历', '项目经历', '专业技能', '自我评价', '个人优势'];

  function pickName(text, lines) {
    var labeled = pickLabeled(text, ['姓名', '名字', '姓 名'], 10);
    if (labeled && isCJK(labeled) && labeled.length <= 6) return { value: labeled, confidence: 0.9 };
    if (labeled && /^[A-Za-z][A-Za-z\s.]{1,28}$/.test(labeled)) return { value: labeled, confidence: 0.8 };

    // 首屏若干行里找「2-4 个汉字 + 分隔符/空白」开头的行，兼容多种版式：
    //   "张三"                       —— 整行就是姓名
    //   "张三 求职意向：测试开发…"    —— 姓名后面还跟着别的信息
    //   "张 三"                        —— 姓名里带空格
    for (var i = 0; i < Math.min(lines.length, 5); i++) {
      var t = clean(lines[i]);
      if (!t || NAME_BLOCKLIST.indexOf(t) !== -1) continue;

      var compact = t.replace(/\s+/g, '');
      if (/^[\u4e00-\u9fa5·]{2,4}$/.test(compact)) {
        return { value: compact, confidence: 0.45 };
      }

      var m = t.match(/^([\u4e00-\u9fa5·]{2,4})(?=[\s|,，·])/);
      if (m && NAME_BLOCKLIST.indexOf(m[1]) === -1) {
        return { value: m[1], confidence: 0.6 };
      }
    }
    return { value: '', confidence: 0 };
  }

  // ---------------------------------------------------- 经历条目解析

  function parseDateRange(s) {
    // 2020.09 - 2024.06
    var m = s.match(/((?:19|20)\d{2})\s*[.\-/年]?\s*(\d{1,2})?\s*月?\s*(?:[-~—–至到]|--)\s*((?:19|20)\d{2})\s*[.\-/年]?\s*(\d{1,2})?/);
    if (m) return { startDate: fmtDate(m[1], m[2]), endDate: fmtDate(m[3], m[4]) };

    // 2020.09 - 至今
    var m2 = s.match(/((?:19|20)\d{2})\s*[.\-/年]?\s*(\d{1,2})?\s*月?\s*(?:[-~—–至到]|--)\s*(至今|现在|今)/);
    if (m2) return { startDate: fmtDate(m2[1], m2[2]), endDate: '至今' };

    // 只有单个年份/年月
    var m3 = s.match(/((?:19|20)\d{2})\s*[.\-/年]\s*(\d{1,2})/);
    if (m3) return { startDate: fmtDate(m3[1], m3[2]), endDate: '' };

    return null;
  }

  function hasDateRange(s) {
    return !!(parseDateRange(s) || /(?:19|20)\d{2}/.test(s));
  }

  /** 以「出现日期」为界，把章节内容切成若干条目 */
  function splitEntries(lines) {
    var entries = [];
    var cur = null;
    lines.forEach(function (raw) {
      var t = clean(raw);
      if (!t) return;
      if (hasDateRange(t) && (!cur || cur.lines.length)) {
        // 已有内容且本行带日期 -> 视为新条目
        if (cur && cur.lines.length) { entries.push(cur); cur = null; }
      }
      if (!cur) cur = { lines: [] };
      cur.lines.push(t);
    });
    if (cur && cur.lines.length) entries.push(cur);
    return entries;
  }

  function parseEducation(lines) {
    return splitEntries(lines).map(function (e) {
      var joined = e.lines.join(' ');
      var dr = parseDateRange(joined) || {};
      var schoolM = joined.match(/([\u4e00-\u9fa5]{2,20}(?:大学|学院|学校|高中|中学|职业技术学院|研究所|研究院))/);
      var degree = '';
      for (var i = 0; i < DEGREES.length; i++) {
        if (joined.indexOf(DEGREES[i]) !== -1) { degree = DEGREES[i]; break; }
      }
      var majorM = joined.match(/([\u4e00-\u9fa5A-Za-z]{2,20})\s*(?:专业|方向)/);
      var major = majorM ? majorM[1] : '';
      // 大多数简历不会写「…专业」二字，专业通常紧邻学历词。
      // 但两种版式都有：「软件工程 硕士」和「硕士 软件工程」，两边都试。
      if (!major && degree) {
        var tokens = joined.split(/\s+/).filter(Boolean);
        var di = -1;
        for (var k = 0; k < tokens.length; k++) {
          if (tokens[k].indexOf(degree) !== -1) { di = k; break; }
        }
        var cands = [];
        if (di > 0) cands.push(tokens[di - 1]);
        if (di >= 0 && di + 1 < tokens.length) cands.push(tokens[di + 1]);
        for (var ci = 0; ci < cands.length; ci++) {
          var c = cands[ci];
          if (!c || c.length < 2 || c.length > 20) continue;
          if (/(?:19|20)\d{2}/.test(c)) continue;
          if (/(?:大学|学院|学校|中学|研究院|研究所)/.test(c)) continue;
          if (DEGREES.indexOf(c) !== -1) continue;
          major = c;
          break;
        }
      }
      return {
        school: schoolM ? schoolM[1] : '',
        major: major,
        degree: degree,
        startDate: dr.startDate || '',
        endDate: dr.endDate || '',
        description: e.lines.slice(1).join(' ')
      };
    }).filter(function (x) { return x.school || x.major || x.degree; });
  }

  var COMPANY_SUFFIX = /(?:股份有限公司|有限责任公司|有限公司|集团|科技|网络|信息技术|软件|银行|证券|研究院|设计院|事务所|分公司|子公司|工作室|中心)$/;
  var TITLE_SUFFIX = /(?:工程师|架构师|产品经理|项目经理|设计师|研究员|实习生|分析师|运营|开发|测试|主管|经理|总监|顾问|专员|助理|负责人|讲师)$/;

  function isCompanyPart(s) {
    if (!s) return false;
    if (/(?:19|20)\d{2}/.test(s)) return false;      // 日期
    if (/^[-~—–至到]+$/.test(s)) return false;        // 连接符
    if (TITLE_SUFFIX.test(s)) return false;           // 职位
    if (s.length > 20) return false;
    return true;
  }

  /**
   * 抽公司名。公司名常被空格切成多段（如「SAP 思爱普 (中国) 有限公司」），
   * 所以先定位以公司后缀结尾的那一段，再向前合并相邻片段。
   * 从前往后找第一个匹配，避免把正文里提到的公司名误当成本次经历。
   */
  function extractCompany(joined) {
    var runs = joined.split(/\s+/).filter(Boolean);
    var end = -1;
    for (var i = 0; i < runs.length; i++) {
      if (COMPANY_SUFFIX.test(runs[i])) { end = i; break; }
    }
    if (end < 0) return { name: '', endIdx: -1 };
    var start = end;
    while (start - 1 >= 0 && isCompanyPart(runs[start - 1])) start--;
    return { name: runs.slice(start, end + 1).join(' '), endIdx: end };
  }

  /** 职位一般紧跟在公司名之后，只在后面若干段里找 */
  function extractTitle(runs, fromIdx) {
    var start = fromIdx < 0 ? 0 : fromIdx + 1;
    var limit = Math.min(runs.length, start + 6);
    for (var i = start; i < limit; i++) {
      if (/(?:19|20)\d{2}/.test(runs[i])) break;
      if (TITLE_SUFFIX.test(runs[i])) return runs[i].replace(/[,，。;；、]$/, '');
    }
    return '';
  }

  function parseExperience(lines) {
    return splitEntries(lines).map(function (e) {
      var joined = e.lines.join(' ');
      var dr = parseDateRange(joined) || {};
      var runs = joined.split(/\s+/).filter(Boolean);
      var co = extractCompany(joined);
      return {
        company: co.name,
        title: extractTitle(runs, co.endIdx),
        startDate: dr.startDate || '',
        endDate: dr.endDate || '',
        description: e.lines.slice(1).join(' ')
      };
    }).filter(function (x) { return x.company || x.title; });
  }

  function parseProjects(lines) {
    return splitEntries(lines).map(function (e) {
      var first = e.lines[0] || '';
      var dr = parseDateRange(e.lines.join(' ')) || {};
      // 去掉「一、」「1.」这类序号，以及行尾的日期区间
      var name = first
        .replace(/^[一二三四五六七八九十\d]+\s*[、.．,，)）]\s*/, '')
        .replace(/\s*(?:19|20)\d{2}\s*[.\-/年]?\s*\d{0,2}\s*(?:[-~—–至到]|--)\s*(?:(?:19|20)\d{2}\s*[.\-/年]?\s*\d{0,2}|至今|现在|今)\s*$/, '')
        .replace(/[（(].*?[)）]\s*$/, '')
        .replace(/\s*[|｜].*$/, '')
        .trim();
      return {
        name: name.slice(0, 60),
        role: '',
        startDate: dr.startDate || '',
        endDate: dr.endDate || '',
        description: e.lines.slice(1).join(' ')
      };
    }).filter(function (x) { return x.name; });
  }

  /** 技能条目常见的引导词，去掉后剩下的才是技能本身 */
  var SKILL_NOISE = /^(?:熟悉|掌握|了解|精通|具备|能够|会使用|熟练使用|擅长|使用|会|有|和|及|与|等)\s*/;

  function parseSkills(lines) {
    var raw = lines.join(' ');
    raw = raw.replace(/(?:专业技能|技能特长|掌握技能|个人技能|技能)\s*[:：]?/g, ' ');

    var parts = raw.split(/[,，、;；|/·\t]+|\s{2,}/).map(function (s) {
      return clean(s)
        .replace(/^[^:：]{1,10}[:：]/, '')      // 去掉「开发与测试：」这类小标题
        .replace(SKILL_NOISE, '')              // 去掉「熟悉 / 掌握 / 具备」
        .replace(/等.*$/, '')                  // 去掉「等常用网络架构」这类尾注
        .replace(/[。；;，,、]$/, '')
        .trim();
    }).filter(function (s) {
      if (!s || s.length < 2 || s.length > 24) return false;
      if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(s)) return false;
      // 长且不含字母数字的，基本是技能描述里的正文残句，不是技能名
      if (s.length > 10 && !/[A-Za-z0-9]/.test(s)) return false;
      return true;
    });
    return uniq(parts).slice(0, 40);
  }

  // ---------------------------------------------------------------- 主流程

  /**
   * @param {string} text 简历纯文本
   * @returns {{ profile: object, confidence: object, sections: object }}
   */
  function parseResume(text) {
    text = normalizeText(text).replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var sections = splitSections(text);

    var byKey = {};
    sections.forEach(function (s) {
      if (!s.key) return;
      byKey[s.key] = (byKey[s.key] || []).concat(s.lines);
    });

    var profile = {
      basic: {
        name: '', gender: '', birthday: '', phone: '', email: '',
        idCard: '', location: '', wechat: '', politicalStatus: ''
      },
      education: [], experience: [], projects: [], skills: [], selfEvaluation: ''
    };
    var confidence = {};

    function set(path, value, conf) {
      if (!value) return;
      var parts = path.split('.');
      if (parts.length === 1) profile[parts[0]] = value;
      else profile[parts[0]][parts[1]] = value;
      confidence[path] = conf;
    }

    // 基本信息（在全文里找，不限于某个章节）
    var nameRes = pickName(text, lines);
    set('basic.name', nameRes.value, nameRes.confidence);
    set('basic.phone', pickPhone(text), 0.95);
    set('basic.email', pickEmail(text), 0.95);
    set('basic.idCard', pickIdCard(text), 0.9);
    set('basic.gender', pickGender(text), 0.85);
    set('basic.birthday', pickBirthday(text), 0.85);
    set('basic.politicalStatus', pickPolitical(text), 0.8);
    set('basic.wechat', pickWechat(text), 0.8);
    set('basic.location', pickLocation(text), 0.65);

    // 章节内容
    if (byKey.skills) {
      var skills = parseSkills(byKey.skills);
      if (skills.length) { profile.skills = skills; confidence.skills = 0.7; }
    }
    if (byKey.selfEvaluation) {
      var evalText = joinParagraph(byKey.selfEvaluation);
      set('selfEvaluation', evalText, 0.75);
    }
    if (byKey.education) {
      var edu = parseEducation(byKey.education);
      if (edu.length) { profile.education = edu; confidence.education = 0.6; }
    }
    if (byKey.experience) {
      var exp = parseExperience(byKey.experience);
      if (exp.length) { profile.experience = exp; confidence.experience = 0.6; }
    }
    if (byKey.projects) {
      var prj = parseProjects(byKey.projects);
      if (prj.length) { profile.projects = prj; confidence.projects = 0.55; }
    }

    return {
      profile: profile,
      confidence: confidence,
      foundSections: Object.keys(byKey)
    };
  }

  window.__RJ_RESUME_PARSER__ = {
    parseResume: parseResume,
    normalizeText: normalizeText,
    matchHeader: matchHeader,
    splitSections: splitSections,
    splitEntries: splitEntries,
    parseEducation: parseEducation,
    parseExperience: parseExperience,
    parseSkills: parseSkills,
    parseDateRange: parseDateRange,
    SECTION_DEFS: SECTION_DEFS
  };
})();
