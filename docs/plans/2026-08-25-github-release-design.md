# GitHub Release 发布设计

## 目标

把 SubTwin 从“只有源码的项目仓库”提升为具有明确版本、可下载产物和可追溯发布记录的仓库，同时保持展示简洁、真实且容易维护。

## 已确认方案

- 以当前 `package.json` 版本创建首个 `v0.1.0` Git 标签和 GitHub Release。
- Release 附带由 `pnpm release` 生成的 Chrome MV3 ZIP，用户无需自行构建即可下载。
- README 重构为专业项目首页：首屏价值说明、克制的 CI/版本/下载量/MV3 徽章、真实 Netflix 效果截图、正式版本下载与安装入口、功能矩阵、工作原理、技术栈、安全边界、开发验证和已知限制。保留现有严谨说明，但按“用户先读、开发者后读”的顺序重组。
- 新增 `CHANGELOG.md`，记录 `v0.1.0` 的主要功能、可靠性改进和验证结果。
- 新增标签触发的 GitHub Actions 发布工作流；工作流在干净环境中安装锁定依赖，执行测试、类型检查和打包，再创建 Release 并上传 ZIP。
- 不擅自修改 `UNLICENSED` 状态，也不添加暗示已经发布到 Chrome Web Store 的徽章。

## 发布流程

日常提交继续由现有 CI 验证。准备版本时更新 `package.json` 与 CHANGELOG，提交后创建并推送 `vX.Y.Z` 标签。发布工作流只响应版本标签，验证标签与包版本一致，运行 `pnpm release`，然后使用 GitHub CLI 创建对应 Release 并上传 `.output/subtwin-*-chrome-mv3.zip`。如果测试、版本校验或打包失败，Release 不会创建。

## 成功标准

- 仓库首页能够在首屏说明产品价值，并看到真实效果、CI 状态、最新版本和下载入口。
- GitHub Releases 页面存在 `v0.1.0`，并包含可下载 ZIP 和清晰发布说明。
- 后续版本只需更新版本与 CHANGELOG、推送标签即可自动发布。
- API Key、`.output` 中间文件和其他本地数据不进入 Git 历史。
