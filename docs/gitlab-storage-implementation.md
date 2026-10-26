# GitHub/GitLab 存储适配器实现与验收记录

日期：2026-10-25。实现依据为 `gitlab-storage-adapters-plan.md`，实际行为以源码与测试为准。

## 2026-10-26：补回空仓库首次写入

用户实测 GitLab 空 vault 时，Files 404 后的 commit/ref 预检将“尚无首个分支”当成了不可访问目标，
导致首次 push 在提交前失败；同一预检也影响迁移后的 GitHub 适配器。这是本次修复的回归。

- GitLab：commit/ref 404 后调用 `GET /projects/:id`，要求项目可访问且明确返回布尔值 `empty_repo: true`。
- GitHub：仅识别已知的空仓库 409 文本；ref 404 时查询不指定 ref 的 commits 列表确认，不能把任意 404/409 当空仓库。
- 已确认空仓库时 read 返回 null、list/status 显示零项，读取不创建 README、分支或提交。
- 首次 push/set 直接使用 Files POST（GitLab）或 Contents PUT（GitHub）创建 store 和首个分支；
  未配置 branch 时为 main，显式 branch 继续生效。不增加初始化专用的额外写操作。
- 已初始化仓库的缺失 ref、无权访问、错误 metadata、首次写入权限错误继续失败；创建竞争仍按冲突处理。
- 不创建远程项目本身，不修改实例或分支保护规则；初始默认分支权限仍由服务端决定。

GitLab 15.9.4 依据：[project empty_repo 字段](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/lib/api/entities/project.rb)、
[Files CreateService](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/app/services/files/create_service.rb)。
新增两平台空 vault 生命周期、默认/自定义分支、并发首次创建、GitLab metadata 权限/类型、
GitHub 409/缺失 ref 区分及 push/set/status 命令回归测试；真实实例首次提交仍待用户验证。

本次本地检查：pnpm lint、pnpm typecheck、pnpm test、pnpm build 均通过；16 个测试文件通过，
208 passed、3 skipped（POSIX 专属）。dist 已重建；未安装 initx CLI，package.json 与 lockfile 无变化，
未访问真实 vault、发布或推送。

## 已实现

- `src/storage/types.ts` 定义中立 StorageAdapter、capabilities、UTF-8 StorageObject 和不透明 version。
- `factory.ts` 显式注册 GitHub/GitLab。list/pull/set/push/setup/run/config status 的命令实现不创建平台客户端。
- GitHub Contents 已迁移；GitLab 支持完整 API base、数字项目 ID、多层 subgroup、编码路径/ref、Files 读取/创建/更新、Tree offset 分页，以及条件删除。
- store 服务保持 schema 1、vars 字符串映射和 targets 格式。StoreRef 使用 version，GitHub 对应文件 SHA，GitLab 对应 last_commit_id。
- 创建明确使用 create；更新/删除必须提供读取的版本。400/409/422 等模糊失败经安全重读比对分类，不能统一当冲突。push --force 最多重读重试一次。
- `.initx-env.json` 与 --config：只包含 schema 与 storage 定位信息，严格拒绝未知版本/字段与凭据。默认只查调用 cwd，显式路径相对调用 cwd，不搜索父级，不改变子进程 cwd。
- 非敏感字段按 override → INITX_ENV_* → project → 同 provider/API local → default 解析；保留旧扁平 GitHub 配置与环境变量。
- 新本地凭据按 provider + 规范化完整 API base 绑定。旧 token 与 GH_TOKEN/GITHUB_TOKEN 仅限默认 GitHub API。显式 --token / INITX_ENV_TOKEN 适用于当前明确选定的目标。
- env-config get/list/set/rm 继续只操作本地配置；status 展示后端、定位、各字段来源、文件来源和完全脱敏的 token 来源。
- apply 来源走 StorageAdapter；目标保留 GitHub Actions，--repo 仍是目标仓库。跨平台/host 必须用 --target-token 或 INITX_ENV_TARGET_TOKEN；仅默认 GitHub 来源保留旧凭据复用。
- HTTP 不跟随认证重定向，30 秒超时，无自动写入重试；错误只保留分类、安全提示与 HTTP 状态，不带原响应、原异常、URL 查询、token 或 store 值。
- `src/utils/run-process.ts` 没有改动，argv、环境值、cwd/stdio、退出状态和信号处理仍使用原实现。

## 对原方案的必要调整：GitLab 15.9.4 条件删除

核对 GitLab **v15.9.4** 源码发现，Files DELETE 只使用 simple_file_params，里面没有声明 last_commit_id。
传入该字段会在 declared_params 过程中丢失，因此单纯向 Files DELETE 发送版本不满足本期冲突契约。

实现改用已有的 `POST /projects/:id/repository/commits`，只提交一个 delete action，action 中带
file_path 和 last_commit_id。该版本 Commits API 明确接受此字段，MultiService 对 delete 执行文件版本校验。
适配器仍提供同一个 remove 接口；不增加删除命令，不提供无条件删除，也不以客户端预读代替服务端版本条件。

依据（版本固定，区别于当前在线文档）：

- [v15.9.4 Files API](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/lib/api/files.rb)
- [v15.9.4 Commits API](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/lib/api/commits.rb)
- [v15.9.4 MultiService](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/app/services/files/multi_service.rb)

另一个保守处理：Tree 请求前校验 commit/ref，避免旧版的 200 空数组把无效 ref 静默解释为空 vault；
新式路径 404 也会重新核验目标；空仓库例外按上方补充规则确认。该额外 GET 要求只读 token 同时有 Commit、Files、Tree 的读取权限，
空 GitLab 仓库还需读取项目 metadata（read_api 覆盖）。
GitHub 路径 404 同样通过 commit/ref 查询区分文件缺失与目标不可访问。

GitLab 更新相同内容可能返回 400；仅当安全重读结果的版本和内容均符合请求，才视为目标已满足。
15.9.4 CreateService 的固定分支权限错误文本会以 400 返回，适配器仅精确识别该已知文本为 permission，
不打印服务端正文；其余同版本 400/409/422 归为 validation，不触发 force。401、403、429、网络错误分别分类。
依据：[v15.9.4 CreateService](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/app/services/commits/create_service.rb)。
超时/网络失败后的写入可能已完成，应先重读确认，不能盲目重复提交。

## 兼容与边界

- 旧 GitHub 本地配置、INITX_ENV_REPO/BRANCH/PATH/TOKEN 与 GH_TOKEN/GITHUB_TOKEN 的兼容优先级保留。
- defaultStore 仍仅默认 branch/path，不添加 provider 默认值去覆盖项目文件。
- run 仅新增分隔符前的 --config。分隔符后的 --config/--token/--help/--version 仍完整传给子进程。
- 空字符串、多行、CRLF、Unicode、不展开值、父环境覆盖、Windows 大小写合并维持原契约。
- push --force 仍用已准备的本地 store 覆盖，版本重读后只尝试一次；并发远端独有改动可能被覆盖。
- 持久化身份切换会清除旧 repo/branch/path；原凭据保留在其绑定的身份下。项目文件不自动改磁盘本地配置。
- 仓库路径校验拒绝绝对路径、反斜杠、控制字符、空段与穿越；项目 path 空字符串表示根目录。
- GitHub Contents 目录列表仍受其平台数量限制；本次分页扩展针对 GitLab Tree。
- GitLab Variables 目标、CI_JOB_TOKEN、Deploy Token API 模式、新加密层与动态第三方适配器加载均未加入。

## 本地验证与测试范围

环境：Windows，Node v26.12.1，pnpm 12.10.1。验证使用 mock 响应、临时 HOME/目录和虚构数据。

新增测试包括：

- 两平台共同 read/list/create/update/delete 契约、版本竞争、删除后冲突、非法路径、权限/认证/限流/网络错误与脱敏。
- GitLab subgroup/数字 ID/中文空格编码、含斜杠 ref、分页（有/无 next header）、旧版空数组/新版 404、错误 ref。
- 模拟旧 Files DELETE 忽略版本的服务，验证适配器走 Commits delete 并拒绝陈旧版本。
- 配置 cwd/显式文件/未知 schema/非法字段/优先级、双向凭据隔离及同域不同 API base 绑定。
- list/pull/set/push/setup/status 命令回归，两平台 force 上限与权限/validation 不重试。
- GitLab 来源到 GitHub apply 的独立凭据与本地 sealed-box 还原校验，dry-run 无目标写入。
- 真实子进程的 argv、cwd、stdin/stdout/stderr、环境覆盖、多行值与非零状态，及未来只读适配器 run。
- 现有 core matcher 的命令分发测试，以及直接调用命令 handler 的真实子进程测试。
  不安装或导入 initx CLI；子进程测试检查执行标记和非零退出码。

现有 Windows/POSIX 进程测试继续保留。Windows 下 3 项 POSIX 专属测试跳过，不能视作 Linux 已验收。
仓库原有 `.github/workflows/test.yaml` 的 Ubuntu/Windows 矩阵保留；本次未推送或触发远端 CI，Linux 结果待 CI 验证。

最终本地检查结果见本文件末尾的记录。

## 后续真实 GitLab CE 15.9.4 验收

本次没有访问公司实例，没有读取/修改真实业务密钥。以下需在临时项目/分支中用无敏感 dummy store 验证：

1. 记录实例版本、代理/API base、项目 ID/namespace、token 类型、scope 和项目角色。
2. 用 read_api 验证 Files、Tree、commit/ref 读取；同时验证跨 subgroup、中文/空格路径与带斜杠 ref。
3. 用超过 100 条目录项验证分页；不存在目录应为空，不存在 ref/无权访问应失败。
4. 用具备 api 与目标分支写权限的凭据验证创建、更新、无变化提交、创建竞争与陈旧版本更新拒绝。
   另外验证空项目首次 push/set 创建 main 和 store；status/list 在首次写入前不创建提交，
   初始默认分支保护不允许的角色应保持失败。
5. **验证 Commits delete action 在该实例拒绝陈旧 last_commit_id，正常版本可删除**，随后清理临时数据。
6. 验证受保护分支/只读 token 的错误分类与脱敏，检查反向代理重定向是否需要修正 API base。
7. 在实际 Linux Runner 确认 env run 执行标记、退出码与信号行为；Windows 控制台 Ctrl+C 仍保留原手工验收项。

只有上述测试完成后，才能记录真实实例兼容性通过。发布插件、更新 Slides 固定版本、迁移生产 vault 是独立动作。

## 业务项目接入示例

将 `examples/gitlab.initx-env.json` 复制为业务项目根目录 `.initx-env.json`，修改 API 地址、repo、branch/path。
GitLab CI 只新增 INITX_ENV_TOKEN（read_api + vault 项目读取权限），业务 API Key 等继续存放在远程 store.vars：

```yaml
# CI 镜像已非交互安装经过验证的固定 initx/env 版本；本次功能尚未发布。
pipeline:
  script:
    - initx env run wukong-content-production --config "$CI_PROJECT_DIR/.initx-env.json" -- npm run pipeline
```

`npm run pipeline` 由业务项目后续实现；本任务不修改公众号项目。
CI 中业务入口仍继承调用者 cwd；隔离 HOME/cwd 的调用者必须传 config 绝对路径。

若需单向写入 GitHub Actions，另设 INITX_ENV_TARGET_TOKEN，并使用：

```sh
initx env apply demo --config .initx-env.json --repo example-owner/target --dry-run
```

确认后去掉 --dry-run 即执行目标写入。该调用不改变 vault repo 或来源 token。

## 最终本地检查结果

2026-10-25，Windows / Node v26.12.1 / pnpm 12.10.1：

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | 通过，lockfile 无需重新解析 |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 移除 initx CLI 开发依赖与对应测试后重新验证：15 个测试文件通过；186 passed，3 skipped（POSIX 专属） |
| `pnpm build` | 通过，dist/index.mjs 与声明文件生成成功 |
| `git diff --check` | 通过 |

命令/store 层检索未发现平台客户端构造或 SHA 字段引用；run-process、gh-env、envfile 的原实现无 diff。
没有发布 npm、创建或推送标签、迁移 vault、升级 Slides 插件、触发部署或修改公众号项目。
