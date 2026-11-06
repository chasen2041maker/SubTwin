# SubTwin 进度交接（2026-11-05，第二轮）

下一次对话从这里继续。仓库：`C:\company\own\SubTwin`，分支 `main`。

## 用户的目标

1. 字幕不要慢半拍、人不说话时不要乱显示。（已完成）
2. 不管进入影片时 Netflix 选的是什么字幕（英文/中文/关闭），默认显示中英双语。（已完成，华语原声影片除外）
3. 控制台 UI 合理、好看。（播放页控制台、弹窗、设置页均已完成）
4. **华语原声影片不做任何处理**，保留 Netflix 原字幕。（代码完成，待实机验证）
5. 其余遗留问题继续修复（见"待办"）。
6. 每轮完成后更新 README（截图必须带中英双语字幕）并推送到 GitHub。

## 本轮完成（本地提交，见 git log）

- **华语原声不处理**：`player-catalog.ts` 读取 `isNative` 音轨语言 → 桥接 `originalLanguage` → `adapter.ts` 的 `isChineseOriginalLanguage`（zh/yue/cmn）。
  - MAIN 世界 `runtime.ts` 的 `maybeStartTrackCapture`：华语原声直接返回；若已开始切换则 `stopTrackCapture()` 恢复原字幕轨。
  - 路由新增 `chinese-original`（native-only）；`netflix-content-session.ts` 只信权威目录，换片时重置；`confirmActiveTrack`、`captureLiveEnglishCue`、`display_unavailable` 报错都跳过。
  - `session-controller.ts`：该路由不渲染、状态 `chinese-original`；`status.ts`、控制台"华语原声"、弹窗均已支持。
- **繁体中文后备**：新增语言分类 `traditional-chinese`（zh-Hant / zh-TW / zh-HK / zh-MO）。目录没有简体中文时：元数据下载、捕获选轨、会话选轨、路由、控制台文案都改用繁体；有简体时不下载繁体。
- **弹窗与设置页重做**：共用 `src/renderer/extension-theme.css`（与控制台同一套变量）；字体列表与字体栈抽到 `src/renderer/subtitle-fonts.ts`。弹窗监听 `storage.onChanged` 实时更新状态。修复设置页字号下拉框不含默认 24px。
- 773 项测试通过；类型检查、生产构建通过。

## 实机验证结果（第三轮，2026-11-05 21:00）

用户已重新加载扩展（`df50093` 之后的构建），在 Chrome + Netflix 上逐项实测：

- **T1 华语原声《陈情令》**：通过。日志 `route_changed chinese-original`，没有任何 `switch_started`；Netflix 字幕始终是繁体中文；SubTwin 无字幕层、不隐藏原字幕；控制台“华语原声 / 保留 Netflix 原字幕，SubTwin 不做任何处理。”，灰点、无提示条。
- **T2 只有繁体中文的影片**：无法实测。本账号地区下 Temptation Island 现在只列出英文字幕（`en/PRIMARY`、`en/ASSISTIVE`），《咒术回战》也没有中文字幕，找不到“只有繁体”的片子；繁体后备只由单元测试覆盖。该片在原生双语下只显示英文并提示改用翻译，行为正确。
- **T3 英语片《星期三》**：通过。原生双语 10/11 句为英文 + 官方简体中文，`route_changed official ... zh`，没有下载繁体；DeepSeek 模式 10/10 句双语、延迟 0ms，状态“DeepSeek 翻译”。
- **T4 离开再返回**：Netflix 的“返回”按钮实际是整页跳转到 `/title/...`，没有出现单页内离开。标题页有两个预告片播放器，20 秒内 SubTwin 没有任何抓取或路由日志（忽略预告片播放器的修复生效）；返回播放页后 8.6 秒恢复中英双语。单页内离开的路径只由单元测试覆盖。
- **发现并已修复**：选了“原生双语”但影片没有官方中文时，控制台显示“等待设置 / 尚未选择翻译方式”，现改为“仅显示英文”并说明原因（776 项测试通过）。
- 测试后状态已恢复：SubTwin 来源为 DeepSeek；《星期三》Netflix 字幕为英文 CC，《陈情令》为繁体中文，Temptation Island 为英文（未改动）。

## 待办

> 完整、可直接粘贴给测试账号的实测步骤见 [`docs/TESTING-HANDOFF.md`](TESTING-HANDOFF.md)。已推送到 `df50093`（含"离开播放页停止抓取"与"忽略浏览页预告片播放器"两个修复）。

- **实机验证（需要用户的 Chrome + Netflix）**：构建后在 `chrome://extensions` 刷新 SubTwin，然后：
  - 《陈情令》81200231：字幕轨不被切换、无 SubTwin 字幕层、控制台显示"华语原声"。
  - Temptation Island 81774488（只有 zh-Hant）：原生双语显示英文 + 繁体中文。
  - 《星期三》81257204：行为不变（英文 + 简体）。
- **README 截图**：新截图须带中英双语字幕；可补一张弹窗/设置页截图。实机验证时一起截。
- **重复打开同一部剧时有时拿不到字幕正文**：已按代码推断修复（离开播放页时停止抓取、清重试计数，再次进入时重新发布目录并补抓），有回归测试；仍需实机复测确认。

## 开发与验证要点

- 本机 pnpm 是 9.x，项目要求 ≥10：直接用本地二进制。
  - 测试：`./node_modules/.bin/vitest run`
  - 类型检查：`./node_modules/.bin/wxt prepare && ./node_modules/.bin/tsc --noEmit --project tsconfig.json`
  - 构建：`./node_modules/.bin/wxt build --browser chrome --mv3`（Chrome 加载的是 `.output/chrome-mv3`，构建后需用户在 `chrome://extensions` 点 SubTwin 的刷新）
- 仓库存 LF、`core.autocrlf=true`，工作区行尾混用不影响提交。
- 实测方法：在 Netflix 页面注入 50ms 采样器，记录 `.player-timedtext` 原字幕文字与 `#subtwin-subtitle-overlay` shadow root 里 `.subtwin-overlay__line` 的出现时间；播放器 API 为 `netflix.appContext.state.playerApp.getAPI().videoPlayer`。
- 测试后把用户的 Netflix 字幕设置恢复原样（《星期三》为英文 CC，华语剧为繁体中文）。
- 用户的 SubTwin 来源设置是 DeepSeek（`deepseek-v4-flash`）。

## 下一步：开头"先英文后双语"（第四轮诊断，未修）

用户反馈：开播时先出现几秒 Netflix 原生英文，紧接着才变成插件双语。以《掌舵少女》（`/watch/83078965`，有英文与英文 CC 两条英文轨）实测确认根因：

- Netflix 自己下载的英文正文是**未绑定请求**，目录里同语言有两条英文轨，`observed-timed-text.ts` 的 `bind()` 因歧义返回 null（日志有 `timed-text body: ttml en`，但内容脚本没有 `timed_text_received`）。
- 随后抓取切到"英文"时，目标正是当前已显示的轨，`switchTo` 不会真的切换，Netflix 不重新下载，于是两次 `timed_out en`。
- 结果整集停在实时捕获模式：每句先空白约 0.5 秒 → Netflix 英文 → 插件英文 → 译文到后才双语。

修复思路（已试做、未提交）：`bind()` 增加可选参数 `selectedTrackId`；同语言多条轨且请求未绑定时，用抓取前用户选中的轨（`trackCapture.originalTrackId`，或 `preparePlayerTrackCapture(...).originalTrackId`）消歧。问题：`tests/netflix/observed-track-binding.test.ts` 里 4 个测试要求插件**自己经 performance 条目重新下载**的未绑定正文不能被认领（可能是另一条英文轨的 URL）。需要只对 Netflix 页面自身发起的 fetch/XHR 正文用"选中轨"消歧，而 performance 重新下载的正文仍保持待定；同时补测试。

可选的后续改进：英文正文解析后立即启用首选英文轨（不必等两次原字幕匹配），让开头几句也能提前翻译。
