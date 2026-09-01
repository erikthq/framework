import { compress, createApp, defineRoute } from '@erikt/framework'
import type { StartInfo } from '@erikt/framework'
import { serve } from '@erikt/framework-deno'
import type { ServeHandle } from '@erikt/framework-deno'

const TEXT = 'text/plain; charset=utf-8'

let handle: ServeHandle | undefined
let started: Partial<StartInfo> = {}

const app = createApp({ banner: false, compress: false, logger: false })
  .plugin({
    name: 'capture-start',
    onStart(info) {
      started = info
    },
  })
  .use('/gzip', compress())
  .get('/', defineRoute(() => 'hello over http'))
  .get(
    '/__start',
    defineRoute(() => ({ url: started.url, hostname: started.hostname, port: started.port })),
  )
  .get(
    '/__close',
    defineRoute(() => {
      setTimeout(() => void handle?.close(), 10)

      return 'closing'
    }),
  )
  .get('/users/:id', defineRoute(c => ({ id: c.params.id })))
  .get('/search', defineRoute(c => c.url.searchParams.get('q') ?? ''))
  .get('/header', defineRoute(c => c.req.headers.get('x-token') ?? 'none'))
  .post('/echo', defineRoute(async c => await c.req.json()))
  .get(
    '/created',
    defineRoute(c => {
      c.header('x-custom', 'yes')
      c.status(201)

      return 'created'
    }),
  )
  .get('/cookies', c => {
    const response = c.body('ok', { type: TEXT })

    response.headers.append('set-cookie', 'a=1')
    response.headers.append('set-cookie', 'b=2')

    return response
  })
  .get('/stream', c =>
    c.body(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()

          controller.enqueue(encoder.encode('one '))
          controller.enqueue(encoder.encode('two '))
          controller.enqueue(encoder.encode('three'))
          controller.close()
        },
      }),
    ),
  )
  .get('/big', c =>
    c.body(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          const chunk = 'x'.repeat(64 * 1024)

          for (let i = 0; i < 16; i++) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
    ),
  )
  .get('/old', c => c.redirect('/new', 301))
  .get('/moved', c => c.redirect('/new'))
  .get('/new', defineRoute(() => 'arrived'))
  .post('/upload', async c => {
    const reader = c.req.body?.getReader()

    if (reader === undefined) return c.body('no body', { status: 400, type: TEXT })

    let bytes = 0

    while (true) {
      const { done, value } = await reader.read()

      if (done) break
      bytes += value.byteLength
    }

    return c.body(JSON.stringify({ bytes }), { type: 'application/json; charset=utf-8' })
  })
  .get('/throw', () => {
    throw new Error('boom')
  })
  .get('/gzip', defineRoute(() => 'compress me '.repeat(500)))

handle = await serve(app, { port: 0 })

console.log(`url=${handle.url}`)
