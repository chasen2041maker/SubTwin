# SubTwin 手工验证指南

本文用于验证自动化测试无法覆盖的真实 Chrome、Netflix 登录态、地区字幕目录和外部翻译服务。每次准备自用发布包或公开测试版时，都应新建一份结果记录，不要直接把“预期”当成“已通过”。

## 当前记录状态

截至本文创建时：

- 本文主要定义验证步骤和验收矩阵，并记录下方有限的非登录浏览器冒烟结果。
- 尚未在本文中记录登录态 Netflix 的完整通过结果。
- 尚未在本文中记录使用用户真实 DeepSeek API Key 的通过结果。

2026-08-23 已对最新 `.output/chrome-mv3` 生产构建执行全新临时 Chrome 配置的非登录冒烟：扩展、后台 service worker、popup、options 均成功加载；默认 provider 为 `unset`；等待 options 完成异步初始化后选择 Google，`chrome.storage.local` 更新成功；Google/DeepSeek 请求数均为 0，页面脚本错误数为 0。Netflix 公共页产生一条站点自身资源请求的 503 控制台错误，不涉及扩展页面或 SubTwin 外部翻译请求。该结果只证明扩展外壳和设置闭环，不替代下方登录态播放、真实字幕目录、外部服务和生命周期矩阵，因此 R/L/S 项仍保持原状态。

如果缺少 Netflix 账号、合适的地区影片或 DeepSeek Key，将对应项目记为 `BLOCKED`，不要记为 `PASS`。

## 1. 前置条件

- Node.js 22.12+、pnpm 10+。
- Chrome 111+ 或兼容的 Chromium，并能加载 Manifest V3 未打包扩展。
- 已登录的 Netflix 账号。
- 当前地区至少准备两部测试内容：
  - A：字幕目录同时含英文和简体中文；
  - B：字幕目录含英文但不含简体中文。
- 仅在验证 DeepSeek 路径时，准备用户自己的有效 DeepSeek API Key 和可用余额。
- 不要在本文、截图、终端历史、HAR、Git commit 或缺陷报告里记录 Netflix cookie、signed subtitle URL、DeepSeek Key、完整字幕原文或译文。

Netflix 字幕可用性会随账号地区和影片版本改变。结果记录可以写影片名称、地区和日期，但不要把测试影片永久写成“全地区都满足”的固定夹具。

## 2. 自动化与构建预检

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

全部命令应以退出码 0 完成。随后检查 `.output/chrome-mv3/manifest.json`：

- `manifest_version` 为 `3`；
- `permissions` 只有 `storage`；
- `host_permissions` 只包含：
  - `https://www.netflix.com/*`
  - `https://api.deepseek.com/*`
  - `https://translate.googleapis.com/*`
- 存在后台 service worker、Netflix content script、popup 和 options 页面；
- 没有任意来源、可选 host permission 或硬编码 API Key。

PowerShell 可用下面的只读检查快速查看关键字段：

```powershell
$manifest = Get-Content -Raw '.output/chrome-mv3/manifest.json' | ConvertFrom-Json
$manifest.manifest_version
$manifest.permissions
$manifest.host_permissions
$manifest.background
$manifest.content_scripts
```

不要用真实 Key 作为仓库全文搜索参数；这会把 Key 留在 shell 历史。检查构建产物时，只确认不存在用户填写的具体值，不要保存或分享包含凭据的存储导出。

## 3. 加载扩展

1. 打开 `chrome://extensions`，启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择 `.output/chrome-mv3`。
3. 确认扩展名称为 SubTwin，且没有加载错误。
4. 打开扩展选项页，确认初始字幕来源为“Netflix 原生双语”。
5. 打开 Netflix 并登录。
6. 每次重新执行 `pnpm build` 后，在扩展管理页点击“重新加载”，再刷新 Netflix 标签页，避免旧 content script 与新后台混用。

开发调试也可以运行 `pnpm dev` 使用 WXT 的 Chrome 开发配置；发布验收必须再用 `.output/chrome-mv3` 生产构建复测。

## 4. 外部调用取证方法

翻译请求由扩展后台 service worker 发出，不能只看 Netflix 页面自己的 Network 面板。

1. 在 `chrome://extensions` 的 SubTwin 卡片上，点击 service worker 的“检查视图/Inspect”。
2. 打开该 DevTools 的 **Network** 面板，启用 **Preserve log**，清空旧记录。
3. 分别用 `api.deepseek.com` 和 `translate.googleapis.com` 过滤。
4. 再开始播放、等待字幕、快进或切换设置。
5. 记录每个域名的新请求数量和时间。场景开始前已经在途的请求要单独标注，不能算作切换后的新请求。

对“零调用”场景，两个域名的新请求数都必须为 0。对单服务场景，未选择服务的新请求数必须为 0。Network 中可能包含敏感的 GET 查询或其他会话信息；不要导出、提交或分享原始 HAR。必要时只记录脱敏后的“域名、请求数、状态码、时间”。

## 5. Netflix 与翻译路由矩阵

结果值统一使用 `NOT RUN`、`PASS`、`FAIL` 或 `BLOCKED`。

| ID | 场景与操作 | 预期网络调用 | 预期字幕/状态 | 结果 |
| --- | --- | --- | --- | --- |
| R01 | 影片 A；选择 Netflix 原生双语；从刷新页面开始播放 | Google 0，DeepSeek 0 | 显示官方英文+简中；状态为官方双语 | NOT RUN |
| R02 | 刷新影片页面，观察目录尚未权威确认的发现阶段 | Google 0，DeepSeek 0 | 保留 Netflix 原生字幕，不提前翻译 | NOT RUN |
| R03 | 影片 B；选择 Netflix 原生双语 | Google 0，DeepSeek 0 | 缺少官方中文时保留英文/原生字幕，不调用外部服务 | NOT RUN |
| R04 | 影片 B；显式选择 Google 翻译 | 只允许 Google；DeepSeek 0 | 英文先可用，中文逐条出现；状态显示 Google 翻译 | NOT RUN |
| R05 | 影片 B；Google 模式下阻断 Google 域名或复现 403/429 | DeepSeek 0 | 显示 Google 不可用/限流状态；不跨服务降级；英文仍可用 | NOT RUN |
| R06 | 影片 B；选择 DeepSeek，但 Key 为空 | Google 0，DeepSeek 0 | 提示配置错误；英文/原生字幕仍可用 | NOT RUN |
| R07 | 影片 B；保存有效 DeepSeek Key，先在选项页测试，再播放 | 只允许 DeepSeek；Google 0 | 上下文中文逐步出现；状态显示 DeepSeek | BLOCKED（需要用户 Key） |
| R08 | 影片 B；保存无效 DeepSeek Key 并播放 | Google 0；DeepSeek 可出现认证失败请求 | 显示认证错误；不改用 Google；英文仍可用 | NOT RUN |
| R09 | 影片 B；外部请求在途时从 Google 切到 DeepSeek，随后反向切换 | 切换后只允许新选择服务发起新任务 | 旧代结果不再渲染或写缓存；无跨服务自动降级 | BLOCKED（DeepSeek 路径需要用户 Key） |
| R10 | 影片 A；分别显式选择 Google 与 DeepSeek | 每次只允许当前所选服务 | 即使有官方中文也按显式来源翻译；不会悄悄切回官方中文 | BLOCKED（DeepSeek 路径需要用户 Key） |
| R11 | 完成一次影片 B 翻译，刷新/重开同一剧集并重播相同片段 | 已缓存 cue 不产生重复服务请求 | 命中同一服务缓存；另一服务的缓存不可串用 | NOT RUN |

R01 用于证明 Netflix 原生双语严格零调用；R10 用于证明 Google/DeepSeek 的显式选择会覆盖官方中文。R02 的核心不是发现阶段持续多久，而是任何非权威目录都不能解锁外部请求。

## 6. 播放器生命周期与可用性矩阵

| ID | 操作 | 验收标准 | 结果 |
| --- | --- | --- | --- |
| L01 | 播放、暂停、恢复 | 字幕跟随当前画面，不重复叠层，不影响播放器控件 | NOT RUN |
| L02 | 前后 seek，多次跳到相同和不同字幕位置 | 当前字幕迅速更新；旧位置译文不闪回；新邻域优先 | NOT RUN |
| L03 | 进入/退出全屏 | 始终只有一个 SubTwin 字幕层，位置和样式正确 | NOT RUN |
| L04 | 自动播放下一集或手动切换剧集 | 旧剧集任务取消；旧字幕/缓存结果不进入新剧集 | NOT RUN |
| L05 | 触发播放器 DOM 重挂载（切剧集、退出再进入播放等） | observer、video listener 和 overlay 不重复；字幕能恢复 | NOT RUN |
| L06 | popup 中禁用，再启用 | 禁用后清除自定义层并保留/恢复原生字幕；启用后仅建立一套监听 | NOT RUN |
| L07 | 断网、后台 service worker 重启或扩展重载 | Netflix 播放不被打断；自定义层失败时原生/英文字幕仍可用 | NOT RUN |
| L08 | 当前 cue 无官方中文对齐结果 | 不调用外部翻译补洞；不显示错误对应的中文 | NOT RUN |
| L09 | 反复切换 Netflix 原生字幕开关/轨道 | SubTwin 不永久隐藏原生字幕；失败/退出时恢复原内联可见性 | NOT RUN |
| L10 | 拖动红色“双”悬浮按钮后刷新、换集、进入/退出全屏 | 入口保持在可视区域；当前标签页内保留位置；全屏内仍可打开 | NOT RUN |
| L11 | 展开控制台并点击“暂停当前页”，再点击继续 | 暂停只影响当前标签页并立即恢复原生字幕；其他 Netflix 标签页和全局 enabled 不改变 | NOT RUN |
| L12 | 在页内控制台关闭“开启双语字幕”，再重新启用 | 关闭后清空自定义字幕并恢复原生字幕；悬浮入口保留，可原地重新启用 | NOT RUN |

## 7. 设置、样式与缓存矩阵

| ID | 操作 | 验收标准 | 结果 |
| --- | --- | --- | --- |
| S01 | 切换英/中文可见性、颜色、字号、字重、上下顺序 | 选项页预览立即更新，Netflix 下一次渲染使用相同设置 | NOT RUN |
| S02 | 修改行距、底部距离、背景透明度、阴影 | 预览与播放器表现一致，不遮挡或拦截播放器控件 | NOT RUN |
| S03 | 关闭并重新打开浏览器/扩展设置页 | 设置仍在当前 Chrome 配置中，provider 不会自行改变 | NOT RUN |
| S04 | 清理当前剧集缓存 | 只删除当前剧集翻译；重播时会重新请求所选服务 | NOT RUN |
| S05 | 清理全部缓存 | 所有本地翻译删除；设置和 DeepSeek Key 不应随缓存一起删除 | NOT RUN |
| S06 | 使用全新 Chrome 配置安装 | 默认 provider 为 `unset`，没有外部请求 | NOT RUN |
| S07 | 在页内控制台调整两种语言字体并刷新 Netflix | 当前字幕即时改变；刷新后字体设置仍保留 | NOT RUN |
| S08 | 快速连续拖动字号、行距、位置和透明度滑块 | 字幕实时响应；最终值自动保存；控制台不阻塞播放器快捷键或鼠标操作 | NOT RUN |

## 8. 密钥、消息与本地数据检查

在扩展 service worker DevTools 的 Application/Storage 视图中检查：

- 设置存放在 extension local storage；Key 字段只应出现在受信任扩展上下文可访问的本地设置中。
- Netflix content script 的运行时设置消息只包含 `enabled`、`provider`、`deepseekKeyReady` 和 `appearance`，不能包含 Key 或模型字符串。
- page-to-content 桥接消息不能包含 cookie、Authorization header 或原始 signed timed-text URL。
- IndexedDB 数据库 `subtwin-translation-cache-v1` 可包含字幕译文，但不能包含 API Key；缓存应按 provider 隔离。
- popup 只能读取公开设置和运行状态；完整私密设置只允许 options 页面读取。
- 关闭/重载扩展后，Netflix 页面仍能正常播放和显示原生字幕。

如果需要截图，只截字段结构和脱敏后的状态。不要截图 Key、Netflix 请求 URL、字幕正文或浏览器账户信息。

## 9. 结果记录模板

复制下面内容到独立的本地测试记录中，或在提交前用脱敏结果更新本节。失败项应附最小复现步骤和非敏感错误码。

```text
日期：
Git commit：
Chrome 版本：
操作系统：
Netflix 地区：
影片 A（官方 EN+简中）：
影片 B（EN、无简中）：
扩展构建：pnpm build / 产物路径 .output/chrome-mv3

自动化：test [ ]  typecheck [ ]  build [ ]
路由矩阵：PASS __ / FAIL __ / BLOCKED __ / NOT RUN __
生命周期矩阵：PASS __ / FAIL __ / BLOCKED __ / NOT RUN __
设置矩阵：PASS __ / FAIL __ / BLOCKED __ / NOT RUN __
Google 请求数（按场景记录）：
DeepSeek 请求数（按场景记录）：
已知失败/阻塞：
脱敏证据位置：
验证人：
```

只有自动化预检通过、R01/R02/R03 的零调用证据明确、所选外部服务隔离正确、以及生命周期失败路径能恢复原生字幕时，才适合把当前构建标记为个人使用候选版本。真实 DeepSeek 质量还应人工检查人名、代词、语气、断句和上下文一致性，不能只确认“出现了中文”。
