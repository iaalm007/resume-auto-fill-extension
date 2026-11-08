/**
 * 数据层：多份简历的存取 + 「当前使用简历」的管理。
 * 该文件同时被 content script 与扩展页面（popup / options）加载。
 *
 * 存储结构（每份简历一个独立键，写入是增量的）：
 *   rj_resume_<id>   : { id, name, profile, createdAt, updatedAt }
 *   rj_active_resume : <当前生效的简历 id>
 *
 * 为什么不用「一个键存整个数组」：
 *   - 那种写法每改一份简历都要把整个数组重写一遍。实测切换一次「使用简历」
 *     就要写 3KB+，再加一份简历要写 9KB+，而且两个页面同时写会互相覆盖（后写者赢）。
 *   - 拆成独立键后：改哪份只写哪份，切换只写一个几十字节的指针，互不干扰。
 */
(function (root) {
  if (root.__RJ_STORE__) return;

  var PREFIX = 'rj_resume_';        // 每份简历一个键：rj_resume_<id>
  var KEY_ACTIVE = 'rj_active_resume';

  var DEFAULT_PROFILE = {
    basic: {
      name: '',
      gender: '',
      birthday: '',
      phone: '',
      email: '',
      idCard: '',
      location: '',
      wechat: '',
      politicalStatus: '',
      // 求职意向类：投递页上很常见，而且大多不在「个人信息」区块里，
      // 单列出来才好和「现居城市」这种真实信息区分开（两者不是一回事）
      expectedCity: '',
      expectedPosition: '',
      expectedIndustry: '',
      workYears: '',
      currentSalary: '',
      expectedSalary: '',
      availableFrom: ''
    },
    education: [],
    experience: [],
    projects: [],
    skills: [],
    selfEvaluation: ''
  };

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function newId() {
    return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function keyOf(id) {
    return PREFIX + id;
  }

  /**
   * 把任意来源的 profile 补齐成完整结构后再落库。
   * 不为了兼容旧版本，而是因为 chrome.storage 没有 schema 校验：
   * 万一数据被手工改坏（比如在 devtools 里改过），这里能兜住，避免编辑页/匹配静默失灵。
   */
  function normalizeProfile(p) {
    var base = clone(DEFAULT_PROFILE);
    if (!p || typeof p !== 'object') return base;

    if (p.basic && typeof p.basic === 'object') {
      Object.keys(base.basic).forEach(function (k) {
        if (p.basic[k] != null) base.basic[k] = String(p.basic[k]);
      });
    }
    ['education', 'experience', 'projects'].forEach(function (k) {
      if (Array.isArray(p[k])) base[k] = p[k];
    });
    if (Array.isArray(p.skills)) base.skills = p.skills.map(String);
    if (typeof p.selfEvaluation === 'string') base.selfEvaluation = p.selfEvaluation;
    return base;
  }

  function makeResume(name, profile) {
    var now = Date.now();
    return {
      id: newId(),
      name: name || '未命名简历',
      profile: normalizeProfile(profile),
      createdAt: now,
      updatedAt: now
    };
  }

  // -------------------------------------------------- 底层读写（都是定向的）

  function getAllRaw() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (all) { resolve(all || {}); });
    });
  }

  function getOne(id) {
    return new Promise(function (resolve) {
      var k = keyOf(id);
      chrome.storage.local.get([k], function (res) { resolve((res && res[k]) || null); });
    });
  }

  /** 只写这一份简历，不触碰其它任何键 */
  function putResume(resume) {
    return new Promise(function (resolve) {
      var data = {};
      data[keyOf(resume.id)] = resume;
      chrome.storage.local.set(data, function () { resolve(resume); });
    });
  }

  /** 只写指针，几十字节 */
  function putActive(id) {
    return new Promise(function (resolve) {
      var data = {};
      data[KEY_ACTIVE] = id;
      chrome.storage.local.set(data, function () { resolve(id); });
    });
  }

  function dropResume(id) {
    return new Promise(function (resolve) {
      chrome.storage.local.remove([keyOf(id)], function () { resolve(); });
    });
  }

  /** 从 storage 快照里捞出所有简历，按创建时间排序（保证列表顺序稳定） */
  function pickResumes(all) {
    return Object.keys(all)
      .filter(function (k) { return k.indexOf(PREFIX) === 0; })
      .map(function (k) { return all[k]; })
      .filter(function (r) { return r && r.id && r.profile; })
      .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
  }

  /**
   * 读取全部简历 + 当前生效 id。
   * 存储为空时自动建立一份空白简历，保证任何时刻至少有一份可用。
   * 这里只做只读；只有在「需要补建」或「指针失效」时才写最小的一笔。
   */
  function readAll() {
    return getAllRaw().then(function (all) {
      var resumes = pickResumes(all);
      var activeId = all[KEY_ACTIVE];

      if (!resumes.length) {
        var first = makeResume('我的简历', clone(DEFAULT_PROFILE));
        return putResume(first)
          .then(function () { return putActive(first.id); })
          .then(function () { return { resumes: [first], activeId: first.id }; });
      }

      if (!activeId || !resumes.some(function (r) { return r.id === activeId; })) {
        activeId = resumes[0].id;
        return putActive(activeId).then(function () {
          return { resumes: resumes, activeId: activeId };
        });
      }

      return { resumes: resumes, activeId: activeId };
    });
  }

  // ---------------------------------------------------------------- 读接口

  function toBrief(r) {
    return {
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt,
      hasName: !!(r.profile && r.profile.basic && r.profile.basic.name)
    };
  }

  function getResumeFrom(s, id) {
    var r = s.resumes.filter(function (x) { return x.id === id; })[0] || s.resumes[0];
    return { id: r.id, name: r.name, profile: r.profile, updatedAt: r.updatedAt };
  }

  /** 简历列表（不含完整 profile，供下拉框使用） */
  function listResumes() {
    return readAll().then(function (s) {
      return { activeId: s.activeId, resumes: s.resumes.map(toBrief) };
    });
  }

  /** 定向读取某一份 */
  function getResume(id) {
    return getOne(id).then(function (r) {
      if (!r) return readAll().then(function (s) { return getResumeFrom(s, s.activeId); });
      return { id: r.id, name: r.name, profile: normalizeProfile(r.profile), updatedAt: r.updatedAt };
    });
  }

  function getActiveResume() {
    return readAll().then(function (s) { return getResumeFrom(s, s.activeId); });
  }

  /** content script 用：取「当前使用简历」的 profile */
  function getProfile() {
    return readAll().then(function (s) { return getResumeFrom(s, s.activeId).profile; });
  }

  function ensureProfile() {
    return getProfile();
  }

  // ---------------------------------------------------------------- 写接口

  /** 切换「当前使用简历」——只写指针 */
  function setActiveResume(id) {
    return getOne(id).then(function (r) {
      if (!r) return null;
      return putActive(id);
    });
  }

  /** 保存指定简历的 profile ——只写这一份 */
  function updateResume(id, profile) {
    return getOne(id).then(function (r) {
      if (!r) return null;
      r.profile = normalizeProfile(profile);
      r.updatedAt = Date.now();
      return putResume(r).then(function () { return r.profile; });
    });
  }

  /** 保存到「当前使用简历」 */
  function saveProfile(profile) {
    return readAll().then(function (s) { return updateResume(s.activeId, profile); });
  }

  /**
   * 新建一份简历并切换为当前使用。
   * 可以同时带上初始 profile（导入场景），避免「先建空的、再写入一次」的两次写。
   */
  function createResume(name, profile) {
    var r = makeResume(name || '新建简历', profile || clone(DEFAULT_PROFILE));
    return putResume(r)
      .then(function () { return putActive(r.id); })
      .then(function () { return r; });
  }

  /** 复制一份简历，并切换为当前使用 */
  function duplicateResume(id) {
    return getOne(id).then(function (src) {
      if (!src) return null;
      var copy = makeResume(src.name + ' 副本', clone(src.profile));
      return putResume(copy)
        .then(function () { return putActive(copy.id); })
        .then(function () { return copy; });
    });
  }

  function renameResume(id, name) {
    return getOne(id).then(function (r) {
      if (!r) return null;
      r.name = String(name || '').trim() || r.name;
      r.updatedAt = Date.now();
      return putResume(r).then(function () { return r; });
    });
  }

  /** 删除简历；至少保留一份 */
  function deleteResume(id) {
    return readAll().then(function (s) {
      if (s.resumes.length <= 1) {
        return { ok: false, error: '至少需要保留一份简历' };
      }
      var next = s.resumes.filter(function (r) { return r.id !== id; });
      var activeId = (s.activeId === id) ? next[0].id : s.activeId;
      return dropResume(id)
        .then(function () { return putActive(activeId); })
        .then(function () { return { ok: true, activeId: activeId }; });
    });
  }

  // -------------------------------------------- 缺失要素 / 新信息回填

  var KEY_MISSING = 'rj_missing_fields';

  /**
   * 把「这次投递表单问了、但简历里是空的」字段记下来并累计次数。
   * 用来在设置页看到「常被问到但我还没填」的信息，一次补齐。
   */
  function recordMissing(entries) {
    if (!entries || !entries.length) return Promise.resolve(0);
    return new Promise(function (resolve) {
      chrome.storage.local.get([KEY_MISSING], function (res) {
        var map = (res && res[KEY_MISSING]) || {};
        entries.forEach(function (e) {
          if (!e || !e.path) return;
          var cur = map[e.path] || { count: 0 };
          cur.label = e.label || cur.label || e.path;
          cur.count = (cur.count || 0) + 1;
          cur.lastAt = Date.now();
          cur.lastUrl = e.url || cur.lastUrl || '';
          map[e.path] = cur;
        });
        var data = {};
        data[KEY_MISSING] = map;
        chrome.storage.local.set(data, function () { resolve(Object.keys(map).length); });
      });
    });
  }

  function getMissing() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([KEY_MISSING], function (res) {
        var map = (res && res[KEY_MISSING]) || {};
        resolve(Object.keys(map).map(function (path) {
          return {
            path: path,
            label: map[path].label || path,
            count: map[path].count || 0,
            lastAt: map[path].lastAt || 0,
            lastUrl: map[path].lastUrl || ''
          };
        }).sort(function (a, b) { return b.count - a.count; }));
      });
    });
  }

  function clearMissing() {
    return new Promise(function (resolve) {
      chrome.storage.local.remove([KEY_MISSING], function () { resolve(); });
    });
  }

  /**
   * 把一批「路径 -> 值」写进**当前使用简历**，只覆盖给出的路径，不碰其它字段。
   * 用于填表时发现的新信息回填（例如表单问了政治面貌，而简历里是空的）。
   */
  function patchActiveProfile(partial) {
    var paths = Object.keys(partial || {});
    if (!paths.length) return Promise.resolve(null);

    return readAll().then(function (s) {
      return getOne(s.activeId).then(function (r) {
        if (!r) return null;
        var profile = normalizeProfile(r.profile);

        paths.forEach(function (path) {
          var v = partial[path];
          if (v === undefined || v === null || v === '') return;
          var parts = path.split('.');
          if (parts.length === 1) {
            if (Array.isArray(profile[parts[0]])) {
              profile[parts[0]] = String(v).split(/[,，、;；|]+/)
                .map(function (x) { return x.trim(); }).filter(Boolean);
            } else {
              profile[parts[0]] = String(v);
            }
          } else if (profile[parts[0]] && typeof profile[parts[0]] === 'object') {
            profile[parts[0]][parts[1]] = String(v);
          }
        });

        r.profile = profile;
        r.updatedAt = Date.now();
        return putResume(r).then(function () { return { id: r.id, name: r.name }; });
      });
    });
  }

  root.__RJ_STORE__ = {
    DEFAULT_PROFILE: DEFAULT_PROFILE,
    normalizeProfile: normalizeProfile,
    patchActiveProfile: patchActiveProfile,
    recordMissing: recordMissing,
    getMissing: getMissing,
    clearMissing: clearMissing,
    listResumes: listResumes,
    getResume: getResume,
    getActiveResume: getActiveResume,
    getProfile: getProfile,
    ensureProfile: ensureProfile,
    setActiveResume: setActiveResume,
    updateResume: updateResume,
    saveProfile: saveProfile,
    createResume: createResume,
    duplicateResume: duplicateResume,
    renameResume: renameResume,
    deleteResume: deleteResume
  };
})(typeof self !== 'undefined' ? self : this);
