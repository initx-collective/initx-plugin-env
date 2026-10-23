import { constants } from 'node:os'
import process from 'node:process'
import spawn from 'cross-spawn'

export interface RunResult {
  code: number
  signal?: NodeJS.Signals
  errorCode?: string
}

export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 1)
}

/** Only the direct child is managed. No shell expression parsing or output buffering. */
export function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    let timer: ReturnType<typeof setTimeout> | undefined
    let forwarded: NodeJS.Signals | undefined
    let finished = false

    const failure = (error: unknown): RunResult => {
      const errorCode = (error as NodeJS.ErrnoException).code
      return { code: errorCode === 'ENOENT' ? 127 : errorCode === 'EACCES' ? 126 : 1, errorCode: errorCode ?? 'UNKNOWN' }
    }

    const finish = (result: RunResult) => {
      if (finished)
        return
      finished = true
      clearTimeout(timer)
      process.removeListener('SIGINT', onInt)
      process.removeListener('SIGTERM', onTerm)
      resolve(result)
    }

    const forward = (signal: NodeJS.Signals) => {
      if (finished || forwarded || child.exitCode !== null || child.signalCode !== null)
        return
      forwarded = signal
      try {
        child.kill(signal)
      }
      catch {
        // Still attempt SIGKILL after the grace period.
      }
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        }
        catch {
          // The process may already have exited, or the OS may deny termination.
        }
        finally {
          // Bound the wait even when the OS can no longer terminate the child.
          child.unref()
          finish({ code: signalExitCode(signal), signal })
        }
      }, 5000)
    }
    function onInt() {
      forward('SIGINT')
    }
    function onTerm() {
      forward('SIGTERM')
    }

    try {
      child = spawn(command, args, { env, stdio: 'inherit', shell: false })
    }
    catch (error) {
      finish(failure(error))
      return
    }

    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    child.once('error', error => finish(failure(error)))
    child.once('close', (code, signal) => {
      const endedBy = forwarded ?? signal ?? undefined
      finish(endedBy ? { code: signalExitCode(endedBy), signal: endedBy } : { code: code ?? 1 })
    })
  })
}

/** Defer re-signalling until initx has returned and persisted its store. */
export function applyRunResult(result: RunResult): void {
  process.exitCode = result.code
  if (result.signal && process.platform !== 'win32') {
    const signal = result.signal
    process.once('beforeExit', () => {
      try {
        process.kill(process.pid, signal)
      }
      catch {
        process.exitCode = result.code
      }
    })
  }
}
