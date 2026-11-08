/**
 * 语义层 - 规则配置。
 * 把「页面字段特征」映射到「Profile 路径」的第一级：同义词词典 + autocomplete 标准名 + 排除词。
 * 规则命中即返回（快、零推理成本）；未命中的字段留给后续 LLM 层（Phase 2）。
 */
(function () {
  if (window.__RJ_CONFIG__) return;

  window.__RJ_CONFIG__ = {
    // 低于该置信度的自动匹配不会被「自动补齐」流程填入
    autoFillThreshold: 0.65,

    fieldRules: [
      {
        path: 'basic.name',
        autocomplete: ['name'],
        keywords: ['真实姓名', '您的姓名', '你的姓名', '申请人姓名', '姓名', '名字', 'fullname', 'full name', 'realname', 'name'],
        exclude: ['公司', '企业', '单位', '学校', '院校', '大学', '学院', '项目名', '职位', '岗位', '部门', '联系人', '紧急联系', '用户名', '昵称', 'companyname', 'schoolname', 'projectname', 'username']
      },
      {
        path: 'basic.gender',
        autocomplete: ['sex'],
        keywords: ['性别', 'gender', 'sex'],
        exclude: []
      },
      {
        path: 'basic.phone',
        autocomplete: ['tel', 'tel-national', 'phone'],
        keywords: ['手机号码', '手机号', '移动电话', '联系电话', '联系方式', '手机', '电话', 'mobile', 'phone', 'tel'],
        exclude: ['区号', '座机', '固话', '验证码']
      },
      {
        path: 'basic.email',
        autocomplete: ['email'],
        keywords: ['电子邮箱地址', '电子邮箱', '邮箱地址', '电子邮件', '邮箱', 'email', 'e-mail', 'mail'],
        exclude: ['邮编', '邮政编码', 'postal', '邮寄']
      },
      {
        path: 'basic.birthday',
        autocomplete: ['bday'],
        keywords: ['出生日期', '出生年月', '出生年份', '生日', 'birthday', 'birthdate', 'birth', 'dob'],
        exclude: ['入职', '毕业', '毕业时间', '到岗']
      },
      {
        path: 'basic.idCard',
        autocomplete: [],
        keywords: ['身份证号码', '身份证号', '身份证', '证件号码', '证件号', 'idcard', 'id card', 'identity'],
        exclude: []
      },
      {
        path: 'basic.location',
        autocomplete: ['address-level1', 'address-level2', 'address-line1'],
        // 「期望工作城市」不在这里 —— 它是求职意向，不是真实居住地，
        // 混在一起会把你的现居地填到意向城市上（实测北森的表单就会这样）。
        keywords: ['现居住地', '现居地', '所在城市', '现居城市', '居住地', '所在地', '城市', '地址', 'address', 'city'],
        exclude: ['邮箱', '邮件', '邮寄', '户籍', '邮编', 'email', 'mail', '期望', '意向']
      },
      {
        path: 'basic.wechat',
        autocomplete: [],
        keywords: ['微信号', '微信', 'wechat', 'weixin'],
        exclude: []
      },
      {
        path: 'basic.politicalStatus',
        autocomplete: [],
        keywords: ['政治面貌', '政治背景', '党派', '党员'],
        exclude: []
      },
      // ---- 求职意向类（投递页上的「期望…」区块，和上面那些真实信息要分清）----
      {
        path: 'basic.expectedCity',
        autocomplete: [],
        keywords: ['期望工作城市', '期望城市', '意向城市', '期望工作地点', '期望工作地', '意向工作地', '期望地点', '工作地点要求'],
        exclude: ['行业', '职业', '职位', '岗位']
      },
      {
        path: 'basic.expectedPosition',
        autocomplete: [],
        keywords: ['期望从事职业', '期望职位', '期望岗位', '意向职位', '意向岗位', '期望职业', '期望从事岗位', '目标职位'],
        exclude: ['行业', '城市', '地点', '薪资', '薪酬']
      },
      {
        path: 'basic.expectedIndustry',
        autocomplete: [],
        keywords: ['期望从事行业', '期望行业', '意向行业', '期望所属行业', '目标行业'],
        exclude: ['职业', '职位', '岗位', '城市', '地点']
      },
      {
        path: 'basic.workYears',
        autocomplete: [],
        keywords: ['工作年限', '工作经验年限', '从业年限', '工作年数', '工作经验'],
        exclude: ['毕业', '学校', '开始', '结束']
      },
      {
        path: 'basic.currentSalary',
        autocomplete: [],
        keywords: ['现月薪', '当前月薪', '现有月薪', '目前月薪', '现薪资', '当前薪资', '目前薪资'],
        exclude: ['期望', '意向']
      },
      {
        path: 'basic.expectedSalary',
        autocomplete: [],
        keywords: ['期望月薪', '期望薪资', '期望年薪', '期望薪酬', '目标薪资', '意向薪资'],
        exclude: []
      },
      {
        path: 'basic.availableFrom',
        autocomplete: [],
        keywords: ['到岗时间', '可到岗时间', '最快到岗', '入职时间', '可入职时间', '预计到岗'],
        exclude: []
      },
      {
        path: 'skills',
        autocomplete: [],
        keywords: ['专业技能', '技能特长', '擅长技能', '技能', '擅长', 'skills', 'skill'],
        exclude: ['语言', '证书']
      },
      {
        path: 'selfEvaluation',
        autocomplete: [],
        keywords: ['自我评价', '自我介绍', '个人评价', '个人简介', '个人优势', '自荐信', 'self evaluation', 'selfevaluation', 'introduction', 'about me', 'summary'],
        exclude: []
      },

      // ---- 重复块：教育 / 工作 / 项目 ----
      //
      // 投递页上这些字段按「块」重复出现（2 段教育就是 2 个块），
      // 块与块之间标签完全一样（都有「开始时间」）。所以规则只说「属于哪一类块」，
      // **第几段由 main.js 按页面顺序算**（路径里的 [*]，见 buildPlan）。
      //
      // block 取值：
      //   'education' / 'experience' / 'projects' —— 明确属于某一类块
      //   '*'                                    —— 中性命段，归到「当前所在的块」
      //                                              （开始/结束时间、职责、描述都是三种块共用的标签）
      // anchor: true 表示这是块的**起点**，遇到它块序号 +1
      {
        path: 'education[*].school',
        block: 'education', anchor: true,
        keywords: ['学校名称', '毕业院校', '院校名称', '就读学校', '毕业学校', '学校'],
        exclude: ['公司', '单位', '专业', '学历', '项目']
      },
      {
        path: 'education[*].major',
        block: 'education',
        keywords: ['专业名称', '所学专业', '主修专业', '就读专业', '专业'],
        exclude: ['学校', '院校', '技能', '证书']
      },
      {
        path: 'education[*].degree',
        block: 'education',
        keywords: ['学历', '学位', '最高学历', '最高学位'],
        exclude: []
      },
      {
        path: 'experience[*].company',
        block: 'experience', anchor: true,
        keywords: ['公司名称', '企业名称', '单位名称', '工作单位', '任职公司', '公司'],
        exclude: ['学校', '院校', '项目', '专业']
      },
      {
        path: 'experience[*].title',
        block: 'experience',
        keywords: ['职位名称', '岗位名称', '担任职位', '任职岗位', '职位', '岗位'],
        exclude: ['项目', '期望', '意向']
      },
      {
        path: 'projects[*].name',
        block: 'projects', anchor: true,
        keywords: ['项目名称', '项目名', '项目标题'],
        exclude: ['公司']
      },
      // 下面四条是三种块共用的标签 —— 归到当前块，块里没有这个键就不填
      // （比如工作块里出现「职务」，experience[i].role 不存在，自然跳过）
      {
        path: '[*].startDate',
        block: '*',
        keywords: ['开始时间', '起始时间', '开始日期', '起始日期'],
        exclude: ['期望', '到岗', '入职']
      },
      {
        path: '[*].endDate',
        block: '*',
        keywords: ['结束时间', '截止时间', '结束日期', '截止日期'],
        exclude: ['期望', '到岗']
      },
      {
        path: '[*].description',
        block: '*',
        keywords: ['工作职责', '工作内容', '职责描述', '工作描述', '项目描述', '项目介绍', '项目内容'],
        exclude: []
      },
      {
        path: '[*].role',
        block: '*',
        keywords: ['项目职务', '项目角色', '担任角色', '职务'],
        exclude: ['公司', '职位名称']
      }
    ]
  };
})();
