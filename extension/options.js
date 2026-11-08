/* 资料设置页：多份简历管理 + 文件导入解析 + 经历数组编辑 */
(function () {
  var STORE = window.__RJ_STORE__;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  // ------------------------------------------------------------ 字段定义

  var FIELDS = [
    ['name', 'basic.name'],
    ['gender', 'basic.gender'],
    ['birthday', 'basic.birthday'],
    ['phone', 'basic.phone'],
    ['email', 'basic.email'],
    ['idCard', 'basic.idCard'],
    ['location', 'basic.location'],
    ['wechat', 'basic.wechat'],
    ['politicalStatus', 'basic.politicalStatus'],
    // 求职意向：投递页上「期望…」那块，和上面的个人信息分开维护
    ['expectedCity', 'basic.expectedCity'],
    ['expectedPosition', 'basic.expectedPosition'],
    ['expectedIndustry', 'basic.expectedIndustry'],
    ['workYears', 'basic.workYears'],
    ['currentSalary', 'basic.currentSalary'],
    ['expectedSalary', 'basic.expectedSalary'],
    ['availableFrom', 'basic.availableFrom'],
    ['selfEvaluation', 'selfEvaluation']
  ];

  var ID_BY_PATH = {};
  FIELDS.forEach(function (f) { ID_BY_PATH[f[1]] = f[0]; });

  /** 经历区块的字段定义：key / 标题 / 占位符 / 控件类型 */
  var REPEAT_DEFS = [
    {
      key: 'education',
      fields: [
        ['school', '学校', '清华大学'],
        ['major', '专业', '计算机科学与技术'],
        ['degree', '学历', '本科'],
        ['startDate', '开始', '2016-09'],
        ['endDate', '结束', '2020-06'],
        ['description', '补充说明', '', 'textarea']
      ],
      title: function (e) { return [e.school, e.degree].filter(Boolean).join(' · '); }
    },
    {
      key: 'experience',
      fields: [
        ['company', '公司', '某某科技有限公司'],
        ['title', '职位', '后端开发工程师'],
        ['startDate', '开始', '2023-07'],
        ['endDate', '结束', '至今'],
        ['description', '工作内容', '负责……', 'textarea']
      ],
      title: function (e) { return [e.company, e.title].filter(Boolean).join(' · '); }
    },
    {
      key: 'projects',
      fields: [
        ['name', '项目名称', '订单中心重构'],
        ['role', '角色', '负责人'],
        ['startDate', '开始', '2023-08'],
        ['endDate', '结束', '2023-12'],
        ['description', '项目描述', '背景、职责、成果……', 'textarea']
      ],
      title: function (e) { return [e.name, e.role].filter(Boolean).join(' · '); }
    }
  ];

  var CONFIDENCE_HINT = 0.7;

  // ---------------------------------------------------------------- 状态

  var state = {
    resumes: [],
    activeId: null,
    nameMode: null,          // 'create' | 'rename'
    repeat: { education: [], experience: [], projects: [] },
    lastImport: null,        // { fileName, kind, textLength }
    savedJson: null          // 上次落盘/载入时的表单快照，用来避免无改动的重复写入
  };

  // ------------------------------------------------------------ 基础工具

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getByPath(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return (o == null ? undefined : o[k]);
    }, obj);
  }

  var savedTimer = null;
  function showSaved(text, isError) {
    var el = $('#saved');
    el.textContent = text || '已保存';
    el.style.color = isError ? '#f87171' : '#34d399';
    el.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function formatTime(t) {
    if (!t) return '';
    try { return new Date(t).toLocaleString('zh-CN', { hour12: false }); }
    catch (e) { return ''; }
  }

  // -------------------------------------------------------- 经历（数组）编辑

  function syncRepeat() {
    REPEAT_DEFS.forEach(function (def) {
      var list = document.getElementById('list-' + def.key);
      if (!list) return;
      var entries = [];
      $$('#' + 'list-' + def.key + ' .entry').forEach(function (box) {
        var obj = {};
        def.fields.forEach(function (f) {
          var input = box.querySelector('[data-k="' + f[0] + '"]');
          obj[f[0]] = input ? input.value.trim() : '';
        });
        entries.push(obj);
      });
      state.repeat[def.key] = entries;
    });
  }

  function isMeaningful(obj) {
    return Object.keys(obj).some(function (k) { return String(obj[k] || '').trim() !== ''; });
  }

  function renderRepeat(key) {
    var def = REPEAT_DEFS.filter(function (d) { return d.key === key; })[0];
    var list = document.getElementById('list-' + key);
    if (!def || !list) return;

    list.innerHTML = '';
    state.repeat[key].forEach(function (entry, idx) {
      var box = document.createElement('div');
      box.className = 'entry';
      box.dataset.idx = idx;

      var head = document.createElement('div');
      head.className = 'entry-head';
      head.innerHTML =
        '<span class="entry-title"></span>' +
        '<button class="btn ghost small danger" data-remove="' + idx + '">删除</button>';
      box.appendChild(head);

      var grid = document.createElement('div');
      grid.className = 'grid';
      def.fields.forEach(function (f) {
        var isText = f[3] === 'textarea';
        var label = document.createElement('label');
        label.className = 'field' + (isText ? ' full' : '');
        var cap = document.createElement('span');
        cap.textContent = f[1];
        var input = document.createElement(isText ? 'textarea' : 'input');
        if (isText) input.rows = 2;
        else input.type = 'text';
        if (f[2]) input.placeholder = f[2];
        input.setAttribute('data-k', f[0]);
        input.value = entry[f[0]] || '';
        label.appendChild(cap);
        label.appendChild(input);
        grid.appendChild(label);
      });
      box.appendChild(grid);
      list.appendChild(box);
    });

    updateTitles(key);
  }

  function renderAllRepeat() {
    REPEAT_DEFS.forEach(function (d) { renderRepeat(d.key); });
  }

  function updateTitles(key) {
    var def = REPEAT_DEFS.filter(function (d) { return d.key === key; })[0];
    if (!def) return;
    $$('#list-' + key + ' .entry').forEach(function (box) {
      var obj = {};
      def.fields.forEach(function (f) {
        var input = box.querySelector('[data-k="' + f[0] + '"]');
        obj[f[0]] = input ? input.value.trim() : '';
      });
      var span = box.querySelector('.entry-title');
      var t = def.title(obj);
      span.textContent = t || '（未填写）';
      span.className = 'entry-title' + (t ? '' : ' empty');
    });
  }

  function addEntry(key) {
    syncRepeat();
    var blank = {};
    var def = REPEAT_DEFS.filter(function (d) { return d.key === key; })[0];
    def.fields.forEach(function (f) { blank[f[0]] = ''; });
    state.repeat[key].push(blank);
    renderRepeat(key);
    var list = document.getElementById('list-' + key);
    var last = list.lastElementChild;
    if (last) {
      var firstInput = last.querySelector('input, textarea');
      if (firstInput) firstInput.focus();
      last.scrollIntoView({ block: 'nearest' });
    }
  }

  // ------------------------------------------------------------ 表单读写

  function fillForm(profile) {
    FIELDS.forEach(function (f) {
      var el = document.getElementById(f[0]);
      if (!el) return;
      var v = getByPath(profile, f[1]);
      el.value = v == null ? '' : v;
    });
    var skills = document.getElementById('skills');
    skills.value = Array.isArray(profile.skills) ? profile.skills.join(', ') : '';

    state.repeat = {
      education: clone(profile.education || []),
      experience: clone(profile.experience || []),
      projects: clone(profile.projects || [])
    };
    renderAllRepeat();
    clearConfidenceMarks();
    state.savedJson = JSON.stringify(collect());   // 记下来，用于判断后面有没有真的改过
  }

  function collect() {
    var profile = JSON.parse(JSON.stringify(STORE.DEFAULT_PROFILE));
    FIELDS.forEach(function (f) {
      var el = document.getElementById(f[0]);
      if (!el) return;
      var parts = f[1].split('.');
      if (parts.length === 1) profile[parts[0]] = el.value.trim();
      else profile[parts[0]][parts[1]] = el.value.trim();
    });
    var raw = document.getElementById('skills').value;
    profile.skills = raw.split(/[,，、;；|]+/).map(function (s) { return s.trim(); }).filter(Boolean);

    syncRepeat();
    profile.education = clone(state.repeat.education).filter(isMeaningful);
    profile.experience = clone(state.repeat.experience).filter(isMeaningful);
    profile.projects = clone(state.repeat.projects).filter(isMeaningful);
    return profile;
  }

  // -------------------------------------------------------- 置信度标注

  function clearConfidenceMarks() {
    $$('.low-conf').forEach(function (el) { el.classList.remove('low-conf'); });
  }

  /** 解析置信度低于阈值的字段标黄，提示重点核对 */
  function markConfidence(confidence) {
    clearConfidenceMarks();
    var low = 0;
    Object.keys(confidence || {}).forEach(function (path) {
      if (confidence[path] >= CONFIDENCE_HINT) return;
      var id = ID_BY_PATH[path];
      var el = id ? document.getElementById(id) : null;
      if (el) { el.classList.add('low-conf'); low++; }
    });
    return low;
  }

  // ------------------------------------------------------------ 简历列表

  function cur() {
    return state.resumes.filter(function (r) { return r.id === state.activeId; })[0];
  }

  function renderSelect() {
    var sel = $('#resume-select');
    sel.innerHTML = '';
    state.resumes.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name + (r.hasName ? '' : '（未填写）');
      sel.appendChild(o);
    });
    sel.value = state.activeId;

    var c = cur();
    $('#resume-meta').textContent = c ? ('最近更新：' + formatTime(c.updatedAt)) : '';
    $('#btn-del').disabled = state.resumes.length <= 1;
  }

  async function refreshList() {
    var data = await STORE.listResumes();
    state.resumes = data.resumes;
    state.activeId = data.activeId;
    renderSelect();
  }

  async function loadIntoForm(id) {
    var r = await STORE.getResume(id);
    fillForm(r.profile);
  }

  /**
   * 保存当前编辑中的简历。
   * 内容没变就不写 —— 否则每次切换简历都会把整份简历重写一遍（实测 4KB+）。
   * @returns {Promise<boolean>} 是否真的写入了
   */
  async function saveCurrent() {
    if (!state.activeId) return false;
    var json = JSON.stringify(collect());
    if (json === state.savedJson) return false;
    await STORE.updateResume(state.activeId, collect());
    state.savedJson = json;
    return true;
  }

  /**
   * 把表单标记成「有未保存的改动」。
   *
   * 为什么必须有这个函数：`fillForm()` 结尾会把当前表单内容记进 `state.savedJson`，
   * 而 `saveCurrent()` 是拿 `collect()` 和它比对来判断「有没有改动」的。
   * 于是凡是「用 fillForm 灌入新内容、再让用户点保存」的路径（导入简历、填入示例），
   * 内容刚灌进去就已经被记成「已保存」了 —— 用户点「保存资料」只会看到「无改动」，
   * **数据从未落盘**，而界面看起来一切正常。灌完必须显式标记为脏。
   */
  function markDirty() {
    state.savedJson = null;
  }

  async function switchTo(id) {
    if (id === state.activeId) return;
    await saveCurrent();                 // 切换前先落盘，避免丢失当前编辑
    await STORE.setActiveResume(id);
    state.activeId = id;
    await loadIntoForm(id);
    await refreshList();
  }

  // -------------------------------------------------------- 名称编辑器

  function openNameEditor(mode, initial) {
    state.nameMode = mode;
    var box = $('#name-editor');
    box.hidden = false;
    var input = $('#name-input');
    input.value = initial || '';
    input.placeholder = mode === 'create' ? '新简历名称，如：后端开发-社招' : '新的简历名称';
    input.focus();
    input.select();
  }

  function closeNameEditor() {
    state.nameMode = null;
    $('#name-editor').hidden = true;
  }

  async function confirmName() {
    var name = $('#name-input').value.trim();
    if (!name) { $('#name-input').focus(); return; }

    if (state.nameMode === 'create') {
      await saveCurrent();
      var r = await STORE.createResume(name);
      state.activeId = r.id;
      fillForm(r.profile);
      await refreshList();
      showSaved('已新建「' + r.name + '」');
    } else if (state.nameMode === 'rename') {
      await STORE.renameResume(state.activeId, name);
      await refreshList();
      showSaved('已重命名');
    }
    closeNameEditor();
  }

  // ------------------------------------------------------------ 文件导入

  function setImportStatus(text, kind) {
    var el = $('#import-status');
    el.textContent = text || '';
    el.className = 'import-status ' + (kind || '');
  }

  function showImportBar(text) {
    $('#import-bar-text').innerHTML = text;
    $('#import-bar').hidden = false;
  }

  function hideImportBar() {
    $('#import-bar').hidden = true;
  }

  function summarize(parsed) {
    var p = parsed.profile;
    var bits = [];
    if (p.basic.name) bits.push('姓名 ' + esc(p.basic.name));
    if (p.basic.phone) bits.push('手机已识别');
    if (p.basic.email) bits.push('邮箱已识别');
    if (p.education.length) bits.push('教育经历 ' + p.education.length + ' 条');
    if (p.experience.length) bits.push('工作经历 ' + p.experience.length + ' 条');
    if (p.projects.length) bits.push('项目经历 ' + p.projects.length + ' 条');
    if (p.skills.length) bits.push('技能 ' + p.skills.length + ' 项');
    return bits.length ? bits.join(' · ') : '未识别出结构化字段';
  }

  async function runImport(file) {
    setImportStatus('正在解析：' + file.name, 'working');
    hideImportBar();

    var res;
    try {
      res = await window.__RJ_FILE_TEXT__.readAsText(file);
    } catch (e) {
      setImportStatus('读取失败：' + ((e && e.message) || e), 'err');
      return;
    }
    if (!res.text) {
      setImportStatus('未提取到文本（扫描件 / 图片型 PDF 需要 OCR，暂不支持）', 'err');
      return;
    }

    var parsed = window.__RJ_RESUME_PARSER__.parseResume(res.text);
    state.lastImport = { fileName: res.fileName, kind: res.kind, textLength: res.text.length };

    fillForm(parsed.profile);                    // 结果先填进表单，用户可改
    markDirty();                                 // 关键：否则「保存资料」会判定无改动，导入的东西永远存不下去
    var lowCount = markConfidence(parsed.confidence);

    setImportStatus(
      '已解析 ' + res.fileName + '（' + res.kind.toUpperCase() + '，' + res.text.length + ' 字）',
      'ok'
    );
    showImportBar(
      '已从 <strong>' + esc(res.fileName) + '</strong> 填入草稿：' + summarize(parsed) +
      (lowCount ? '　黄框字段为低置信度，请重点核对' : '') +
      '　核对后点右下角「保存资料」，或直接存为新简历。'
    );
  }

  async function saveImportAsNewResume() {
    var profile = collect();
    var base = (state.lastImport && state.lastImport.fileName || '').replace(/\.[^.]+$/, '').trim();
    var name = base || profile.basic.name || '导入的简历';

    // 建简历时就带上解析结果，只写「新简历 + 指针」两笔，避免先建空的再补一次
    var r = await STORE.createResume(name, profile);
    state.activeId = r.id;
    await refreshList();
    await loadIntoForm(r.id);
    hideImportBar();
    setImportStatus('已存为新简历「' + r.name + '」', 'ok');
    showSaved('已存为新简历');
  }

  // ------------------------------------------------------------ AI 设置

  var AI = window.__RJ_AI__;

  function aiStatus(text, kind) {
    var el = $('#ai-status');
    el.textContent = text || '';
    el.className = 'import-status ' + (kind || '');
  }

  function collectAiConfig() {
    return {
      enabled: $('#ai-enabled').checked,
      baseUrl: $('#ai-baseurl').value.trim(),
      model: $('#ai-model').value.trim(),
      apiKey: $('#ai-apikey').value.trim()
    };
  }

  async function loadAiConfig() {
    var cfg = await AI.get();
    $('#ai-enabled').checked = cfg.enabled;
    $('#ai-baseurl').value = cfg.baseUrl;
    $('#ai-model').value = cfg.model;
    $('#ai-apikey').value = cfg.apiKey;
  }

  // 说明：AI 相关动作（测试连接、清空缓存）都在本页直接完成，不走后台。
  // 后台只在投递页的兜底匹配里用到（那边需要跨标签页共享缓存与并发控制）。
  // 需要探后台时用 window.__RJ_BG__.once({ type: 'RJ_PING_BG' })。

  // -------------------------------------------------------- 缺失要素清单

  async function renderMissing() {
    var list = await STORE.getMissing();
    var active = await STORE.getActiveResume();
    var box = $('#missing-list');
    box.innerHTML = '';

    list.forEach(function (m) {
      var filled = !!String(getByPath(active.profile, m.path) || '').trim();

      var item = document.createElement('div');
      item.className = 'missing-item' + (filled ? ' is-filled' : '');

      var left = document.createElement('div');
      left.innerHTML =
        '<div class="missing-label">' + esc(m.label) +
        (filled
          ? '<span class="missing-count filled">已补齐</span>'
          : '<span class="missing-count">被问过 ' + m.count + ' 次</span>') +
        '</div>' +
        '<div class="missing-path">' + esc(m.path) + '</div>';

      var btn = document.createElement('button');
      btn.className = 'btn ghost small';
      btn.textContent = filled ? '去查看' : '去填写';
      btn.addEventListener('click', function () { gotoPath(m.path); });

      item.appendChild(left);
      item.appendChild(btn);
      box.appendChild(item);
    });
  }

  /** 跳到对应的输入框并高亮一下；数组型字段没有单输入框，直接提示 */
  function gotoPath(path) {
    var id = ID_BY_PATH[path];
    var el = id ? document.getElementById(id) : null;
    if (!el) {
      showSaved('该项请在「经历」区块里填写', true);
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus();
    el.classList.add('low-conf');
    setTimeout(function () { el.classList.remove('low-conf'); }, 1600);
  }

  // ------------------------------------------------------------ 事件绑定

  function bindRepeatLists() {
    REPEAT_DEFS.forEach(function (def) {
      var list = document.getElementById('list-' + def.key);
      if (!list) return;

      list.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-remove]');
        if (!btn) return;
        var idx = Number(btn.getAttribute('data-remove'));
        syncRepeat();
        state.repeat[def.key].splice(idx, 1);
        renderRepeat(def.key);
      });

      list.addEventListener('input', function () {
        syncRepeat();
        updateTitles(def.key);
      });
    });

    $$('[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        addEntry(btn.getAttribute('data-add'));
      });
    });
  }

  document.addEventListener('DOMContentLoaded', async function () {
    await STORE.ensureProfile();
    await refreshList();
    await loadIntoForm(state.activeId);
    bindRepeatLists();
    await loadAiConfig();
    await renderMissing();

    // ---- 简历管理 ----
    $('#resume-select').addEventListener('change', function () { switchTo(this.value); });

    $('#btn-save').addEventListener('click', async function () {
      var changed = await saveCurrent();
      await refreshList();
      await renderMissing();          // 补了内容后，缺失清单里的「已补齐」标记要跟着更新
      showSaved(changed ? '已保存' : '无改动');
    });

    $('#btn-new').addEventListener('click', function () { openNameEditor('create', ''); });
    $('#btn-rename').addEventListener('click', function () {
      var c = cur();
      openNameEditor('rename', c ? c.name : '');
    });

    $('#btn-dup').addEventListener('click', async function () {
      await saveCurrent();
      var r = await STORE.duplicateResume(state.activeId);
      if (!r) return;
      state.activeId = r.id;
      fillForm(r.profile);
      await refreshList();
      showSaved('已复制为「' + r.name + '」');
    });

    $('#btn-del').addEventListener('click', async function () {
      var c = cur();
      if (!confirm('确定删除「' + (c ? c.name : '') + '」？该操作不可恢复。')) return;
      var res = await STORE.deleteResume(state.activeId);
      if (!res || !res.ok) { showSaved((res && res.error) || '删除失败', true); return; }
      state.activeId = res.activeId;
      await loadIntoForm(state.activeId);
      await refreshList();
      showSaved('已删除');
    });

    // ---- 名称编辑器 ----
    $('#btn-name-ok').addEventListener('click', confirmName);
    $('#btn-name-cancel').addEventListener('click', closeNameEditor);
    $('#name-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') confirmName();
      if (e.key === 'Escape') closeNameEditor();
    });

    // ---- 文件导入 ----
    $('#btn-import').addEventListener('click', function () { $('#import-file').click(); });
    $('#import-file').addEventListener('change', async function () {
      var file = this.files && this.files[0];
      this.value = '';                     // 允许连续选同一个文件
      if (!file) return;
      await runImport(file);
    });
    $('#btn-import-newsave').addEventListener('click', saveImportAsNewResume);
    $('#btn-import-dismiss').addEventListener('click', hideImportBar);

    // ---- AI 设置 ----
    $('#btn-ai-save').addEventListener('click', async function () {
      await AI.save(collectAiConfig());
      aiStatus('已保存', 'ok');
    });

    /**
     * 「测试连接」直接在本页测接口，**不绕后台**。
     *
     * 这个按钮要回答的是「我配的接口通不通」，而不是「后台活着没有」——
     * 绕后台的话，后台一旦连不上，你只会看到一句
     * 「Could not establish connection. Receiving end does not exist.」，
     * 既不知道 Key 对不对、也不知道模型名对不对。
     *
     * 后台状态单独探一次、单独报：接口通不通和后台通不通是两件事，
     * 混在一起报就会互相掩盖（扫描阶段用不了 AI，是后台的问题，不是接口的问题）。
     */
    var aiTesting = false;
    $('#btn-ai-test').addEventListener('click', async function () {
      // 连点几下就是好几倍的请求 —— 对着有速率限制的接口，这足以把自己打限流。
      // 所以测试期间禁用按钮，并加一道并发闸。
      if (aiTesting) return;
      aiTesting = true;
      var btn = $('#btn-ai-test');
      btn.disabled = true;
      aiStatus('测试中…', 'working');
      await AI.save(collectAiConfig());

      var res = await window.__RJ_AI_MAP__.testConnection();
      aiTesting = false;
      btn.disabled = false;

      if (!res.ok) {
        // 接口的原始报错（尤其 429）翻译成能照做的说法
        aiStatus('失败：' + window.__RJ_AI_MAP__.explainError(res.error), 'err');
        return;
      }

      var bg = await window.__RJ_BG__.once({ type: 'RJ_PING_BG' });
      var head = '接口正常（' + res.model + '）。示例字段「手机号码」判定：' +
        (res.sample ? res.sample.path : '未匹配') + '。';

      if (bg.ok) {
        aiStatus(head + '后台正常。', 'ok');
      } else {
        aiStatus(head + '但后台连不上 —— ' + window.__RJ_BG__.friendly(bg) +
          '（投递页上的 AI 兜底需要后台，先把这个修好）', 'working');
      }
    });

    // 缓存就存在 chrome.storage.local 里，本页直接清即可，同样不需要后台
    $('#btn-ai-clear').addEventListener('click', async function () {
      try {
        await window.__RJ_AI_MAP__.clearCache();
        aiStatus('缓存已清空', 'ok');
      } catch (e) {
        aiStatus('清空失败：' + ((e && e.message) || e), 'err');
      }
    });

    // ---- 缺失要素 ----
    $('#btn-missing-clear').addEventListener('click', async function () {
      await STORE.clearMissing();
      await renderMissing();
      showSaved('已清空记录');
    });

    // ---- 示例数据 ----
    $('#btn-sample').addEventListener('click', function () {
      var sample = {
        name: '张三', gender: '男', birthday: '1998-06-01',
        phone: '13800000000', email: 'zhangsan@example.com',
        location: '上海', wechat: 'zhangsan_wx', politicalStatus: '共青团员'
      };
      var current = collect();
      Object.keys(sample).forEach(function (k) { current.basic[k] = sample[k]; });
      current.skills = ['Java', 'Spring Boot', 'MySQL', 'Redis'];
      current.selfEvaluation = '五年后端开发经验，熟悉高并发与分布式系统设计，参与过多个从 0 到 1 的项目落地。';
      current.education = [
        { school: '清华大学', major: '计算机科学与技术', degree: '本科', startDate: '2016-09', endDate: '2020-06', description: '' },
        { school: '清华大学', major: '软件工程', degree: '硕士', startDate: '2020-09', endDate: '2023-06', description: '' }
      ];
      current.experience = [
        { company: '某某科技有限公司', title: '后端开发工程师', startDate: '2023-07', endDate: '至今', description: '负责订单系统重构，QPS 提升 3 倍。' }
      ];
      fillForm(current);
      markDirty();                        // 同「导入简历」：灌进去的内容必须标记为未保存
      showSaved('已填入示例，记得点保存');
    });
  });
})();
