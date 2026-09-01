import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createApp,
  defineErrorPage,
  defineLayout,
  defineRoute,
  fileRouter,
  html,
  useLayout,
  staticStore,
} from '@erikt/framework'
import type { AppOptions, RouteModule, RouteRender } from '@erikt/framework'

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

// What a page does: ask for a layout, then render. A route that skips this
// answers with its markup as-is, which is what the endpoint tests rely on.
const page = (render: RouteRender) =>
  defineRoute(c => {
    useLayout(c, shell)

    return render(c)
  })

test('a page is served as html', async () => {
  const app = newApp().get('/', defineRoute(() => html`<h1>hi</h1>`))
  const response = await app.fetch(get())

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await response.text(), '<h1>hi</h1>')
})

test('a page is wrapped in the layout it asks for', async () => {
  const app = newApp().get('/', page(() => html`<h1>hi</h1>`))
  const body = await (await app.fetch(get())).text()

  assert.match(body, /^<!doctype html>/)
  assert.match(body, /<main><h1>hi<\/h1><\/main>$/)
})

test('the layout does not escape the page it wraps', async () => {
  const app = newApp().get(
    '/',
    page(() => html`<p class="a">1 &amp; 2</p>`),
  )
  const body = await (await app.fetch(get())).text()

  assert.match(body, /<main><p class="a">1 &amp; 2<\/p><\/main>/)
  assert.doesNotMatch(body, /&lt;p/)
})

test('values interpolated into a page are still escaped', async () => {
  const app = newApp().get(
    '/',
    defineRoute(c => html`<h1>${c.url.searchParams.get('q')}</h1>`),
  )
  const body = await (await app.fetch(get('/?q=%3Cscript%3E'))).text()

  assert.match(body, /<h1>&lt;script&gt;<\/h1>/)
  assert.doesNotMatch(body, /<script>/)
})

test('a page passes data to the layout through the context', async () => {
  const app = newApp().get(
    '/',
    page(c => {
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

  const app = newApp().get(
    '/',
    defineRoute(async c => {
      useLayout(c, slow)

      await new Promise(resolve => setTimeout(resolve, 1))

      return html`<h1>slow</h1>`
    }),
  )

  assert.equal(await (await app.fetch(get())).text(), '<main><h1>slow</h1></main>')
})

test('a page keeps the status and headers it set', async () => {
  const app = newApp().get(
    '/',
    page(c => {
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

test('a route that returns an object answers with json', async () => {
  const app = newApp().get('/api/user', defineRoute(() => ({ id: 7, name: 'ada' })))
  const response = await app.fetch(get('/api/user'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.deepEqual(await response.json(), { id: 7, name: 'ada' })
})

test('an array is data too', async () => {
  const app = newApp().get('/api/list', defineRoute(() => [1, 2, 3]))

  assert.deepEqual(await (await app.fetch(get('/api/list'))).json(), [1, 2, 3])
})

test('a render may be async and still answer with json', async () => {
  const app = newApp().get(
    '/api/user',
    defineRoute(async c => {
      await new Promise(resolve => setTimeout(resolve, 1))

      return { path: c.url.pathname }
    }),
  )

  assert.deepEqual(await (await app.fetch(get('/api/user'))).json(), { path: '/api/user' })
})

test('markup is still markup, String object and all', async () => {
  // `html` returns a String object, not a primitive. If that counted as data
  // every page in the framework would answer with json.
  const app = newApp().get('/', defineRoute(() => html`<h1>hi</h1>`))
  const response = await app.fetch(get())

  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await response.text(), '<h1>hi</h1>')
})

test('a data route keeps the status and headers it set', async () => {
  const app = newApp().get(
    '/api/user',
    defineRoute(c => {
      c.status(201)
      c.header('x-made', 'yes')

      return { ok: true }
    }),
  )

  const response = await app.fetch(get('/api/user'))

  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-made'), 'yes')
  assert.deepEqual(await response.json(), { ok: true })
})

test('nothing is injected into data, and no layout wraps it', async () => {
  const app = newApp()
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<meta name="a">' }) })
    .get(
      '/api/user',
      defineRoute(c => {
        // Asking and then returning data is a contradiction; the return wins.
        useLayout(c, shell)

        return { id: 7 }
      }),
    )

  const response = await app.fetch(get('/api/user'))

  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(await response.text(), '{"id":7}')
})

test('a data route works as a route file export', async () => {
  const store = staticStore({
    'routes/api/user.ts': async (): Promise<RouteModule> => ({
      GET: defineRoute(() => ({ id: 7 })),
    }),
  })

  const app = newApp().plugin(fileRouter({ store, dir: 'routes' }))

  assert.deepEqual(await (await app.fetch(get('/api/user'))).json(), { id: 7 })
})

test('a handler that is not a page is left alone', async () => {
  const app = newApp()
    .get('/text', defineRoute(() => 'plain'))
    .get('/html', c => c.body('<h1>raw</h1>', { type: 'text/html; charset=utf-8' }))

  assert.equal(await (await app.fetch(get('/text'))).text(), 'plain')
  assert.equal(await (await app.fetch(get('/html'))).text(), '<h1>raw</h1>')
})

test('a page from the file router is wrapped too', async () => {
  const modules: Record<string, RouteModule> = {
    'index.ts': { GET: page(() => html`<h1>home</h1>`) },
    'about.ts': { default: page(() => html`<h1>about</h1>`) },
  }

  const store = staticStore(
    Object.fromEntries(Object.entries(modules).map(([path, module]) => [path, async () => module])),
  )

  const app = newApp().plugin(fileRouter({ store }))

  assert.match(await (await app.fetch(get('/'))).text(), /<main><h1>home<\/h1><\/main>/)
  assert.match(await (await app.fetch(get('/about'))).text(), /<main><h1>about<\/h1><\/main>/)
})

test('a notFound page is wrapped too', async () => {
  const app = newApp().notFound(
    page(c => {
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
  const spy = defineLayout((content, c) => {
    paths.push(c.url.pathname)

    return content
  })
  const app = newApp()
    .get(
      '/one',
      defineRoute(c => {
        useLayout(c, spy)

        return html`<p>1</p>`
      }),
    )
    .get(
      '/two',
      defineRoute(c => {
        useLayout(c, spy)

        return html`<p>2</p>`
      }),
    )

  await app.fetch(get('/one'))
  await app.fetch(get('/two'))

  assert.deepEqual(paths, ['/one', '/two'])
})

test('a render is reusable with and without a layout', async () => {
  const body = () => html`<h1>shared</h1>`

  const bare = newApp().get('/', defineRoute(body))
  const wrapped = newApp().get(
    '/',
    defineRoute(c => {
      useLayout(c, shell)

      return body()
    }),
  )

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
  const app = newApp().get('/panel', defineRoute(() => html`<div id="panel">open</div>`))
  const response = await app.fetch(get('/panel'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await response.text(), '<div id="panel">open</div>')
})

test('a route that asks for no layout is not wrapped', async () => {
  const app = newApp()
    .get('/page', page(() => html`<h1>page</h1>`))
    .get('/panel', defineRoute(() => html`<div id="panel">open</div>`))

  assert.match(await (await app.fetch(get('/page'))).text(), /<!doctype html>/)
  assert.equal(await (await app.fetch(get('/panel'))).text(), '<div id="panel">open</div>')
})

test('an endpoint collects injections into its fragment', async () => {
  const app = newApp()
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<script src="/p.js"></script>' }) })
    .get('/panel', defineRoute(() => html`<div id="panel">open</div>`))

  assert.equal(
    await (await app.fetch(get('/panel'))).text(),
    '<div id="panel">open</div><script src="/p.js"></script>',
  )
})

test('an endpoint can set its own status and headers', async () => {
  const app = newApp().get(
    '/panel',
    defineRoute(c => {
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
  const app = newApp().get('/panel', defineRoute(() => html`<p>${'<b>hi</b>'}</p>`))

  assert.equal(await (await app.fetch(get('/panel'))).text(), '<p>&lt;b&gt;hi&lt;/b&gt;</p>')
})

test('an endpoint works as a route file export', async () => {
  const store = staticStore({
    'routes/panel.ts': async (): Promise<RouteModule> => ({
      GET: defineRoute(() => html`<div id="panel">from disk</div>`),
    }),
  })

  const app = newApp().plugin(fileRouter({ store, dir: 'routes' }))

  assert.equal(await (await app.fetch(get('/panel'))).text(), '<div id="panel">from disk</div>')
})

test('an error page renders through the layout it asks for, and gets the error', async () => {
  const app = newApp()
    .onError(
      defineErrorPage((error, c) => {
        useLayout(c, shell)

        return html`<p>${(error as Error).message}</p>`
      }),
    )
    .get('/', () => {
      throw new Error('it broke')
    })

  const response = await app.fetch(get())
  const body = await response.text()

  assert.equal(response.status, 500)
  assert.match(body, /<!doctype html>/)
  assert.match(body, /<p>it broke<\/p>/)
})

test('an error page answers 500 without being asked', async () => {
  const app = newApp()
    .onError(defineErrorPage(() => html`<p>sorry</p>`))
    .get('/', () => {
      throw new Error('boom')
    })

  assert.equal((await app.fetch(get())).status, 500)
})

test('an error page can choose another status', async () => {
  const app = newApp()
    .onError(
      defineErrorPage((_error, c) => {
        c.status(503)

        return html`<p>later</p>`
      }),
    )
    .get('/', () => {
      throw new Error('boom')
    })

  assert.equal((await app.fetch(get())).status, 503)
})

test('a status the failing handler set is kept', async () => {
  const app = newApp()
    .onError(defineErrorPage(() => html`<p>sorry</p>`))
    .get('/', c => {
      c.status(401)

      throw new Error('unauthorized')
    })

  assert.equal((await app.fetch(get())).status, 401)
})

test('an error page can read the status it is about to answer with', async () => {
  const seen: number[] = []

  const app = newApp()
    .onError(
      defineErrorPage((_error, c) => {
        seen.push(c.status())

        return html`<p>${String(c.status())}</p>`
      }),
    )
    .get('/set', c => {
      c.status(401)

      throw new Error('unauthorized')
    })
    .get('/unset', () => {
      throw new Error('boom')
    })

  assert.match(await (await app.fetch(get('/set'))).text(), /<p>401<\/p>/)
  assert.match(await (await app.fetch(get('/unset'))).text(), /<p>500<\/p>/)
  assert.deepEqual(seen, [401, 500])
})

test('a handler that left the status alone still gets a 500', async () => {
  const app = newApp()
    .onError(defineErrorPage(() => html`<p>sorry</p>`))
    .get('/', () => {
      throw new Error('boom')
    })

  assert.equal((await app.fetch(get())).status, 500)
})

test('an error page escapes what it interpolates', async () => {
  const app = newApp()
    .onError(defineErrorPage(error => html`<p>${(error as Error).message}</p>`))
    .get('/', () => {
      throw new Error('<script>alert(1)</script>')
    })

  const body = await (await app.fetch(get())).text()

  assert.doesNotMatch(body, /<script>alert/)
  assert.match(body, /&lt;script&gt;/)
})

test('an error page collects head injections like any other page', async () => {
  const app = newApp()
    .plugin({ name: 'injector', injectHTML: () => ({ head: '<meta name="a">' }) })
    .onError(defineErrorPage(() => html`<p>sorry</p>`))
    .get('/', () => {
      throw new Error('boom')
    })

  assert.match(await (await app.fetch(get())).text(), /<meta name="a">/)
})

test('a plain error handler is left exactly as it was', async () => {
  const app = newApp()
    .onError((error, c) =>
      c.body(JSON.stringify({ error: (error as Error).message }), {
        status: 502,
        type: 'application/json; charset=utf-8',
      }),
    )
    .get('/', () => {
      throw new Error('boom')
    })

  const response = await app.fetch(get())

  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'boom' })
})

test('an error page that itself fails falls back to a plain 500', async () => {
  const broken = defineLayout(() => {
    throw new Error('the layout is broken too')
  })

  const app = newApp()
    .onError(
      defineErrorPage((_error, c) => {
        useLayout(c, broken)

        return html`<p>sorry</p>`
      }),
    )
    .get('/', () => {
      throw new Error('boom')
    })

  const response = await app.fetch(get())

  assert.equal(response.status, 500)
  assert.equal(await response.text(), '500 Internal Server Error')
})

test('an error page that asks for no layout serves its fragment', async () => {
  const app = newApp()
    .onError(defineErrorPage(error => html`<p>${(error as Error).message}</p>`))
    .get('/', () => {
      throw new Error('bare')
    })

  const response = await app.fetch(get())

  assert.equal(response.status, 500)
  assert.equal(await response.text(), '<p>bare</p>')
})
