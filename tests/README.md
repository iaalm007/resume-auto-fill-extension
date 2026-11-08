# 测试

## 怎么跑

```bash
cd tests

node run-all.js                  # 全部（单元 + 界面 + 真实投递页门禁），约 3 分钟
node run-all.js --fast           # 只跑单元，约 30 秒
node run-all.js --only=real-site  # 只跑真实投递页那条门禁

npm install                      # 首次准备依赖（puppeteer-core）
```

退出码：**0** 全过 · **1** 有失败 · **2** 有「没跑成」。

`2` 特意和 `1` 分开：门禁最怕的不是报错，而是**看起来通过了其实什么都没跑**。
环境不具备时绝不算绿色，必须显式冒头。

## 三组的分工

| 目录 | 需要什么 | 验什么 |
|---|---|---|
| `unit/` | 只要 Node | 规则词典、字段匹配、存储、API 限速、AI 提示词与映射、扫描器回归 |
| `ui/` | 起无头 Chrome | 扩展真装上之后：弹窗、资料设置页、后台 Service Worker、AI 兜底、旧页面补注入 |
| `real-site/` | **调试浏览器 + 登录态** | **门禁**：真投递页上端到端填一遍，并清理干净 |

`lib/` 是共享工具（`cdp.js` 极简 CDP 客户端、`extension.js` 扩展装配与状态）。
`tools/` 是诊断脚本，不是测试：

```bash
node tools/ext-state.js           # 环境体检：扩展装了吗、是当前代码吗、简历在吗
node tools/ext-state.js --load    # 没装就装上（装的是磁盘上的最新代码）
```

## 门禁用例：`real-site/form-fill.test.js`

**改动之后、继续下一步之前，这条必须过。** 它跑的是真扩展 + 真页面 + 真登录态，
通过扩展自己的消息通道（`RJ_SCAN` / `RJ_FILL` / `RJ_CLEAR`）驱动，不是手工注入脚本。

它验四件事：

| 段 | 验什么 |
|---|---|
| **A** 感知与匹配 | 字段扫得到、标签读得到；`期望工作城市` 落到 `basic.expectedCity` 而**不是** `basic.location`；现月薪/期望月薪不互换 |
| **B** 组件执行 | 自定义下拉/地区选择器能清空、能选上，且扫描器能读回显示值 |
| **C** 端到端 | 按简历填空白字段；另有一条确定性的「清空某个真输入框 → 按简历填回 → 读回一致」 |
| **D** 安全红线 | 页面上**原有内容**的字段，全程一个字符都不能变 |

设计上的三条硬规矩：

1. **自己造状态**。不假设页面现在是什么样：用得上的字段先清空再填，跑完还原或清掉。
2. **失败也要还原**。清理放在 `finally` 里 —— 断言失败不会把测试值留在你的表单上。
3. **清理优先走扩展**，扩展清不掉的（清除图标靠 CSS `:hover`，合成事件触发不了）
   用 CDP 真实鼠标兜底，并在结果里标明用了哪条路。

```bash
node real-site/form-fill.test.js          # 跑完清理
node real-site/form-fill.test.js --keep   # 跑完不清理（排查用，记得自己清）
```

## 前置条件

门禁需要这三样，缺一它就会以退出码 2 明确报出来：

1. **带调试端口的 Chrome 开着**（`--remote-debugging-port=9222`）
2. **投递页打开着、并且已登录**（URL 里含 `zhiye.com`）
3. **扩展装着且是当前代码**（`node tools/ext-state.js` 一看便知）

推荐这样启动调试浏览器 —— 加 `--enable-unsafe-extension-debugging`：

```
chrome.exe --remote-debugging-port=9222 --user-data-dir=<某目录> --enable-unsafe-extension-debugging
```

原因见下面第 1 条坑。

## 踩过的坑（都别再踩）

1. **不要用 `chrome.runtime.reload()` 去刷新扩展代码。**
   对通过 CDP `Extensions.loadUnpacked` 装进来的 unpacked 扩展，reload 之后它不会正常回来：
   会被 Chrome 标成 `unsupportedDeveloperExtension` 并进入 **DISABLED**，
   所有扩展页面变成 `ERR_BLOCKED_BY_CLIENT`（Chrome 里显示「此页面已被 X 屏蔽」），
   看着像扩展坏了。正确做法：没装就 `Extensions.loadUnpacked`（必然是最新代码）；
   已装就比对版本，不一致时**明确报出来**让人去 `chrome://extensions` 点「重新加载」。
   程序化刷新不值得再冒险 —— 详见 `lib/extension.js` 顶部注释。

   **那怎么刷新？** 用 `tests/tools/refresh-ext.js`：
   ```bash
   node tools/refresh-ext.js            # 装新实例 → 卸旧实例，并核对版本
   ```
   它走的是 `Extensions.loadUnpacked` + `Extensions.uninstall`：装一个**新实例**（必然读磁盘代码），
   再把旧实例卸掉（同一目录两个实例会同时注入 content script，必须清理干净）。

   > ⚠️ **别再用 `ext-state.js --reload`。** 那个走 `chrome.developerPrivate.reload`，
   > 在 Chrome 156 + 日常 profile 上实测会把扩展刷成 **DISABLED 且版本不跟磁盘**；
   > 之后 `chrome.management.setEnabled(true)` 只能救回 ENABLED，代码仍是旧的，
   > 禁用→启用来回切也一样。（早先那台机器上它确实好使，所以这条经验被记错过一次。）
   > 代价：扩展 ID 会变，所以**所有测试按目录路径认扩展，不要写死 ID**；
   > 重装会清空扩展存储（简历要重新导入，门禁会自动导）。

   > 别指望自动重载：曾经观察到改 `manifest.json` 后版本自己跟上了，后来证明那次是人手点的。
   > 实测 0.3.6 → 0.3.7 时并没有自动重载，门禁如实报「装的是旧代码」并跳过 —— 这就是安全网该有的样子。

2. **`plan` 里的字段名是 `label`，不是 `labelText`。**
   `labelText` 是扫描器内部字段名。读错键不会报错，只会得到 `undefined`，
   于是所有「按标签找字段」的断言静默跳过、用例照样报绿色 —— 假通过。
   `form-fill.test.js` 里专门加了一条「扫出来的字段带可读标签」把这种情况顶出来。

3. **字段 id 不能跨扫描复用。** id 是「本次扫描的序号」，而**填了值的自定义组件会把内部那个
   `input` 删掉**，由补扫在列表末尾重新收进来 —— 同一个字段两次扫描的 id 不一样。
   一律**按标签**查找（`entryByLabel`），否则会得到「读回为空」这种假失败。

4. **CSS `:hover` 合成不了。** 组件库的清除图标平时是 `display:none`，靠 `:hover` 显示；
   `dispatchEvent` 派发的 `mouseover` 不算数。CDP 的 `Input.dispatchMouseEvent` 产生可信事件，
   能真正触发 —— 这是**测试能做、扩展做不到**的事，所以清理有兜底这一路。
   （后来发现北森的 `phoenix-select__clearIcon` 虽然 `display:none`，**直接派发 click 照样管用**，
   扩展侧的「撤销填写」已经用上这条路，`via=component-clear-icon`。）

8. **`selector` 不唯一，重复块一律用「标签 + 第几次出现」定位。**
   投递页 39 个字段只有 29 个不同的 `selector`，两个教育块的「学校名称」拿到的是同一个字符串。
   拿它当键去清理会认错块 —— 实测把教育块1 的结束时间（用户填的 2027-07）当成工作块的清掉了，
   而真正的目标字段一点没动。`restore` 与清理现在都按 `label#nth`，DOM 侧的读值也走同一套。

9. **`phoenix-checkbox` 的 `input.checked` 恒为 false。** 状态画在
   `span.phoenix-checkbox__realInput` 的 `--checked` 类上（背景变蓝 rgb(47,84,235)）。
   按 `input.checked` 判断会得到「明明勾着却报没勾」；另外文字节点的类名就是
   `phoenix-checkbox__text`，`closest('[class*="checkbox"]')` 会返回它**自己**，点了个寂寞 ——
   要点父级 `div.phoenix-checkbox`。

10. **「至今」不是一个日期值。** 结束时间旁边的「至今」是勾选框，简历里的「至今」要翻译成
    「勾上它」。硬填进日期组件必然失败，还会让工作经历那块标红「必填」。
    `filler` 对 `至今/现在/present/now` 走勾选路径，靠**屏幕坐标**找同行右侧最近的那个框
    （日期组件的 input 在浮层容器里，DOM 上爬不到勾选框）。

5. **清空自定义组件不能靠「写空字符串」。** 往组件内部 `input` 写空值读回确实是空的、
   看起来成功了，但组件自己的状态没变、显示值还在。所以有单独的 `RJ_CLEAR` 消息走组件的清空路径。

6. **页面主线程被占住时命令不会回来，那不是死循环。** 实测：清空北森的三级地区选择器之后，
   站点要重画 99 个省/区的列表，主线程被占十几秒到几十秒。CDP 超时因此给到 90 秒
   （`RJ_CDP_TIMEOUT_MS` 可调）—— 30 秒正好卡在边界上，会误报成我们的代码有问题。

7. **别让脚本往用户浏览器里留标签。** 早期失败版本在浏览器里留下了几个报错标签页，
   看起来像扩展坏了。`lib/extension.js` 会记录自己开的页面并在结束时关掉，
   门禁的 `finally` 里一定会调。

## 已知问题

- **操作地区选择器会明显卡顿**：清空或选定「期望工作城市」时，站点重画省/区列表会把
  页面主线程占住十几秒到几十秒（门禁里这一步是最慢的）。
  这是站点侧的重渲染成本，扩展侧无法避免；已经做到的是不把它当失败。
- `ui/stale-page-test.js`、`ui/sw-test.js` 目前只有退出码、没有 `N/M` 汇总行，
  runner 会显式标出「无法核对项数」—— 不算问题，但看着不够放心，哪天补上断言计数。
