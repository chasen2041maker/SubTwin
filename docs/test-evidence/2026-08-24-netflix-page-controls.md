# 2026-08-24 Netflix 页面控制台验证记录

## 构建信息

- 分支/提交：`main` / `7111f04` 加当前未提交实现
- 生产目录：`.output/chrome-mv3`
- 安装包：`.output/subtwin-0.1.0-chrome-mv3.zip`
- 安装包大小：230958 bytes
- SHA-256：`D121221CF3782ED31E22C80705FC22059E80DF426FDAF19AD945B87400D64FDD`
- 生产文件：12 个
- Manifest：MV3，最低 Chrome 111；权限仅 `storage`；host permissions 限定 Netflix、DeepSeek、Google

## 自动化证据

- `pnpm test`：PASS，44 个测试文件、546 项测试
- `pnpm typecheck`：PASS
- `pnpm zip`：PASS
- Netflix 资源发现专项：PASS，56 项测试覆盖 Player Manifest、Cadmium `licensedmanifest`、空目录回退和运行时绑定
- 全屏迁移：PASS（自动化）；字幕与控制台 host 监听 `fullscreenchange`，进入时迁入 fullscreen element，退出时迁回并清理监听器

## 真实 Chrome 环境

- 已登录 Netflix：PASS
- 实际播放标题：`外滩探秘` 第 1 集，随后切换至第 2 集 `幸运罗盘`
- SubTwin 已解压扩展已加载：PASS
- Shadow DOM：PASS；`#subtwin-page-controls` 和 `#subtwin-subtitle-overlay` 始终各 1 个
- 悬浮按钮：PASS；从 `left: 1002px; top: 885px` 拖至 `left: 774px; top: 674px`，刷新后位置保持
- 控制台展开/折叠：PASS
- 页面暂停/继续：PASS；`aria-pressed` 在 `false → true → false` 间正确变化
- Netflix 快进：PASS；视频时间从 1706.4s 到 1718.4s，约 +12s，两个 host 均保持 1 个
- Netflix 字幕切轨：PASS；从简体中文切至英语 CC 后实际原生字幕变为英文，两个 host 均保持 1 个
- 换集：PASS；URL 从 `/watch/80236528` 切至 `/watch/81017207`，标题更新为第 2 集，设置保持
- 刷新持久化：PASS；全部样式和悬浮按钮位置保持
- 关闭/恢复：PASS；总开关关闭后黄色状态点出现，SubTwin cue 清空，Netflix 原生英文字幕仍可见

## 实时设置实测值

以下字段均通过真实页面控件修改、自动保存，并在刷新和换集后重新读取确认：

- 上下顺序：中文在上
- 英文字体/字号/字重/颜色：等宽体 / 36px / 700 / `#FFD166`
- 中文字体/字号/字重/颜色：衬线体 / 40px / 500 / `#7FDBFF`
- 阴影：强
- 行距：16px
- 垂直位置：18%
- 背景不透明度：0.75
- 英文与中文独立开关：PASS；勾选数 `3 → 2 → 3`
- 保存状态：`设置已保存`

## 字幕数据链路

- Player 权威目录：PASS；识别 `en · closed-caption` 与 `zh-Hans · subtitle`
- Netflix 网络播放元数据：PASS；换集时捕获并开始读取 Cadmium 播放元数据
- 当前 Chrome 已加载版本：FAIL；Player Manifest 缺少外层影片归属时被严格资源提取器拒绝，页面显示 `Netflix 字幕下载资源提取失败`
- 源码修复：PASS（自动化）；用已验证的 `getMovieId()` 在 MAIN world 内为只读 Player Manifest 添加 `titleId` 外层，资源提取测试通过；空目录不再产生假“不匹配”
- 最新源码修复的真实双语 cue：BLOCKED；最新生产包尚未在 Chrome 中重新加载，因此不能宣称双语字幕已在实机通过

### 2026-08-25 重载复测与诊断进展

- 用户已重新加载此前生产包并刷新真实 Netflix 播放页；两个 Shadow DOM host 仍各 1 个，视频和 Netflix 原生英文字幕正常播放。
- 控制台仍能识别官方 `en · closed-caption` 与 `zh-Hans · subtitle`，但 SubTwin overlay 没有 cue；此前的 Player Manifest 包装修复因此被实机反证，不能判定通过。
- 刷新后字幕链路稳定停在“正在读取 Netflix 播放元数据”超过一分钟：`metadata_response_accepted` 已到达，但没有后续 JSON 解析、资源提取或读取超时状态。
- 浏览器只读页面检查运行在隔离环境，无法直接读取 Netflix MAIN-world 私有 Player 对象；该结果不能用于断言 Player 会话不存在。
- 已通过 RED→GREEN 修复元数据流的总读取期限：旧实现对每个 chunk 重置 5 秒计时，持续分块会无限停在“正在读取”；新实现只给整条响应一个总预算，超时后取消 clone reader 并发布 `metadata_body_timeout`。RED 测试先缺少超时诊断，修复后 Netflix 探针/运行时相关 63 项测试与类型检查通过。
- 已生成只记录 Player 候选方法名的临时安全诊断构建；不记录 signed URL、令牌、cookie 或字幕正文。待动作时确认后通过 Computer Use 重载，取得真实 Cadmium Player 方法名，再按 TDD 修复并移除诊断。
- 历史诊断包：231028 bytes；SHA-256 `1FD4E03CE4FF398151E58D3CE05284DE15921D69E1DA6FD3D648A15CC9DC2FC2`；仅用于确认真实 Player 候选入口，不是交付包。
- 诊断构建已在真实 Chrome 运行，MAIN-world 日志反复确认 2026 Cadmium Player 不提供 `getManifest`、`getMovieManifest` 或 `getPlaybackInfo`，但提供只读 `getTimedTextTrackList`。这证明旧实现读取了错误的 Player 层级。
- 已按 RED→GREEN 增加 `getTimedTextTrackList` 资源元数据回退：RED 先证明真实候选入口从未被调用；GREEN 后能从该列表提取下载资源，Player/资源/探针/运行时相关 88 项测试通过。
- 临时诊断日志已从正式源码和生产包删除。最终包：230958 bytes；SHA-256 `D121221CF3782ED31E22C80705FC22059E80DF426FDAF19AD945B87400D64FDD`；完整 546 项测试、类型检查和生产构建通过。

## 登录态 E2E 矩阵

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 安装已解压 MV3 构建 | PASS | 生产扩展 ID 已注入，两个 Shadow DOM host 各 1 个 |
| 播放影片 | PASS | 第 1、2 集均实际播放 |
| 打开悬浮控制台 | PASS | 控件可展开/折叠，完整字段可交互 |
| 调节全部字幕字段 | PASS | 上述实测值、保存状态、刷新/换集持久化 |
| 快进 | PASS | +12s 后 host 无重复或丢失 |
| 切换字幕轨 | PASS | 简中切至英语 CC，实际字幕文本变化 |
| 全屏 | PASS | 最终包真实点击 Netflix 全屏按钮，页面出现 `control-fullscreen-exit`；双字幕与悬浮按钮均保持可见 |
| 换集 | PASS | `/watch/80236528` → `/watch/81017207` |
| 刷新 | PASS | 设置、按钮位置、单例 host 均保持 |
| 关闭扩展并恢复原生字幕 | PASS | 原生英文字幕截图；SubTwin cue 为空 |
| 最新资源修复后的双语 cue | PASS | 真实 Netflix 日志进入 `timed_text_accepted dual`，页面同时显示简中与英文 |

## 证据文件

- `2026-08-24-netflix-disabled-native-restored.png`：总开关关闭时 Netflix 原生英文字幕仍可见
- `2026-08-24-netflix-page-controls-settings.png`：播放页与已持久化悬浮按钮状态
- `2026-08-24-netflix-resource-unmatched.png`：旧资源匹配失败的诊断画面，仅作修复前证据

截图和日志不包含 Netflix cookie、signed URL、API Key 或持久化字幕正文。

## 2026-08-25 最终复测

- 最终安装包：233539 bytes；SHA-256 `B41187FD2365FBEA4F0562BE5755C608BD627FCC74765E278673A6487449FF26`。
- 自动化：45 个测试文件、560 项测试全部通过；TypeScript 类型检查、MV3 生产构建和 `git diff --check` 通过。
- 真实 Netflix：最终包日志出现 `timed_text_accepted dual`；页面实测中文 26px、英文 24px、白色无衬线、30% 半透明黑底。
- 原生字幕互斥：双语 cue 提交后，Netflix `.player-timedtext` 与 `.player-timedtext-text-container` 的计算可见性均为 `hidden`；单行/清空/停用时自动恢复。
- 悬浮按钮：保存的旧坐标会在刷新和全屏时重新夹紧；最终实测从越界 `y=829` 调整到 `y=670`，保留 92px 底部安全区，不再遮挡 Netflix 全屏按钮。
- 全屏：真实点击 Netflix `control-fullscreen-enter` 后出现 `control-fullscreen-exit`，中英双字幕、原生字幕隐藏与悬浮按钮均保持正确。
- 最终视觉证据：`netflix-dual-subtitles-final-fullscreen.png`。

## 当前阻塞

无。

## 2026-08-25 字幕直接拖动复测

- 最终安装包：234210 bytes；SHA-256 `ADE738FF80082C77E3AAA5ADADA0A6050D6FA6FE7854E1C6025C66C5DC831852`。
- 自动化：45 个测试文件、563 项测试全部通过；TypeScript 类型检查和 MV3 生产构建通过。
- 新版界面：控制台宽度为 440px；“英文字重/中文字重”已改为“英文粗细/中文粗细”；字幕垂直位置范围为 0–80%。
- 真实 Netflix：页面同时显示官方英文与简体中文；控制台打开时字幕 cue 的 `pointer-events` 为 `auto`、光标为 `grab`，并显示“拖动字幕”提示。
- 真实拖动：字幕从 7% 上移到 21.5%，字幕框顶部从约 663px 实时移动到约 537px，控制台滑块同步为 21.5%，保存状态为“设置已保存”。
- 关闭控制台：拖动模式变为 `false`，字幕 cue 的 `pointer-events` 恢复为 `none`，保存的 21.5% 位置保持不变，不拦截 Netflix 操作。
- 视觉证据：`netflix-direct-subtitle-drag-final.png`。
