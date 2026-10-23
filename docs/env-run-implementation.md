# env run 实现与验证

日期：2026-10-23

依据：[env-run-design.md](env-run-design.md)。变更限定在本插件；未修改 initx 核心，未发布、推送或执行业务部署。

## 已实现

- 注册 `env run <store> [--token <token>] -- <command> [...args]`，使用原始 `ctx.cliOptions['--']` 数组；显式校验 store、命令、额外位置参数和不支持的前缀选项。
- 复用 `readStore()` / `normalizeStoreName()`，每次远程读取，无变量缓存。原值注入子进程，不经 stdout 渲染器，不写 `.env`、`GITHUB_ENV` 或秘密缓存。
- 独立的 run 变量名/NUL 校验、Windows 大小写合并与冲突检测；其他命令的 `.env` 命名规则保持原样。
- 继承 cwd/stdio，保留退出码，ENOENT=127、EACCES=126、其他失败=1；转发 SIGINT/SIGTERM、5 秒宽限后尽力终止直接子进程、移除监听器。POSIX 重新发送同信号延迟到 `beforeExit`，让 initx 先完成 store 写回。
- repo/branch/path 支持 `INITX_ENV_REPO` / `INITX_ENV_BRANCH` / `INITX_ENV_PATH`，与 Token 一样使用 `overrides.env`。环境配置不回写；`status` 展示实际值，`get/list` 的帮助明确为持久化值。
- README 补充配置优先级、GitLab 接入、权限/日志/中断边界；原分期将 run 纳入当前范围。

## 参数链路与兼容条件

实施时曾使用 `initx@0.4.3` 的真实 `bin/initx.mjs`，经过 cac、默认 runner、真实插件加载器和匹配器验证构建插件，使用临时 HOME/USERPROFILE、假插件注册表与假 GitHub 响应。随后按用户要求移除了 initx 开发依赖及对应 CLI 冒烟测试和 fixtures；以下为当时的验证记录，不再由当前 `pnpm test` 重跑。

实测与设计一致：尾部字符串放在 `cliOptions['--']`，不混入位置参数；子命令 `--help` / `--version` / `--token` 不触发外层解析；空参数、引号、空格、Unicode、等号、第二个 `--` 均保留。cac 在没有分隔符和有空分隔符时都返回空数组，本实现将两者一并作为缺少待执行命令拒绝。真实 CLI 的子进程退出码 0、7、42 均原样保留，runner 未重置 `process.exitCode`。

兼容基准为 initx 0.4.3；更早版本未验证。其他版本需满足上述原始尾部数组、帮助边界与退出状态条件。无需扩展核心 handler 返回类型。

## 依赖

| 依赖 | 用途 |
| --- | --- |
| `cross-spawn`（运行时） | Windows PATH/PATHEXT 与 `.cmd` 启动器解析、参数转义；不手写 cmd 拼接或统一打开 shell |
| `@types/cross-spawn`（开发） | 执行器类型检查 |
| `esbuild`（开发） | 将执行器编译进独立信号测试 fixture，避免信号终止 Vitest 自身 |

`pnpm test` 直接运行 Vitest，不再强制先构建，也不安装或调用 initx CLI。

## 本地检查

环境：Windows，Node.js 26.12.1，pnpm 12.10.1，initx 0.4.3。所有值和凭据均为假的；未调用 DNS、SSH、真实 GitHub 读写接口。

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 94 通过，3 项 POSIX 专属测试跳过（移除 CLI 冒烟测试后） |
| `pnpm build` | 通过 |

当前保留参数与环境纯函数校验、配置各级优先级及空值回退、环境值及父环境不变、空 store、NUL、Windows 大小写冲突、真实子进程退出状态及信号生命周期测试。`setup` 的 Actions 注入/mask、`pull` 幂等、`push` 合并、`apply --repo` 目标含义及配置展示均有回归测试。真实 CLI 参数/退出码链路、实时 stdio、PATH、读取失败不启动、日志与落盘边界的端到端用例已随 CLI 测试移除，当前测试集不再覆盖这些端到端路径。

实施时曾实际启动 Windows `pnpm.cmd exec node ...`，确认空字符串、空格、引号、Unicode、`&`、`|`、括号、百分号变量文本、感叹号、反斜杠和同名子命令选项保留。对应自动化用例现已移除。

## 平台验证边界

- Windows 的 SIGINT/SIGTERM 不是可捕获的 POSIX 信号。独立外层进程通过 IPC 触发父进程的真实信号处理器，再验证真实直接子进程终止、130/143 退出与监听器清理；这不等于验证了交互式控制台 Ctrl+C。
- 可忽略信号的 5 秒计时、重复信号与 SIGKILL 清理逻辑有跨平台模拟进程测试。
- 本机无已安装的 WSL Linux 发行版或 Docker 运行时，未实际执行 Linux 验证。POSIX 的真实 EACCES、忽略信号后 5 秒强杀、子进程自行被信号终止共 3 项测试保留在测试集中，在 Windows 明确跳过；Linux 上还会实测信号转发与同信号退出。
- 已添加 `.github/workflows/test.yml` 的 ubuntu/windows 矩阵，但本次未推送或触发远程 CI，不能将配置视为 Linux 实测通过。
- 仅管理直接子进程。Windows `.cmd` 的后代及主动脱离进程组的后台进程不保证整体终止。

Linux 实测及 Windows 交互 Ctrl+C 仍需在对应运行环境验证；README 如实说明这些限制。
