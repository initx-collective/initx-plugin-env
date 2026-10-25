# env 存储适配器与 GitLab 支持改造方案

日期：2026-10-25。状态：待实现，供另一个任务接手。本文不代表功能已经实现。

## 1. 目标与已确认现状

目标：业务项目用一个 store 管理整组运行配置，GitLab CI 只额外维护一项 vault 访问凭据；env 同时支持 GitHub、GitLab，后续新增其他存储无需改每个命令。

已阅读本项目源码，以及 `D:/Projects/acewill/slides/slidev-platform/src/ci-deploy.ts`、`ci/slidev.yml` 和 README。

- 本项目当前版本 0.1.2，存储只有 GitHub Contents API。
- Slides 已按用户反馈跑通：GitLab CI → 固定版本 initx/env → GitHub 私有 vault → `env run` → 部署子进程。运行平台与存储平台是独立维度。
- Slides 当前固定 initx/core 0.4.3、manager 0.6.0、env 0.1.2，使用隔离 HOME 非交互安装，并通过业务成功回执补充验证。保持旧用法兼容；本次不替 Slides 升版、迁库或触发发布。
- `src/store.ts` 的参数直接是 `GitHubContentsClient`，版本字段为 `sha`，解码也依赖 GitHub 数据结构。
- `env.ts`、`env-run.ts`、`env-config.ts`、`env-apply.ts` 均直接实例化 GitHub 客户端。
- `config.ts`、`env-config.ts` 只接受 `owner/repo`；token 回退包含 GH_TOKEN/GITHUB_TOKEN，没有按后端隔离。
- `env apply` 当前把同一份 token 用于读取 vault 和写入 GitHub Actions secrets，这个假设不能沿用到跨平台。
- 调查时 `pnpm test`：94 通过、3 跳过；跳过项不代表已在 Linux 验证。本轮未调用真实 vault，也未进行远端写入。

## 2. 本期交付范围

本期完成：

1. 抽出存储适配器，迁移 GitHub 实现并保留现有行为。
2. 新增 GitLab Repository Files/Tree API 适配器，支持自建实例与多层 subgroup。
3. 增加项目配置文件，CI 使用一个 INITX_ENV_TOKEN 即可读取整组业务变量。
4. list、pull、set、push、setup、run、config status 统一走适配器；存储层删除能力也实现并测试，不因此新增删除命令。
5. 保留 GitHub apply；将其源端读取切换到存储适配器，明确目标端凭据。
6. 补齐配置、冲突、分页、错误脱敏、命令回归测试和文档。

后续独立交付：GitLab CI/CD Variables 写入目标、CI_JOB_TOKEN 专用只读模式、本地文件/S3/Vault 等具体后端、加密存储、多个 store 合并与复杂 profile 继承。现在为其留接口，不一起实现。

GitLab vault + `env run` 已足够满足公众号每日 CI，不需要先实现 GitLab Variables 同步。

## 3. 分层与目录

```text
commands → 配置解析 / adapter factory → store 服务 → StorageAdapter
                                                    ├─ github
                                                    └─ gitlab

env apply：StorageAdapter（来源）→ GitHub Actions target（目的地）
env run：store.vars → 现有 createRunEnv / runProcess
```

建议目录：

```text
src/storage/types.ts           中立数据结构、能力与写入条件
src/storage/errors.ts          中立错误类型
src/storage/factory.ts         内置适配器注册、创建和能力检查
src/storage/path.ts            公共相对路径校验
src/storage/github.ts          GitHub Contents 实现
src/storage/gitlab.ts          GitLab Files / Tree 实现
src/project-config.ts          项目配置读取、校验
src/config.ts                  新旧配置归一化、来源、凭据解析
src/store.ts                   schema / 合并 / store 路径与读写
src/targets/github-actions.ts  现有 apply 目标实现，可复用 actions-secrets.ts
```

目录可按代码实际微调。关键验收：命令层不再出现 `new GitHubContentsClient` / `new GitLabClient`，store 服务不再依赖供应商响应类型。

不建设动态 npm 适配器加载体系；先用显式内置 factory。新增后端只需新增适配器、配置 schema 分支和 factory 注册，不增加命令中的平台判断。

## 4. 存储契约

建议最小接口，具体命名可调整：

```ts
type WriteCondition
  = | { kind: 'create' }
    | { kind: 'update', expectedVersion: string }

interface StorageObject {
  content: string // 已解码 UTF-8 文本
  version: string // 后端拥有的不透明版本，业务层不解释其含义
}

interface StorageEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'other'
}

interface StorageAdapter {
  readonly capabilities: {
    read: boolean
    list: boolean
    write: boolean
    delete: boolean
    conditionalWrite: boolean
  }
  read: (path: string) => Promise<StorageObject | null>
  list: (path: string) => Promise<StorageEntry[]>
  write: (path: string, content: string, options: {
    condition: WriteCondition
    message?: string
  }) => Promise<void>
  remove: (path: string, options: {
    expectedVersion: string
    message?: string
  }) => Promise<void>
}
```

- `StoreRef.sha` 改为 `version`。GitHub 使用文件 sha；GitLab 使用文件 `last_commit_id`。GitLab tree 的 blob id 不能当文件最后修改提交。
- 更新/删除必须带读取时的版本，新建必须明确为 create；不提供默认无条件覆盖。
- `--force` 保持显式重读最新版本后再尝试的语义，重试有上限；不能无限循环，也不能吞掉权限等错误。
- 未来只读后端在 write/delete 前报告 UnsupportedOperation，不伪造写成功；缺少可靠条件写入的后端不能声称支持 conditionalWrite。
- 不存在的文件返回 null，不存在的目录返回空列表；但仓库、ref 不存在或不可访问必须报错。适配器在必要时校验目标，不能把所有 404 都解释为空 vault。
- 中立错误至少区分 authentication、permission、not-found、conflict、validation、rate-limit、network、unsupported。
- 命令只打印脱敏摘要与可操作提示；HTTP 原始响应、token、完整 URL 查询、store 内容不能直接进入异常消息。读取请求设超时；重试要区分读操作与结果未知的写操作，禁止盲目重复提交。

## 5. 项目配置：减少 CI 变量

新增可提交的 `.initx-env.json`，仅放非敏感定位信息。例如：

```json
{
  "schema": 1,
  "storage": {
    "type": "gitlab",
    "apiBaseUrl": "https://gitlab.acewill.cn/api/v4",
    "repo": "example-group/env-vault",
    "branch": "main",
    "path": "stores"
  }
}
```

GitHub 对应 `type: github`，默认 apiBaseUrl 为 `https://api.github.com`；GitLab 默认可为 `https://gitlab.com/api/v4`，自建实例显式填写。统一使用 **API base URL**，避免 origin / api/v4 拼接歧义。示例仓库仅是占位，不代表已创建。

约定：

1. 支持 `--config <file>`，文件路径相对调用者 cwd 解析；显式指定但文件缺失应失败。
2. 未指定时只查当前 cwd 的 `.initx-env.json`；不向父级递归搜索，也不根据 GitLab CI 环境自动切换 provider。
3. 没有项目文件时继续旧配置；文件存在但 JSON/schema 错误则失败，禁止静默回退。
4. 项目文件禁止 token 等凭据字段，不写业务变量值；store 格式仍为 schema 1、vars 字符串映射，二者是不同配置层。
5. 非敏感配置优先级：显式 override → 已有 INITX_ENV_REPO/BRANCH/PATH 等环境覆盖 → 项目配置 → 本地持久化 → 默认值。保留旧环境变量兼容，不要求 CI 再新增一套变量。
6. 项目文件选择了 provider 后，不能继承另一 provider 的 repo/base URL/token；先选择后端，再按该后端解析字段。同类型跨 host 时也要防止继承旧的目标定位和凭据。项目文件至少写 type、repo，自建实例写 apiBaseUrl。
7. `env-config get/list/set/rm` 继续针对用户本地配置，不暗中改项目文件；`status` 显示生效后端、API 地址、仓库、ref、目录、配置来源与脱敏 token 来源。文件 schema 未知版本拒绝处理。
8. 旧扁平 repo/token/branch/path 配置归一化成 GitHub，不强制改磁盘格式。新增 provider 配置使用可区分的结构；不要让 defaultStore 的 github 默认值盖过项目文件。

CI 中的使用方式（仅展示接入点，安装步骤继续固定已发布版本）：

```sh
initx env run wukong-content-production --config .initx-env.json -- npm run pipeline
```

其中 `npm run pipeline` 是公众号项目后续新增的入口，本期 env 插件不实现它。CI 仅需一项 INITX_ENV_TOKEN；其他业务 API Key 等放在所选 store 的 vars 中，由插件向子进程注入。

减少的是 GitLab 页面上逐项维护的配置，并不需要改变操作系统环境变量的运行机制。AI 服务分组、模型参数等业务结构仍由公众号项目负责，不引入 env 插件专用 AI schema。

注意 Slides 当前在隔离临时 HOME/cwd 下执行 env run；若以后迁移成项目文件，必须传绝对 `--config` 路径，同时保留现有子进程 cwd 行为。迁移不是本次改造的隐式动作。

## 6. 凭据隔离

- 继续优先支持 `--token` / INITX_ENV_TOKEN，不需要为每个后端强制新增 CI 环境变量。
- GH_TOKEN/GITHUB_TOKEN 只在 GitHub 后端使用；不能发往 GitLab 或任意自定义 host。
- 旧持久化 token 仅保留在旧 GitHub 默认 API 域的兼容路径；新持久化凭据按 provider + API host/base 绑定。切换后端/host 时不自动复用旧 token。
- 项目文件只能选择目标，不能带入凭据；使用者的显式 override 和 INITX_ENV_TOKEN 适用于其明确选择的当前目标。带认证请求禁止跟随跨 origin 重定向。
- GitLab 本期使用 Personal/Project Access Token（以实例实际支持及授权为准），API header 为 PRIVATE-TOKEN；本机写操作与 CI 只读操作分别配置权限。
- CI 使用覆盖 Files 和 Tree 读取的 read_api 权限并有 vault 项目读取权限；写入用 api 并满足分支权限。权限是否够用以公司 15.9.4 的实际只读验证为准。
- Slides 拉共享仓库的 Deploy Token 用于 Git 操作，不能直接复用成 Repository Files API token。[GitLab Deploy Token 文档](https://docs.gitlab.com/user/project/deploy_tokens/)
- 本期不自动回退到 CI_JOB_TOKEN。其 Files API 能力与普通 API token 不同；后续支持应显式区分 auth 类型、使用 raw 文件读取、暴露只读/不支持 list 的能力，并验证跨项目授权及旧实例版本。[Job Token 文档](https://docs.gitlab.com/ci/jobs/ci_job_token/)

## 7. GitLab 适配器实现要点

使用现有 fetch 风格，无需为几个接口引入完整 GitLab SDK。

| 操作 | API |
| --- | --- |
| 读取文件 | GET /projects/:id/repository/files/:file_path?ref=... |
| 列目录 | GET /projects/:id/repository/tree?path=...&ref=...&per_page=100&page=... |
| 新建文件 | POST /projects/:id/repository/files/:file_path |
| 更新文件 | PUT /projects/:id/repository/files/:file_path |
| 删除文件 | DELETE /projects/:id/repository/files/:file_path |

具体要求：

- repo 支持数字项目 ID，或者 group/subgroup/project；不要沿用 GitHub 两段格式。
- 项目完整路径作为一个 URL path 参数编码；file_path 的斜杠也需编码；ref 放 URLSearchParams。防止双重编码，测试中文、空格、含斜杠分支名。
- Files 响应内容 Base64 解码后交给 store 服务；保留 last_commit_id 作为版本。
- Tree 处理 type=blob/tree，翻页至结束，只列选定目录，不递归全仓库；根目录要有明确语义。
- 创建/更新/删除写入 branch 与 commit_message，更新和删除携带 last_commit_id。
- GitLab 写入可能以 400 表示多种失败，不能把所有 400 都当冲突。必要时安全重读比对版本；无变化提交、无权限、非法路径分别处理，不能靠打印完整服务端响应猜原因。
- 路径校验复用公共实现；拒绝绝对路径、路径穿越、反斜杠、空段与控制字符，允许的根目录不依赖错误地传空字符串给 assertSafePath。
- 以公司文档记录的 GitLab CE 15.9.4 为兼容目标，不依赖新版细粒度 job token、新增 API 字段或 keyset 特性。目录不存在在旧版可能返回 200 空数组，新版可能返回 404，两种都需覆盖；目标不可访问不可静默为空。

接口依据：[Repository Files API](https://docs.gitlab.com/api/repository_files/)、[Repositories API](https://docs.gitlab.com/api/repositories/)。官方当前文档不等于公司旧版本已经验收，需保留实例验证记录。

GitHub 迁移时顺带收紧当前“所有 422 都算 sha 冲突”的判断，验证错误不能触发 force 重写。变化限制在两种适配器共同需要的错误契约内。

## 8. env run 与 apply 兼容

### run

- 严格保留 `<store> -- <command> [...args]`；新增 --config 放在分隔符之前。其余既有拒绝项保持拒绝。
- 修改 prefix 参数白名单和 cac kebab/camel 处理；分隔符后的 --config/--token/--help 等完整传给子进程。
- 保持 store 值覆盖父进程环境、空字符串、多行、Unicode、不展开变量、不写 .env/缓存/CI artifact 的语义。
- 保持 Windows 大小写冲突处理、退出码 126/127、子进程非零退出码、POSIX 信号与 Windows 既有终止边界。
- 新后端只替换取 store 的路径，不重写 run-process。

### apply

- `--repo` 仍是目标仓库，不能改成 vault repo；目标默认仍是 GitHub Actions，与 storage.type 无关。
- 来源改用 StorageAdapter；GitLab vault 也能读取到供 apply 使用的 store。
- 增加显式目标凭据入口，例如 --target-token；不同平台/host 下缺目标凭据必须失败，禁止把 GitLab token 发给 GitHub。
- 为老用户保留“GitHub 默认域 vault → GitHub 默认域 target 复用原 token”的旧路径；新跨平台配置要求显式目标凭据。目标配置不能改写 vault 身份。
- targets.secrets 旧格式保持有效，本期不为 GitLab 目标抬高 StoreFile schema 版本。
- 后续 GitLab Variables 作为另一种 target adapter 实现，配置 protected/masked/raw/environment_scope 等属性，并按实例版本核验。GitHub secrets 的只写不读特性不能概括成所有 CI 存储的共同限制；GitLab Variables API 能返回 value，插件仍可主动坚持 vault 单向投影策略。[Variables API](https://docs.gitlab.com/api/project_level_variables/)

## 9. 实施顺序与验收

1. 建 StorageAdapter / errors / factory，将 GitHub 包进来；命令行为不变，先跑现有回归。
2. StoreRef 改用 version，统一所有调用点与 force 路径；把 GitHub 专用解码和错误判断移回 adapter。
3. 增加项目配置文件、新旧配置归一化、按平台隔离 token；更新 config status 与 run prefix 参数。
4. 完成 GitLab read/list/create/update/delete 和共同契约测试。
5. 拆开 apply 来源/目标凭据，新增跨平台读取和拒绝错误复用的测试。
6. README、帮助、旧 docs/plan.md 更新为新的平台边界，写两平台接入示例与迁移说明。

必须覆盖的测试：

- GitHub 旧本地配置、INITX_ENV_*、GH_TOKEN/GITHUB_TOKEN 优先级不变；Slides 原命令不加任何新参数仍能读取 fake GitHub vault。
- GitLab 多层 namespace / 数字项目 ID、自建 API 地址、编码、Base64、多页目录、文件不存在、仓库/ref 不可访问、旧版空目录响应。
- 新建竞争、陈旧版本更新/删除、force 有界重读；400/401/403/404/409/422/429 与网络超时有正确分类，不打印响应正文和凭据。
- 临时目录配置文件的 cwd/显式路径、缺失/非法/未知 schema、优先级；provider/host 切换不混用 repo 与 token。
- run 原有 argv、环境值、cwd、stdio、退出码/信号测试全部保留，新 --config 与子进程 --config 分别验证。
- GitLab vault → GitHub apply 必须有独立目标凭据，旧 GitHub apply 回归通过。
- 假只读 adapter 可运行 read/run，写操作在发出请求前返回 unsupported；说明新增后端不必复制命令逻辑。

本地必须运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`；在现有 Linux/Windows CI 矩阵验证。旧 initx 可能对未匹配命令返回 0，因此 CLI 烟雾验证必须检查无敏感内容的执行标记和子进程非零状态，不能只看 initx 自身退出 0。

真实集成：使用无真实业务密钥的临时测试 store，在目标 GitLab 15.9.4 验证只读读取/分页及陈旧版本拒绝；远端写入和测试数据清理由接手任务按授权范围执行，不操作生产 vault。记录用到的实例版本、token 类型、权限及结果。发布新插件版本、更新 Slides 固定版本、迁移生产 vault 均作为单独动作，不由本方案自动触发。

## 10. 给接手任务的简短任务说明

在 `D:/Projects/initx-plugin-env` 按本文实现 GitHub/GitLab 存储适配器和非敏感项目配置文件。保留 env 0.1.2 的旧配置、store schema 1、run 参数/退出码契约及 Slides 当前 GitHub vault 接入方式。命令通过 factory 获取 StorageAdapter，不再直接依赖 GitHubContentsClient；版本字段改为不透明 version。GitLab 支持自建域名、多级 subgroup、分页、条件更新与错误脱敏。CI 只需一个 INITX_ENV_TOKEN，业务变量由 env run 注入。apply 的来源与目标平台、凭据独立，本期保留 GitHub 目标，GitLab Variables 写入另期处理。完成两平台 mock 契约及回归测试，运行 lint/typecheck/test/build；不要发布 npm、触发 Slides 发布或修改生产 vault。
