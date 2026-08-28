import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type StartInfoLike = {
  url?: string
  hostname?: string
  port?: number
}

export type FetchHandler = {
  fetch(request: Request): Response | Promise<Response>
  start?(info: StartInfoLike): unknown
  stop?(): unknown
}

export type ServeOptions = {
  port?: number
  hostname?: string
}

export type ServeHandle = {
  url: string
  hostname: string
  port: number
  close(): Promise<void>
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

function toWebStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  const iterator = req[Symbol.asyncIterator]()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next()

      if (done === true) {
        controller.close()

        return
      }

      controller.enqueue(value)
    },

    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}

function drain(res: ServerResponse): Promise<void> {
  return new Promise(resolve => res.once('drain', resolve))
}

function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers()

  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const value = req.rawHeaders[i + 1]

    if (name !== undefined && value !== undefined) headers.append(name, value)
  }

  const method = req.method ?? 'GET'
  const controller = new AbortController()

  req.once('aborted', () => controller.abort())

  if (BODYLESS_METHODS.has(method)) {
    return new Request(new URL(req.url ?? '/', origin), {
      method,
      headers,
      signal: controller.signal,
    })
  }

  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    body: toWebStream(req),
    // Required whenever a streaming body is passed to Request.
    duplex: 'half',
    signal: controller.signal,
  } as RequestInit)
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers = Object.fromEntries(response.headers)
  const cookies = response.headers.getSetCookie()

  res.writeHead(
    response.status,
    cookies.length === 0 ? headers : { ...headers, 'set-cookie': cookies },
  )

  if (response.body === null) {
    res.end()

    return
  }

  const reader = response.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break
      if (!res.write(value)) await drain(res)
    }

    res.end()
  } catch (error) {
    await reader.cancel(error)
    res.destroy(error instanceof Error ? error : undefined)
  }
}

export function serve(handler: FetchHandler, options: ServeOptions = {}): Promise<ServeHandle> {
  const hostname = options.hostname ?? 'localhost'
  const port = options.port ?? 3000

  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? `${hostname}:${port}`}`

    void (async () => {
      try {
        await writeResponse(await handler.fetch(toRequest(req, origin)), res)
      } catch {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })

        res.end('500 Internal Server Error')
      }
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)

    server.listen(port, hostname, () => {
      const address = server.address()
      const boundPort = typeof address === 'object' && address !== null ? address.port : port
      const url = `http://${hostname}:${boundPort}`

      // Awaited by the handler's own fetch(), so requests arriving in this
      // window still wait for plugin startup to finish.
      void handler.start?.({ url, hostname, port: boundPort })

      resolve({
        url,
        hostname,
        port: boundPort,
        async close() {
          await handler.stop?.()

          return new Promise<void>((done, fail) => {
            server.closeAllConnections()
            server.close(error => (error === undefined || error === null ? done() : fail(error)))
          })
        },
      })
    })
  })
}
