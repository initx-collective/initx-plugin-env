/* eslint-disable unused-imports/no-unused-vars -- Runtime JS fixture; TS6 ESLint scope analysis misclassifies these value references. */
import { appendFileSync } from 'node:fs'
import process from 'node:process'

// The test compiles the executor separately so this host can exercise real signals
// without terminating the Vitest process or involving initx's plugin discovery.
const { applyRunResult, runProcess } = await import(process.env.INITX_TEST_EXECUTOR)
const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))
// Windows kill(SIGINT/TERM) force-terminates a process instead of delivering a
// catchable POSIX signal. Drive the parent's signal event over IPC on that OS.
process.on('message', (signal) => {
  if (signal === 'SIGINT' || signal === 'SIGTERM')
    process.emit(signal)
})
const result = await runProcess(process.argv[2], process.argv.slice(3), process.env)
appendFileSync(process.env.INITX_TEST_EVENTS, `${JSON.stringify({ result, before, after: ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)) })}\n`)
applyRunResult(result)
if (process.connected)
  process.disconnect()
