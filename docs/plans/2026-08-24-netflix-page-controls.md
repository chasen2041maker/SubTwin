# Netflix 页面控制台实施计划

**目标：** 交付带悬浮入口、页内控制台、实时持久设置与真实 Netflix 验证证据的 Chrome MV3 安装包。

## chunk-01：页面 UI 合同与渲染边界

**文件：**

- 新建 `src/renderer/PageControlSurface.tsx`
- 新建 `src/renderer/page-control-surface.css`
- 新建 `tests/renderer/PageControlSurface.test.tsx`

**验收：**

- 折叠入口、展开面板、状态和元数据具有稳定且可访问的标签。
- 所有要求的外观字段均可交互，按钮位置可拖动并限制在视口内。
- host 使用 Shadow DOM、支持全屏迁移，销毁后不残留监听或节点。

## chunk-02：安全持久化协议

**文件：**

- 修改 `src/shared/messages.ts`
- 修改 `src/storage/background-actions.ts`
- 修改 `src/app/background-runtime.ts`
- 修改相应消息、存储和后台测试

**验收：**

- content script 只能更新全局 enabled 与 appearance，不能传输或更改 Key/model/provider。
- 后台严格校验、持久化并广播最终运行设置；失败返回类型化错误。

## chunk-03：Netflix content script 集成

**文件：**

- 新建 `src/netflix/page-metadata.ts`
- 修改 `entrypoints/netflix.content/index.tsx`
- 新建/修改页面元数据与会话集成测试

**验收：**

- 控制台显示标题、播放状态、音轨、字幕轨、目录、官方优先、服务和错误。
- 暂停仅作用于当前标签页；全局禁用持久化；外观修改即时更新 overlay 并保存。
- 刷新、换集、全屏和播放器重挂载时只保留一套控制台与字幕资源。

## chunk-04：产物与端到端证据

**文件：**

- 更新 `README.md`、`docs/manual-verification.md`
- 新建脱敏测试记录与截图目录

**验收：**

- `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm zip` 全部退出码为 0。
- 生产 MV3 产物可在 Chrome 加载，权限无扩张。
- 在真实登录态 Netflix 完成目标中的完整操作链并保存不含凭据、URL 或字幕正文的截图与日志。
