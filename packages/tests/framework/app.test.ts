import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from 'framework'
// The framework enables banner, compress and logger by default. Unit tests opt
// out so each one measures only what it registers itself.
const newApp = () => createApp({ banner: false, compress: false, logger: false })


const get = (path: string) => new Request(`http://localhost${path}`)

test('routes a request to a handler', async () => {
  const app = newApp().get('/', c => c.text('hello'))
  const response = await app.fetch(get('/'))

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'hello')
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
})

test('routes by method', async () => {
  const app = newApp()
    .get('/items', c => c.text('list'))
    .post('/items', c => c.text('created', 201))

  assert.equal(await (await app.fetch(get('/items'))).text(), 'list')

  const created = await app.fetch(new Request('http://localhost/items', { method: 'POST' }))

  assert.equal(created.status, 201)
  assert.equal(await created.text(), 'created')
})

test('exposes path params on the context', async () => {
  const app = newApp().get('/users/:id', c => c.text(c.params.id ?? ''))

  assert.equal(await (await app.fetch(get('/users/42'))).text(), '42')
})

test('json sets the content type and serialises the body', async () => {
  const app = newApp().get('/', c => c.json({ ok: true }))
  const response = await app.fetch(get('/'))

  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.deepEqual(await response.json(), { ok: true })
})

test('html sets the content type', async () => {
  const app = newApp().get('/', c => c.html('<h1>hi</h1>'))
  const response = await app.fetch(get('/'))

  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await response.text(), '<h1>hi</h1>')
})

test('redirect sets location and status', async () => {
  const app = newApp().get('/old', c => c.redirect('/new', 301))
  const response = await app.fetch(get('/old'))

  assert.equal(response.status, 301)
  assert.equal(response.headers.get('location'), '/new')
})

test('header and status accumulate onto the response', async () => {
  const app = newApp().get('/', c => {
    c.header('x-powered-by', 'framework')
    c.status(418)

    return c.text('teapot')
  })
  const response = await app.fetch(get('/'))

  assert.equal(response.status, 418)
  assert.equal(response.headers.get('x-powered-by'), 'framework')
})

test('returns 404 when no route matches', async () => {
  const response = await newApp().get('/', c => c.text('root')).fetch(get('/missing'))

  assert.equal(response.status, 404)
})

test('a custom notFound handler replaces the default', async () => {
  const app = newApp().notFound(c => c.json({ missing: c.url.pathname }, 404))
  const response = await app.fetch(get('/nope'))

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { missing: '/nope' })
})

test('returns 405 with an Allow header when the path matches but the method does not', async () => {
  const app = newApp().get('/items', c => c.text('list'))
  const response = await app.fetch(new Request('http://localhost/items', { method: 'DELETE' }))

  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET')
})

test('all() matches any method', async () => {
  const app = newApp().all('/any', c => c.text(c.req.method))

  assert.equal(await (await app.fetch(new Request('http://localhost/any', { method: 'PUT' }))).text(), 'PUT')
})

test('middleware wraps the handler', async () => {
  const order: string[] = []

  const app = newApp()
    .use(async (c, next) => {
      order.push('before')
      const response = await next()
      order.push('after')

      response.headers.set('x-wrapped', 'yes')

      return response
    })
    .get('/', c => {
      order.push('handler')

      return c.text('ok')
    })

  const response = await app.fetch(get('/'))

  assert.deepEqual(order, ['before', 'handler', 'after'])
  assert.equal(response.headers.get('x-wrapped'), 'yes')
})

test('middleware runs in registration order', async () => {
  const order: string[] = []

  const app = newApp()
    .use(async (c, next) => {
      order.push('one')

      return next()
    })
    .use(async (c, next) => {
      order.push('two')

      return next()
    })
    .get('/', c => c.text('ok'))

  await app.fetch(get('/'))

  assert.deepEqual(order, ['one', 'two'])
})

test('middleware can short-circuit without calling next', async () => {
  let reached = false

  const app = newApp()
    .use(c => c.text('denied', 401))
    .get('/', c => {
      reached = true

      return c.text('secret')
    })

  const response = await app.fetch(get('/'))

  assert.equal(response.status, 401)
  assert.equal(reached, false)
})

test('scoped middleware only runs on matching paths', async () => {
  const seen: string[] = []

  const app = newApp()
    .use('/admin/*', async (c, next) => {
      seen.push(c.url.pathname)

      return next()
    })
    .get('/admin/users', c => c.text('admin'))
    .get('/public', c => c.text('public'))

  await app.fetch(get('/public'))
  assert.deepEqual(seen, [])

  await app.fetch(get('/admin/users'))
  assert.deepEqual(seen, ['/admin/users'])
})

test('context state passes from middleware to handler', async () => {
  const app = newApp()
    .use(async (c, next) => {
      c.set('user', { id: 7 })

      return next()
    })
    .get('/me', c => c.json(c.get('user')))

  assert.deepEqual(await (await app.fetch(get('/me'))).json(), { id: 7 })
})

test('a thrown error becomes a 500', async () => {
  const app = newApp().get('/', () => {
    throw new Error('boom')
  })
  const response = await app.fetch(get('/'))

  assert.equal(response.status, 500)
})

test('onError handles thrown errors', async () => {
  const app = newApp()
    .onError((error, c) => c.json({ error: (error as Error).message }, 500))
    .get('/', () => {
      throw new Error('boom')
    })

  assert.deepEqual(await (await app.fetch(get('/'))).json(), { error: 'boom' })
})

test('onError catches errors thrown in middleware', async () => {
  const app = newApp()
    .onError((error, c) => c.text((error as Error).message, 500))
    .use(() => {
      throw new Error('middleware failed')
    })
    .get('/', c => c.text('ok'))

  assert.equal(await (await app.fetch(get('/'))).text(), 'middleware failed')
})

test('reads the request body in a handler', async () => {
  const app = newApp().post('/echo', async c => c.json(await c.req.json()))
  const response = await app.fetch(
    new Request('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    }),
  )

  assert.deepEqual(await response.json(), { hello: 'world' })
})

test('HEAD falls back to the GET route without a body', async () => {
  const app = newApp().get('/', c => c.text('body here'))
  const response = await app.fetch(new Request('http://localhost/', { method: 'HEAD' }))

  assert.equal(response.status, 200)
  assert.equal(response.body, null)
  assert.equal(await response.text(), '')
})

test('matches url components beyond the pathname', async () => {
  const app = newApp().get(
    { hostname: ':tenant.example.com', pathname: '/dashboard' },
    c => c.text(c.params.tenant ?? ''),
  )

  assert.equal(await (await app.fetch(new Request('https://acme.example.com/dashboard'))).text(), 'acme')
})

test('the first matching route wins', async () => {
  const app = newApp()
    .get('/users/me', c => c.text('me'))
    .get('/users/:id', c => c.text('other'))

  assert.equal(await (await app.fetch(get('/users/me'))).text(), 'me')
  assert.equal(await (await app.fetch(get('/users/9'))).text(), 'other')
})

test('an explicit content type wins over the helper default', async () => {
  const app = newApp().get('/', c =>
    c.text('{}', { headers: { 'content-type': 'application/json' } }),
  )

  assert.equal((await app.fetch(get('/'))).headers.get('content-type'), 'application/json')
})

test('routes registered after the first request are still matched', async () => {
  const app = newApp().get('/first', c => c.text('first'))

  assert.equal((await app.fetch(get('/second'))).status, 404)

  app.get('/second', c => c.text('second'))

  assert.equal(await (await app.fetch(get('/second'))).text(), 'second')
})
