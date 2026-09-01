import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compress, createApp, defineRoute } from '@erikt/framework'

// The framework enables banner, compress and logger by default. Unit tests opt
// out so each one measures only what it registers itself.
const newApp = () => createApp({ banner: false, compress: false, logger: false })

// Named only where the handler builds its own Response to carry a header the
// test is about; a route says its type by what it returns.
const TEXT = 'text/plain; charset=utf-8'

const BIG = 'hello world '.repeat(500)

const get = (headers: Record<string, string> = {}, path = '/') =>
  new Request(`http://localhost${path}`, { headers })

async function inflate(response: Response, format: 'gzip' | 'deflate'): Promise<string> {
  const body = response.body

  if (body === null) throw new Error('response has no body')

  return new Response(body.pipeThrough(new DecompressionStream(format))).text()
}

test('compresses a text response with gzip', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.equal(await inflate(response, 'gzip'), BIG)
})

test('the compressed body is actually smaller', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const compressed = await (await app.fetch(get({ 'accept-encoding': 'gzip' }))).arrayBuffer()

  assert.ok(compressed.byteLength < BIG.length / 10)
})

test('uses deflate when that is all the client accepts', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(get({ 'accept-encoding': 'deflate' }))

  assert.equal(response.headers.get('content-encoding'), 'deflate')
  assert.equal(await inflate(response, 'deflate'), BIG)
})

test('prefers gzip when the client accepts both', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(get({ 'accept-encoding': 'deflate, gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'gzip')
})

test('honours the encoding preference order given in options', async () => {
  const app = newApp()
    .use(compress({ encodings: ['deflate', 'gzip'] }))
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(get({ 'accept-encoding': 'deflate, gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'deflate')
})

test('respects q-values when choosing an encoding', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip;q=0.1, deflate;q=0.9' }))

  assert.equal(response.headers.get('content-encoding'), 'deflate')
})

test('treats q=0 as a refusal', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip;q=0, deflate;q=0' }))

  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(await response.text(), BIG)
})

test('matches a wildcard accept-encoding', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(get({ 'accept-encoding': '*' }))

  assert.equal(response.headers.get('content-encoding'), 'gzip')
})

test('does not compress when the client sends no accept-encoding', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(get())

  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(await response.text(), BIG)
})

test('skips bodies below the threshold', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => 'tiny'))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(await response.text(), 'tiny')
})

test('compresses a small body when the threshold is lowered', async () => {
  const app = newApp()
    .use(compress({ threshold: 0 }))
    .get('/', defineRoute(() => 'tiny'))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.equal(await inflate(response, 'gzip'), 'tiny')
})

test('compresses a streamed body of unknown length', async () => {
  const app = newApp()
    .use(compress())
    .get('/', c =>
      c.body(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(BIG))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/plain' } },
      ),
    )

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.equal(await inflate(response, 'gzip'), BIG)
})

test('compresses json', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => ({ items: Array.from({ length: 500 }, (_, i) => i) })))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'gzip')

  const parsed = JSON.parse(await inflate(response, 'gzip')) as { items: number[] }

  assert.equal(parsed.items.length, 500)
})

test('leaves a non-compressible content type alone', async () => {
  const app = newApp()
    .use(compress())
    .get('/', c => c.body(BIG, { headers: { 'content-type': 'image/png' } }))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), null)
})

test('a custom types pattern overrides the default list', async () => {
  const app = newApp()
    .use(compress({ types: /^image\/png$/ }))
    .get('/', c => c.body(BIG, { headers: { 'content-type': 'image/png' } }))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'gzip')
})

test('a custom filter decides instead of the content type', async () => {
  const app = newApp()
    .use(compress({ filter: c => c.url.pathname.startsWith('/yes') }))
    .get('/yes', c => c.body(BIG, { headers: { 'content-type': 'image/png' } }))
    .get('/no', defineRoute(() => BIG))

  assert.equal(
    (await app.fetch(get({ 'accept-encoding': 'gzip' }, '/yes'))).headers.get('content-encoding'),
    'gzip',
  )
  assert.equal(
    (await app.fetch(get({ 'accept-encoding': 'gzip' }, '/no'))).headers.get('content-encoding'),
    null,
  )
})

test('does not double-compress an already encoded response', async () => {
  const app = newApp()
    .use(compress())
    .get('/', c => c.body(BIG, { headers: { 'content-type': 'text/plain', 'content-encoding': 'br' } }))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'br')
})

test('respects cache-control: no-transform', async () => {
  const app = newApp()
    .use(compress())
    .get('/', c => c.body(BIG, { type: TEXT, headers: { 'cache-control': 'public, no-transform' } }))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), null)
})

test('leaves a 304 alone', async () => {
  const app = newApp()
    .use(compress({ threshold: 0 }))
    .get('/', c => c.body(null, 304))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.status, 304)
  assert.equal(response.headers.get('content-encoding'), null)
})

test('sets Vary: Accept-Encoding on compressible responses', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const compressed = await app.fetch(get({ 'accept-encoding': 'gzip' }))
  const plain = await app.fetch(get())

  assert.equal(compressed.headers.get('vary'), 'Accept-Encoding')
  assert.equal(plain.headers.get('vary'), 'Accept-Encoding')
})

test('appends to an existing Vary header without clobbering it', async () => {
  const app = newApp()
    .use(compress())
    .get('/', c => c.body(BIG, { type: TEXT, headers: { vary: 'Origin' } }))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('vary'), 'Origin, Accept-Encoding')
})

test('does not duplicate Vary when it already lists Accept-Encoding', async () => {
  const app = newApp()
    .use(compress())
    .get('/', c => c.body(BIG, { type: TEXT, headers: { vary: 'accept-encoding' } }))

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('vary'), 'accept-encoding')
})

test('drops the stale content-length after compressing', async () => {
  const app = newApp()
    .use(compress())
    .get('/', c =>
      c.body(BIG, { type: TEXT, headers: { 'content-length': String(BIG.length) } }),
    )

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.equal(response.headers.get('content-length'), null)
})

test('preserves status and other headers', async () => {
  const app = newApp()
    .use(compress())
    .get(
      '/',
      defineRoute(c => {
        c.header('x-custom', 'kept')
        c.status(201)

        return BIG
      }),
    )

  const response = await app.fetch(get({ 'accept-encoding': 'gzip' }))

  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-custom'), 'kept')
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
})

test('leaves a HEAD response without a body alone', async () => {
  const app = newApp()
    .use(compress())
    .get('/', defineRoute(() => BIG))

  const response = await app.fetch(new Request('http://localhost/', { method: 'HEAD' }))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-encoding'), null)
})
