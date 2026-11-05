# 文件型变量：实现与验证记录

> 对应设计：[env-file-refs-design.md](env-file-refs-design.md)
> 版本：0.2.0
> 记录日期：2026-11-05

## 1. 落地范围

设计文档里的范围已全部实现：

- store 保持 **schema 1**，新增可选 `files`；路径按 `<path>/_files/<store>/<id>` 推导，不落库。
- `${file-<id>}` 整值引用；未声明的引用硬失败，不做字面量兜底。
- `env file add / ls / cat / pull / rm / check` 六个子命令。
- `pull / setup / run / apply / --json` 统一解引用；`push` 零下载比对并保护引用。
- `.env` 多行序列化、`$` / 反引号转义、BOM 处理。
- 10 MB / 1 MiB / 32 KB / 48 KB 限额与 `E2BIG` 提示。

## 2. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/files/refs.ts` | 引用语法、id 规则、声明一致性检查 |
| `src/files/paths.ts` | `_files/<store>/<id>` 路径推导 |
| `src/files/limits.ts` | 单文件 / 内联 / 环境变量限额 |
| `src/files/read.ts` | 读取 + 字节数 + sha256 校验 |
| `src/files/resolve.ts` | 解引用、并发上限、base64 / UTF-8 解码 |
| `src/files/push.ts` | push 的零下载比对与冲突分析 |
| `src/commands/env-file.ts` | `env file` 命令族 |
| `src/storage/github.ts` / `gitlab.ts` | `readBytes` / `writeBytes`；GitHub >1 MB 走 Blobs |
| `src/utils/envfile.ts` | 多行转义、`$` / 反引号转义、BOM |
| `src/index.ts` | `env file` 路由与 help |

## 3. 关键行为

- **引用**：只有整值匹配且 id 已声明才解析；文件内容不会再被展开。
- **推送**：本地值按 `encoding` 还原成字节，先比 `bytes` 再比 `sha256(本地字节)`，全程不下载。
- **冲突**：引用键内容变化默认报错；`--update-files` 重传并保留引用，`--inline` 改普通值并清理条目。
- **删除**：`file rm` 先改 store 再删文件；别的键共用同一 id 时保留文件本体。
- **检查**：`file check` 覆盖缺失、大小、sha、未声明引用、孤儿文件、悬空元数据，并支持 `--json` 纯数据输出。
- **JSON**：`file ls` / `file check` / `setup --json` 均只输出数据，可直接管道给 `jq`。

## 4. 验证

```text
pnpm lint       通过
pnpm typecheck  通过
pnpm test       24 个文件，316 通过 / 3 跳过
pnpm build      成功（dist/index.mjs 约 75 kB）
```

测试覆盖：

- `file-refs.test.ts`：语法、id、路径、schema、未声明引用。
- `storage-contract.test.ts`：两个后端的字节读写、GitHub blob 回退、大小上限。
- `file-resolve.test.ts`：UTF-8 / base64 / BOM / 共享 id / 冲突 / 限额。
- `envfile.test.ts`：多行、尾随换行、`$` / 反引号、BOM、强制引号。
- `env-file.test.ts`：add 幂等与覆盖、ls/cat/pull/rm/check、JSON 输出。
- `env-push.test.ts`：保留引用、`--update-files`、`--inline`、`--prune`、共用 id 冲突。
- `commands-regression.test.ts` / `command-output.test.ts`：pull / setup 解引用、JSON 纯净性、错误边界。
- `http-e2e.test.ts`：本地回环 HTTP + 真实 `fetch`，跑通 add / pull / file pull / check / push --update-files。

打包产物冒烟使用内存 GitHub Contents 模拟器跑通：

```text
file add → pull → setup --json → file pull → file check → push --update-files
```

## 5. 尚未完成的真实验收

没有可用的真实 vault 凭据，因此以下项目仍需在真实 GitHub / GitLab 实例上确认：

- [ ] GitHub 小型文件与 >1 MB 文件的 `file add` / `file pull`
- [ ] GitLab 子组、受保护分支、Files/Tree 权限
- [ ] `file check` 对真实并发写的漂移检测
- [ ] Windows 下 `file pull` 的 `mode` 忽略行为
- [ ] 真实 CI 中 `setup --json` / `run` 的日志脱敏

这些属于环境验收，不影响代码层面的功能完成。

## 6. 按设计明确不做

- 没有 `extract`：存量 base64 按设计手工迁移。
- 没有 `gc`：孤儿由 `file check` 报出后手工删。
- 没有跨 store 共享文件、没有加密、没有字符串插值。