import type { InitxContext, InitxMatcherRules } from '@initx-plugin/core'
import type { EnvPluginStore } from './config'
import { InitxPlugin } from '@initx-plugin/core'
import { logger } from '@initx-plugin/utils'
import { createCliOptions } from './cli-options'
import { handleEnv } from './commands/env'
import { handleEnvApply } from './commands/env-apply'
import { handleEnvConfig, printConfigHelp } from './commands/env-config'
import { handleEnvRun } from './commands/env-run'
import { DEFAULT_BRANCH, DEFAULT_PATH } from './config'
import { reportCommandError } from './utils/terminal'

const ENV_ACTIONS = ['list', 'ls', 'pull', 'set', 'push', 'setup', 'apply', 'run', 'help']
const CONFIG_ACTIONS = ['setup', 'set', 'get', 'list', 'ls', 'rm', 'remove', 'status', 'help']

export default class EnvPlugin extends InitxPlugin<EnvPluginStore> {
  /**
   * 插件自己的配置（vault 仓库地址 + token）。
   * initx 会把它存到 `~/.initx/stores/@initx-plugin/env/store.json`，退出时自动落盘。
   */
  defaultStore: EnvPluginStore = {
    branch: DEFAULT_BRANCH,
    path: DEFAULT_PATH
  }

  rules: InitxMatcherRules = [
    {
      matching: 'env',
      description: 'Env vars from a private repo: env list | pull | set | push | setup | apply | run',
      // matchinitx 的字符串匹配是**精确相等**，所以这里必须把子命令列全；
      // 带 undefined 是为了让裸 `npx initx env`（什么都不带）也能进来打帮助。
      optional: [undefined, ...ENV_ACTIONS]
    },
    {
      matching: 'env-config',
      description: 'Configure GitHub/GitLab vault storage and check connectivity',
      optional: [undefined, ...CONFIG_ACTIONS]
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
    // 裸 `npx initx env` 时 matcher 会塞一个 undefined 进来，先滤掉
    const rest = args.filter((arg): arg is string => typeof arg === 'string')
    const options = createCliOptions(
      ctx.cliOptions as Record<string, unknown>,
      ctx.optionsList
    )
    // Local stub installs can load a different utils instance from the CLI.
    logger.setLevel(options.boolean('debug') || options.boolean('d') ? 'debug' : 'info')
    const store = (ctx.store ?? {}) as EnvPluginStore

    if (ctx.key === 'env-config') {
      if (rest[0] === 'help' || options.boolean('help')) {
        printConfigHelp()
        return
      }

      await handleEnvConfig(store, rest, options)
      return
    }

    // Help is read only from parsed prefix options, never from the raw -- tail.
    if (rest[0] === 'run' && !options.boolean('help') && !options.boolean('h')) {
      await handleEnvRun({ store, options }, rest.slice(1))
      return
    }

    if (!rest.length || rest[0] === 'help' || options.boolean('help') || options.boolean('h')) {
      printEnvHelp()
      return
    }

    const [action, ...params] = rest

    if (action === 'apply') {
      await handleEnvApply({ store, options }, params)
      return
    }

    await handleEnv({ store, options }, [action, ...params])
  }
}

function printEnvHelp(): void {
  logger.info(`
用法：npx initx env <命令>

  list                        列出 vault 仓库里所有 store
  pull [store]                拉取到本地 .env（不写名字就列出来选）
                              --to .env.local  指定目标文件（可逗号分隔多个）
                              --dry-run        只看会改哪些键，不写文件
  set <store> KEY=value ...   直接往仓库里的 store 写变量（store 名就是文件名）
  push <store>                从本地 .env 反向更新 store
                              --from .env.local  指定来源文件（默认 .env.local → .env）
                              --prune            删掉仓库里本地没有的键
                              --force            远端被改过时强制覆盖
  setup [store]               把 store 注入**本次**运行的环境：
                              GitHub Actions 里写 $GITHUB_ENV（后续 step 可见）并自动脱敏
                              本地则打到 stdout（--stdout 强制；--json 输出 JSON）
  apply <store> --repo o/r    把 store 写进某个仓库的 Actions secrets
                              --target-token <pat>  独立 GitHub 目标凭据
                              --env <环境名>     写环境级 secret
                              --only A,B         只写这几个
                              --dry-run          只列出将写入的名字
                              --skip-invalid     跳过名字不合法的变量（默认中止）
  run <store> -- cmd [args]   直接注入子进程，继承 stdio / cwd，传递退出状态
                              --token <pat>      临时凭据（CI 推荐 INITX_ENV_TOKEN）

  全部存储命令支持 --config <file>（相对调用者 cwd；默认只读 cwd 的 .initx-env.json）。
  run 的 --config / --token 放在 -- 前；之后的全部参数原样透传子进程。
  支持 GitHub / GitLab vault；apply 的 --repo 始终是 GitHub Actions 目标。
  跨平台 apply 必须设置 --target-token 或 INITX_ENV_TARGET_TOKEN。

  配置 vault 仓库用：npx initx env-config --help

示例：
  npx initx env-config set repo imba97/env-vault
  npx initx env set mail-peon-publish EXTENSION_ID=abc CHROME_REFRESH_TOKEN=1//0g...
  npx initx env pull mail-peon-publish
  npx initx env setup mail-peon-publish --token "$GITHUB_TOKEN"
  npx initx env apply mail-peon-publish --repo mail-peon/mail-peon
`)
}
