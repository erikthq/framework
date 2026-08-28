import { serve } from 'deno-adapter'
import type { ServeHandle } from 'deno-adapter'

let handle: ServeHandle | undefined

const handler = {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url)

    if (pathname === '/throw') throw new Error('boom')

    if (pathname === '/__close') {
      setTimeout(() => void handle?.close(), 10)

      return new Response('closing')
    }

    return new Response('bare handler')
  },
}

handle = await serve(handler, { port: 0 })

console.log(`url=${handle.url}`)
