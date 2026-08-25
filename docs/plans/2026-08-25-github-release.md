# Professional GitHub Release Implementation Plan

**Goal:** 把 SubTwin v0.1.0 发布为具有专业首页、可下载产物和可复用自动发布流程的 GitHub 项目。

**Architecture:** README 作为面向用户与贡献者的入口，CHANGELOG 作为版本事实来源，标签触发的 GitHub Actions 负责在干净环境中验证并创建 Release。发布工作流复用项目现有 `pnpm release`，避免本地构建与远程发布产生不同验证路径。

**Tech Stack:** GitHub Actions、GitHub CLI、pnpm 11、Node.js 22、WXT、Markdown。

---

### chunk-01: Professional repository and release pipeline

**Files:**

- Modify: `README.md`
- Create: `CHANGELOG.md`
- Create: `.github/workflows/release.yml`

**Changes:**

- 重构 README 首屏、截图、下载、功能、架构、安全、开发、验证与限制信息，并加入真实状态徽章。
- 用 Keep a Changelog 风格记录 v0.1.0 的用户能力和可靠性改进。
- 创建只响应 `v*` 标签的发布工作流，校验标签与包版本，安装锁定依赖，执行 `pnpm release`，并用 GitHub CLI 创建 Release 和上传 Chrome ZIP。
- 完整验证、提交并推送实现后，创建并推送 `v0.1.0` 标签，监控发布工作流直至 Release 与附件可访问。

**Acceptance Criteria:**

- [ ] README 首屏清楚说明产品价值，并提供真实截图、状态徽章和正式下载入口。
- [ ] CHANGELOG 与 v0.1.0 实际功能一致，不包含密钥或误导性发布声明。
- [ ] 发布工作流会在版本不匹配或 `pnpm release` 失败时停止，成功时只创建对应标签的 Release 并上传 ZIP。
- [ ] `v0.1.0` Release 在 GitHub 可见，附件可下载，仓库工作区与远程一致。

**Dependencies:** none

---

### Risks

- Release 工作流必须在创建标签前进入默认分支，否则标签不会包含工作流。
- GitHub Release 创建与已有标签/Release 必须保持幂等，避免重复发布。
- README 徽章只能引用真实存在的 CI 和 Release 数据。
- 测试截图不能包含 API Key 或其他本地敏感数据。
