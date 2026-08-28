import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createApp, fileRouter, generateStore } from 'framework'
import type { FileStore } from 'framework'
import { nodeStore } from 'node-adapter'

const fixtures = new URL('../fixtures/', import.meta.url)

const newApp = (store: FileStore) =>
  createApp({ banner: false, compress: false, logger: false }).plugin(
    fileRouter({ store, dir: 'routes' }),
  )

const get = (path: string, method = 'GET') =>
  new Request(`http://localhost${path}`, { method })

const visible = (paths: readonly string[]) =>
  paths.filter(path => !path.split('/').some(part => part.startsWith('.'))).sort()

test('lists every file as a path relative to the directory', async () => {
  const files = await nodeStore(fixtures).list()

  assert.deepEqual(visible(files.map(file => file.path)), [
    'layouts/main.html',
    'public/hello.txt',
    'routes/_lib/shared.ts',
    'routes/about.ts',
    'routes/index.ts',
    'routes/notes.md',
    'routes/notes/[...rest].ts',
    'routes/users/[id].ts',
    'routes/users/me.ts',
  ])
})

test('the listing can be narrowed by prefix and extension', async () => {
  const files = await nodeStore(fixtures).list({ prefix: 'routes/', extensions: ['.ts'] })

  assert.deepEqual(visible(files.map(file => file.path)), [
    'routes/_lib/shared.ts',
    'routes/about.ts',
    'routes/index.ts',
    'routes/notes/[...rest].ts',
    'routes/users/[id].ts',
    'routes/users/me.ts',
  ])
})

test('a directory given as a path works as well as a url', async () => {
  const files = await nodeStore(fixtures.pathname).list({ prefix: 'public/' })

  assert.deepEqual(
    files.map(file => file.path),
    ['public/hello.txt'],
  )
})

test('a module with a bracketed filename imports', async () => {
  const module = await nodeStore(fixtures).import('routes/users/[id].ts')

  assert.equal(typeof (module as { GET?: unknown }).GET, 'function')
})

test('reading a file returns its bytes with its metadata', async () => {
  const response = await nodeStore(fixtures).read('public/hello.txt')

  assert.equal(await response?.text(), 'hello from the store\n')
  assert.equal(response?.headers.get('content-length'), '21')
  assert.notEqual(response?.headers.get('last-modified'), null)
})

test('reading a file that is not there returns null', async () => {
  assert.equal(await nodeStore(fixtures).read('public/missing.txt'), null)
})

test('reading refuses to leave the directory', async () => {
  const store = nodeStore(fixtures)

  await assert.rejects(() => store.read('../../../etc/passwd'), /outside the store/)
  await assert.rejects(() => store.read('/etc/passwd'), /outside the store/)
  await assert.rejects(() => store.import('../../package.json'), /outside the store/)
})

test('an app serves the routes it finds on disk', async () => {
  const app = newApp(nodeStore(fixtures))

  assert.equal(await (await app.fetch(get('/'))).text(), 'home')
  assert.equal(await (await app.fetch(get('/about'))).text(), 'about')
  assert.deepEqual(await (await app.fetch(get('/users/7'))).json(), { id: '7' })
  assert.deepEqual(await (await app.fetch(get('/users/me'))).json(), { id: 'me' })
  assert.equal((await app.fetch(get('/users/7', 'POST'))).status, 201)
  assert.equal(await (await app.fetch(get('/notes/a/b', 'PUT'))).text(), 'PUT a/b')
  assert.equal((await app.fetch(get('/_lib/shared'))).status, 404)
  assert.equal((await app.fetch(get('/notes.md'))).status, 404)
})

test('the routes found on disk are reported in a stable order', async () => {
  const app = newApp(nodeStore(fixtures))

  await app.start()

  assert.deepEqual(app.routes, [
    { method: 'GET', pattern: '/' },
    { method: 'GET', pattern: '/about' },
    { method: 'GET', pattern: '/users/me' },
    { method: 'GET', pattern: '/users/:id' },
    { method: 'POST', pattern: '/users/:id' },
    { method: 'ALL', pattern: '/notes{/:rest}*' },
  ])
})

test('a store generated from a listing serves the same routes', async () => {
  const disk = nodeStore(fixtures)
  const entries = await disk.list({ prefix: 'routes/', extensions: ['.ts'] })
  const directory = await mkdtemp(join(import.meta.dirname, '.tmp-store-'))

  try {
    const file = join(directory, 'store.ts')

    await writeFile(file, generateStore(entries, { base: fixtures.href, name: 'baked' }))

    const generated = (await import(pathToFileURL(file).href)) as { store: FileStore }
    const baked = newApp(generated.store)
    const live = newApp(disk)

    await baked.start()
    await live.start()

    assert.equal(generated.store.import === undefined, false)
    assert.equal(generated.store.read === undefined, false)
    assert.deepEqual(baked.routes, live.routes)
    assert.deepEqual(await (await baked.fetch(get('/users/7'))).json(), { id: '7' })
    assert.equal(await (await baked.fetch(get('/notes/a/b', 'PUT'))).text(), 'PUT a/b')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
