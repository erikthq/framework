import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compress, createApp } from 'framework'
// The framework enables banner, compress and logger by default. Unit tests opt
// out so each one measures only what it registers itself.
const newApp = () => createApp({ banner: false, compress: false, logger: false })

import { serve } from 'node-adapter'
import type { ServeHandle } from 'node-adapter'

function dechunk(framed: Buffer): Buffer {
  const chunks: Buffer[] = []
  let offset = 0

  while (offset < framed.byteLength) {
    const lineEnd = framed.indexOf('\r\n', offset)

    if (lineEnd === -1) break

    const size = Number.parseInt(framed.subarray(offset, lineEnd).toString('utf8'), 16)

    if (Number.isNaN(size) || size === 0) break

    chunks.push(framed.subarray(lineEnd + 2, lineEnd + 2 + size))
    offset = lineEnd + 2 + size + 2
  }

  return Buffer.concat(chunks)
}

async function withServer(
  app: Parameters<typeof serve>[0],
  run: (server: ServeHandle) => Promise<void>,
): Promise<void> {
  const server = await serve(app, { port: 0 })

  try {
    await run(server)
  } finally {
    await server.close()
  }
}

test('serves a response over http', async () => {
  const app = newApp().get('/', c => c.text('hello over http'))

  await withServer(app, async server => {
    const response = await fetch(server.url)

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'hello over http')
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  })
})

test('binds an ephemeral port and reports it', async () => {
  await withServer(newApp(), async server => {
    assert.ok(server.port > 0)
    assert.equal(server.url, `http://localhost:${server.port}`)
  })
})

test('passes path params through', async () => {
  const app = newApp().get('/users/:id', c => c.json({ id: c.params.id }))

  await withServer(app, async server => {
    assert.deepEqual(await (await fetch(`${server.url}/users/7`)).json(), { id: '7' })
  })
})

test('passes the query string through', async () => {
  const app = newApp().get('/search', c => c.text(c.url.searchParams.get('q') ?? ''))

  await withServer(app, async server => {
    assert.equal(await (await fetch(`${server.url}/search?q=hello`)).text(), 'hello')
  })
})

test('forwards request headers', async () => {
  const app = newApp().get('/', c => c.text(c.req.headers.get('x-token') ?? 'none'))

  await withServer(app, async server => {
    const response = await fetch(server.url, { headers: { 'x-token': 'abc123' } })

    assert.equal(await response.text(), 'abc123')
  })
})

test('reads a request body', async () => {
  const app = newApp().post('/echo', async c => c.json(await c.req.json()))

  await withServer(app, async server => {
    const response = await fetch(`${server.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })

    assert.deepEqual(await response.json(), { hello: 'world' })
  })
})

test('forwards response status and headers', async () => {
  const app = newApp().get('/', c => {
    c.header('x-custom', 'yes')

    return c.text('created', 201)
  })

  await withServer(app, async server => {
    const response = await fetch(server.url)

    assert.equal(response.status, 201)
    assert.equal(response.headers.get('x-custom'), 'yes')
  })
})

test('sends multiple set-cookie headers separately', async () => {
  const app = newApp().get('/', c => {
    const response = c.text('ok')

    response.headers.append('set-cookie', 'a=1')
    response.headers.append('set-cookie', 'b=2')

    return response
  })

  await withServer(app, async server => {
    assert.deepEqual((await fetch(server.url)).headers.getSetCookie(), ['a=1', 'b=2'])
  })
})

test('streams a streamed response body', async () => {
  const app = newApp().get('/stream', c =>
    c.body(
      new ReadableStream({
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

  await withServer(app, async server => {
    assert.equal(await (await fetch(`${server.url}/stream`)).text(), 'one two three')
  })
})

test('serves the 404 from the app', async () => {
  const app = newApp().get('/', c => c.text('root'))

  await withServer(app, async server => {
    assert.equal((await fetch(`${server.url}/missing`)).status, 404)
  })
})

test('a redirect reaches the client', async () => {
  const app = newApp()
    .get('/old', c => c.redirect('/new', 301))
    .get('/new', c => c.text('new'))

  await withServer(app, async server => {
    const response = await fetch(`${server.url}/old`, { redirect: 'manual' })

    assert.equal(response.status, 301)
    assert.equal(response.headers.get('location'), '/new')
  })
})

test('follows a redirect to the new location', async () => {
  const app = newApp()
    .get('/old', c => c.redirect('/new'))
    .get('/new', c => c.text('arrived'))

  await withServer(app, async server => {
    assert.equal(await (await fetch(`${server.url}/old`)).text(), 'arrived')
  })
})

test('a HEAD request returns headers without a body', async () => {
  const app = newApp().get('/', c => c.text('body here'))

  await withServer(app, async server => {
    const response = await fetch(server.url, { method: 'HEAD' })

    assert.equal(response.status, 200)
    assert.equal(await response.text(), '')
  })
})

test('a throwing handler becomes a 500', async () => {
  const app = newApp().get('/', () => {
    throw new Error('boom')
  })

  await withServer(app, async server => {
    assert.equal((await fetch(server.url)).status, 500)
  })
})

test('serves any fetch handler, not just this framework', async () => {
  const handler = { fetch: () => new Response('bare handler') }

  await withServer(handler, async server => {
    assert.equal(await (await fetch(server.url)).text(), 'bare handler')
  })
})

test('close stops accepting connections', async () => {
  const server = await serve(newApp().get('/', c => c.text('up')), { port: 0 })

  assert.equal(await (await fetch(server.url)).text(), 'up')

  await server.close()

  await assert.rejects(() => fetch(server.url))
})

test('reads a streamed request body', async () => {
  const app = newApp().post('/upload', async c => {
    const chunks: Uint8Array[] = []
    const reader = c.req.body?.getReader()

    if (reader === undefined) return c.text('no body', 400)

    while (true) {
      const { done, value } = await reader.read()

      if (done) break
      chunks.push(value)
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)

    return c.json({ chunks: chunks.length, bytes: total })
  })

  await withServer(app, async server => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()

        controller.enqueue(encoder.encode('first chunk '))
        controller.enqueue(encoder.encode('second chunk'))
        controller.close()
      },
    })

    const response = await fetch(`${server.url}/upload`, {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)

    const result = (await response.json()) as { bytes: number }

    assert.equal(result.bytes, 'first chunk second chunk'.length)
  })
})

test('handles a large response body without truncating', async () => {
  const chunk = 'x'.repeat(64 * 1024)
  const app = newApp().get('/big', c =>
    c.body(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()

          for (let i = 0; i < 16; i++) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
    ),
  )

  await withServer(app, async server => {
    const text = await (await fetch(`${server.url}/big`)).text()

    assert.equal(text.length, chunk.length * 16)
  })
})

test('compressed responses survive the http bridge', async () => {
  const big = 'compress me '.repeat(500)
  const app = newApp()
    .use(compress())
    .get('/', c => c.text(big))

  await withServer(app, async server => {
    const response = await fetch(server.url, { headers: { 'accept-encoding': 'gzip' } })

    assert.equal(response.status, 200)
    assert.equal(await response.text(), big)
    assert.match(response.headers.get('vary') ?? '', /Accept-Encoding/)
  })
})

test('the bytes on the wire are gzip when the client asks for it', async () => {
  const big = 'compress me '.repeat(500)
  const app = newApp()
    .use(compress())
    .get('/', c => c.text(big))

  await withServer(app, async server => {
    // Raw socket, because fetch decompresses transparently and hides the framing.
    const { connect } = await import('node:net')
    const url = new URL(server.url)

    const received = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname, () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${url.host}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
        )
      })

      const chunks: Buffer[] = []

      socket.on('data', (chunk: Buffer | string) => {
        if (typeof chunk !== 'string') chunks.push(chunk)
      })
      socket.on('error', reject)
      socket.on('end', () => resolve(Buffer.concat(chunks)))
    })

    const split = received.indexOf('\r\n\r\n')
    const headers = received.subarray(0, split).toString('utf8')
    const framed = received.subarray(split + 4)

    assert.match(headers, /content-encoding: gzip/i)
    assert.match(headers, /transfer-encoding: chunked/i)

    const body = dechunk(framed)

    assert.deepEqual([...body.subarray(0, 2)], [0x1f, 0x8b])
    assert.ok(body.byteLength < big.length / 10)
  })
})
