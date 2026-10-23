# env run 设计与实现约定

日期：2026-10-23

状态：已实现；本地验证与平台边界见 [实施记录](env-run-implementation.md)

项目：`D:/Projects/initx-plugin-env`

新增 `initx env run <store> -- <command> [...args]`，从现有私有 GitHub 仓库读取变量，直接注入指定子进程。命令用于本地开发和 CI，首个使用场景是 GitLab 中执行 flash-dns 和静态站点部署脚本。

本次只交付设计文档。后续 Agent 按下述约定实现插件、测试和使用说明，无需访问真实变量仓库或部署服务器。

## 1. 范围与职责

沿用现有 store 格式、GitHub Contents API 客户端、配置存储和每次远程读取的方式，不新增变量缓存。

| 部分 | 职责 |
| --- | --- |
| initx env | 读取 store，向指定进程注入变量，传递执行结果 |
| flash-dns | 根据项目配置管理 DNS |
| 部署脚本 | 上传构建产物、切换版本、验证访问 |
| GitLab CI | 构建与部署 job 的依赖、权限和触发规则 |

本次不实现 GitLab Variables API、GitLab 版 `env apply`、store 加密、多 store 合并、自动选择环境、Shell 表达式执行或部署逻辑。`run` 不绑定 GitLab、Slidev 或 flash-dns。

本次包含 `INITX_ENV_REPO`、`INITX_ENV_BRANCH`、`INITX_ENV_PATH` 配置支持，保证临时 Runner 不依赖用户主目录中的预配置。

## 2. 现状与接入位置

以下事实来自当前源码，实施时应先检查工作区是否已有变化。

- `src/index.ts` 的 `ENV_ACTIONS` 和帮助信息尚未声明 `run`。
- `src/commands/env.ts` 已有读取 store 的逻辑；变量通过 `readStore()` 获取，不应另写一套 HTTP 请求。
- `src/utils/gh-env.ts` 的自动注入面向 `$GITHUB_ENV`；其他环境输出 Shell 赋值文本。stdout 形式不带 `export`，多行值转为字面量 `\n`，且 Shell 引号保护不完整，因此 `run` 不能复用这条输出后再 `eval` 的路径。
- `env setup --json` 输出 JSON 后还会写日志，不能将其当作 `run` 的内部机器接口。`run` 应直接调用读取函数。
- `src/config.ts` 当前只有 Token 支持环境变量读取；repo、branch、path 仅读取 overrides 与本地 store。
- `D:/Projects/initx/packages/cli/src/cli/parser.ts` 使用 cac，解析结果以 `ctx.cliOptions` 传入插件。当前实测 `--` 后的参数位于 `cliOptions['--']`，不在位置参数中；空参数、第二个 `--` 和子命令的 `--help` 都被保留。
- initx 当前插件 handler 返回 `Promise<void>`。仅仅 `return 7` 不会改变 CLI 退出码，应使用进程退出状态传播机制。

预期仅修改 env 插件。先用真实 initx 命令验证参数链路，若发现已安装版本与以上源码行为不同，记录具体差异后再决定是否需要核心兼容修改，不要先行扩展 initx 接口。

## 3. 命令接口

```bash
initx env run <store> [--token <token>] -- <command> [...args]
```

示例：

```bash
initx env run demo -- node scripts/check.mjs
initx env run acewill-slidev-production -- pnpm deploy
initx env run demo -- node --version
initx env run demo -- bash scripts/deploy.sh
```

约定：

1. `<store>` 必填，始终显式指定，不弹出选择器。名称沿用 `normalizeStoreName()`。
2. 第一个 `--` 必填，后面至少有一个非空的命令名。
3. `--` 前只能有一个 store 位置参数；多余位置参数报错，避免误把待执行参数吞掉。
4. 插件配置选项位于 `--` 前；`--` 后的所有字符串都属于子进程，不解析、不重排、不展开。
5. 必须保留参数中的空字符串、空格、引号、Unicode、等号、第二个 `--` 以及 `--help`、`--version`、`--token` 等同名选项。
6. `--help` 在分隔符前显示帮助；在分隔符后传给子命令。显式拦截这条边界，不能因子命令参数而提前显示插件帮助。
7. 不提供 `--shell`、`--json`、`--stdout`、`--only`、`--cwd` 等新选项；不要为 `run` 意外复用其他子命令的选项。
8. `--token` 继续支持，但 CI 示例使用 `INITX_ENV_TOKEN`，避免把凭据写进命令参数。

Shell 管道、重定向和变量展开由用户显式启动的 Shell 负责。插件不把参数拼接成字符串，不使用 `eval`，不默认启用 `shell: true`。

需要多步执行时优先编写脚本，再用一次 `run` 包装整个脚本。每次 `run` 只影响本次子进程及其后代，不会修改调用它的 Shell，也不会让后续独立 CI 命令自动获得变量。

## 4. 参数透传实现

在入口保留并读取 `ctx.cliOptions['--']` 的原始字符串数组。不要经过 `CliOptions.string()`：该方法会把数组用逗号拼接，破坏参数边界。

建议为尾部参数增加一个明确的类型检查工具，或让 `env-run` 处理器接收独立的 `commandArgs: string[]`。不要使用插件参数的整体 `filter(Boolean)`，它会删除合法的空字符串参数。

至少验证以下完整命令从真实 initx CLI 到子进程的结果：

```text
initx env run demo -- node fixture.mjs --help --token=child "" "a b" -- --version
```

fixture 收到的尾部参数必须与用户提供的数组一致，且没有触发 initx 的帮助、版本或 Token 处理逻辑。

## 5. 配置解析

为四项配置统一实现以下优先级：

| 配置 | 优先级，从高到低 |
| --- | --- |
| Token | 现有显式 override / `--token` → `INITX_ENV_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → 本地配置 |
| 仓库 | 显式 override → `INITX_ENV_REPO` → 本地 `repo` |
| 分支 | 显式 override → `INITX_ENV_BRANCH` → 本地 `branch` → `main` |
| 路径 | 显式 override → `INITX_ENV_PATH` → 本地 `path` → `stores` |

空字符串按未设置处理；保持现有有效值的校验规则。`overrides.env` 继续作为可注入的测试环境，所有配置项均从同一份环境对象读取。

环境变量配置只影响当前解析，不回写插件 store，不持久化 Token。不要给 `run` 新增 `--repo`：现有 `env apply --repo` 表示写入 Actions secrets 的目标仓库，必须保持原有含义，vault 仓库由上述配置确定。

更新 `env-config status` 的解析和说明，使其展示实际生效的仓库、分支、路径；Token 保持脱敏。现有 `env-config get/list` 如展示的是持久化配置，应明确其含义，无需重做命令体系。

## 6. 环境变量语义

读取和校验成功后，构造新的子进程环境：

```ts
const childEnv = { ...process.env, ...store.vars }
```

这是语义示例，Windows 实现还需处理下面的大小写规则。

- store 值覆盖父进程的同名值；其他父进程变量保留，包括 `PATH`、CI 项目上下文等。
- 不修改父进程的 `process.env`，不展开 `$VAR` 或 `${VAR}`，不进行类型转换。
- 字符串按原值传入，包括空值、真实换行、CRLF、反斜杠、美元符、引号、分号、反引号和 Unicode。
- store 不存在、响应不合法或任意变量不合法时，整体失败，禁止启动子进程，不能跳过坏值继续部署。
- 空 store 允许执行，相当于只继承父进程环境；无需为了兼容 `setup` 的空值限制而拒绝。
- `run` 使用独立的跨平台变量名校验：`^[A-Za-z_][A-Za-z0-9_]*$`。已有 `.env` 工具允许 `.` 和 `-`，不要全局收紧其他命令的规则。
- 拒绝变量值中的 NUL；名称的 NUL、等号等由名称校验拒绝。错误只报告变量名和原因，不回显变量值。
- Windows 环境名不区分大小写：store 的 `PATH` 应覆盖父环境的 `Path`，最终只保留一个有效项。同一 store 若有 `FOO` 与 `foo`，在 Windows 上明确报冲突；Linux 保持大小写敏感语义。

不额外删除父进程的 `GH_TOKEN` 等变量，也不自动实现环境隔离沙箱。执行脚本与 store 都是受信任输入；最小权限由 CI Token 和 job 范围控制。

## 7. 子进程生命周期

### 7.1 启动与输出

- 继承当前工作目录，不自动切换到插件目录或仓库目录。
- 标准输入、标准输出、标准错误直接继承，支持交互和持续输出，不缓冲整段部署日志。
- 使用参数数组启动，禁止把变量值或 argv 拼接成 Shell 字符串。
- 普通可执行文件可用 Node `spawn`。Windows 的 `pnpm` / `npm` 可能是 `.cmd` 启动器，不能只验证 `node.exe` 就宣称跨平台完成。
- 若需处理 Windows 启动器，采用成熟且可维护的跨平台 spawn 工具，并验证参数转义；不要用手工 `cmd /c` 拼接或统一 `shell: true` 兜底。新增依赖需在实现说明中交代用途。
- 不直接使用现有 `@initx-plugin/utils` 的 `c()` 包装器：它返回聚合文本且把失败转换为结果对象，不符合实时输出和退出状态要求。

### 7.2 退出与失败

| 情况 | 对外行为 |
| --- | --- |
| 子进程正常退出 | 原样传递其退出码，包括非零码 |
| 命令缺失，ENOENT | 非零退出，约定 127 |
| 无执行权限，EACCES | 非零退出，约定 126 |
| 参数、配置、读取、校验失败 | 非零退出，约定 1；不启动子进程 |
| 其他启动失败 | 非零退出，约定 1 |
| 子进程由信号结束 | POSIX 优先让父进程以同信号结束；无法复现的平台使用明确的非零映射 |

实现应等待子进程结束，设置正确的 `process.exitCode`，避免无条件 `process.exit()` 导致日志截断或绕过 initx 的 store 清理。纯执行工具可以返回结构化结果，再由命令处理层应用到 CLI 状态；不要在工具单元测试中直接结束测试进程。

父进程收到 `SIGINT` / `SIGTERM` 时，应转发给仍存活的直接子进程，等待退出并移除监听器。终端可能同时向父子进程发送信号，处理逻辑应可重复进入且只完成一次。对于收到转发信号后仍不退出的子进程，给予 5 秒宽限，再尽力强制终止直接子进程，并以非零状态结束。

首版不承诺管理脱离进程组的后台进程；部署脚本应保持前台运行。Windows 信号与 POSIX 不完全相同，README 应说明实际支持的中断行为，测试中不能静默跳过所有平台差异。

## 8. 凭据与日志边界

`run` 不写 `.env`、`GITHUB_ENV`、GitLab dotenv artifact 或本地秘密缓存，不调用现有 stdout 变量渲染器。读取 store 时的名称或键数量可用于排障，所有插件自身诊断写 stderr，不能输出变量值、Token、完整远程响应正文或完整命令参数。

子进程 stdout/stderr 直接继承，因此插件不会自动遮罩子进程打印的凭据。不要添加一套字符串替换过滤器并宣称安全脱敏，也不要在 GitLab 中输出 GitHub 的 `::add-mask::` 协议。保持现有 `setup` 在 GitHub Actions 中的行为不变。

当前 store 仍是私有 GitHub 仓库中的明文 JSON，Git 历史会留存旧值。`run` 不改变这一存储边界，也不应被描述成加密秘密管理服务。

CI 的引导 Token 应只读指定 vault 仓库的 Contents。注意仓库权限只能限制到仓库，不能靠 store 文件名隔离授权；不同信任边界需要独立仓库或其他授权方案，本次不实现新的权限系统。

## 9. GitLab CI 使用方式

GitLab 设置一个受保护且遮罩的 `INITX_ENV_TOKEN`，仅用于读取 vault。仓库、分支、路径等非敏感配置可直接放 CI YAML。

以下仅展示插件接入位置，不是本次要写入任何业务仓库的完整流水线。initx 和插件应在固定版本的 CI 镜像或明确的无交互安装步骤中预先准备，不能依赖首次运行时弹出插件安装选择；具体固定版本由实现后的发布版本决定。

```yaml
deploy:
  stage: deploy
  variables:
    INITX_ENV_REPO: example/private-env-vault
    INITX_ENV_BRANCH: main
    INITX_ENV_PATH: stores
  script:
    - initx env run acewill-slidev-production -- pnpm deploy
```

`pnpm deploy` 应作为单一入口，内部执行 flash-dns、SSH 上传与部署验证。构建 job 不获取部署 store。store 可放 Cloudflare API Token、SSH 私钥等部署变量；具体键名由部署脚本和 flash-dns 的实际接口确定，不在插件中硬编码。

SSH 私钥可以保留为真实多行值。SSH 所需文件由部署脚本按需创建、设置权限并清理，不由 `env run` 自动落盘，也不通过 artifact/cache 传递。

GitLab 中注册为 Masked 的引导 Token 与运行时拉取的变量是两件事，后者不会因被注入而自动注册日志遮罩。部署脚本不得开启会打印凭据的命令跟踪。

## 10. 建议代码组织

| 文件 | 预期变更 |
| --- | --- |
| `src/index.ts` | 注册 `run`，更新帮助，保留 `--` 尾部数组并正确分发 |
| `src/commands/env-run.ts` | 参数校验、配置解析、读取 store、环境校验、调用执行器、设置退出状态 |
| `src/utils/run-process.ts` | 启动、实时 stdio、退出状态、信号转发和监听器清理 |
| `src/config.ts` | 新增三个配置环境变量，统一优先级 |
| `src/commands/env-config.ts` | 生效配置展示与说明适配 |
| `src/__tests__/` | 参数、环境、真实进程和现有能力回归 |
| `README.md` | run 用法、配置优先级、CI 示例及输出边界 |
| `docs/plan.md` | 将 `env run` 从未来分期调整为本次范围，链接本设计 |

优先复用 `readStore()`、`normalizeStoreName()` 等公共函数。若当前命令文件内的私有函数确需复用，可以做最小提取，不要为此重构全部命令或引入适配器框架。

## 11. 测试与验收

所有测试使用假的 store 值、临时目录或模拟 GitHub 响应，不读取真实用户配置，不调用真实 DNS、SSH 或 GitHub 写入接口。

### 11.1 参数与配置

- 真实匹配器恰好命中一个 `run` handler；原有子命令匹配不变。
- 缺 store、缺 `--`、缺命令、额外位置参数均非零失败，且在网络请求前拒绝。
- 通过真实 initx/cac 参数链路验证 `--help`、`--version`、`--token`、空字符串、空格、引号、Unicode 和第二个 `--`。
- 所有配置项的 override、环境变量、本地配置和默认值优先级，以及空值回退。
- `env apply --repo` 继续表示目标 Actions 仓库，不影响 vault 的选择。

### 11.2 环境与执行

- 用真实 Node 子进程读取环境并回传到测试 harness，确认 store 覆盖、父变量保留、空值、多行、CRLF、特殊字符均逐字一致，父进程环境未变。
- 对包含分号、反引号、`$()` 等字符的假值设置哨兵检查，确认按数据传递，没有额外命令被执行。
- 不存在的 store、读取失败、格式错误、非法变量名、NUL 均阻止启动；空 store 正常执行。
- cwd 与调用方一致；在 Linux 和 Windows 验证 PATH 命令查找，Windows 特别验证 `Path` / `PATH` 覆盖和大小写冲突。
- 真实子进程分别退出 0、7、42，外层 CLI 返回相同状态；ENOENT / EACCES 符合约定。EACCES 可在具备权限语义的平台执行。
- 延时输出的 fixture 验证 stdout/stderr 实时可见、stdin 可传入，而非等进程结束后输出。
- 使用独立外层进程验证 SIGINT / SIGTERM：直接子进程收到转发，父进程不提前成功退出，结束后清理监听器；忽略信号的 fixture 验证宽限后终止行为。
- Linux 和 Windows 均有 `pnpm` 启动器的实际冒烟验证，至少包含带空格参数，不能只 mock spawn。
- 带故意失败命令的真实 initx smoke test，确保 handler 结束后外层没有把退出码重置为 0。

### 11.3 日志与回归

- 假秘密哨兵值不出现在插件自身 stdout/stderr 中；fixture 不主动打印秘密时，整个调用也不能泄露它。
- 不生成 `.env`、备份、秘密缓存或改写 `GITHUB_ENV`；配置环境变量不回写本地 store。
- 原有 `setup`、`pull`、`push`、`apply`、配置相关测试继续通过。
- 按项目已有脚本运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`。检查结果分别记录，不用真实凭据做验收。

## 12. 实施顺序与交付

1. 检查当前 git 状态与项目指令，确认 initx 参数透传接口，保留用户已有变更。
2. 实现配置环境变量与纯参数/环境校验，补针对性测试。
3. 实现进程执行器、退出状态和中断行为，并用真实子进程验证。
4. 注册命令，完成真实 initx 入口冒烟测试及现有命令回归。
5. 更新 README、原方案分期，运行项目检查并记录 Linux / Windows 的实际验证情况。

最终说明应列出变更、验证结果、最低 initx 版本或兼容条件，以及尚未验证的平台行为。不要擅自发布 npm 包、推送仓库、修改 GitLab 变量或执行业务部署。

## 13. 交给实现 Agent 的任务

请在 `D:/Projects/initx-plugin-env` 实现本设计的 `initx env run`，先阅读项目指令、当前源码及本文，按已有 TypeScript、ESLint、antfu 和测试约定工作。实现范围包含跨平台子进程注入、三个配置环境变量、参数透传、退出状态和中断处理、测试及文档更新。优先只修改插件；确需改 initx 核心时先给出具体兼容证据和最小修改范围。使用假凭据和临时 fixture 验证，不访问真实秘密、不执行部署、不自动发布或推送。
