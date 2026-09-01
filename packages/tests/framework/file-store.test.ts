import { test } from 'node:test'
import assert from 'node:assert/strict'

import { generateStore, listFiles, staticStore, withRead } from '@erikt/framework'
import type { FileStore } from '@erikt/framework'

const naive = (paths: readonly string[]): FileStore => ({
  name: 'naive',
  list: async () => paths.map(path => ({ path })),
})

test('a static store lists the files it was given', async () => {
  const store = staticStore({
    'index.ts': async () => ({}),
    'logo.svg': {},
  })

  assert.deepEqual(await listFiles(store), [{ path: 'index.ts' }, { path: 'logo.svg' }])
})

test('a function entry is shorthand for a module', async () => {
  const store = staticStore({ 'index.ts': async () => ({ answer: 42 }) })

  assert.deepEqual(await store.import?.('index.ts'), { answer: 42 })
})

test('a static store reads an entry that supplies bytes', async () => {
  const store = staticStore({
    'hello.txt': { read: async () => new Response('hi'), size: 2 },
  })
  const response = await store.read?.('hello.txt')

  assert.equal(await response?.text(), 'hi')
  assert.deepEqual(await listFiles(store), [{ path: 'hello.txt', size: 2 }])
})

test('reading an entry with no bytes returns null rather than throwing', async () => {
  const store = staticStore({ 'index.ts': async () => ({}) })

  assert.equal(await store.read?.('index.ts'), null)
  assert.equal(await store.read?.('nothing.txt'), null)
})

test('importing an entry with no module is an error', async () => {
  const store = staticStore({ 'logo.svg': {} }, { name: 'assets' })

  await assert.rejects(async () => store.import?.('logo.svg'), /has no module/)
})

test('the prefix is applied even when the store ignores it', async () => {
  const store = naive(['routes/index.ts', 'layouts/main.html'])

  assert.deepEqual(await listFiles(store, { prefix: 'routes' }), [{ path: 'routes/index.ts' }])
})

test('the extensions are applied even when the store ignores them', async () => {
  const store = naive(['index.ts', 'notes.md'])

  assert.deepEqual(await listFiles(store, { extensions: ['.ts'] }), [{ path: 'index.ts' }])
})

test('a listing comes back in a stable order whatever order the store used', async () => {
  const store = naive(['b.ts', 'a.ts', 'c/a.ts'])

  assert.deepEqual(
    (await listFiles(store)).map(file => file.path),
    ['a.ts', 'b.ts', 'c/a.ts'],
  )
})

test('decomposed unicode in a path is normalized', async () => {
  const store = naive(['cafe\u0301.ts'])

  assert.deepEqual(
    (await listFiles(store)).map(file => file.path),
    ['caf\u00e9.ts'],
  )
})

test('a path listed twice is listed once', async () => {
  const store = naive(['a.ts', 'a.ts'])

  assert.deepEqual(await listFiles(store), [{ path: 'a.ts' }])
})

test('metadata the store reports is carried through', async () => {
  const store: FileStore = {
    name: 'meta',
    list: async () => [{ path: 'a.ts', size: 12, modified: 1000 }],
  }

  assert.deepEqual(await listFiles(store), [{ path: 'a.ts', size: 12, modified: 1000 }])
})

test('a path that leaves the store is rejected', async () => {
  await assert.rejects(() => listFiles(naive(['../secret.ts'])), /unusable path/)
  await assert.rejects(() => listFiles(naive(['a/../../secret.ts'])), /unusable path/)
  await assert.rejects(() => listFiles(naive(['./a.ts'])), /unusable path/)
  await assert.rejects(() => listFiles(naive(['a\\b.ts'])), /unusable path/)
  await assert.rejects(() => listFiles(naive([''])), /unusable path/)
})

test('a leading slash is tolerated rather than rejected', async () => {
  assert.deepEqual(await listFiles(naive(['/a.ts'])), [{ path: 'a.ts' }])
})

test('withRead gives a store a read without touching the rest of it', async () => {
  const listed = staticStore({ 'index.ts': async () => ({ GET: 1 }) })
  const store = withRead(listed, async path => new Response(`bytes of ${path}`))

  assert.deepEqual(await listFiles(store), [{ path: 'index.ts' }])
  assert.deepEqual(await store.import?.('index.ts'), { GET: 1 })
  assert.equal(await (await store.read?.('index.ts'))?.text(), 'bytes of index.ts')
})

test('withRead leaves a store that cannot import unable to import', async () => {
  const store = withRead(naive(['a.txt']), async () => null)

  assert.equal(store.import, undefined)
})

test('a generated store imports the modules and lists the rest', () => {
  const source = generateStore([{ path: 'logo.svg', size: 9 }, { path: 'index.ts' }], {
    base: './routes/',
    name: 'baked',
  })

  assert.match(source, /import \{ staticStore \} from "@erikt\/framework"/)
  assert.match(source, /"index\.ts": \{ import: \(\) => import\("\.\/routes\/index\.ts"\) \}/)
  assert.match(source, /"logo\.svg": \{ size: 9 \}/)
  assert.match(source, /\{ name: "baked" \}/)
})

test('a generated store is sorted and free of timestamps', () => {
  const entries = [
    { path: 'b.ts', modified: 1234 },
    { path: 'a.ts', modified: 5678 },
  ]

  const source = generateStore(entries)

  assert.ok(source.indexOf('"a.ts"') < source.indexOf('"b.ts"'))
  assert.equal(source.includes('modified'), false)
  assert.equal(source, generateStore(entries))
})

test('a base that would emit a bare specifier is rejected', () => {
  assert.throws(() => generateStore([{ path: 'a.ts' }], { base: 'routes/' }), /bare specifier/)
})

test('a url base is accepted', () => {
  const source = generateStore([{ path: 'a.ts' }], { base: 'file:///app/routes/' })

  assert.match(source, /import\("file:\/\/\/app\/routes\/a\.ts"\)/)
})

test('a dot directory keeps its dot', async () => {
  const store = naive(['.well-known/x.txt', 'well-known/x.txt'])

  assert.deepEqual(await listFiles(store, { prefix: '.well-known' }), [
    { path: '.well-known/x.txt' },
  ])
})

test('the prefix reaches the store already normalized', async () => {
  const seen: (string | undefined)[] = []
  const store: FileStore = {
    name: 'spy',
    list: async options => {
      seen.push(options?.prefix)

      return [{ path: 'routes/index.ts' }]
    },
  }

  await listFiles(store, { prefix: './routes' })

  assert.deepEqual(seen, ['routes/'])
})
