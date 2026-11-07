import type { InitxContext, InitxMatcherRules } from '@initx-plugin/core'
import type { EnvPluginStore } from './config'
import { InitxPlugin } from '@initx-plugin/core'
import { logger } from '@initx-plugin/utils'
import { createCliOptions } from './cli-options'
import { handleEnv } from './commands/env'
import { handleEnvApply } from './commands/env-apply'
import { handleEnvFile } from './commands/env-file'
import { handleProfile } from './commands/env-profile'
import { handleEnvRun } from './commands/env-run'
import { migrateLegacyStore } from './store-migrate'
import { reportCommandError } from './utils/terminal'

const ENV_ACTIONS = ['list', 'ls', 'pull', 'set', 'unset', 'push', 'rm', 'remove', 'delete', 'setup', 'apply', 'run', 'file', 'profile', 'profiles', 'help']

export default class EnvPlugin extends InitxPlugin<EnvPluginStore> {
  /**
   * 插件自己的配置。
   *
   * initx 会把内存里的 store 在退出时落盘，所以迁移直接改对象即可。
   * 这里刻意不预置任何定位字段——唯一真相是 `profiles`。
   */
  defaultStore: EnvPluginStore = {}

  rules: InitxMatcherRules = [
    {
      matching: 'env',
      description: 'Env vars from private vaults: env list | pull | set | unset | push | rm | run | profile',
      // matchinitx 的字符串匹配是**精确相等**，所以子命令必须列全；
      // 带 undefined 是为了让裸 `npx initx env` 也能进来打帮助。
      optional: [undefined, ...ENV_ACTIONS]
    }
  ]

  async handle(
    ctx: InitxContext<EnvPluginStore>,
    ...args: (string | undefined)[]
  ): Promise<void> {
    try {
      await this.dispatch(ctx, ...args)
    }
    catch (error) {
      reportCommandError(error)
    }
  }

  private async dispatch(
    ctx: InitxContext<EnvPluginStore>,
    ...args: (string | undefined)[]
  ): Promise<void> {
    const rest = args.filter((arg): arg is string => typeof arg === 'string')
    const options = createCliOptions(
      ctx.cliOptions as Record<string, unknown>,
      ctx.optionsList
    )
    logger.setLevel(options.boolean('debug') || options.boolean('d') ? 'debug' : 'info')

    const store = (ctx.store ?? {}) as EnvPluginStore

    // 迁移在任何命令之前，且只会在旧配置存在时动一次。
    const migration = migrateLegacyStore(store)
    if (migration.changed) {
      logger.warn(`检测到旧配置，已迁移到 profile 模式：${migration.created.map(name => `"${name}"`).join('、') || '（无新建）'}`)
      if (migration.removed.length)
        logger.info(`  已清除旧字段：${migration.removed.join('、')}`)
    }

    // Help 只认前缀参数，不认 `--` 之后的透传。
    if (rest[0] === 'run' && !options.boolean('help') && !options.boolean('h')) {
      await handleEnvRun({ store, options }, rest.slice(1))
      return
    }

    if (!rest.length || rest[0] === 'help' || options.boolean('help') || options.boolean('h')) {
      printEnvHelp()
      return
    }

    const [action, ...params] = rest

    if (action === 'profile') {
      const [sub, ...profileArgs] = params
      if (!sub || sub === 'help')
        printProfileHelp()
      else
        await handleProfile({ store, options }, sub, profileArgs)
      return
    }

    // 顶层别名：`env profiles` 直接列出本机 profile，省掉一层 `profile`。
    if (action === 'profiles') {
      await handleProfile({ store, options }, 'profiles', params)
      return
    }

    if (action === 'apply') {
      await handleEnvApply({ store, options }, params)
      return
    }

    if (action === 'file') {
      await handleEnvFile({ store, options }, params)
      return
    }

    await handleEnv({ store, options }, [action, ...params])
  }
}

function printEnvHelp(): void {
  logger.info(`
用法：npx initx env <命令>

  list                        列出当前 profile 下 vault 里的所有 store
  pull [store]                拉取到本地 .env（不写名字就列出来选）
                              --to .env.local  指定目标文件（可逗号分隔多个）
                              --dry-run        只看会改哪些键，不写文件
  set <store> KEY=value ...   直接往仓库里的 store 写变量（store 名就是目录名）
  unset <store> KEY [KEY...]  删除变量；值是文件引用时，连 _files 下对应文件一起删
                              删光所有变量时，store 本身也一并删除
  push <store>                从本地 .env 反向更新 store
                              --from .env.local  指定来源文件（默认 .env.local → .env）
                              --prune            删掉仓库里本地没有的键
                              --force            远端被改过时强制覆盖
                              --update-files     引用键内容变化时重新上传，保留引用
                              --inline           引用键改成普通值，删除文件条目
  rm <store>                  删除整个 store（store 名就是目录名）
                              --dry-run          只报告，不删除
                              --keep-files       保留 _files 下的文件对象
  setup [store]               把 store 注入**本次**运行的环境（GitHub Actions 写 GITHUB_ENV；
                              本地打到 stdout，可加 --stdout / --json）
  apply <store> --repo o/r    把 store 写进某个仓库的 Actions secrets
  file add <store> KEY --file <path>   上传文件并把变量改成文件引用
  file ls / cat / pull / rm / check    文件引用的查看、落盘、删除与校验
  run <store> -- cmd [args]   直接注入子进程，继承 stdio / cwd，传递退出状态

profile 管理：
  profile setup [name]        新建或覆盖一个 vault profile（最后一步才问名字）
  profile edit [name]         交互式修改 profile，回车即保持原值
  profile use [name]          设置默认 profile
  profile profiles            列出本机所有 profile（* 为默认）
  profile rm-profile <name>   删除 profile（删默认需 --force）
  profile status [--offline]  显示当前项目实际生效的 profile 与连通性

任何一个命令都可以加 --profile <名字> 临时指定另一套 vault。
项目里的 .initx-env.json 只写 type/apiBaseUrl/repo 等定位字段，
插件会据此自动挑选匹配的 profile 并取用它的 token。

示例：
  npx initx env profile setup
  npx initx env profile use acewill
  npx initx env profile profiles
  npx initx env set mail-peon-publish EXTENSION_ID=abc
  npx initx env run acewill-npm -- pnpm publish -r
`)
}

function printProfileHelp(): void {
  logger.info(`
用法：npx initx env profile <命令>

  setup [name]        新建 profile；同名时询问是否覆盖，覆盖不再问名字
  edit [name]         交互式修改；除 token 外直接回车即保持原值
  use [name]          设为默认 profile（不带名字则列出让你选）
  profiles            列出所有 profile（* 标记默认，← 标记当前项目生效的）
  rm-profile <name>   删除 profile；删默认需 --force，最后一个不能删
  status              显示当前项目生效的 profile、字段来源与连通性

env profiles 是 env profile profiles 的简写，两者等价。

profile 是一套自包含的 vault 连接：type / apiBaseUrl / repo / branch / path / token。
本机可以有多套，项目通过 .initx-env.json 的定位字段自动匹配。

CI 等无人值守环境不需要在本机建 profile：.initx-env.json 里写全 storage 即可，
token 由 INITX_ENV_TOKEN 提供，此时生效的名字显示为 (project)。
`)
}
