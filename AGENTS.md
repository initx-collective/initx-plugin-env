# 项目约定

## 禁止安装 initx CLI

- 用户已多次明确要求：不要在本项目中安装 `initx` CLI，也不要将其加入 dependencies、devDependencies、optionalDependencies 或 peerDependencies。
- 不为本项目的测试或验证在临时目录、独立 prefix 中安装 initx CLI，也不使用 npx、pnpm dlx 等方式隐式下载它。
- 测试使用现有的 `@initx-plugin/core`、`@initx-plugin/utils`、mock 和直接调用命令 handler 的子进程 fixture。这两个现有 SDK 包与 `initx` CLI 是不同依赖，不受上述禁止安装 CLI 的规则影响。
- 文档中的历史 CLI 冒烟记录、业务 CI 安装示例与固定版本要求，不构成本项目安装 initx CLI 的依据。
- 不得为了增加 CLI 端到端测试而重新引入 initx CLI。真实 CLI 验证可以列为待在已有外部运行环境中完成的验收项。

历史说明见 `docs/env-run-implementation.md` 的“参数链路与兼容条件”和“依赖”部分。
