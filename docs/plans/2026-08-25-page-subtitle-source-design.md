# Netflix 播放页字幕来源选择

## 目标

在 Netflix 播放页控制台中提供三个互斥来源：Netflix 原生双语、Google 翻译、DeepSeek 翻译。用户的选择立即作用于当前播放会话，并持久化为全局设置。

## 行为约束

- `unset` 在现有设置协议中表示“Netflix 原生双语”，不增加迁移字段。
- 选择 Netflix 原生双语时，只对齐 Netflix 官方英文和简体中文轨道，不发起外部请求；缺少官方中文时保留原生英文。
- 选择 Google 或 DeepSeek 时，显式选择优先于官方中文字幕目录，即使存在官方中文也使用所选翻译源。
- Google 与 DeepSeek 不互相降级。DeepSeek 未配置 Key 时显示缺少 Key 的既有错误状态。
- 来源切换立即取消旧 provider generation 的任务，迟到结果不能渲染或写入缓存。

## 安全边界

Netflix 页面消息只携带 `unset | google-free | deepseek` 枚举。DeepSeek API Key 和模型继续只保存在扩展设置与后台 service worker；播放页只收到 `deepseekKeyReady` 布尔值。

## 持久化

页面设置补丁增加 `provider` 与 `updateProvider`。后台只在 `updateProvider` 为真时覆盖来源，从而避免并发的外观保存覆盖选项页中的新设置。来源切换立即保存，外观修改仍使用原有防抖保存。

## 验证重点

- 官方中英文轨道 + Netflix 原生双语：官方对齐、零外部请求。
- 官方中英文轨道 + Google/DeepSeek：按显式来源发起翻译，不回退到官方中文。
- 仅英文轨道 + Google/DeepSeek：英文先显示，中文结果到达后形成双语。
- DeepSeek 缺少 Key：不发请求，控制台提示先配置 Key。
- 切换来源、页面重载及并发设置更新后，选择仍保持且私密配置不进入页面消息。
