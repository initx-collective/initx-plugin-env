# 方案：@initx-plugin/env

> 2026-10-25 更新：下文保留最初 GitHub 版本的历史设计。
> 当前存储边界已扩展为 GitHub/GitLab StorageAdapter，版本字段为不透明 `version`；
> GitHub Actions 仍是唯一 apply 目标，来源与目标凭据独立。
> `.initx-env.json`、凭据隔离及 GitLab CE 15.9.4 的实现与验收状态以
> [存储适配器实现记录](gitlab-storage-implementation.md) 和 README 为准。
> GitHub Secrets 的只写不读限制只适用于该目标，不代表所有 CI 平台都不能读取变量。

> 把「本地 `.env` / CI secrets」的唯一真相源放在**一个私有 GitHub 仓库**里，
> 插件负责两个投影：**拉到本地** 和 **写进 CI**。
>
> 这份文档是定稿的功能边界。**唯一权威是代码**，但这里记录了为什么这么划。

---

## 1. 一句话定位

`initx` 插件：一个私有仓库当 vault，里面一个 JSON 一个 store；`env pull` 拉到本地 `.env`，
`env setup` 注入当前 job，`env run <store> -- <command>` 直接注入子进程，`env apply` 写进某个仓库的 Actions secrets。

**刻意不做的那一半**：CI → 本地。GitHub Actions secret 的值**只写不读**
（官方 schema 只有 `name` / `created_at` / `updated_at`），所以 vault 永远是真相源，
CI 永远是单向投影。这不是偷懒，是物理限制 —— 任何工具都做不到。

---

## 2. 命令面

| 命令 | 方向 | 说明 |
| --- | --- | --- |
| `env-config setup\|set\|get\|list\|rm\|status` | — | vault 的 `repo/token/branch/path`；形状对齐 cp 的 `cp-config`；token 一律脱敏 |
| `env list` | — | 列仓库里的 store |
| `env pull [store]` | 仓库 → 本地 `.env` | 无名字就列出来选；目标文件同样列出来选 |
| `env set <store> K=V ...` | 本地 → 仓库（单键） | store 名**就是文件名** → `stores/<store>.json` |
| `env push <store>` | 本地 → 仓库（批量） | 从 `.env` 反向更新 store，`--prune` / `--force` |
| `env setup [store]` | 仓库 → **当前环境** | CI 写 `$GITHUB_ENV` + `::add-mask::`；本地打到 stdout |
| `env run <store> -- <command> [...args]` | 仓库 → **子进程** | 原值注入，继承 stdio/cwd，传递退出状态与中断；不落秘密文件 |
| `env apply <store> --repo o/r` | 仓库 → **Actions secrets** | REST + libsodium sealed box，串行写入 |

`apply` 是这个插件存在的主要理由：dotenvx / sops / 1Password / Doppler / Infisical / Vault
**全都是"注入"路线**，没有一个往 GitHub 的 secret 存储里写。

---

## 3. store 格式

```jsonc
// <path>/<name>.json，path 默认 stores
{
  "schema": 1,
  "vars": { "KEY": "value" },
  "targets": { // 可选：只是省掉交互里的两次选择
    "envFiles": [".env.local"],
    "secrets": [{ "repo": "owner/repo", "env": null }]
  }
}
```

- 一 store 一文件 → 一次 `PUT` 就是一个原子提交（Contents API 单文件）。
- `sha` 乐观锁：并发改过 → `GitHubConflictError` → 提示"先 pull / 加 `--force`"。
- 值一律字符串，不做类型转换。

---

## 4. 关键设计决定

| 决定 | 为什么 |
| --- | --- |
| **不用 Octokit**，裸 `fetch` 打 Contents API | 只需要 4 个调用；cp 已经验证过这条路 |
| **不照抄 cp 的缓存** | cp 是「缓存优先、永不校验」，缓存文件里存的是**解码后的明文**。对密钥而言双重事故：换了值还在用旧的 + 明文摊在 home 目录。本插件每次现拉 |
| **不照抄 cp 的 `rename`** | cp 那里有真 bug：`getFile` 返回的 content 还是 base64，被原样传给 `putFile` 又编码一次 → rename 后内容坏掉 |
| **校验配置里的 `path`** | cp 把配置值直接拼进 URL，含 `..` 也能拼出去（`assertSafePath`） |
| **合并而不是覆盖 `.env`** | 同名键原地更新、新键追加、其它键/注释/顺序不动；写前备份 `<file>.bak`；幂等 |
| **单一解析器** | 本地 / store / CI 三处共用一套解析语义（无 shell 展开），避免"本地与 CI 的值不一样"这类最难查的 bug |
| **串行写 secrets** | `gh secret set -f` 是并发 PUT：中途失败无原子性、不好汇总 |
| **`apply` 前查命名合法性并中止** | GitHub 只允许 `[A-Za-z0-9_]`、不能数字开头、不能 `GITHUB_` 前缀，且一律大写存储。静默跳过的后果是"以为写进去了" |
| **用 `defaultStore` 而不是自己写 config.json** | initx 核心已经提供自动落盘的 store（`~/.initx/stores/@initx-plugin/env/store.json`），cp 是没用它 |
| **`build.config.ts` 关掉 `inlineDependencies`** | `libsodium-wrappers` 运行时加载 WASM，被 inline 进 bundle 会找不到自己的二进制 |

---

## 5. 已知限制（写进 README，别藏着）

1. **secret 只写不读** → 没有反向同步，`--dry-run` 也只能列名字，不能做内容级 diff。
2. **v1 用明文 JSON**：私有仓库 + git 历史永久留存，这就是 cp 的风险姿态。加密是正交的（加一个密钥 secret），以后加不改进命令面。
3. **单条 secret ≤ 48 KB**；仓库 100 / 环境 100 / 组织 1000 个；组织级超过 100 个时按名称字母序取前 100。
4. **CI 里的内置 `GITHUB_TOKEN` 读不了另一个私有仓库** → vault 独立时需要单独一个 PAT（就一个 secret）。
5. **组织级 secret 需要 `admin:org`**（v1 不做）。
6. **`env-config` 的 token 明文落盘**，与 cp 一致；可用 `INITX_ENV_TOKEN` 规避。

---

## 6. 分期

| 期 | 内容 |
| --- | --- |
| **v1（当前）** | 上表命令 + `env-config`；明文 JSON；仓库级 secrets；`.env` 更新式合并；`env run` 与 CI 配置环境变量（[设计](env-run-design.md)、[实现与验证](env-run-implementation.md)） |
| v2 | 加密（dotenvx 或 sops+age）+ `rotate`（批量重加密并重推） |
| v2 | `apply --to variables`（Actions variables 的 value **可读** → 这部分能真正做到双向 + 内容级 diff） |
| v2 | `env diff` / `env status`（名称集合 + `updated_at` 做漂移检测；variables 上做内容级） |
| v3 | `env guard`（.env 是否被 gitignore、解密密钥是否被 git 跟踪）、共享变量 `ref`、系统 keychain、环境级 / 组织级 scope |

---

## 7. v1 验收清单

- [ ] `env-config set repo/token` → `env-config status` 打 `***` 并报告连通性
- [ ] `env set demo A=1 B=2` → 仓库出现 `stores/demo.json`；再 `set A=9` 只改 A
- [ ] `env pull`（多个 store）→ 能选 store、选 `.env`；同名键更新、其它键与注释不变
- [ ] `env pull` 幂等：第二次跑报"无需改动"，且文件字节不变
- [ ] `env push --from .env.local` → 反向更新；远端独有的键保留；`--prune` 才删
- [ ] `env push` 在远端被改过时报冲突，`--force` 可覆盖
- [ ] `GITHUB_ENV=<tmp> env setup demo` → 文件里有两行；`--json` 输出 JSON
- [ ] `env apply demo --repo <测试仓库> --dry-run` → 只列名字；非法名（例如 `GITHUB_X`）默认中止
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿
