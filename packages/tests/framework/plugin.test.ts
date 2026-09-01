import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  banner,
  createApp,
  defineLayout,
  defineRoute,
  html,
  logger,
  useLayout,
} from '@erikt/framework'
import type { Layout, Plugin, RouteRender, StartInfo } from '@erikt/framework'

// The framework enables banner, compress, datastar and logger by default. This
// file asserts on the plugin list itself, so it opts out of all four and each
// test measures only what it registers itself.
const newApp = () => createApp({ banner: false, compress: false, datastar: false, logger: false })

// Named only in the hooks, which hand back a Response of their own rather than
// rendering; a route says its type by what it returns.
const TEXT = 'text/plain; charset=utf-8'

// A page that asks for the layout it is handed. Routes that skip useLayout stay
// fragments, which several tests below rely on.
const pageWith = (layout: Layout, render: RouteRender) =>
  defineRoute(c => {
    useLayout(c, layout)

    return render(c)
  })

const ANSI = /\u001b\[[0-9;]*m/

const get = (path = '/') => new Request(`http://localhost${path}`)

test('setup runs once when the app starts', async () => {
  let calls = 0
  const app = newApp().plugin({ name: 'counter', setup: () => void calls++ })

  await app.start()
  await app.start()

  assert.equal(calls, 1)
})

test('setup can register routes', async () => {
  const plugin: Plugin = {
    name: 'health',
    setup(app) {
      app.get('/health', defineRoute(() => ({ ok: true })))
    },
  }

  const app = newApp().plugin(plugin)

  assert.deepEqual(await (await app.fetch(get('/health'))).json(), { ok: true })
})

test('onStart receives runtime, routes and plugin names', async () => {
  let info: StartInfo | undefined

  const app = newApp()
    .plugin({ name: 'inspector', onStart: received => void (info = received) })
    .get('/', defineRoute(() => 'root'))
    .post('/items', defineRoute(() => 'made'))

  await app.start({ url: 'http://example.test' })

  assert.equal(info?.url, 'http://example.test')
  assert.equal(info?.runtime, 'Node.js/24')
  assert.deepEqual(info?.plugins, ['inspector'])
  assert.deepEqual(info?.routes, [
    { method: 'GET', pattern: '/' },
    { method: 'POST', pattern: '/items' },
  ])
  assert.ok((info?.startedAt ?? 0) > 0)
})

test('fetch starts the app even when start is never called', async () => {
  let started = false
  const app = newApp()
    .plugin({ name: 'flag', onStart: () => void (started = true) })
    .get('/', defineRoute(() => 'ok'))

  assert.equal(started, false)

  await app.fetch(get())

  assert.equal(started, true)
})

test('onRequest can short-circuit before any handler runs', async () => {
  let reached = false

  const app = newApp()
    .plugin({ name: 'gate', onRequest: c => c.body('blocked', { status: 403, type: TEXT }) })
    .get(
      '/',
      defineRoute(() => {
        reached = true

        return 'secret'
      }),
    )

  const response = await app.fetch(get())

  assert.equal(response.status, 403)
  assert.equal(reached, false)
})

test('onRequest that returns nothing lets the request through', async () => {
  const seen: string[] = []

  const app = newApp()
    .plugin({ name: 'observer', onRequest: c => void seen.push(c.url.pathname) })
    .get('/page', defineRoute(() => 'page'))

  assert.equal(await (await app.fetch(get('/page'))).text(), 'page')
  assert.deepEqual(seen, ['/page'])
})

test('onResponse can observe and replace the response', async () => {
  const app = newApp()
    .plugin({
      name: 'tagger',
      onResponse(c, response) {
        response.headers.set('x-tagged', 'yes')
      },
    })
    .plugin({
      name: 'replacer',
      onResponse: (c, response) =>
        response.status === 200 ? c.body('replaced', { type: TEXT }) : response,
    })
    .get('/', defineRoute(() => 'original'))

  const response = await app.fetch(get())

  assert.equal(await response.text(), 'replaced')
})

test('onError observes thrown errors without handling them', async () => {
  const seen: unknown[] = []

  const app = newApp()
    .plugin({ name: 'reporter', onError: error => void seen.push(error) })
    .get('/', () => {
      throw new Error('boom')
    })

  const response = await app.fetch(get())

  assert.equal(response.status, 500)
  assert.equal((seen[0] as Error).message, 'boom')
})

test('onStop runs on stop', async () => {
  let stopped = false
  const app = newApp().plugin({ name: 'closer', onStop: () => void (stopped = true) })

  await app.start()
  await app.stop()

  assert.equal(stopped, true)
})

test('hooks run in plugin registration order', async () => {
  const order: string[] = []

  const app = newApp()
    .plugin({ name: 'first', onRequest: () => void order.push('first') })
    .plugin({ name: 'second', onRequest: () => void order.push('second') })
    .get('/', defineRoute(() => 'ok'))

  await app.fetch(get())

  assert.deepEqual(order, ['first', 'second'])
})

test('async hooks are awaited', async () => {
  const order: string[] = []

  const app = newApp()
    .plugin({
      name: 'slow',
      async onRequest() {
        await new Promise(resolve => setTimeout(resolve, 5))

        order.push('hook')
      },
    })
    .get(
      '/',
      defineRoute(() => {
        order.push('handler')

        return 'ok'
      }),
    )

  await app.fetch(get())

  assert.deepEqual(order, ['hook', 'handler'])
})

test('routes exposes the registered routes', () => {
  const app = newApp()
    .get('/', defineRoute(() => 'a'))
    .all({ hostname: ':tenant.example.com', pathname: '/x' }, defineRoute(() => 'b'))

  assert.deepEqual(app.routes, [
    { method: 'GET', pattern: '/' },
    { method: 'ALL', pattern: ':tenant.example.com /x' },
  ])
})

test('banner logs a box with the url, runtime and routes', async () => {
  const output: string[] = []

  const app = newApp()
    .plugin(banner({ color: false, log: message => output.push(message) }))
    .get('/', defineRoute(() => 'root'))

  await app.start({ url: 'http://localhost:4321' })

  const printed = output.join('\n')

  assert.match(printed, /framework ready/)
  assert.match(printed, /http:\/\/localhost:4321/)
  assert.match(printed, /runtime {2}Node\.js\/24/)
  assert.match(printed, /GET {4}\//)
  assert.match(printed, /^│.*│$/m)
  assert.ok(printed.startsWith('╭'))
  assert.ok(printed.endsWith('╯'))
})

test('banner emits no ansi codes when color is off', async () => {
  const output: string[] = []

  const app = newApp().plugin(banner({ color: false, log: message => output.push(message) }))

  await app.start()

  assert.doesNotMatch(output.join('\n'), ANSI)
})

test('banner emits ansi codes when color is on', async () => {
  const output: string[] = []

  const app = newApp().plugin(banner({ color: true, log: message => output.push(message) }))

  await app.start()

  assert.match(output.join('\n'), ANSI)
})

test('banner pads every line of the box to the same visible width', async () => {
  const output: string[] = []

  const app = newApp()
    .plugin(banner({ color: false, log: message => output.push(message) }))
    .get('/a-very-long-route-pattern/:id', defineRoute(() => 'x'))

  await app.start({ url: 'http://localhost:4321' })

  const widths = new Set(output.join('\n').split('\n').map(line => [...line].length))

  assert.equal(widths.size, 1)
})

test('banner keeps the box aligned with color on', async () => {
  const output: string[] = []

  const app = newApp()
    .plugin(banner({ color: true, log: message => output.push(message) }))
    .get('/some/route/:id', defineRoute(() => 'x'))

  await app.start({ url: 'http://localhost:4321' })

  const widths = new Set(
    output
      .join('\n')
      .split('\n')
      .map(line => [...line.replace(new RegExp(ANSI.source, 'g'), '')].length),
  )

  assert.equal(widths.size, 1)
})

test('banner uses a custom title', async () => {
  const output: string[] = []

  const app = newApp().plugin(
    banner({ color: false, title: 'my-app', log: message => output.push(message) }),
  )

  await app.start()

  assert.match(output.join('\n'), /my-app ready/)
})

test('banner can omit the route list', async () => {
  const output: string[] = []

  const app = newApp()
    .plugin(banner({ color: false, routes: false, log: message => output.push(message) }))
    .get('/hidden', defineRoute(() => 'x'))

  await app.start()

  assert.doesNotMatch(output.join('\n'), /\/hidden/)
})

test('banner logs on stop', async () => {
  const output: string[] = []

  const app = newApp().plugin(
    banner({ color: false, title: 'my-app', log: message => output.push(message) }),
  )

  await app.start()
  await app.stop()

  assert.match(output.at(-1) ?? '', /my-app stopped/)
})

test('logger logs the method, path and status of every response', async () => {
  const output: string[] = []
  const app = newApp()
    .plugin(logger({ log: message => output.push(message) }))
    .get(
      '/users/:id',
      defineRoute(c => {
        c.status(201)

        return `user ${c.params.id ?? ''}`
      }),
    )

  await app.fetch(new Request('http://localhost/users/7?full=1'))
  await app.fetch(new Request('http://localhost/missing', { method: 'POST' }))

  assert.equal(output.length, 2)
  assert.match(output[0] ?? '', /^GET \/users\/7 → 201 \(\d+\.\dms\)$/)
  assert.match(output[1] ?? '', /^POST \/missing → 404 \(\d+\.\dms\)$/)
})

test('logger reports the elapsed time in a header', async () => {
  const app = newApp()
    .plugin(logger({ log: () => {} }))
    .get('/', defineRoute(() => 'ok'))

  const response = await app.fetch(new Request('http://localhost/'))

  assert.match(response.headers.get('x-response-time') ?? '', /^\d+\.\dms$/)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
})

test('logger can log without touching the response', async () => {
  const output: string[] = []
  const app = newApp()
    .plugin(logger({ header: false, log: message => output.push(message) }))
    .get('/', defineRoute(() => 'ok'))

  const response = await app.fetch(new Request('http://localhost/'))

  assert.equal(response.headers.get('x-response-time'), null)
  assert.equal(output.length, 1)
})

test('logger adds its header to a response whose headers are immutable', async () => {
  const app = newApp()
    .plugin(logger({ log: () => {} }))
    .get('/', () => Response.redirect('http://localhost/new', 302))

  const response = await app.fetch(new Request('http://localhost/'))

  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'http://localhost/new')
  assert.match(response.headers.get('x-response-time') ?? '', /^\d+\.\dms$/)
})

test('logger keeps its header on a HEAD served by a GET route', async () => {
  const app = newApp()
    .plugin(logger({ log: () => {} }))
    .get('/', defineRoute(() => 'body here'))

  const response = await app.fetch(new Request('http://localhost/', { method: 'HEAD' }))

  assert.match(response.headers.get('x-response-time') ?? '', /^\d+\.\dms$/)
  assert.equal(await response.text(), '')
})

test('logger stays quiet when a handler throws, which onError reports instead', async () => {
  const output: string[] = []
  const seen: unknown[] = []
  const app = newApp()
    .plugin(logger({ log: message => output.push(message) }))
    .plugin({ name: 'watch', onError: error => void seen.push(error) })
    .get('/', () => {
      throw new Error('boom')
    })

  const response = await app.fetch(new Request('http://localhost/'))

  assert.equal(response.status, 500)
  assert.deepEqual(output, [])
  assert.equal(seen.length, 1)
})

test('injectHTML puts markup into the head and the body of a layout', async () => {
  const shell = defineLayout(
    content => html`<html><head><title>t</title></head><body>${content}</body></html>`,
  )

  const app = createApp({ banner: false, compress: false, datastar: false, logger: false })
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<meta name="a">', body: '<i>b</i>' }) })
    .get('/', pageWith(shell, () => html`<h1>hi</h1>`))

  assert.equal(
    await (await app.fetch(get())).text(),
    '<html><head><title>t</title><meta name="a"></head><body><h1>hi</h1><i>b</i></body></html>',
  )
})

test('injectHTML sees the context and runs per request', async () => {
  const shell = defineLayout(content => html`<html><head></head><body>${content}</body></html>`)

  const app = createApp({ banner: false, compress: false, datastar: false, logger: false })
    .plugin({ name: 'injector', injectHTML: c => ({ head: `<meta content="${c.url.pathname}">` }) })
    .get('/:slug', pageWith(shell, () => html`<h1>hi</h1>`))

  assert.match(await (await app.fetch(get('/one'))).text(), /<meta content="\/one">/)
  assert.match(await (await app.fetch(get('/two'))).text(), /<meta content="\/two">/)
})

test('every plugin that injects contributes, in registration order', async () => {
  const shell = defineLayout(content => html`<html><head></head><body>${content}</body></html>`)

  const app = createApp({ banner: false, compress: false, datastar: false, logger: false })
    .plugin({ name: 'first', injectHTML: () => ({ head: '<meta name="1">' }) })
    .plugin({ name: 'quiet' })
    .plugin({ name: 'second', injectHTML: () => ({ head: '<meta name="2">' }) })
    .get('/', pageWith(shell, () => html`<h1>hi</h1>`))

  assert.match(await (await app.fetch(get())).text(), /<meta name="1"><meta name="2"><\/head>/)
})

test('injectHTML is not applied to a handler that renders no markup', async () => {
  const app = newApp()
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<meta name="a">' }) })
    .get('/plain', c =>
      c.body('<html><head></head><body>plain</body></html>', {
        type: 'text/html; charset=utf-8',
      }),
    )
    .get('/json', defineRoute(() => ({ ok: true })))

  assert.equal(
    await (await app.fetch(get('/plain'))).text(),
    '<html><head></head><body>plain</body></html>',
  )
  assert.equal(await (await app.fetch(get('/json'))).text(), '{"ok":true}')
})

test('a page with no layout still collects its injections', async () => {
  const app = newApp()
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<meta name="a">' }) })
    .get('/', defineRoute(() => html`<h1>hi</h1>`))

  assert.equal(await (await app.fetch(get())).text(), '<h1>hi</h1><meta name="a">')
})

test('head lands before body when a fragment sends both to the end', async () => {
  const app = newApp()
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<meta name="a">', body: '<i>b</i>' }) })
    .get('/', defineRoute(() => html`<h1>hi</h1>`))

  assert.equal(await (await app.fetch(get())).text(), '<h1>hi</h1><meta name="a"><i>b</i>')
})

test('injected markup with no closing tag to sit before is appended', async () => {
  const shell = defineLayout(content => html`<section>${content}</section>`)

  const app = createApp({ banner: false, compress: false, datastar: false, logger: false })
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<meta name="a">' }) })
    .get('/', pageWith(shell, () => html`<h1>hi</h1>`))

  assert.equal(
    await (await app.fetch(get())).text(),
    '<section><h1>hi</h1></section><meta name="a">',
  )
})

test('injectHTML is told whether it is filling a document or a fragment', async () => {
  const seen: string[] = []
  const shell = defineLayout(content => html`<html><head></head><body>${content}</body></html>`)

  const app = createApp({ banner: false, compress: false, datastar: false, logger: false })
    .plugin({ name: 'watcher', injectHTML: (_c, target) => void seen.push(target) })
    .get('/page', pageWith(shell, () => html`<h1>hi</h1>`))
    .get('/panel', defineRoute(() => html`<div>hi</div>`))

  await app.fetch(get('/page'))
  await app.fetch(get('/panel'))

  assert.deepEqual(seen, ['document', 'fragment'])
})

test('a layout-less page counts as a fragment', async () => {
  const seen: string[] = []

  const app = newApp()
    .plugin({ name: 'watcher', injectHTML: (_c, target) => void seen.push(target) })
    .get('/', defineRoute(() => html`<h1>hi</h1>`))

  await app.fetch(get())

  assert.deepEqual(seen, ['fragment'])
})
