# 方案：文件型变量（store 内的文件引用）

> 状态：已实现，版本 0.2.0。
> 代码：`src/files/`（引用解析、字节读取、push 分析）、`src/commands/env-file.ts`、
> `src/storage/github.ts` / `gitlab.ts`（`readBytes` / `writeBytes`）。
> 关联：[初始方案](plan.md)、[env run 设计](env-run-design.md)。
>
> **范围声明（自用版）**：本方案只服务「本地新增文件引用 → push → CI 消费」这一条路径。
> 不做存量迁移（没有 `extract`），不做孤儿回收（没有 `gc`），不做多版本兼容
> （只有作者本人在用，直接升级）。store **不升版本**，`files` 只是 schema 1 的可选字段。

## 1. 问题

现在 `stores/<name>.json` 的 `vars` 只接受 `string:string`。SSH 私钥、证书、keystore、
GCP service account JSON 这类「本来就是一个文件」的值，只能 base64 内联进 JSON：

- 单行 4 KB ~ 100 KB，store 文件基本不可读、不可 review；
- 每次改任何一个键，都要把整块 base64 重新编码、整文件提交，diff 只有一行巨长字符串；
- `pull` 出来的 `.env` 里是 base64，交给工具还得再解一次；想落成真实文件（SSH 要 0600、
  要真实换行）插件完全不管；
- 换行、编码、尾随换行在「JSON 字符串 → base64 → .env 引号转义」这条链上层层转义，容易丢。

## 2. 目标与非目标

**目标**

1. store 里只保留短引用，文件内容作为独立对象存放，仍在同一个 vault 仓库。
2. 引用写法 `ABC=${file-<id>}`，默认语义是「读取该文件的内容作为值」。
3. 文件对象的增删查、落盘、校验由**独立命令**负责，不复用 `push` / `pull`。
4. 保持现有安全边界：不做本地缓存、值不做 shell / 变量展开、不打印值。

**非目标**

- 加密（与 sops / age 正交，后续单独做）；
- 二进制内容直接注入环境变量（只支持文本，或显式 `encoding: base64` 后注入 base64 文本）；
- 跨 store 共享文件、文件版本历史浏览；
- 本地路径引用（`${file:/abs/path}`）——不可移植，CI 里没有意义；
- 字符串内插值（`prefix${file-x}suffix`）；
- 存量迁移、孤儿回收、多版本兼容（自用，见 §11）。

## 3. 核心决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 引用是**整值引用**，不是插值 | 只有整值替换才能无损处理二进制、换行、编码；插值会引入「文本还是字节」的歧义和注入面 |
| D2 | 引用和元数据写在 store 的 `files` 区块，作为 **schema 1 的可选字段** | 只有作者本人在用，没有老客户端需要区分，不必升版本；`files` 缺失时行为与现状完全一致 |
| D3 | 文件放在 `<path>/_files/<store>/<id>` | 与 store 同级、跟着已有的 `path` 配置走，不引入第二个配置项；`listStores` 只取 `.json`，天然忽略该目录 |
| D4 | 独立命令族 `env file add/ls/cat/pull/rm/check` | 见 §3.1 |
| D5 | 解引用集中在 resolver，所有出口共用 | 避免 `pull` / `run` / `apply` 各写一套，出现「本地和 CI 值不一样」 |
| D6 | `push` 遇到引用默认**报错**，不静默内联 | 本地 `.env` 里是解析后的明文，直接回写会把文件内容塞回 vars，引用被破坏且不可逆 |
| D7 | 引用的 id 未声明时**报错**，不按字面量放过 | 密钥场景「静默错值」比「硬失败」危险得多（见 §6.2） |

### 3.1 为什么不塞进 push / pull

`pull` / `push` 的契约是「整份 `.env` 与 `vars` 的键级投影」：只读、幂等、以键为单位。
文件对象是完全不同的生命周期——上传、校验、引用、落盘，且**写操作**会产生远端副作用。

如果让 `push` 顺带传文件：

- `push` 从「只改 vars」变成「可能改远端文件」，冲突处理和 `--force` 语义都要重新定义；
- 每次 push 都要为所有引用计算 diff，一个「本地少了末尾换行」就能把密钥文件重写一遍；
- CI 里 `pull` 是只读投影，绝不该触发上传。

所以文件对象必须有独立命令，且明确区分读（`ls/cat/pull/check`）与写（`add/rm`）。

## 4. 命令面

```bash
# 上传本地文件并建立引用；id 默认由 KEY 推导（IOS_P12 -> ios-p12）
initx env file add <store> KEY --file ./dist.p12 [--as ios-p12] \
    [--encoding base64] [--mode 600] [--dry-run]

# 查看
initx env file ls <store> [--json]
initx env file cat <store> KEY [--show]        # 不加 --show 只报大小 / 编码，不输出内容
initx env file pull <store> --to-dir ./.secrets [--only KEY] [--force]

# 删除（默认连引用带文件一起删）
initx env file rm <store> KEY [--keep-blob]

# 校验：缺失 / 大小 / sha 漂移 / 未声明引用 / 孤儿文件 / 悬空元数据
initx env file check <store> [--json]
```

没有 `gc`，没有 `extract`，理由见 §11。

命名：占位符叫 `file-`，命令也叫 `file`，用户心智一致。

约定与现有命令一致：`--dry-run` 先报告、`--json` 只输出数据、颜色走 `colorText`、
失败只打一行错误 + 退出码 1。

### 4.1 `file add`

1. 读本地文件（`--file -` 读 stdin），单文件上限 10 MB（见 §8）；
2. 计算 sha256 与字节数；
3. 若 `_files/<store>/<id>` 已存在且 sha256 相同 → 跳过上传（幂等）；
4. 否则上传文件（先 blob，后 store，理由见 §7）；
5. 把 `vars[KEY]` 改成 `${file-<id>}`，写入 `files[id]` 元数据。

store 不存在时创建空 store（与 `set` 一致），并打印一行提示。

### 4.2 `file rm`

1. `vars[KEY]` 不是文件引用 → 报错（普通值请用 `set` 改）；
2. 删除 `vars[KEY]`；
3. 若**还有别的键**引用同一个 id → 保留 `files[id]` 和文件，只删本键引用，并提示；
4. 否则删除 `files[id]`；没有 `--keep-blob` 时再删文件。

逆序（先 store、后文件）的理由见 §7。文件删除失败会留下没人登记的文件，
`file check` 的「孤儿文件」一项能报出来。

### 4.3 `file check`

同时检查两个方向，缺一不可：

| 方向 | 检查 |
| --- | --- |
| `files` → 存储 | 文件缺失、字节数与 `bytes` 不符、sha256 漂移 |
| `vars` → `files` | 值形如 `${file-<id>}` 但 `files` 里没有该 id |
| 存储 → `files` | `_files/<store>/` 下存在但 `files` 没登记的文件（孤儿） |
| `files` → `vars` | `files` 里有、但没有任何键引用的条目（悬空元数据） |

后两项需要列一次 `_files/<store>/` 目录；`rm` 失败和 `set` 内联都会留下这类残留，
没有 `gc` 的情况下它们是唯一的发现手段。

## 5. 数据格式（schema 1 + 可选 `files`）

```jsonc
// stores/acewill-slidev.json
{
  "schema": 1,
  "vars": {
    "DEPLOY_KEY": "${file-deploy-key}",
    "GCP_SA_JSON": "${file-gcp-sa}",
    "NORMAL": "plain-value"
  },
  "files": {
    "deploy-key": {
      "sha256": "9f2c…（64 位）",
      "bytes": 3243,
      "encoding": "utf8", // utf8（默认）| base64
      "mode": "600" // 仅用于 file pull 落盘，POSIX 有效
    },
    "gcp-sa": {
      "sha256": "…",
      "bytes": 2381,
      "encoding": "base64" // 注入时对该文件的字节做 base64，内容仍以原始字节存储
    }
  }
}
```

- **不存 `path`**：路径固定按 `_files/<store>/<id>` 推导。没有跨 store 共享，显式路径只多一处
  需要校验的不一致。
- `encoding` 决定**注入形态**，不决定存储形态：文件永远按原始字节存。
  - `utf8`：字节按 UTF-8 解码后注入；上传时解码失败直接报错，提示改用 `base64`。
  - `base64`：注入 `base64(原始字节)` 文本，正好覆盖现在手工 base64 的用法。
- `bytes` 让 `apply`（48 KB 上限）、`pull`（1 MiB 上限）和 `run` 在**下载之前**就能预检，
  也是 `push` 零下载比对的第一道闸。
- `sha256` 是解引用时的完整性校验，也是 `push` 判定「本地值是否等于当前内容」的唯一依据。
- `mode` 是**字符串**（如 `"600"`），不是数字：JSON 数字会丢前导零，且八进制在 JSON 里
  没有合法字面量。非 POSIX 平台忽略该字段。
- `schema` 保持 `1`。没有 `files` 的 store 行为与现状完全一致。

### 5.1 多行值在 `.env` 里的写法（必须定死）

`files` 里的内容常常是多行（PEM 私钥、证书链），而 `.env` 是行式格式。
`pull` 必须输出一种**能被 `push` 无损解析回来**的表示，否则「pull → 改 → push」会破坏引用（§6.4 规则 1 依赖值相同才能保留引用）。

**v1 采用：双引号 + `\n` 转义，强制单行。**

```bash
# 多行文件（encoding: utf8）
DEPLOY_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n"
```

规则：

1. **由文件解析出的值一律用双引号包裹**；内部的 `"` 转义为 `\"`，反斜杠转义为 `\\`。
   普通字面量沿用现有 `renderValue` 的「按需加引号」，避免无意义 diff。
2. 换行写成 `\n`，**不做 CRLF 归一化**：原始字节里的 `\r\n` 写成 `\r\n`，
   纯 `\n` 写成 `\n`（§6.1 要求保留，这里同样不能丢）。
3. **保留尾随换行**。PEM 文件末尾的 `\n` 必须体现出来（见上面示例最后那个 `\n`），
   否则 `push` 比对时永远「值不同」，触发 §6.4 的报错分支。
4. **解析侧保持宽松，不因未知转义报错。** 现有 `unescapeDouble`（`src/utils/envfile.ts`）
   只还原 `\n \r \t \" \\`，其它序列**原样保留**，所以 `PATH="C:\Users\me"` 今天能读。
   改成「非法转义直接报错」会让这类现存 `.env` 直接失败——这是回归，不是改进。

   往返可逆不依赖严格报错：生成侧总是把 `\` 写成 `\\`，读回来必然还原。
   因此不提供 `--strict-escapes`，只有宽松解析一条路径。

**为什么不用单引号 + 真实换行：** 真实换行会让 `.env` 每一行都不像键值对，
普通编辑器的语法高亮、diff 查看、以及很多 dotenv 解析器都会出错；
而 `\n` 转义在各种工具里表现一致。

**`encoding: base64` 的值**天然是单行，不需要转义，直接 `KEY="<base64>"`。

### 5.2 `$` 与反引号（既有 bug，本方案会放大）

现有 `renderValue` 只转义 `\ " \n \r \t`。`NEEDS_QUOTING` 含 `$`，所以 `abc$(cmd)`
**会被加引号**，但双引号内 `$(cmd)` 和 `` `cmd` `` 在 POSIX shell 里照样执行。

以前 `.env` 多是短令牌，命中概率低；现在要写任意文件内容（私钥、证书、含 `$` 的 JSON），
风险显著上升。**必须在 PR3 一并修**：

- 生成侧：`$` → `\$`，`` ` `` → `` \` ``；
- 解析侧：`unescapeDouble` 补 `\$` → `$`、`` \` `` → `` ` ``，**两边严格对称**；
- 补一组老 `.env` 回归：不含 `$` / 反引号的既有文件，往返后逐字节不变。

> 这属于「改变输出格式」的修复：之前写出的 `KEY="abc$d"` 在新版本里会写成
> `KEY="abc\$d"`。两者读回来的值相同，但文件 diff 会显示变化，知道即可。

## 6. 解析规则

### 6.1 语法

```
^\$\{file-([a-z0-9][a-z0-9._-]{0,63})\}$
```

- 整值必须完全等于占位符；`"prefix ${file-x}"` 不解析（保持「值永不展开」）。
- 不做递归：文件内容里即使出现 `${file-y}` 也原样注入。
- 保留尾随换行、CRLF、Unicode；不 trim、不做换行归一化。
- 只有 `files` 里**声明过**的 id 才解析。

### 6.2 未声明引用 → 硬失败

若值形如 `${file-<id>}` 但 `files` 里没有该 id，解析时报错：

```
store "x" 的 DEPLOY_KEY 引用了未声明的文件 "deploy-ke"
（检查拼写，或先执行 initx env file add / file ls）
```

理由：放过它就等于把一个字符串 `${file-deploy-ke}` 当密钥注入，错误发生在业务运行时而不是
部署时，极难排查。宁可 `pull` / `run` 当场失败。

确实需要这个字面量的极端情况 v1 不支持（这种值本身就是引用语法，不该作为真实值）。
以后需要再引入转义（`$${file-…}`），届时要在 `.env` 往返里定义清楚。

### 6.3 解析时机

只在「store → 输出」的边界解析：

| 命令 | 是否解析 | 说明 |
| --- | --- | --- |
| `pull` | 是 | 写进 `.env` 的是真实值 |
| `setup` | 是 | `::add-mask::` 用**解析后**的值 |
| `run` | 是 | 注入真实值；`encoding: base64` 注入 base64 文本 |
| `apply` | 是 | 48 KB 按解析后的字节数检查 |
| `--json` | 是 | 与其他出口一致，避免 CI 里拿到占位符 |
| `push` / `set` | 否 | 见 §6.4 |
| `file add/rm` | 否 | 只做引用和元数据 |

### 6.3.1 占位符与 shell 展开

`${file-<id>}` 的 `$` 只在**被 shell 解析**时才有意义。本方案保证占位符不进入 shell：

- `run` 用 `spawn(command, args, { env, shell: false })` 直接把解析后的值塞进子进程环境，
  不经过任何 shell。见 `src/utils/run-process.ts`。**禁止**改成写临时 `.env` 再 `source`。
- `apply` / `setup` 直接把值写进平台 secret / `GITHUB_ENV`，同样不经 shell。
- `pull` 永远写**真实值**，不写占位符，所以 `pull` 的输出里没有 `${file-…}`。
- 文件内容里的 `$` / 反引号由 §5.2 的转义处理；这跟占位符无关，是 `.env` 输出本身的转义规则。

如果手工把占位符写进 `.env` 再 `source`，会被 shell 展开成空串——这是 shell 的行为，
不是插件在做变量展开；插件自身从不展开任何 `${...}`。

**为什么保留 `${file-…}` 语法**：`@{file-x}` / `[[file-x]]` 能规避展开，但会让 store 里的写法
和文档里的写法分裂。真正的边界是「不把占位符交给 shell」，上面已经做到。

### 6.4 push / set 与引用的交互（最容易出错的地方）

`pull` 写出的 `.env` 里是**明文**。用户改完再 `push`，如果按普通键值处理，就会把整份密钥
重新内联，`files` 变成孤儿，引用彻底消失。

规则：

1. 若 store 里该键当前是引用，且本地值与**当前内容**相同 → 未变更，保留引用。

   **比对全程零下载**，只比本地字节与 `files` 元数据：

   | 步骤 | 判定 |
   | --- | --- |
   | ① 本地值按 `encoding` 还原成字节：`utf8` → `Buffer.from(v, 'utf8')`；`base64` → `Buffer.from(v, 'base64')` | — |
   | ② 长度 vs `files[id].bytes` | 不等 → **不同**（绝大多数情况在此结束） |
   | ③ `sha256(本地字节)` vs `files[id].sha256` | 不等 → **不同**；相等 → **相同**，保留引用 |

   `files[id].sha256` 本来就是「内容哈希」，本地按同一编码还原后算一遍即可比对，
   **这一列的目的就是让比对不需要内容**。下载只发生在 `pull` / `run` / `apply` / `check`
   真正需要字节的时候。
2. 若本地值不同：
   - 默认：**报错**并列出冲突键，要求显式选择：
     - `--update-files`：重新上传本地内容，保留引用（适合「确实换了密钥」）；
     - `--inline`：改为字面量，删除 `files` 条目（适合「本来就不该是文件」）。
   - 不默认选 `--update-files`：本地可能只是缺了末尾换行、CRLF 变了，静默重写等于把密钥写坏。
3. `set <store> KEY=<普通值>` 作用在引用键上 → 等价 `--inline`，原文件成为孤儿，
   `file check` 的「悬空元数据」一项会报出来，手工清理。
4. `push --prune` 删键后，同步清掉不再被任何键引用的 `files` 条目。

## 7. 写入顺序与一致性

`file add` 是两次写（blob + store），没有跨文件原子性：

1. **先写文件，再写 store**。
   - 反过来会留下「store 已引用、文件还不存在」的窗口，其他客户端 `pull` 直接 404。
   - 文件先落地、store 后落地，中途失败的产物是「没人引用的孤儿文件」，无害且可回收。
2. store 写入沿用现有 `version` 条件（GitHub sha / GitLab `last_commit_id`），冲突照旧报错。
3. `file rm` 反向：**先改 store 去掉引用，再删文件**；删失败留孤儿，`check` 能报出来。
4. 幂等：同 id、同 sha256 的文件不重复上传；`add` 可安全重跑。
5. 覆盖：同 id 内容不同，仅当引用它的是**同一个键**时才允许覆盖，打印旧/新 sha 前 8 位与
   字节数；被别的键引用则报错，见 §7.1。
6. 漂移：`file check` 下载并比对 sha256；不一致默认报错（说明文件被手工改过，或写入中断）。

### 7.1 id 推导与撞名

id 规则：小写；非 `[a-z0-9]` 一律转 `-`；合并连续 `-`、去掉首尾 `-`；长度上限 64；
必须以字母或数字开头。例：`IOS_P12` → `ios-p12`，`SA_JSON` → `sa-json`。

`DEPLOY_KEY` 与 `DEPLOY-KEY` 都会得到 `deploy-key`。规则：

1. `--as` 显式指定 id → 以显式值为准；若该 id 已被**别的键**占用，仍然报错。
2. 推导出的 id 已存在：
   - 被**同一个键**引用，且内容相同 → 幂等，跳过；
   - 被**同一个键**引用，但内容不同 → 覆盖（§7 第 5 条）；
   - 被**另一个键**引用 → **报错**，提示 `--as <新id>`。
3. 不自动加后缀，也不提供改名开关：静默改名会让用户以为「还是原来那个文件」，
   而实际引用已经指向新对象。

## 8. 大小与平台限制

必须写进 README，否则会拿它塞几十 MB 的 keystore：

| 位置 | 限制 | 处理 |
| --- | --- | --- |
| 单个资源文件 | **10 MB**（`INITX_ENV_MAX_FILE_BYTES` 可调） | 超过报错，提示用独立仓库或对象存储 |
| GitHub Contents GET | ≤1 MB 才有内联 base64；更大返回 `encoding: "none"` | 用返回的 `sha` 走 Git Blobs API（≤100 MB），不依赖 `download_url` 的跨域重定向 |
| GitLab Files API | 受实例 `client_max_body_size` 等网关配置影响 | 错误映射成「存储拒绝，可能是网关体积限制」，不打印响应体 |
| 环境变量注入 | Linux 单条约 128 KB；Windows 环境块约 32K 字符量级；macOS 受 `ARG_MAX` 总量约束 | > 32 KB 时 `run` 打警告：大文件请用 `file pull` 落盘，把路径传给程序 |
| `pull` 内联上限 | **1 MiB** | 解析后的值超过即**报错**，提示改用 `file pull --to-dir`。否则一个 10 MB 文件会把 `.env` 撑成不可用的大文件 |
| `setup` 环境变量上限 | **32 KB 硬上限** | **超过直接失败，不是警告。** 警告会让一个坏值写进 `GITHUB_ENV`，之后整个 job 的环境块都可能被判超限，症状离原因极远 |
| GitHub Actions secret | 48 KB / 条（已实现） | 按解析后（base64 后）的字节数检查 |
| `GITHUB_ENV` | 无公开明确的字节上限；实践在数百 KB 量级开始不稳定 | 同样按「大文件不走环境变量」处理，不承诺具体数值 |

这些上限对所有值生效，包括没有用引用的普通变量。升级后先检查自己的 store：

```bash
initx env setup <store> --json | jq 'to_entries[] | select(.value|length > 32768) | .key'
```

有超限的键，正好用这次的新功能迁成文件。

**`run` 遇到 `E2BIG` 必须映射成可行动的提示。** `spawn` 失败时的 `E2BIG`
当前只会落到通用的「启动失败」。应在 `runProcess` 的错误分类里单独识别，输出：

```
环境变量总大小超过平台上限（E2BIG）。改用 initx env file pull <store> --to-dir <dir>
落盘后用路径传参，不要把大文件放进环境变量。
```

上表的数字是**预防**，E2BIG 映射是**兜底**，两者都要有。

结论要明确：**文件引用解决的是「store 可读、diff 可读、能落盘」，不是「把大文件塞进环境变量」。**

## 9. 适配器改造

`StorageAdapter` 现在只有字符串 `read` / `write`。文件是字节，且 GitHub 的大文件路径不同，
需要新增两个方法（不改现有签名，避免所有调用点重写）：

```ts
interface StorageAdapter {
  readBytes: (path: string, options?: { maxBytes?: number }) => Promise<{ bytes: Uint8Array, version: string } | null>
  writeBytes: (path: string, bytes: Uint8Array, options: WriteOptions) => Promise<void>
  capabilities: { readBytes: boolean, writeBytes: boolean, [key: string]: boolean }
}
```

- GitHub：≤1 MB 直接解 Contents 的 `content`；>1 MB 用 `sha` 调 `/git/blobs/{sha}`（base64）。
  写一律 Contents PUT（base64）。
- GitLab：读 `GET /repository/files/:path?ref=` 的 base64；写 `encoding: "base64"`。
- `read()` / `write()` 保留给 store JSON，内部可复用新方法。
- 文件路径同样过 `assertSafePath`，id 另有白名单校验（Windows 保留名 `CON`、`NUL` 等一并拒绝）。

## 10. 安全

- 文件内容和 `vars` 一样是**明文进 Git 历史**；引用不提供加密，只是把「大块密文」从 store 里
  挪出来。轮换策略不变。
- `file cat` 默认不输出内容，必须 `--show`；输出前打一行提醒（会被 CI 日志采集）。
- `file pull --to-dir`：POSIX 下按 `mode` 落盘（私钥默认 600），默认不覆盖已存在文件（`--force`），
  写完后提示确认目录在 `.gitignore` 内（只提示，不自动改）。
- 日志不打印内容、完整 sha（只前 8 位）、本地绝对路径。
- `setup` 的 `::add-mask::` 必须使用解析后的值（base64 形态也要 mask）。
- `push --inline` 打印显式警告：正在把文件内容写回 vars。

### 10.1 `file cat` 打印什么（写死，不留歧义）

`cat` 输出的是**注入值**，不是存储字节：

| `encoding` | `cat --show` 输出 | 说明 |
| --- | --- | --- |
| `utf8` | UTF-8 解码后的文本 | 与注入一致 |
| `base64` | **`base64(原始字节)` 文本** | 与注入一致，不是原始字节 |

理由：`cat` 的用途是「看我会被塞进环境变量的到底是什么」。
想拿原始字节用 `file pull --to-dir`，那才是落盘语义。

不加 `--show` 时只打印 `KEY`、`bytes`、`encoding`、`sha256` 前 8 位。

### 10.2 BOM 有两种，处理相反

| 位置 | 处理 | 理由 |
| --- | --- | --- |
| **文件内容里的 BOM** | **保留**（原样存、原样注入） | §6.1 要求「不 trim、不改写」；某些配置文件确实带 BOM，丢掉会改变内容哈希 |
| **`.env` 文件头的 BOM** | **读时 strip** | 否则第一个键名变成 `\uFEFFKEY`，`pull` / `push` 都认不出它，表现为「值丢了」 |

`.env` 头的 BOM 只在读整个文件时处理一次，不能逐行 strip——那会误伤值中间恰好出现的 BOM 字符。
strip 之后 `mergeEnv` 写回的内容不含 BOM，等于一次性的规范化，首次写入会生成 `.bak`；
这是有意的，不保留原 BOM。

## 11. 本次不做的事

本方案只服务一条路径：**本地新增文件引用 → push → CI 消费**。

### 11.1 不做存量迁移（没有 `extract`）

已有 store 里的 base64 变量保持原样，不自动转成文件。需要转的键手工转一次：

```bash
# 1. 把现有值落成临时文件（从 store / .env 里取，别让值进 shell history）
#    解码成文件即可，base64 -d 或 Node 都行
# 2. 上传并保持原来的注入形态（消费方拿到的仍是 base64）
initx env file add <store> KEY --file ./.tmp-key --encoding base64
# 3. 校验引用与哈希，然后清理临时文件
initx env file check <store>
```

`file add` 本身会把 `vars[KEY]` 换成引用，不需要再手工改 store。

不做的理由：迁移是一次性动作；自动判定「哪些值该转」不可靠（`test`、`abcd` 都是合法 base64），
一旦判错，代价是密钥被写坏且不会当场暴露。

### 11.2 不做 `gc`

`file rm` 默认同时删引用和文件，孤儿只在「删除文件失败」或「`set` 内联」时产生。
`file check` 的「孤儿文件 / 悬空元数据」两项能报出来，手工删即可。

判断依据：没有共享文件、没有批量迁移，就没有大规模孤儿来源。
等真出现跨 store 共享需求再补 `gc`，且届时默认 dry-run。

## 12. 测试计划

- 语法：整值匹配、未声明报错、非法 id、大小写、内容不被改写。
- 往返：多行、尾随换行、CRLF、BOM、Unicode 经 `pull → push` 后引用保持。
- **`.env` 序列化（§5.1）**：`"` 与 `\` 转义往返、`\r\n` 不被归一化、PEM 尾随 `\n`
  往返后仍判定「值未变」（否则每次 push 都会误报冲突）。
- **转义宽松性（§5.1 规则 4）**：`PATH="C:\Users\me"` 现状用例保持不变。
- **`$` 与反引号（§5.2）**：含 `$(...)` 与 `` `...` `` 的值经 render → unescape 往返后
  逐字符相同；并断言 render 输出里含 `\$` / `` \` ``。补一组不含这两字符的老文件回归。
- **shell 展开（§6.3.1）**：`run` 链路断言未创建任何 `.env` 临时文件；
  `pull` 输出里不含 `${file-…}`。
- resolver：memo 命中、并发上限、缺失、sha 漂移、超限、非法 UTF-8、`encoding: base64`。
- 适配器契约：`readBytes` / `writeBytes` 两个后端；GitHub 的 `encoding: "none"` → blobs 分支。
- 命令：`add` 幂等、第二步失败留孤儿、`rm` 顺序、`rm` 遇到别的键共用 id 时保留文件、
  `push` 的三种分支、`apply` 48 KB。
- **限额（§8）**：单文件超 10 MB 被拒；`pull` 内联超 1 MiB 报错；
  `setup` 超 32 KB **失败**而非警告；`run` 的 `E2BIG` 映射成 `file pull` 提示。
- **`push` 零下载（§6.4）**：断言 push 全程未发起文件下载请求（`fetch` 未调用），
  含「长度相同但内容不同」这一必须靠本地 sha 才能判出的用例。
- **id 冲突（§7.1）**：`DEPLOY_KEY` 与 `DEPLOY-KEY` 撞名时报错；同键幂等通过。
- **`cat`（§10.1）**：`encoding: base64` 时 `--show` 输出的是 base64 文本而非原始字节。
- **BOM（§10.2）**：文件内容 BOM 保留且不改哈希；`.env` 头 BOM 被 strip，首键可正常识别。
- **`check`（§4.3）**：四个方向各一条用例——缺失、sha 漂移、孤儿文件、悬空元数据。
- 回归：不含 `files` 的 schema 1 store 全部现有测试不变。

## 13. 交付拆分

| PR | 内容 |
| --- | --- |
| 1 | `types.ts` 增加可选 `files` + 引用解析/序列化 + 错误类型（无命令） |
| 2 | 适配器 `readBytes` / `writeBytes` + 契约测试 |
| 3 | resolver + 接入 `pull` / `setup` / `run` / `apply` / `--json`（含 §5.1 序列化、§5.2 转义、§8 限额与 `E2BIG`） |
| 4a | `env file add`（含 §7.1 id 撞名） |
| 4b | `file ls/cat/pull/rm/check` |
| 5 | `push` 引用保护 + README / help / 发布说明 |

> 原 PR3 同时改 4 个出口，review 面太大，仍合成一个 PR，但按「读出口 / 写出口」分两组提交。

**最小可用切片 = PR1 + PR2 + PR3 + PR4a**：能上传文件、`pull` 出真实值、`run` 能注入。

`push` 保护（PR5）建议不要拖太久，它是唯一能防住「`pull` 后误 `push` 把文件内容内联回 `vars`」
的机制。

## 14. 待确认的取舍

以下三项仍未定，但不阻塞实现：

1. 命令名：`env file`（与占位符一致）还是 `env asset`（更强调对象）。**本文按 `file` 写。**
2. `push` 遇到引用内容变化：默认报错 + 显式 `--update-files`（本文推荐），还是默认自动重传。
3. 是否允许跨 store 共享同一个文件 id（v1 不允许，按 store 隔离）。

### 14.1 已定稿的项

实现时不再自由发挥：

| # | 项 | 结论 | 位置 |
| --- | --- | --- | --- |
| 1 | store 版本 | **保持 schema 1**，`files` 是可选字段 | §5 |
| 2 | 文件路径 | 不存 `path`，按 `_files/<store>/<id>` 推导 | §5 |
| 3 | `run` 是否落地临时 `.env` | **否**，直接 `spawn(shell: false)` 注入，禁止改动 | §6.3.1 |
| 4 | 多行值在 `.env` 的写法 | 双引号 + `\n` 转义，保留尾随换行 | §5.1 |
| 5 | 未知转义 | **宽松保留**（现状），不提供严格开关 | §5.1 |
| 6 | `$` 与反引号 | PR3 一并修：生成侧转义、解析侧对称还原 | §5.2 |
| 7 | `pull` 是否写占位符 | **否**，永远写真实值；不提供 `--keep-refs` | §6.3 |
| 8 | `file rm` 的默认行为 | 删引用 + 删文件；`--keep-blob` 才留文件；别的键共用 id 时保留文件 | §4.2 |
| 9 | `file add` 的 id 撞名 | 被**别的键**占用即报错；不提供自动改名 | §7.1 |
| 10 | `push` 的引用比对 | **全程零下载**：本地字节比 `bytes`，再比 `sha256(本地字节)` | §6.4 |
| 11 | `mode` 的类型 | 字符串，如 `"600"` | §5 |
| 12 | `cat --show` 的语义 | 输出**注入值**；`encoding: base64` 时输出 base64 文本 | §10.1 |
| 13 | BOM | 内容里的保留，`.env` 头的 strip | §10.2 |
| 14 | `pull` 内联上限 | 1 MiB，超限报错并提示 `file pull --to-dir` | §8 |
| 15 | `setup` 超限行为 | 32 KB **硬失败**，不是警告 | §8 |
| 16 | `run` 的 `E2BIG` | 单独识别，映射成 `file pull` 提示 | §8 |
| 17 | 存量 base64 迁移 | **不做**，没有 `extract`；手工三步见 §11.1 | §11.1 |
| 18 | 孤儿文件清理 | **不做 `gc`**，`file check` 报出后手工删 | §11.2 |
| 19 | 单 store 文件数 / 总量上限 | **不设**，只保留单文件 10 MB | §8 |