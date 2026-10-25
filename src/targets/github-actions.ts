import type { ResolvedEnvConfig } from '../config'
import process from 'node:process'
import { putSecret } from '../actions-secrets'
import { DEFAULT_API_URLS, validateStorageRepo } from '../storage/path'

/** Source identity never changes the destination (GitHub Actions on api.github.com). */
export function createGitHubActionsTarget(source: ResolvedEnvConfig, explicitToken?: string, env = process.env) {
  const token = explicitToken || env.INITX_ENV_TARGET_TOKEN
    || (source.type === 'github' && source.apiBaseUrl === DEFAULT_API_URLS.github ? source.token : '')
  if (!token)
    throw new Error('GitHub Actions 目标需要独立凭据：--target-token 或 INITX_ENV_TARGET_TOKEN')
  return {
    write(repo: string, name: string, value: string, targetEnv?: string | null) {
      validateStorageRepo('github', repo)
      return putSecret(repo, token, name, value, { env: targetEnv })
    }
  }
}
