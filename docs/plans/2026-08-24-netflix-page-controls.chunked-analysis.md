# Netflix 页面控制台分块分析

**Source Plan:** `docs/plans/2026-08-24-netflix-page-controls.md`
**Status:** APPROVED_BY_GOAL

## 执行顺序

1. `chunk-01` 页面 UI 合同与渲染边界（无依赖）
2. `chunk-02` 安全持久化协议（依赖 chunk-01 的设置合同）
3. `chunk-03` Netflix content script 集成（依赖 chunk-01、chunk-02）
4. `chunk-04` 产物与端到端证据（依赖全部实现）

## 依赖图

```text
chunk-01 ──> chunk-02 ──> chunk-03 ──> chunk-04
```

## 审查策略

每个 chunk 都先执行目标测试，再检查与现有未提交改动的交叉范围。chunk-01 至 chunk-03 完成后分别运行相关测试；chunk-04 运行全量门禁和真实浏览器验收。当前会话禁止未受用户要求的子代理，因此所有分块由当前任务顺序执行，不派生执行代理。
