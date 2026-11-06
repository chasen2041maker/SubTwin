# Changelog

SubTwin 的重要变更记录在此文件中。版本格式遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Fixed

- 修正字幕"慢半拍"：读取 Netflix 原字幕时按 `<br>` 和文本区域分行，不再把两行粘成 "housewithout"，原字幕与字幕文件能正确匹配并确认字幕轨，从而启用整集预翻译。
- 在线翻译预取当前句之后的 6 句，整集批量翻译从当前播放位置向后开始；实测每句字幕出现时译文已就绪（此前每句都要空白 0.65–1.3 秒）。
- 原字幕匹配忽略空白差异；Netflix 重复下发内容相同的字幕时不再取消在途翻译、清空已到的译文。
- 译文未就绪时的空白等待由 1.5 秒缩短为 0.5 秒；超时先显示原字幕，本句内译文到达后补上中文；翻译或渲染失败时本句仍固定保留原字幕。
- 修正后台仍以官方中文字幕为由拒绝或取消用户明确选择的 Google/DeepSeek 翻译，补上跨前后台的来源组合回归。
- 保留字幕请求发起时的轨道身份，区分语言相同的英语与英语 CC；无法确认身份时有限重试并保留 Netflix 原字幕。
- 替代字幕成功显示后才隐藏 Netflix 原字幕，避免等待翻译、渲染失败或字幕层被移除时画面完全没有字幕。
- 捕获失败可覆盖“等待另一条”状态；翻译来源提示不再把已选择服务误报为已成功翻译。

## [0.1.0] - 2026-08-25

### Added

- Netflix 播放页英中双语字幕层，以及可拖拽的“双”悬浮控制台。
- Netflix 原生双语、Google 翻译和 DeepSeek 上下文翻译三种明确来源。
- 字幕上下顺序、字体、字号、粗细、颜色、阴影、行距、单行长度、垂直位置和背景透明度设置。
- Netflix 字幕目录、timed-text 资源捕获、TTML/WebVTT 解析和官方字幕时间对齐。
- 带优先级、并发限制、重试、代际取消和 IndexedDB 缓存的翻译调度器。
- DeepSeek Key 本地存储、连接测试、模型选择和严格的页面/后台消息边界。

### Changed

- 开启双语后立即隐藏 Netflix 原字幕，暂停或关闭 SubTwin 时恢复。
- 外部翻译完成前不显示单行英文，中英文准备完成后同时出现。
- 播放补充时钟继承 Netflix 页面实际字幕，避免下载时间轴偏差导致同一句字幕闪烁或提前消失。
- 多英文字幕轨、播放器重挂载、剧集切换和迟到异步结果采用确定性处理。

### Security

- MAIN world 与 isolated world 桥接增加 nonce、generation、来源、结构和大小校验。
- API Key 不进入 Netflix 页面消息、日志、截图、构建产物或 Git 历史。
- 生产主机权限限制为 Netflix、DeepSeek 和 Google 翻译固定来源。

### Verification

- 45 个测试文件、574 项自动化测试通过。
- TypeScript 类型检查和 Chrome Manifest V3 生产打包通过。
- 在登录态 Chrome + Netflix 中完成来源选择、双行同步、原字幕隐藏与字幕稳定性实机验证。

[Unreleased]: https://github.com/chasen2041maker/SubTwin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chasen2041maker/SubTwin/releases/tag/v0.1.0
