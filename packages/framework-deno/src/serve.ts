import type { FetchHandler, ServeHandle, ServeOptions } from '@erikt/framework'

type DenoServer = {
  addr: { hostname: string; port: number }
  shutdown(): Promise<void>
}

declare const Deno: {
  serve(
    options: {
      port: number
      hostname: string
      onListen: () => void
      onError: (error: unknown) => Response
    },
    handler: (request: Request) => Response | Promise<Response>,
  ): DenoServer
}

function internalError(): Response {
  return new Response('500 Internal Server Error', {
    status: 500,
    headers: { 'content-type': 'text/plain' },
  })
}

export async function serve(
  handler: FetchHandler,
  options: ServeOptions = {},
): Promise<ServeHandle> {
  const hostname = options.hostname ?? 'localhost'

  const server = Deno.serve(
    {
      port: options.port ?? 3000,
      hostname,
      // Deno announces the port itself unless this is supplied, and reports the
      // throw to stderr unless onError is.
      onListen: () => {},
      onError: internalError,
    },
    request => handler.fetch(request),
  )

  const port = server.addr.port
  const url = `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`

  // Awaited by the handler's own fetch(), so requests arriving in this window
  // still wait for plugin startup to finish.
  void handler.start?.({ url, hostname, port })

  return {
    url,
    hostname,
    port,

    async close() {
      await handler.stop?.()
      await server.shutdown()
    },
  }
}
