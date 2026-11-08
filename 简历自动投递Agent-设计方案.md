# 简历自动投递 Agent — 设计方案

> 场景：用户进入招聘网站/公司官网的投递页面后，Agent 自动扫描前端输入框，将用户的结构化简历数据填入表单。

---

## 一、核心结论（先看这个）

1. **形态选型：推荐「浏览器扩展（Content Script）」，而不是无头浏览器。**
   - 招聘网站 90% 需要登录态、有验证码、有风控。
   - 无头浏览器需自行维护 Cookie、对抗反爬，成本和封号风险高。
   - 扩展跑在用户已登录的真实浏览器中，感知与填写都在真实页面上完成，天然规避上述问题。

2. **智能核心是「语义映射」，不是「扫描」。**
   - 扫描字段是体力活；把形态各异的字段对应到结构化简历，才是 Agent 的价值所在。

3. **必须人在环路（Human-in-the-loop）。**
   - 流程是「自动填 → 高亮待确认 → 用户点提交」。
   - **绝不自动点击「提交」按钮**，除非用户当次明确授权。

4. **处理动态表单靠循环。**
   - 「扫描 → 填 → 重扫」的循环是处理「选了某选项才出现的新字段」的关键。

---

## 二、整体架构

```
┌──────────────────────────────────────────────┐
│ 用户层：浏览器扩展 Popup / 悬浮面板              │
└──────────────────────────────────────────────┘
        │                          ▲
        ▼                          │ 回填结果 + 置信度
┌─────────────────┐        ┌──────────────────┐
│ Content Script  │        │  Background/后端  │
│ 感知层 + 执行层   │◄──────►│  Agent 编排 + LLM │
└─────────────────┘        └──────────────────┘
        │                          │
   ┌────▼─────┐              ┌────▼─────┐
   │ 页面 DOM  │              │ 数据层    │
   │ /AX tree │              │ Profile  │
   └──────────┘              │ 简历解析  │
                             │ 映射记忆  │
                             └──────────┘
```

分层职责：

| 层 | 职责 | 关键技术 |
|---|---|---|
| 用户层 | 触发投递、展示待确认字段 | 扩展 Popup / 悬浮面板 |
| 感知层 | 扫描可填控件、抽取字段特征 | DOM + Accessibility Tree |
| 语义层 | 字段 → Profile 路径映射 | 规则 + LLM + 记忆三级漏斗 |
| 执行层 | 写入值、触发事件 | 原生 setter hack / CDP 键入 |
| 数据层 | 简历解析、Profile 存储、映射记忆 | LLM 抽取 + 向量库 |
| 编排层 | ReAct 循环、校验、人在环路 | 自研 / LangGraph |

---

## 三、模块详解

### 3.1 感知层：扫描输入框

遍历文档定位所有可填控件：`input` / `textarea` / `select` / `[contenteditable]`，
并为每个字段抽取**特征包**（后续语义匹配的输入）：

```json
{
  "selector": "稳定的定位路径",
  "tag": "input",
  "type": "text",
  "attrs": { "name": "realName", "id": "name",
             "placeholder": "请输入姓名", "autocomplete": "name" },
  "labelText": "姓名",
  "nearbyText": "请填写您的真实姓名",
  "required": true,
  "options": [],
  "visible": true,
  "iframePath": null
}
```

要点：

- **label 推断是重点**。中文表单常无规范 `label for`，需逐级兜底：
  `aria-label` → `<label for>` / `aria-labelledby` → 兄弟节点文本 → 父容器文本 → 上方最近文本。
- **穿透 iframe 与 Shadow DOM**（很多招聘系统内嵌）。
- **AX tree 比裸 DOM 更稳**：`Accessibility.getFullAXTree` 返回 role + name，语义清晰。
  建议 DOM 与 AX **双源合并**。
- **视觉兜底**：canvas 渲染或疑难场景，截图交多模态模型识别。

### 3.2 语义层：字段映射（核心）

**标准化 Profile Schema（对齐 JSON Resume）：**

```json
{
  "basic": { "name": "", "gender": "", "birthday": "", "phone": "", "email": "", "idCard": "" },
  "education": [{ "school": "", "major": "", "degree": "", "startDate": "", "endDate": "", "gpa": "" }],
  "experience": [{ "company": "", "title": "", "startDate": "", "endDate": "", "description": "" }],
  "projects": [{ "name": "", "role": "", "description": "" }],
  "skills": [],
  "selfEvaluation": ""
}
```

**三级匹配漏斗：**

1. **规则层（快、便宜、命中即返回）**
   - 同义词词典：`{ phone: ["手机", "电话", "联系方式", "mobile", "tel"] }`
   - `autocomplete` 标准名直接命中。
   - 覆盖约 60–70% 常见字段，零推理成本。

2. **LLM 层（兜底语义匹配）**
   - 输入：未命中字段的「特征包」+ Profile 的 key 列表。
   - 输出（强制 JSON）：
     ```json
     [{ "selector": "...", "path": "basic.phone", "confidence": 0.6 }]
     ```

3. **记忆层（越用越准）**
   - 「字段指纹（label+name+placeholder 哈希）」→「用户最终填的值 / 路径」存入向量库。
   - 下次遇相似字段直接命中用户习惯，决定长期体验。

**产出物 = Fill Plan：**

```json
[{ "selector": "...", "path": "basic.name", "value": "张三", "confidence": 0.95, "reason": "label=姓名" }]
```

### 3.3 执行层：填写

**核心陷阱：React/Vue 受控组件直接 `el.value = x` 无效**（框架 state 不同步）。

```js
// 方式一：原生 setter hack + 派发事件
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(el, value);
el.dispatchEvent(new Event('input',  { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));

// 方式二（更拟真）：CDP Input.dispatchKeyEvent 逐字符键入
// 方式三：Playwright locator.fill() / pressSequentially()
```

**特殊控件处理清单：**

| 控件类型 | 处理方式 |
|---|---|
| select / 级联省市区 | 匹配 option 文本或 value |
| 日期选择器 | 优先填文本，失败再驱动日历弹窗 |
| radio / checkbox | 按 label 文本匹配后点击 |
| 富文本 contenteditable | 模拟输入 + 触发 blur |
| 文件上传（简历 PDF） | `setInputFiles` / 构造 DataTransfer |
| 验证码 | **人工接管**（弹窗让用户填），不硬刚 |
| 动态表单 | 填完一轮后**重扫**，循环补齐 |

### 3.4 数据层：简历 → Profile

- **简历解析**：PDF/DOCX → 文本 → LLM 结构化抽取（JSON mode / function calling）。
- **存储**：PII 本地加密，不存明文密码；文件上传用本地文件句柄。
- **记忆**：字段指纹向量化，支撑语义层第 3 级。

---

## 四、Agent 工作流（ReAct 循环）

```
扫描页面
   │
   ▼
生成 Fill Plan
   │
   ▼
高置信度 → 自动填写
   │
   ▼
重扫页面（处理动态新增字段）
   │
   ▼
低置信度 → 高亮，等用户确认
   │
   ▼
用户手动点击「提交」
```

要点：

- 循环是常态：一次填不完很正常，**「扫描→填→重扫」** 是处理动态表单的核心。
- 每一步填写后读回校验（verify），失败进入下一轮。
- 提交动作永远交给用户。

---

## 五、技术选型

| 层 | 推荐 |
|---|---|
| 感知 / 执行 | Chrome Extension (MV3) + Content Script；复杂站点用 Playwright / CDP |
| Agent 编排 | 自研轻量 ReAct，或 LangGraph |
| 模型 | 强模型做映射决策 + 多模态模型做视觉兜底 |
| 记忆 | 向量库（字段指纹检索） |
| 简历解析 | 专用解析库 + LLM 抽取 |

---

## 六、MVP 路线图

- **Phase 1**：单站点硬编码 + 手动录入 Profile。先跑通「能填进去」，验证受控组件方案。
- **Phase 2**：接入 LLM 通用映射，支持 2–3 个站点，做人在环路 UI。
- **Phase 3**：简历自动解析 + 记忆学习 + 扩展形态打磨。
- **Phase 4**：多站点规模化、拟人化操作、风控适配。

---

## 七、风险与合规

- **反爬 / 风控**：拟人化延迟、随机抖动；扩展形态天然更安全。
- **合规红线**：遵守目标网站 ToS；不做高频批量投递；自动提交必须用户确认。
- **隐私**：PII 加密存储；能本地映射就不上云。
