import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp, readSignals } from 'framework'

const BIG = 'hello world '.repeat(500)

const gzipRequest = (path = '/') =>
  new Request(`http://localhost${path}`, { headers: { 'accept-encoding': 'gzip' } })

async function inflate(response: Response): Promise<string> {
  const body = response.body

  if (body === null) throw new Error('response has no body')

  return new Response(body.pipeThrough(new DecompressionStream('gzip'))).text()
}

test('compress is enabled by default', async () => {
  const app = createApp({ banner: false, logger: false }).get('/', c => c.text(BIG))
  const response = await app.fetch(gzipRequest())

  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.equal(await inflate(response), BIG)
})

test('banner is registered by default', async () => {
  const output: string[] = []
  const app = createApp({
    logger: false,
    banner: { color: false, log: message => output.push(message) },
  })

  const info = await app.start({ url: 'http://localhost:4321' })

  assert.deepEqual(info.plugins, ['datastar', 'banner'])
  assert.match(output.join('\n'), /framework ready/)
})

test('compress: false disables it', async () => {
  const app = createApp({ banner: false, compress: false, logger: false }).get('/', c =>
    c.text(BIG),
  )
  const response = await app.fetch(gzipRequest())

  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(await response.text(), BIG)
})

test('banner: false disables it', async () => {
  const app = createApp({ banner: false, logger: false })
  const info = await app.start({ url: 'http://localhost:4321' })

  assert.deepEqual(info.plugins, ['datastar'])
})

test('compress options pass through', async () => {
  const app = createApp({ banner: false, compress: { threshold: 0 }, logger: false }).get(
    '/',
    c => c.text('tiny'),
  )
  const response = await app.fetch(gzipRequest())

  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.equal(await inflate(response), 'tiny')
})

test('banner options pass through', async () => {
  const output: string[] = []
  const app = createApp({
    logger: false,
    banner: { color: false, title: 'custom-title', log: message => output.push(message) },
  })

  await app.start()

  assert.match(output.join('\n'), /custom-title ready/)
})

test('the default compress wraps user middleware', async () => {
  const app = createApp({ banner: false, logger: false })
    .use(async (c, next) => {
      const response = await next()

      response.headers.set('x-inner', 'ran')

      return response
    })
    .get('/', c => c.text(BIG))

  const response = await app.fetch(gzipRequest())

  assert.equal(response.headers.get('x-inner'), 'ran')
  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.equal(await inflate(response), BIG)
})

test('the default compress still honours the threshold', async () => {
  const app = createApp({ banner: false, logger: false }).get('/', c => c.text('small body'))
  const response = await app.fetch(gzipRequest())

  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(await response.text(), 'small body')
})

test('the default compress does nothing without accept-encoding', async () => {
  const app = createApp({ banner: false, logger: false }).get('/', c => c.text(BIG))
  const response = await app.fetch(new Request('http://localhost/'))

  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(await response.text(), BIG)
})

test('an explicitly added compress does not double-encode', async () => {
  const { compress } = await import('framework')

  const app = createApp({ banner: false, logger: false })
    .use(compress({ threshold: 0 }))
    .get('/', c => c.text(BIG))

  const response = await app.fetch(gzipRequest())

  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.equal(await inflate(response), BIG)
})

test('logger is registered by default', async () => {
  const output: string[] = []
  const app = createApp({ banner: false, logger: { log: message => output.push(message) } }).get(
    '/',
    c => c.text('ok'),
  )

  const info = await app.start()
  const response = await app.fetch(new Request('http://localhost/thing'))

  assert.deepEqual(info.plugins, ['logger', 'datastar'])
  assert.equal(response.status, 404)
  assert.match(output.join('\n'), /^GET \/thing → 404 \(\d+\.\dms\)$/)
})

test('the default logger times every response', async () => {
  const app = createApp({ banner: false, logger: { log: () => {} } }).get('/', c => c.text('ok'))
  const response = await app.fetch(new Request('http://localhost/'))

  assert.match(response.headers.get('x-response-time') ?? '', /^\d+\.\dms$/)
  assert.equal(await response.text(), 'ok')
})

test('logger: false disables it', async () => {
  const app = createApp({ banner: false, logger: false }).get('/', c => c.text('ok'))

  const info = await app.start()
  const response = await app.fetch(new Request('http://localhost/'))

  assert.deepEqual(info.plugins, ['datastar'])
  assert.equal(response.headers.get('x-response-time'), null)
})

test('logger options pass through', async () => {
  const output: string[] = []
  const app = createApp({
    banner: false,
    logger: { header: 'x-elapsed', log: message => output.push(message) },
  }).get('/', c => c.text('ok'))

  const response = await app.fetch(new Request('http://localhost/'))

  assert.equal(response.headers.get('x-response-time'), null)
  assert.match(response.headers.get('x-elapsed') ?? '', /^\d+\.\dms$/)
  assert.equal(output.length, 1)
})

test('datastar is registered by default', async () => {
  const app = createApp({ banner: false, logger: false }).get('/', c => c.json(readSignals(c)))

  const info = await app.start()
  const response = await app.fetch(new Request('http://localhost/?datastar=%7B%22count%22%3A9%7D'))

  assert.deepEqual(info.plugins, ['datastar'])
  assert.deepEqual(await response.json(), { count: 9 })
})

test('datastar: false disables it', async () => {
  const app = createApp({ banner: false, datastar: false, logger: false }).get('/', c =>
    c.json(readSignals(c)),
  )

  const info = await app.start()
  const response = await app.fetch(new Request('http://localhost/?datastar=%7B%22count%22%3A9%7D'))

  assert.deepEqual(info.plugins, [])
  assert.deepEqual(await response.json(), {})
})

test('datastar options pass through', async () => {
  const app = createApp({
    banner: false,
    datastar: { param: 'ds' },
    logger: false,
  }).get('/', c => c.json(readSignals(c)))

  const response = await app.fetch(new Request('http://localhost/?ds=%7B%22count%22%3A9%7D'))

  assert.deepEqual(await response.json(), { count: 9 })
})

test('the default datastar leaves the body for the handler', async () => {
  const app = createApp({ banner: false, logger: false }).post('/', async c =>
    c.json({ signals: readSignals(c), body: await c.req.json() }),
  )

  const response = await app.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"count":9}',
    }),
  )

  assert.deepEqual(await response.json(), { signals: { count: 9 }, body: { count: 9 } })
})
