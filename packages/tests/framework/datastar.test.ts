import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createApp,
  DATASTAR_CLIENT,
  DATASTAR_VERSION,
  defineLayout,
  defineRoute,
  defineStream,
  html,
  useLayout,
} from '@erikt/framework'
import type { AppOptions, RouteRender } from '@erikt/framework'

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
    body: JSON.stringify(signals)
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
  const app = newApp().get('/count', defineRoute(c => c.signals))

  assert.deepEqual(await (await app.fetch(query('/count', { count: 3 }))).json(), { count: 3 })
})

test('the query parameter name is configurable', async () => {
  const app = newApp({ datastar: { param: 'ds' } }).get('/count', defineRoute(c => c.signals))

  const response = await app.fetch(get('/count?ds=%7B%22count%22%3A7%7D'))

  assert.deepEqual(await response.json(), { count: 7 })
})

test('signals arrive from the json body on POST', async () => {
  const app = newApp().post('/count', defineRoute(c => c.signals))

  assert.deepEqual(await (await app.fetch(post('/count', { count: 4 }))).json(), { count: 4 })
})

test('reading signals leaves the body for the handler', async () => {
  const app = newApp().post(
    '/count',
    defineRoute(async c => ({ signals: c.signals, body: await c.req.json() })),
  )

  assert.deepEqual(await (await app.fetch(post('/count', { count: 5 }))).json(), {
    signals: { count: 5 },
    body: { count: 5 }
  })
})

test('a request carrying no signals reads as an empty object', async () => {
  const app = newApp().get('/count', defineRoute(c => c.signals))

  assert.deepEqual(await (await app.fetch(get('/count'))).json(), {})
})

test('unparseable and non-object signals read as an empty object', async () => {
  const app = newApp().get('/count', defineRoute(c => c.signals))

  assert.deepEqual(await (await app.fetch(get('/count?datastar=%7Bnope'))).json(), {})
  assert.deepEqual(await (await app.fetch(query('/count', [1, 2]))).json(), {})
})

test('a non-json body is left alone', async () => {
  const app = newApp().post(
    '/count',
    defineRoute(async c => ({ signals: c.signals, body: await c.req.text() })),
  )

  const request = new Request('http://localhost/count', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'count=6'
  })

  assert.deepEqual(await (await app.fetch(request)).json(), { signals: {}, body: 'count=6' })
})

test('c.signals is absent when the plugin is switched off', async () => {
  // The plugin owns the property, so switching it off means nothing puts one
  // there. The type still says it exists — reading it with datastar off is the
  // one place that claim is a lie, and the trade for the plugin owning it.
  const app = newApp({ datastar: false }).get('/count', defineRoute(c => ({ present: c.signals !== undefined })),
  )

  assert.deepEqual(await (await app.fetch(query('/count', { count: 8 }))).json(), {
    present: false,
  })
})

test('a stream answers with the signals it was sent', async () => {
  type Counter = { count: number }

  const app = newApp().post(
    '/count',
    defineStream((stream, c) => {
      const { count } = c.signals as Counter

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

// A page asks for a layout, which is what makes its response a document. The
// tag and the import map only belong in a document.
const page = (render: RouteRender) =>
  defineRoute(c => {
    useLayout(c, shell)

    return render(c)
  })

const clientApp = () =>
  createApp({ banner: false, compress: false, logger: false, datastar: { client: true } })

test('the client is not served or injected by default', async () => {
  const app = newApp().get('/', defineRoute(() => html`<h1>hi</h1>`))

  assert.doesNotMatch(await (await app.fetch(get())).text(), /<script/)
  assert.equal((await app.fetch(get(CLIENT_URL))).status, 404)
})

test('client: true serves the vendored runtime', async () => {
  const app = clientApp().get('/', defineRoute(() => html`<h1>hi</h1>`))
  const response = await app.fetch(get(CLIENT_URL))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')

  const body = await response.text()

  assert.match(body, /^\/\/ Datastar v1\.0\.3\n/)
  assert.ok(body.length > 30000)
})

test('the served runtime is exactly the exported bundle', async () => {
  const app = clientApp().get('/', defineRoute(() => html`<h1>hi</h1>`))

  assert.equal(await (await app.fetch(get(CLIENT_URL))).text(), DATASTAR_CLIENT)
  assert.equal(DATASTAR_VERSION, '1.0.3')
})

test('client: true injects the tag into a document', async () => {
  const app = clientApp().get('/', page(() => html`<h1>hi</h1>`))

  assert.match(
    await (await app.fetch(get())).text(),
    /<script type="module" src="\/datastar-1\.0\.3\.js"><\/script><\/head>/,
  )
})

test('the runtime is never appended to a fragment', async () => {
  const app = clientApp()
    .get('/panel', defineRoute(() => html`<div id="panel">open</div>`))
    .get('/bare', defineRoute(() => html`<h1>bare</h1>`))

  const bare = createApp({
    banner: false,
    compress: false,
    logger: false,
    datastar: { client: true }
  }).get('/bare', defineRoute(() => html`<h1>bare</h1>`))

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
    .get('/', defineRoute(() => html`<h1>hi</h1>`))

  const body = await (await app.fetch(get())).text()

  assert.ok(body.indexOf('datastar-1.0.3.js') < body.indexOf('/app.js'))
})

const pageApp = (options: AppOptions = {}) =>
  createApp({ banner: false, compress: false, logger: false, ...options })

test('patchPage renders the referring page and patches it as a document', async () => {
  const app = pageApp()
    .get('/dash', page(() => html`<h1>dash</h1>`))
    .get('/refresh', defineStream(async stream => stream.patchPage()))

  const body = await (
    await app.fetch(
      new Request('http://localhost/refresh', { headers: { referer: 'http://localhost/dash' } }),
    )
  ).text()

  assert.match(body, /^event: datastar-patch-elements\n/)
  assert.doesNotMatch(body, /data: selector/)
  assert.doesNotMatch(body, /data: mode/)
  assert.match(body, /data: elements <html>/)
  assert.match(body, /<h1>dash<\/h1>/)
  assert.match(body, /<\/html>/)
})

test('the patched page reflects server state at the moment it is asked for', async () => {
  let count = 0

  const app = pageApp()
    .get('/dash', defineRoute(() => html`<p>${String(count)}</p>`))
    .get(
      '/bump',
      defineStream(async stream => {
        count += 1

        await stream.patchPage()
      }),
    )

  const bump = () =>
    app.fetch(new Request('http://localhost/bump', { headers: { referer: 'http://localhost/dash' } }))

  assert.match(await (await bump()).text(), /<p>1<\/p>/)
  assert.match(await (await bump()).text(), /<p>2<\/p>/)
})

test('one endpoint serves whichever page called it', async () => {
  const app = pageApp()
    .get('/one', defineRoute(() => html`<h1>one</h1>`))
    .get('/two', defineRoute(() => html`<h1>two</h1>`))
    .get('/refresh', defineStream(async stream => stream.patchPage()))

  const from = async (referer: string) =>
    (await app.fetch(new Request('http://localhost/refresh', { headers: { referer } }))).text()

  assert.match(await from('http://localhost/one'), /<h1>one<\/h1>/)
  assert.match(await from('http://localhost/two'), /<h1>two<\/h1>/)
})

test('an explicit target beats the referer', async () => {
  const app = pageApp()
    .get('/one', defineRoute(() => html`<h1>one</h1>`))
    .get('/two', defineRoute(() => html`<h1>two</h1>`))
    .get('/refresh', defineStream(async stream => stream.patchPage('/two')))

  const body = await (
    await app.fetch(
      new Request('http://localhost/refresh', { headers: { referer: 'http://localhost/one' } }),
    )
  ).text()

  assert.match(body, /<h1>two<\/h1>/)
  assert.doesNotMatch(body, /<h1>one<\/h1>/)
})

test('the internal render is readable even with compression on', async () => {
  const app = createApp({ banner: false, logger: false })
    .get('/dash', defineRoute(() => html`<h1>${'dash '.repeat(500)}</h1>`))
    .get('/refresh', defineStream(async stream => stream.patchPage()))

  const body = await (
    await app.fetch(
      new Request('http://localhost/refresh', {
        headers: { referer: 'http://localhost/dash', 'accept-encoding': 'gzip' }
      }),
    )
  ).text()

  assert.match(body, /<h1>dash dash/)
})

test('a conditional request header does not turn the render into a 304', async () => {
  const app = pageApp()
    .get('/dash', defineRoute(() => html`<h1>dash</h1>`))
    .get('/refresh', defineStream(async stream => stream.patchPage()))

  const body = await (
    await app.fetch(
      new Request('http://localhost/refresh', {
        headers: {
          referer: 'http://localhost/dash',
          'if-none-match': '*',
          'if-modified-since': 'Wed, 26 Aug 2026 12:03:08 GMT'
        }
      }),
    )
  ).text()

  assert.match(body, /<h1>dash<\/h1>/)
})

test('the render carries a marker so a page cannot patch itself forever', async () => {
  const seen: (string | null)[] = []

  const app = pageApp()
    .get(
      '/dash',
      defineRoute(c => {
        seen.push(c.req.headers.get('x-framework-render'))

        return html`<h1>dash</h1>`
      }),
    )
    .get('/refresh', defineStream(async stream => stream.patchPage()))

  await (
    await app.fetch(
      new Request('http://localhost/refresh', { headers: { referer: 'http://localhost/dash' } }),
    )
  ).text()

  assert.deepEqual(seen, ['1'])
})

test('patchPage inside a render refuses rather than looping', async () => {
  const app = pageApp()
    .get('/loop', defineStream(async stream => stream.patchPage('/loop-page')))
    .get(
      '/loop-page',
      defineStream(async stream => stream.patchPage('/loop-page')),
    )

  const response = await app.fetch(
    new Request('http://localhost/loop', { headers: { referer: 'http://localhost/loop-page' } }),
  )

  await assert.rejects(() => response.text(), /not terminate|not html/)
})

test('patchPage with nothing to render says so', async () => {
  const app = pageApp().get('/refresh', defineStream(async stream => stream.patchPage()))

  const response = await app.fetch(get('/refresh'))

  await assert.rejects(() => response.text(), /no page to render/)
})

test('patchPage refuses another origin', async () => {
  const app = pageApp().get(
    '/refresh',
    defineStream(async stream => stream.patchPage('https://elsewhere.test/x')),
  )

  const response = await app.fetch(get('/refresh'))

  await assert.rejects(() => response.text(), /not this app/)
})

test('patchPage refuses a route that is not html', async () => {
  const app = pageApp()
    .get('/data', defineRoute(() => ({ ok: true })))
    .get('/refresh', defineStream(async stream => stream.patchPage('/data')))

  const response = await app.fetch(get('/refresh'))

  await assert.rejects(() => response.text(), /not html/)
})

const MAP = '<script type="importmap">{"imports":{"datastar":"/datastar-1.0.3.js"}}</script>'

test('client: true injects an import map for the bare specifier', async () => {
  const app = clientApp().get('/', page(() => html`<h1>hi</h1>`))

  assert.match(await (await app.fetch(get())).text(), new RegExp(MAP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('the import map is not html-escaped, so its json survives', async () => {
  const body = await (await clientApp().get('/', page(() => html`<h1>hi</h1>`)).fetch(get())).text()
  const map = /<script type="importmap">(.*?)<\/script>/.exec(body)?.[1] ?? ''

  // A <script> body is raw text: an escaped quote would arrive as &quot;.
  assert.doesNotMatch(map, /&quot;|&amp;/)
  assert.deepEqual(JSON.parse(map), { imports: { datastar: '/datastar-1.0.3.js' } })
})

test('the import map precedes every module script, or the browser ignores it', async () => {
  const app = clientApp()
    .plugin({ name: 'other', injectHTML: () => ({ head: '<script type="module" src="/x.js"></script>' }) })
    .get('/', defineRoute(() => html`<h1>hi</h1>`))

  const body = await (await app.fetch(get())).text()

  assert.ok(body.indexOf('type="importmap"') < body.indexOf('type="module"'))
})

test('no runtime means no import map', async () => {
  const app = newApp().get('/', defineRoute(() => html`<h1>hi</h1>`))

  assert.doesNotMatch(await (await app.fetch(get())).text(), /importmap/)
})

test('a fragment carries no import map', async () => {
  const app = clientApp().get('/panel', defineRoute(() => html`<div id="panel">open</div>`))

  assert.equal(await (await app.fetch(get('/panel'))).text(), '<div id="panel">open</div>')
})

test('c.signals is typed by declaration merging, no cast needed', async () => {
  const seen: number[] = []

  const app = newApp().get(
    '/count',
    defineRoute(c => {
      // `count` is declared on the Signals interface in bag.ts, so this assigns.
      // An undeclared key reads as unknown, which would not.
      const count: number | undefined = c.signals.count

      seen.push(count ?? -1)

      return 'ok'
    }),
  )

  await app.fetch(query('/count', { count: 7 }))

  assert.deepEqual(seen, [7])
})

