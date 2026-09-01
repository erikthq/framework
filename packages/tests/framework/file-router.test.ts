import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp, defineRoute, fileRouter, patternFromFilePath, staticStore } from '@erikt/framework'
import type { Context, FileStore, RouteModule } from '@erikt/framework'

// The framework enables banner, compress and logger by default. Unit tests opt
// out so each one measures only what it registers itself.
const newApp = () => createApp({ banner: false, compress: false, logger: false })

const get = (path = '/', method = 'GET') =>
  new Request(`http://localhost${path}`, { method })

const files = (modules: Record<string, RouteModule>) =>
  staticStore(
    Object.fromEntries(Object.entries(modules).map(([path, module]) => [path, async () => module])),
  )

const mount = (modules: Record<string, RouteModule>, dir?: string) =>
  newApp().plugin(
    fileRouter({ store: files(modules), ...(dir === undefined ? {} : { dir }) }),
  )

const text = async (path: string, modules: Record<string, RouteModule>) => {
  const response = await mount(modules).fetch(get(path))

  return `${response.status} ${await response.text()}`
}

test('an index file serves the root', async () => {
  assert.equal(await text('/', { 'index.ts': { GET: defineRoute(() => 'home') } }), '200 home')
})

test('a named file serves its own path', async () => {
  assert.equal(await text('/about', { 'about.ts': { GET: defineRoute(() => 'about') } }), '200 about')
})

test('a directory index file serves the directory path', async () => {
  const modules = { 'blog/index.ts': { GET: defineRoute(() => 'blog') } }

  assert.equal(await text('/blog', modules), '200 blog')
})

test('a bracket segment becomes a named parameter', async () => {
  const modules = { 'users/[id].ts': { GET: defineRoute(c => `user ${c.params.id}`) } }

  assert.equal(await text('/users/7', modules), '200 user 7')
})

test('a catch-all segment captures the rest of the path', async () => {
  const modules = { 'files/[...rest].ts': { GET: defineRoute(c => `${c.params.rest}`) } }

  assert.equal(await text('/files/a/b/c', modules), '200 a/b/c')
})

test('a catch-all segment also matches the directory itself', async () => {
  const modules = { 'files/[...rest].ts': { GET: defineRoute(c => `${c.params.rest}`) } }

  assert.equal(await text('/files', modules), '200 undefined')
})

test('a doubled bracket segment is optional', async () => {
  const modules = { 'posts/[[page]].ts': { GET: defineRoute(c => `${c.params.page}`) } }

  assert.equal(await text('/posts', modules), '200 undefined')
  assert.equal(await text('/posts/2', modules), '200 2')
})

test('a parenthesised directory does not appear in the path', async () => {
  const modules = { '(marketing)/pricing.ts': { GET: defineRoute(() => 'pricing') } }

  assert.equal(await text('/pricing', modules), '200 pricing')
  assert.equal(await text('/(marketing)/pricing', modules), '404 404 Not Found')
})

test('files and directories prefixed with an underscore are not routed', async () => {
  const modules = {
    '_helper.ts': { GET: defineRoute(() => 'helper') },
    '_lib/thing.ts': { GET: defineRoute(() => 'thing') },
  }

  assert.equal(await text('/_helper', modules), '404 404 Not Found')
  assert.equal(await text('/_lib/thing', modules), '404 404 Not Found')
  assert.deepEqual(mount(modules).routes, [])
})

test('method exports route by method', async () => {
  const modules = {
    'items/index.ts': {
      GET: defineRoute(() => 'list'),
      POST: defineRoute(c => {
        c.status(201)

        return 'created'
      }),
    },
  }
  const app = mount(modules)

  assert.equal(await (await app.fetch(get('/items'))).text(), 'list')
  assert.equal((await app.fetch(get('/items', 'POST'))).status, 201)
  assert.equal((await app.fetch(get('/items', 'DELETE'))).status, 405)
})

test('a default export answers every method', async () => {
  const modules = { 'ping.ts': { default: defineRoute(c => c.req.method) } }
  const app = mount(modules)

  assert.equal(await (await app.fetch(get('/ping'))).text(), 'GET')
  assert.equal(await (await app.fetch(get('/ping', 'PUT'))).text(), 'PUT')
})

test('a method export wins over the default export in the same file', async () => {
  const modules = {
    'ping.ts': {
      default: defineRoute(() => 'any'),
      POST: defineRoute(() => 'posted'),
    },
  }
  const app = mount(modules)

  assert.equal(await (await app.fetch(get('/ping', 'POST'))).text(), 'posted')
  assert.equal(await (await app.fetch(get('/ping', 'GET'))).text(), 'any')
})

test('a static path beats a parameter whatever order the source lists them in', async () => {
  const modules = {
    'users/[id].ts': { GET: defineRoute(() => 'param') },
    'users/me.ts': { GET: defineRoute(() => 'me') },
  }

  assert.equal(await text('/users/me', modules), '200 me')
  assert.equal(await text('/users/7', modules), '200 param')
})

test('a parameter beats an optional parameter at the same depth', async () => {
  const modules = {
    'posts/[[page]].ts': { GET: defineRoute(() => 'optional') },
    'posts/[id].ts': { GET: defineRoute(() => 'param') },
  }

  assert.equal(await text('/posts/7', modules), '200 param')
  assert.equal(await text('/posts', modules), '200 optional')
})

test('a catch-all is the last resort', async () => {
  const modules = {
    'files/[...rest].ts': { GET: defineRoute(() => 'catch-all') },
    'files/logo.png.ts': { GET: defineRoute(() => 'logo') },
    'files/[name]/raw.ts': { GET: defineRoute(() => 'raw') },
  }

  assert.equal(await text('/files/logo.png', modules), '200 logo')
  assert.equal(await text('/files/x/raw', modules), '200 raw')
  assert.equal(await text('/files/x/y', modules), '200 catch-all')
})

test('a pattern export overrides the path convention', async () => {
  const modules = {
    'legacy.ts': { pattern: '/v1/legacy/:id', GET: defineRoute(c => `${c.params.id}`) },
  }

  assert.equal(await text('/v1/legacy/9', modules), '200 9')
  assert.equal(await text('/legacy', modules), '404 404 Not Found')
})

test('a use export scopes middleware to the route', async () => {
  const modules = {
    'guarded.ts': {
      use: async (c: Context, next: () => Promise<Response>) => {
        const response = await next()

        response.headers.set('x-guarded', 'yes')

        return response
      },
      GET: defineRoute(() => 'ok'),
    },
    'open.ts': { GET: defineRoute(() => 'ok') },
  }
  const app = mount(modules)

  assert.equal((await app.fetch(get('/guarded'))).headers.get('x-guarded'), 'yes')
  assert.equal((await app.fetch(get('/open'))).headers.get('x-guarded'), null)
})

test('the routes it registers are reported by the app', async () => {
  const app = mount({
    'index.ts': { GET: defineRoute(() => 'home') },
    'users/[id].ts': { GET: defineRoute(() => 'user'), POST: defineRoute(() => 'saved') },
  })

  await app.start()

  assert.deepEqual(app.routes, [
    { method: 'GET', pattern: '/' },
    { method: 'GET', pattern: '/users/:id' },
    { method: 'POST', pattern: '/users/:id' },
  ])
})

test('two files claiming the same method and path are rejected', async () => {
  const app = mount({
    'about.ts': { GET: defineRoute(() => 'a') },
    'about/index.ts': { GET: defineRoute(() => 'b') },
  })

  await assert.rejects(app.start(), /already registered/)
})

test('a route file that exports no handler is rejected', async () => {
  const app = mount({ 'empty.ts': {} })

  await assert.rejects(app.start(), /exports no handler/)
})

test('a catch-all that is not the last segment is rejected', async () => {
  const app = mount({ '[...rest]/edit.ts': { GET: defineRoute(() => 'x') } })

  await assert.rejects(app.start(), /catch-all segment that is not last/)
})

test('an unusable parameter name is rejected', async () => {
  const app = mount({ 'users/[my-id].ts': { GET: defineRoute(() => 'x') } })

  await assert.rejects(app.start(), /invalid parameter name/)
})

test('paths map to patterns', () => {
  assert.equal(patternFromFilePath('index.ts'), '/')
  assert.equal(patternFromFilePath('about.ts'), '/about')
  assert.equal(patternFromFilePath('about/index.ts'), '/about')
  assert.equal(patternFromFilePath('users/[id].ts'), '/users/:id')
  assert.equal(patternFromFilePath('files/[...rest].ts'), '/files{/:rest}*')
  assert.equal(patternFromFilePath('posts/[[page]].ts'), '/posts{/:page}?')
  assert.equal(patternFromFilePath('(marketing)/pricing.ts'), '/pricing')
  assert.equal(patternFromFilePath('_helper.ts'), null)
  assert.equal(patternFromFilePath('_lib/thing.ts'), null)
})

test('dir scopes the router to part of the store', async () => {
  const app = mount(
    {
      'routes/index.ts': { GET: defineRoute(() => 'home') },
      'routes/about.ts': { GET: defineRoute(() => 'about') },
      'layouts/main.ts': { GET: defineRoute(() => 'layout') },
    },
    'routes',
  )

  assert.equal(await (await app.fetch(get('/'))).text(), 'home')
  assert.equal(await (await app.fetch(get('/about'))).text(), 'about')
  assert.equal((await app.fetch(get('/main'))).status, 404)
  assert.equal((await app.fetch(get('/layouts/main'))).status, 404)
})

test('a declaration file is not a route', async () => {
  const app = mount({
    'index.ts': { GET: defineRoute(() => 'home') },
    'types.d.ts': {},
  })

  await app.start()

  assert.deepEqual(app.routes, [{ method: 'GET', pattern: '/' }])
})

test('a file whose extension is not a module is ignored', async () => {
  const app = mount({
    'index.ts': { GET: defineRoute(() => 'home') },
    'notes.md': {},
  })

  await app.start()

  assert.deepEqual(app.routes, [{ method: 'GET', pattern: '/' }])
})

test('a store that cannot import modules is rejected with a way out', async () => {
  const store: FileStore = { name: 'assets-only', list: async () => [{ path: 'index.ts' }] }
  const app = newApp().plugin(fileRouter({ store }))

  await assert.rejects(app.start(), /"assets-only" cannot import modules/)
})

test('an export that is not a function is rejected', async () => {
  const app = mount({ 'index.ts': { GET: 'not a handler' } as unknown as RouteModule })

  await assert.rejects(app.start(), /exports GET but it is not a function/)
})
