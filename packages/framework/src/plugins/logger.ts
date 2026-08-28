import type { Plugin } from '../plugin.ts'

export type LoggerOptions = {
  header?: string | false
  log?: (message: string) => void
}

const DEFAULT_HEADER = 'x-response-time'

const STARTED = 'logger:started'

export function logger(options: LoggerOptions = {}): Plugin {
  const header = options.header === undefined ? DEFAULT_HEADER : options.header
  const write = options.log ?? ((message: string) => console.log(message))

  return {
    name: 'logger',

    onRequest(c) {
      c.set(STARTED, performance.now())
    },

    onResponse(c, response) {
      const started = c.get(STARTED)

      if (started === undefined) return

      const elapsed = `${(performance.now() - started).toFixed(1)}ms`

      write(`${c.req.method} ${c.url.pathname} → ${String(response.status)} (${elapsed})`)

      if (header === false) return

      // Copied rather than set in place: a handler is free to return a response
      // whose headers are immutable, such as one straight from fetch().
      const headers = new Headers(response.headers)

      headers.set(header, elapsed)

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    },
  }
}
