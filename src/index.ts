import type { InitxContext, InitxMatcherRules } from '@initx-plugin/core'
import type { EnvPluginStore } from './config'
import { InitxPlugin } from '@initx-plugin/core'
import { createCliOptions } from './cli-options'
import { handleEnv } from './commands/env'
import { handleEnvApply } from './commands/env-apply'
import { handleEnvConfig, printConfigHelp } from './commands/env-config'
import { DEFAULT_BRANCH, DEFAULT_PATH } from './config'

const ENV_ACTIONS = ['list', 'ls', 'pull', 'set', 'push', 'setup', 'apply', 'help']
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
      description: 'Env vars from a private repo: env list | pull | set | push | setup | apply',
      // matchinitx 的字符串匹配是**精确相等**，所以这里必须把子命令列全；
      // 带 undefined 是为了让裸 `npx initx env`（什么都不带）也能进来打帮助。
      optional: [undefined, ...ENV_ACTIONS]
    },
    {
      matching: 'env-config',
      description: 'Configure the vault repo (repo / token / branch / path) and check connectivity',
      optional: [undefined, ...CONFIG_ACTIONS]
    }
  ]

  async handle(
    ctx: InitxContext<EnvPluginStore>,
    ...args: (string | undefined)[]
  ): Promise<void> {
    // 裸 `npx initx env` 时 matcher 会塞一个 undefined 进来，先滤掉
    const rest = args.filter((arg): arg is string => typeof arg === 'string')
    const options = createCliOptions(
      ctx.cliOptions as Record<string, unknown>,
      ctx.optionsList
    )
    const store = (ctx.store ?? {}) as EnvPluginStore

    if (ctx.key === 'env-config') {
      if (rest[0] === 'help' || options.boolean('help')) {
        printConfigHelp()
        return
      }

      await handleEnvConfig(store, rest, options)
      return
    }

    if (!rest.length || rest[0] === 'help' || options.boolean('help')) {
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
  // eslint-disable-next-line no-console
  console.log(`
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
                              --env <环境名>     写环境级 secret
                              --only A,B         只写这几个
                              --dry-run          只列出将写入的名字
                              --skip-invalid     跳过名字不合法的变量（默认中止）

  配置 vault 仓库用：npx initx env-config --help

示例：
  npx initx env-config set repo imba97/env-vault
  npx initx env set mail-peon-publish EXTENSION_ID=abc CHROME_REFRESH_TOKEN=1//0g...
  npx initx env pull mail-peon-publish
  npx initx env setup mail-peon-publish --token "$GITHUB_TOKEN"
  npx initx env apply mail-peon-publish --repo mail-peon/mail-peon
`)
}
