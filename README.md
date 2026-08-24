# SubTwin

SubTwin 是一个面向 Netflix 桌面网页端的英中双语字幕 Chrome 扩展。项目使用 **WXT + TypeScript + React** 构建为 Manifest V3 扩展；当前目标是个人自用，保留了以后公开发布所需的清晰边界，但不包含账号、付费、云同步或托管翻译服务。

> 支持范围：Netflix 网页端、英文源字幕、简体中文目标字幕、Chromium 系浏览器。

## 工作方式

SubTwin 采用“官方字幕优先、外部翻译显式选择”的路由：

| 当前状态 | 行为 | 外部翻译调用 |
| --- | --- | --- |
| Netflix 同时提供官方英文和简体中文 | 解析两条官方轨道，按时间对齐并显示双语 | **0** |
| 字幕目录仍在发现中，尚未确认完整 | 保留 Netflix 原生字幕，不把“暂未看到中文”当作“没有中文” | **0** |
| 尚未选择翻译服务 | 保留英文/原生字幕，提示在设置中选择 | **0** |
| 已确认只有英文，选择 Google 免费翻译 | 逐条使用 Google 免费翻译 | 只调用 Google |
| 已确认只有英文，选择 DeepSeek | 使用上下文批次翻译并校验结果 | 只调用 DeepSeek |
| DeepSeek 未配置 Key、翻译失败或离线 | 保留可用英文/原生字幕并显示状态 | 不切换到 Google |

Google 与 DeepSeek 之间没有自动降级：选择哪一个，就只允许哪一个接收字幕。切换服务、切换剧集、关闭扩展、播放器重挂载，或后续发现官方中文字幕时，旧一代任务会被取消；迟到结果不能继续渲染或写入缓存。

字幕采集与播放页隔离：MAIN world 只观察 Netflix 播放器的字幕目录和受限的 timed-text 数据，跨 world 消息带会话 nonce、generation、来源和大小校验。自定义字幕层使用 Shadow DOM，且只有成功渲染后才隐藏 Netflix 原生字幕；初始化或运行失败时会保留/恢复原生字幕。

## 翻译方式

### Google 免费翻译（实验性、无需 Key）

该选项使用未公开、无 SLA 的 `translate.googleapis.com/translate_a/single?client=gtx` 接口，不是 Google Cloud Translation API。它可能限流、改变返回格式或停止工作，不适合作为付费产品的稳定依赖。

请求通过 HTTPS 发送，但原字幕文本位于 GET 查询参数中，可能出现在 Google、浏览器、代理或网络诊断记录里。SubTwin 自身不会记录完整请求 URL、查询字符串、原文或译文；Google 失败也不会改用 DeepSeek。

### DeepSeek（自带 Key）

DeepSeek 需要用户自己的 API Key。打开扩展的“选项”页，选择 DeepSeek、填写 Key 和模型，保存后可执行连接测试。真实请求会产生 DeepSeek 侧费用，具体可用性、额度和计费以用户自己的 DeepSeek 账户为准。

Key 只存放在当前浏览器配置的 `chrome.storage.local` 中，由受信任的扩展页面和后台 service worker 使用；Netflix content script 只收到“是否已配置 Key”的布尔状态，不收到 Key 或模型值。Key 不应写入源码、`.env`、Git、日志、截图或问题报告。此方案适合个人 BYOK，不等同于操作系统密钥链或面向公众的托管密钥方案。

## 本地安装与开发

要求：

- Node.js 22.13 或更高版本
- pnpm 10 或更高版本（仓库通过 `packageManager` 固定具体版本）
- Chrome 或其他可加载 Chrome MV3 扩展的 Chromium 浏览器

从仓库根目录安装锁定依赖：

```sh
pnpm install --frozen-lockfile
```

启动 WXT 开发模式：

```sh
pnpm dev
```

运行自动化验证：

```sh
pnpm test
pnpm typecheck
pnpm build
```

构建可分发压缩包：

```sh
pnpm zip
```

`pnpm release` 会依次执行测试、类型检查和压缩包构建。`.wxt`、`.output`、`node_modules` 和本地密钥类文件均不会提交到 Git。

### 手动加载生产构建

1. 执行 `pnpm build`。
2. 打开 `chrome://extensions`，启用“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本仓库下的 `.output/chrome-mv3`。
5. 打开扩展选项页，选择翻译方式并调整字幕样式。
6. 登录 Netflix，打开带字幕的影片进行验证。重新构建后，在扩展管理页点击“重新加载”，并刷新 Netflix 标签页。

完整的登录态测试、零调用取证和结果记录方式见 [手工验证指南](docs/manual-verification.md)。真实 Netflix 行为受账号、地区、影片和 Netflix 网页版本影响；没有登录态和用户提供的 Key 时，自动化测试不能替代这部分验证。

## 本地数据与安全边界

- 设置和 DeepSeek Key：`chrome.storage.local`，并限制为受信任的扩展上下文；Key 不进入 Netflix content/page 消息。
- 翻译缓存：后台 IndexedDB，默认最多 5,000 条或 25 MiB，按剧集、字幕轨哈希、语言、服务和服务契约版本隔离；DeepSeek 缓存还按模型和提示词版本隔离。
- 缓存包含字幕译文、cue 标识和**非加密内容指纹**，但不直接保存源字幕正文或 API Key。该指纹用于缓存匹配与失效，不作为密码学隐私保护；可在选项页清理当前剧集或全部缓存。
- Netflix signed timed-text URL 不写日志、不跨到扩展隔离 world，也不持久化；桥接数据有 10 MiB 上限和严格结构校验。
- 后台只接受当前扩展、准确页面和 Netflix HTTPS 标签页发送的对应消息；外部翻译请求还必须匹配当前标签页的 session、当前 authoritative 字幕目录，并再次确认存在英文且不存在官方简体中文。
- 生产权限只有 `storage` 以及固定主机 `www.netflix.com`、`api.deepseek.com`、`translate.googleapis.com`，没有宽泛来源和可选主机权限。

## 项目结构

```text
entrypoints/              WXT 后台、Netflix MAIN/isolated content、popup、options
src/app/                  语言路由、会话控制、运行状态和跨上下文任务客户端
src/netflix/              Netflix 目录、网络探针、桥接、时钟和生命周期适配
src/subtitles/            TTML/WebVTT 解析、规范化和官方字幕时间对齐
src/translation/          Google/DeepSeek、调度、验证和 IndexedDB 缓存
src/renderer/             React 双语字幕层及样式
src/storage/              设置 schema、迁移、权限与后台操作
tests/                    单元、契约和跨模块集成测试
docs/plans/               MVP 设计、实现计划和分块分析
```

## 验证边界

仓库内测试覆盖解析器、官方轨对齐、权威目录门禁、零调用路由、多英文轨选择、两种服务的错误矩阵、代际取消、持久缓存、设置安全边界、字幕层和播放器生命周期。真实登录态 Netflix 冒烟测试以及真实 DeepSeek API 测试必须由拥有相应账号/Key 的用户按手工指南执行并记录；文档不会把尚未执行的外部验证写成已通过。

## 公开发布前

当前设计面向个人使用。若以后收费或公开发布，应至少重新评估 Chrome Web Store 政策、Netflix 使用条款、隐私披露、支持范围、Google 未公开接口的可持续性，以及把厂商自有 Key 移到带鉴权、额度和滥用防护的后端。不要把开发者自己的 DeepSeek Key 打包进扩展。

## 设计资料

- [MVP 设计](docs/plans/2026-08-23-subtwin-design.md)
- [实现计划](docs/plans/2026-08-23-subtwin-mvp.md)
- [Subtitle-Translate 参考项目审查](docs/research/2026-08-23-subtitle-translate-reference-review.md)

## License

本个人仓库当前未授权（`UNLICENSED`）。