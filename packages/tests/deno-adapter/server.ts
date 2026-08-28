import { compress, createApp } from 'framework'
import type { StartInfo } from 'framework'
import { serve } from 'deno-adapter'
import type { ServeHandle } from 'deno-adapter'

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
  .get('/', c => c.text('hello over http'))
  .get('/__start', c =>
    c.json({ url: started.url, hostname: started.hostname, port: started.port }),
  )
  .get('/__close', c => {
    setTimeout(() => void handle?.close(), 10)

    return c.text('closing')
  })
  .get('/users/:id', c => c.json({ id: c.params.id }))
  .get('/search', c => c.text(c.url.searchParams.get('q') ?? ''))
  .get('/header', c => c.text(c.req.headers.get('x-token') ?? 'none'))
  .post('/echo', async c => c.json(await c.req.json()))
  .get('/created', c => {
    c.header('x-custom', 'yes')

    return c.text('created', 201)
  })
  .get('/cookies', c => {
    const response = c.text('ok')

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
  .get('/new', c => c.text('arrived'))
  .post('/upload', async c => {
    const reader = c.req.body?.getReader()

    if (reader === undefined) return c.text('no body', 400)

    let bytes = 0

    while (true) {
      const { done, value } = await reader.read()

      if (done) break
      bytes += value.byteLength
    }

    return c.json({ bytes })
  })
  .get('/throw', () => {
    throw new Error('boom')
  })
  .get('/gzip', c => c.text('compress me '.repeat(500)))

handle = await serve(app, { port: 0 })

console.log(`url=${handle.url}`)
