import { logger } from '@initx-plugin/utils'
import { colorText } from '../utils/terminal'

export type GitLabOperation = 'project' | 'commit' | 'tree' | 'file-read' | 'file-create' | 'file-update' | 'file-delete' | 'branch' | 'protection'

interface Diagnostic {
  operation: GitLabOperation
  event: 'empty-repository' | 'write-result' | 'request-failed' | 'network-error' | 'permissions' | 'unavailable'
  status?: number
  emptyRepo?: boolean
  archived?: boolean
  accessLevel?: number
  protected?: boolean
  canPush?: boolean
  allowedPushLevels?: number[]
}

/** Only call with selected booleans/numbers and fixed labels, never raw API data. */
export function storageDebug(enabled: boolean, diagnostic: Diagnostic): void {
  if (!enabled)
    return
  logger.debug(colorText(`GitLab ${JSON.stringify(diagnostic)}`, 'gray'))
}

export function accessLevel(value: unknown): number | undefined {
  return [0, 5, 10, 20, 30, 40, 50].includes(value as number) ? value as number : undefined
}
