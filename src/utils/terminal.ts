import process from 'node:process'
import { logger, useColors } from '@initx-plugin/utils'

type Tone = 'blue' | 'green' | 'yellow' | 'red' | 'gray'

/** Keep redirected output plain; the SDK's builders do not detect terminal support. */
export function colorText(text: string, tone: Tone, stream: 'stdout' | 'stderr' = 'stdout'): string {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0')
    return text
  if (!process[stream].isTTY && !process.env.FORCE_COLOR)
    return text
  return useColors(text)[tone]().toString()
}

/** Catch at the plugin boundary so Node never prints the minified source or stack. */
export function reportCommandError(error: unknown): void {
  const message = error instanceof Error && error.message ? error.message : '命令执行失败'
  logger.error(colorText(message, 'red'))
  process.exitCode = 1
}
