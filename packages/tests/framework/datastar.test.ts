import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createApp,
  DATASTAR_CLIENT,
  DATASTAR_VERSION,
  defineEndpoint,
  defineLayout,
  definePage,
  defineStream,
  html,
  readSignals,
} from 'framework'
import type { AppOptions } from 'framework'

// The framework enables banner, compress, datastar and logger by default. Unit
// tests opt out of the three that write to stdout or re-encode a body; datastar
// is what these tests measure, so it stays on.
const newApp = (options: AppOptions = {}) =>
  createApp({ banner: false, compress: false, logger: false, ...options })

const get = (path = '/') => new Request(`http://localhost${path}`)

const post = (path: string, signals: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signals),
  })

const query = (path: string, signals: unknown) =>
  get(`${path}?datastar=${encodeURIComponent(JSON.stringify(signals))}`)

test('a stream is served as an event stream that compress will not transform', async () => {
  const app = newApp().get('/updates', defineStream(stream => stream.patchSignals({ ok: true })))
  const response = await app.fetch(get('/updates'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.match(response.headers.get('cache-control') ?? '', /no-transform/)
})

test('patchSignals emits a datastar-patch-signals event', async () => {
  const app = newApp().get('/updates', defineStream(stream => stream.patchSignals({ count: 2 })))

  assert.equal(
    await (await app.fetch(get('/updates'))).text(),
    'event: datastar-patch-signals\ndata: signals {"count":2}\n\n',
  )
})

test('patchSignals carries onlyIfMissing when asked', async () => {
  const app = newApp().get(
    '/updates',
    defineStream(stream => stream.patchSignals({ count: 0 }, { onlyIfMissing: true })),
  )

  assert.equal(
    await (await app.fetch(get('/updates'))).text(),
    'event: datastar-patch-signals\ndata: onlyIfMissing true\ndata: signals {"count":0}\n\n',
  )
})

test('patchElements emits one data line per line of markup', async () => {
  const app = newApp().get(
    '/updates',
    defineStream(stream => stream.patchElements('<p id="a">one</p>\n<p id="b">two</p>')),
  )

  assert.equal(
    await (await app.fetch(get('/updates'))).text(),
    'event: datastar-patch-elements\ndata: elements <p id="a">one</p>\ndata: elements <p id="b">two</p>\n\n',
  )
})

test('patchElements accepts the html helper and its options', async () => {
  const app = newApp().get(
    '/updates',
    defineStream(stream =>
      stream.patchElements(html`<li>${'<b>'}</li>`, { selector: '#list', mode: 'append' }),
    ),
  )

  assert.equal(
    await (await app.fetch(get('/updates'))).text(),
    'event: datastar-patch-elements\ndata: selector #list\ndata: mode append\n' +
      'data: elements <li>&lt;b&gt;</li>\n\n',
  )
})

test('removeElements targets a selector with the remove mode', async () => {
  const app = newApp().get('/updates', defineStream(stream => stream.removeElements('#gone')))

  assert.equal(
    await (await app.fetch(get('/updates'))).text(),
    'event: datastar-patch-elements\ndata: selector #gone\ndata: mode remove\n\n',
  )
})

test('a stream can emit several events in order', async () => {
  const app = newApp().get(
    '/updates',
    defineStream(async stream => {
      stream.patchSignals({ status: 'loading' })
      await Promise.resolve()
      stream.patchElements('<div id="out">done</div>')
      stream.patchSignals({ status: 'done' })
    }),
  )

  assert.equal(
    await (await app.fetch(get('/updates'))).text(),
    'event: datastar-patch-signals\ndata: signals {"status":"loading"}\n\n' +
      'event: datastar-patch-elements\ndata: elements <div id="out">done</div>\n\n' +
      'event: datastar-patch-signals\ndata: signals {"status":"done"}\n\n',
  )
})

test('event emits a raw event for anything the helpers do not cover', async () => {
  const app = newApp().get(
    '/updates',
    defineStream(stream => stream.event('datastar-patch-signals', ['signals {a: 1}'])),
  )

  assert.equal(
    await (await app.fetch(get('/updates'))).text(),
    'event: datastar-patch-signals\ndata: signals {a: 1}\n\n',
  )
})

test('a closed stream ignores further patches', async () => {
  const app = newApp().get(
    '/updates',
    defineStream(stream => {
      stream.patchSignals({ first: true })
      stream.close()
      stream.patchSignals({ second: true })
    }),
  )

  assert.equal(
    await (await app.fetch(get('/updates'))).text(),
    'event: datastar-patch-signals\ndata: signals {"first":true}\n\n',
  )
})

test('a stream reports when it has closed', async () => {
  let closedDuring: boolean | undefined
  let closedAfter: boolean | undefined

  const app = newApp().get(
    '/updates',
    defineStream(stream => {
      closedDuring = stream.closed
      stream.close()
      closedAfter = stream.closed
    }),
  )

  await (await app.fetch(get('/updates'))).text()

  assert.equal(closedDuring, false)
  assert.equal(closedAfter, true)
})

test('signals arrive from the datastar query parameter on GET', async () => {
  const app = newApp().get('/count', c => c.json(readSignals(c)))

  assert.deepEqual(await (await app.fetch(query('/count', { count: 3 }))).json(), { count: 3 })
})

test('the query parameter name is configurable', async () => {
  const app = newApp({ datastar: { param: 'ds' } }).get('/count', c => c.json(readSignals(c)))

  const response = await app.fetch(get('/count?ds=%7B%22count%22%3A7%7D'))

  assert.deepEqual(await response.json(), { count: 7 })
})

test('signals arrive from the json body on POST', async () => {
  const app = newApp().post('/count', c => c.json(readSignals(c)))

  assert.deepEqual(await (await app.fetch(post('/count', { count: 4 }))).json(), { count: 4 })
})

test('reading signals leaves the body for the handler', async () => {
  const app = newApp().post('/count', async c =>
    c.json({ signals: readSignals(c), body: await c.req.json() }),
  )

  assert.deepEqual(await (await app.fetch(post('/count', { count: 5 }))).json(), {
    signals: { count: 5 },
    body: { count: 5 },
  })
})

test('a request carrying no signals reads as an empty object', async () => {
  const app = newApp().get('/count', c => c.json(readSignals(c)))

  assert.deepEqual(await (await app.fetch(get('/count'))).json(), {})
})

test('unparseable and non-object signals read as an empty object', async () => {
  const app = newApp().get('/count', c => c.json(readSignals(c)))

  assert.deepEqual(await (await app.fetch(get('/count?datastar=%7Bnope'))).json(), {})
  assert.deepEqual(await (await app.fetch(query('/count', [1, 2]))).json(), {})
})

test('a non-json body is left alone', async () => {
  const app = newApp().post('/count', async c =>
    c.json({ signals: readSignals(c), body: await c.req.text() }),
  )

  const request = new Request('http://localhost/count', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'count=6',
  })

  assert.deepEqual(await (await app.fetch(request)).json(), { signals: {}, body: 'count=6' })
})

test('readSignals is empty when the plugin is switched off', async () => {
  const app = newApp({ datastar: false }).get('/count', c => c.json(readSignals(c)))

  assert.deepEqual(await (await app.fetch(query('/count', { count: 8 }))).json(), {})
})

test('a stream answers with the signals it was sent', async () => {
  type Counter = { count: number }

  const app = newApp().post(
    '/count',
    defineStream((stream, c) => {
      const { count } = readSignals<Counter>(c)

      stream.patchSignals({ count: count + 1 })
    }),
  )

  assert.equal(
    await (await app.fetch(post('/count', { count: 41 }))).text(),
    'event: datastar-patch-signals\ndata: signals {"count":42}\n\n',
  )
})

test('a throw after the stream opens aborts it rather than becoming a 500', async () => {
  const app = newApp().get(
    '/updates',
    defineStream(stream => {
      stream.patchSignals({ ok: true })

      throw new Error('boom')
    }),
  )

  const response = await app.fetch(get('/updates'))

  assert.equal(response.status, 200)
  await assert.rejects(() => response.text(), /boom/)
})

test('a stream stops when the request is aborted', async () => {
  const controller = new AbortController()
  let iterations = 0

  const app = newApp().get(
    '/updates',
    defineStream(async stream => {
      while (!stream.closed && iterations < 100) {
        iterations++
        stream.patchSignals({ iterations })
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    }),
  )

  const response = await app.fetch(
    new Request('http://localhost/updates', { signal: controller.signal }),
  )

  const reader = response.body?.getReader()
  assert.ok(reader !== undefined)

  await reader.read()
  controller.abort()
  await reader.cancel()

  const settled = iterations

  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(iterations, settled)
})

const CLIENT_URL = '/datastar-1.0.3.js'

const shell = defineLayout(
  content => html`<html><head></head><body>${content}</body></html>`,
)

const clientApp = () =>
  createApp({ banner: false, compress: false, logger: false, layout: shell, datastar: { client: true } })

test('the client is not served or injected by default', async () => {
  const app = newApp({ layout: shell }).get('/', definePage(() => html`<h1>hi</h1>`))

  assert.doesNotMatch(await (await app.fetch(get())).text(), /<script/)
  assert.equal((await app.fetch(get(CLIENT_URL))).status, 404)
})

test('client: true serves the vendored runtime', async () => {
  const app = clientApp().get('/', definePage(() => html`<h1>hi</h1>`))
  const response = await app.fetch(get(CLIENT_URL))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')

  const body = await response.text()

  assert.match(body, /^\/\/ Datastar v1\.0\.3\n/)
  assert.ok(body.length > 30000)
})

test('the served runtime is exactly the exported bundle', async () => {
  const app = clientApp().get('/', definePage(() => html`<h1>hi</h1>`))

  assert.equal(await (await app.fetch(get(CLIENT_URL))).text(), DATASTAR_CLIENT)
  assert.equal(DATASTAR_VERSION, '1.0.3')
})

test('client: true injects the tag into a document', async () => {
  const app = clientApp().get('/', definePage(() => html`<h1>hi</h1>`))

  assert.match(
    await (await app.fetch(get())).text(),
    /<script type="module" src="\/datastar-1\.0\.3\.js"><\/script><\/head>/,
  )
})

test('the runtime is never appended to a fragment', async () => {
  const app = clientApp()
    .get('/panel', defineEndpoint(() => html`<div id="panel">open</div>`))
    .get('/bare', definePage(() => html`<h1>bare</h1>`))

  const bare = createApp({
    banner: false,
    compress: false,
    logger: false,
    datastar: { client: true },
  }).get('/bare', definePage(() => html`<h1>bare</h1>`))

  assert.equal(await (await app.fetch(get('/panel'))).text(), '<div id="panel">open</div>')
  assert.equal(await (await bare.fetch(get('/bare'))).text(), '<h1>bare</h1>')
})

test('a stream never carries the runtime', async () => {
  const app = clientApp().get('/updates', defineStream(stream => stream.patchSignals({ a: 1 })))

  assert.doesNotMatch(await (await app.fetch(get('/updates'))).text(), /datastar-1\.0\.3\.js/)
})

test('the runtime tag comes before the page own scripts', async () => {
  const app = clientApp()
    .plugin({ name: 'other', injectHTML: () => ({ head: '<script src="/app.js"></script>' }) })
    .get('/', definePage(() => html`<h1>hi</h1>`))

  const body = await (await app.fetch(get())).text()

  assert.ok(body.indexOf('datastar-1.0.3.js') < body.indexOf('/app.js'))
})
