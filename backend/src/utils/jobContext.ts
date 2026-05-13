import { AsyncLocalStorage } from 'node:async_hooks'

const jobIdContext = new AsyncLocalStorage<string>()

export function withJobContext<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  return jobIdContext.run(jobId, fn)
}

export function getCurrentJobId(): string | undefined {
  return jobIdContext.getStore()
}

export function jobLog(message: string): void {
  const jobId = jobIdContext.getStore()
  if (jobId) {
    console.log(`[${jobId}] ${message}`)
  } else {
    console.log(message)
  }
}
