import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'

import { denoInstalled, startDenoServer } from './deno.ts'
import type { DenoServer } from './deno.ts'

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

// The script closes its own server a tick after answering, so the first attempt
// may still land on the connection that carried the request.
async function untilRefused(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await fetch(url)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const skip = denoInstalled ? false : 'deno is not installed'

let server: DenoServer

before(async () => {
  if (denoInstalled) server = await startDenoServer('server.ts')
})

after(() => server?.kill())

test('serves a response over http', { skip }, async () => {
  const response = await fetch(server.url)

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'hello over http')
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
})

test('binds an ephemeral port and reports it', { skip }, () => {
  const port = Number(new URL(server.url).port)

  assert.ok(port > 0)
  assert.equal(server.url, `http://localhost:${port}`)
})

test('reports the bound address to the handler it started', { skip }, async () => {
  const started = await (await fetch(`${server.url}/__start`)).json()

  assert.deepEqual(started, {
    url: server.url,
    hostname: 'localhost',
    port: Number(new URL(server.url).port),
  })
})

test('passes path params through', { skip }, async () => {
  assert.deepEqual(await (await fetch(`${server.url}/users/7`)).json(), { id: '7' })
})

test('passes the query string through', { skip }, async () => {
  assert.equal(await (await fetch(`${server.url}/search?q=hello`)).text(), 'hello')
})

test('forwards request headers', { skip }, async () => {
  const response = await fetch(`${server.url}/header`, { headers: { 'x-token': 'abc123' } })

  assert.equal(await response.text(), 'abc123')
})

test('reads a request body', { skip }, async () => {
  const response = await fetch(`${server.url}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  })

  assert.deepEqual(await response.json(), { hello: 'world' })
})

test('forwards response status and headers', { skip }, async () => {
  const response = await fetch(`${server.url}/created`)

  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-custom'), 'yes')
})

test('sends multiple set-cookie headers separately', { skip }, async () => {
  const response = await fetch(`${server.url}/cookies`)

  assert.deepEqual(response.headers.getSetCookie(), ['a=1', 'b=2'])
})

test('streams a streamed response body', { skip }, async () => {
  assert.equal(await (await fetch(`${server.url}/stream`)).text(), 'one two three')
})

test('serves the 404 from the app', { skip }, async () => {
  assert.equal((await fetch(`${server.url}/missing`)).status, 404)
})

test('a redirect reaches the client', { skip }, async () => {
  const response = await fetch(`${server.url}/old`, { redirect: 'manual' })

  assert.equal(response.status, 301)
  assert.equal(response.headers.get('location'), '/new')
})

test('follows a redirect to the new location', { skip }, async () => {
  assert.equal(await (await fetch(`${server.url}/moved`)).text(), 'arrived')
})

test('a HEAD request returns headers without a body', { skip }, async () => {
  const response = await fetch(server.url, { method: 'HEAD' })

  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
})

test('a throwing handler becomes a 500', { skip }, async () => {
  assert.equal((await fetch(`${server.url}/throw`)).status, 500)
})

test('reads a streamed request body', { skip }, async () => {
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

  assert.deepEqual(await response.json(), { bytes: 'first chunk second chunk'.length })
})

test('handles a large response body without truncating', { skip }, async () => {
  const text = await (await fetch(`${server.url}/big`)).text()

  assert.equal(text.length, 64 * 1024 * 16)
})

test('compressed responses survive the http bridge', { skip }, async () => {
  const response = await fetch(`${server.url}/gzip`, { headers: { 'accept-encoding': 'gzip' } })

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'compress me '.repeat(500))
  assert.match(response.headers.get('vary') ?? '', /Accept-Encoding/)
})

test('the bytes on the wire are gzip when the client asks for it', { skip }, async () => {
  // Raw socket, because fetch decompresses transparently and hides the framing.
  const { connect } = await import('node:net')
  const url = new URL(server.url)

  const received = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET /gzip HTTP/1.1\r\nHost: ${url.host}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
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
  const body = dechunk(received.subarray(split + 4))

  assert.match(headers, /content-encoding: gzip/i)
  assert.match(headers, /transfer-encoding: chunked/i)
  assert.deepEqual([...body.subarray(0, 2)], [0x1f, 0x8b])
  assert.ok(body.byteLength < 'compress me '.repeat(500).length / 10)
})

test('serves any fetch handler, not just this framework', { skip }, async () => {
  const bare = await startDenoServer('bare.ts')

  try {
    assert.equal(await (await fetch(bare.url)).text(), 'bare handler')
    assert.equal((await fetch(`${bare.url}/throw`)).status, 500)
  } finally {
    bare.kill()
  }
})

test('close stops accepting connections', { skip }, async () => {
  const bare = await startDenoServer('bare.ts')

  try {
    assert.equal(await (await fetch(bare.url)).text(), 'bare handler')
    assert.equal(await (await fetch(`${bare.url}/__close`)).text(), 'closing')
    await assert.rejects(() => untilRefused(bare.url))
  } finally {
    bare.kill()
  }
})
