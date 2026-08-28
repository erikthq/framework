import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createApp,
  defineEndpoint,
  defineLayout,
  definePage,
  fileRouter,
  html,
  staticStore,
} from 'framework'
import type { AppOptions, Context, RouteModule } from 'framework'

// The framework enables banner, compress and logger by default. Unit tests opt
// out so each one measures only what it registers itself.
const newApp = (options: AppOptions = {}) =>
  createApp({ banner: false, compress: false, logger: false, ...options })

const get = (path = '/') => new Request(`http://localhost${path}`)

const shell = defineLayout((content, c) =>
  html`<!doctype html>
    <title>${c.get('title') ?? 'untitled'}</title>
    <main>${content}</main>`,
)

test('a page is served as html', async () => {
  const app = newApp().get('/', definePage(() => html`<h1>hi</h1>`))
  const response = await app.fetch(get())

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await response.text(), '<h1>hi</h1>')
})

test('a page is wrapped in the layout', async () => {
  const app = newApp({ layout: shell }).get('/', definePage(() => html`<h1>hi</h1>`))
  const body = await (await app.fetch(get())).text()

  assert.match(body, /^<!doctype html>/)
  assert.match(body, /<main><h1>hi<\/h1><\/main>$/)
})

test('the layout does not escape the page it wraps', async () => {
  const app = newApp({ layout: shell }).get(
    '/',
    definePage(() => html`<p class="a">1 &amp; 2</p>`),
  )
  const body = await (await app.fetch(get())).text()

  assert.match(body, /<main><p class="a">1 &amp; 2<\/p><\/main>/)
  assert.doesNotMatch(body, /&lt;p/)
})

test('values interpolated into a page are still escaped', async () => {
  const app = newApp({ layout: shell }).get(
    '/',
    definePage(c => html`<h1>${c.url.searchParams.get('q')}</h1>`),
  )
  const body = await (await app.fetch(get('/?q=%3Cscript%3E'))).text()

  assert.match(body, /<h1>&lt;script&gt;<\/h1>/)
  assert.doesNotMatch(body, /<script>/)
})

test('a page passes data to the layout through the context', async () => {
  const app = newApp({ layout: shell }).get(
    '/',
    definePage(c => {
      c.set('title', 'a & b')

      return html`<h1>hi</h1>`
    }),
  )

  assert.match(await (await app.fetch(get())).text(), /<title>a &amp; b<\/title>/)
})

test('a page and a layout may both be async', async () => {
  const slow = defineLayout(async content => {
    await new Promise(resolve => setTimeout(resolve, 1))

    return html`<main>${content}</main>`
  })

  const app = newApp({ layout: slow }).get(
    '/',
    definePage(async () => {
      await new Promise(resolve => setTimeout(resolve, 1))

      return html`<h1>slow</h1>`
    }),
  )

  assert.equal(await (await app.fetch(get())).text(), '<main><h1>slow</h1></main>')
})

test('a page keeps the status and headers it set', async () => {
  const app = newApp({ layout: shell }).get(
    '/',
    definePage(c => {
      c.status(404)
      c.header('x-page', 'yes')

      return html`<h1>gone</h1>`
    }),
  )

  const response = await app.fetch(get())

  assert.equal(response.status, 404)
  assert.equal(response.headers.get('x-page'), 'yes')
  assert.match(await response.text(), /<main><h1>gone<\/h1><\/main>/)
})

test('a handler that is not a page is left alone', async () => {
  const app = newApp({ layout: shell })
    .get('/text', c => c.text('plain'))
    .get('/html', c => c.html('<h1>raw</h1>'))

  assert.equal(await (await app.fetch(get('/text'))).text(), 'plain')
  assert.equal(await (await app.fetch(get('/html'))).text(), '<h1>raw</h1>')
})

test('a page from the file router is wrapped too', async () => {
  const modules: Record<string, RouteModule> = {
    'index.ts': { GET: definePage(() => html`<h1>home</h1>`) },
    'about.ts': { default: definePage(() => html`<h1>about</h1>`) },
  }

  const store = staticStore(
    Object.fromEntries(Object.entries(modules).map(([path, module]) => [path, async () => module])),
  )

  const app = newApp({ layout: shell }).plugin(fileRouter({ store }))

  assert.match(await (await app.fetch(get('/'))).text(), /<main><h1>home<\/h1><\/main>/)
  assert.match(await (await app.fetch(get('/about'))).text(), /<main><h1>about<\/h1><\/main>/)
})

test('a notFound page is wrapped too', async () => {
  const app = newApp({ layout: shell }).notFound(
    definePage(c => {
      c.status(404)

      return html`<h1>no ${c.url.pathname}</h1>`
    }),
  )

  const response = await app.fetch(get('/missing'))

  assert.equal(response.status, 404)
  assert.match(await response.text(), /<main><h1>no \/missing<\/h1><\/main>/)
})

test('the layout receives the request context', async () => {
  const paths: string[] = []
  const app = newApp({
    layout: (content, c: Context) => {
      paths.push(c.url.pathname)

      return content
    },
  })
    .get('/one', definePage(() => html`<p>1</p>`))
    .get('/two', definePage(() => html`<p>2</p>`))

  await app.fetch(get('/one'))
  await app.fetch(get('/two'))

  assert.deepEqual(paths, ['/one', '/two'])
})

test('a page is reusable across apps with different layouts', async () => {
  const page = definePage(() => html`<h1>shared</h1>`)

  const bare = newApp().get('/', page)
  const wrapped = newApp({ layout: shell }).get('/', page)

  assert.equal(await (await bare.fetch(get())).text(), '<h1>shared</h1>')
  assert.match(await (await wrapped.fetch(get())).text(), /<main><h1>shared<\/h1><\/main>/)
})

test('html escapes interpolated values but not the template', () => {
  const value = '<img src=x onerror="1">'

  assert.equal(String(html`<p>${value}</p>`), '<p>&lt;img src=x onerror=&quot;1&quot;&gt;</p>')
  assert.equal(String(html`<p>${null}${undefined}</p>`), '<p></p>')
  assert.equal(
    String(html`<ul>${[html`<li>a</li>`, html`<li>b</li>`]}</ul>`),
    '<ul><li>a</li><li>b</li></ul>',
  )
})

test('an endpoint serves its fragment as html', async () => {
  const app = newApp().get('/panel', defineEndpoint(() => html`<div id="panel">open</div>`))
  const response = await app.fetch(get('/panel'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await response.text(), '<div id="panel">open</div>')
})

test('an endpoint is never wrapped in the layout', async () => {
  const app = newApp({ layout: shell })
    .get('/page', definePage(() => html`<h1>page</h1>`))
    .get('/panel', defineEndpoint(() => html`<div id="panel">open</div>`))

  assert.match(await (await app.fetch(get('/page'))).text(), /<!doctype html>/)
  assert.equal(await (await app.fetch(get('/panel'))).text(), '<div id="panel">open</div>')
})

test('an endpoint collects injections into its fragment', async () => {
  const app = newApp({ layout: shell })
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<script src="/p.js"></script>' }) })
    .get('/panel', defineEndpoint(() => html`<div id="panel">open</div>`))

  assert.equal(
    await (await app.fetch(get('/panel'))).text(),
    '<div id="panel">open</div><script src="/p.js"></script>',
  )
})

test('an endpoint can set its own status and headers', async () => {
  const app = newApp({ layout: shell }).get(
    '/panel',
    defineEndpoint(c => {
      c.status(202)
      c.header('x-panel', 'yes')

      return html`<div id="panel">queued</div>`
    }),
  )

  const response = await app.fetch(get('/panel'))

  assert.equal(response.status, 202)
  assert.equal(response.headers.get('x-panel'), 'yes')
})

test('an endpoint escapes its interpolations like a page does', async () => {
  const app = newApp().get('/panel', defineEndpoint(() => html`<p>${'<b>hi</b>'}</p>`))

  assert.equal(await (await app.fetch(get('/panel'))).text(), '<p>&lt;b&gt;hi&lt;/b&gt;</p>')
})

test('an endpoint works as a route file export', async () => {
  const store = staticStore({
    'routes/panel.ts': async (): Promise<RouteModule> => ({
      GET: defineEndpoint(() => html`<div id="panel">from disk</div>`),
    }),
  })

  const app = newApp({ layout: shell }).plugin(fileRouter({ store, dir: 'routes' }))

  assert.equal(await (await app.fetch(get('/panel'))).text(), '<div id="panel">from disk</div>')
})
