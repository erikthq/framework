import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The harness is still node --test: these tests drive a real Deno process the
// same way the gzip test drives a real socket. Skipped rather than failed where
// Deno is not installed.
export const denoInstalled = spawnSync('deno', ['--version']).error === undefined

const HERE = import.meta.dirname
const TESTS = fileURLToPath(new URL('../', import.meta.url))

export type DenoServer = {
  url: string
  kill(): void
}

function collect(process: ChildProcess): () => string {
  const chunks: string[] = []

  process.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))

  return () => chunks.join('')
}

export function startDenoServer(script: string): Promise<DenoServer> {
  const child = spawn('deno', ['run', '--allow-net', script], { cwd: HERE })
  const stderr = collect(child)

  return new Promise((resolve, reject) => {
    let out = ''

    const fail = (reason: string) => reject(new Error(`${reason}\n${stderr()}`))

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')

      const url = /^url=(\S+)$/m.exec(out)?.[1]

      if (url !== undefined) resolve({ url, kill: () => void child.kill() })
    })

    child.on('error', error => fail(error.message))
    child.on('exit', code => fail(`${script} exited with ${String(code)} before listening`))
  })
}

export function runDenoReport(script: string): Promise<unknown> {
  // Run from the tests root, so the report's relative-path store resolves
  // against a working directory it can predict.
  const child = spawn(
    'deno',
    ['run', '--allow-read', `--allow-write=${HERE}`, `framework-deno/${script}`],
    { cwd: TESTS },
  )
  const stderr = collect(child)

  return new Promise((resolve, reject) => {
    let out = ''

    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))

    child.on('error', reject)
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`${script} exited with ${String(code)}\n${stderr()}`))

        return
      }

      resolve(JSON.parse(out))
    })
  })
}
