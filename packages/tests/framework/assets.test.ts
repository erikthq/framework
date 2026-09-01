import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assets, createApp, defineRoute, staticStore, withRead } from '@erikt/framework'
import type { AppOptions, FileStore, StaticFiles } from '@erikt/framework'
import { nodeStore } from '@erikt/framework-node'

// The framework enables banner, compress, datastar and logger by default. Unit
// tests opt out of the three that write to stdout or re-encode a body.
const newApp = (options: AppOptions = {}) =>
  createApp({ banner: false, compress: false, logger: false, ...options })

const get = (path: string, headers?: Record<string, string>) =>
  new Request(`http://localhost${path}`, headers === undefined ? {} : { headers })

const MODIFIED = 'Wed, 26 Aug 2026 12:03:08 GMT'

// A store shaped like the real ones: bytes plus the two headers they set.
function fileStore(files: Record<string, string>, name = 'files'): FileStore {
  const listing: StaticFiles = Object.fromEntries(Object.keys(files).map(path => [path, {}]))

  return withRead(staticStore(listing, { name }), async path => {
    const body = files[path]

    if (body === undefined) return null

    // Bytes, not a string: a string body makes Response set a content-type of
    // its own, which the real stores never do.
    const bytes = new TextEncoder().encode(body)

    return new Response(bytes, {
      headers: {
        'content-length': String(bytes.byteLength),
        'last-modified': MODIFIED,
      },
    })
  })
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'

const appWith = (files: Record<string, string>, options: Partial<Parameters<typeof assets>[0]> = {}) =>
  newApp().plugin(assets({ store: fileStore(files), ...options }))

test('a file is served as it is, with a type from its extension', async () => {
  const app = appWith({ 'public/favicon.svg': ICON })
  const response = await app.fetch(get('/favicon.svg'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/svg+xml')
  assert.equal(await response.text(), ICON)
})

test('the served bytes are untouched', async () => {
  const app = appWith({ 'public/notes.txt': 'first\nsecond\n' })

  assert.equal(await (await app.fetch(get('/notes.txt'))).text(), 'first\nsecond\n')
})

test('caching headers are set', async () => {
  const app = appWith({ 'public/favicon.svg': ICON })
  const response = await app.fetch(get('/favicon.svg'))

  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.match(response.headers.get('etag') ?? '', /^W\/"[0-9a-f]+-[0-9a-f]+"$/)
})

test('cache-control is configurable', async () => {
  const app = appWith({ 'public/favicon.svg': ICON }, { cacheControl: 'public, max-age=60' })

  assert.equal(
    (await app.fetch(get('/favicon.svg'))).headers.get('cache-control'),
    'public, max-age=60',
  )
})

test('a matching if-none-match is a 304 with no body', async () => {
  const app = appWith({ 'public/favicon.svg': ICON })
  const etag = (await app.fetch(get('/favicon.svg'))).headers.get('etag') ?? ''

  const response = await app.fetch(get('/favicon.svg', { 'if-none-match': etag }))

  assert.equal(response.status, 304)
  assert.equal(await response.text(), '')
  assert.equal(response.headers.get('etag'), etag)
  assert.equal(response.headers.get('content-length'), null)
})

test('a star if-none-match is a 304', async () => {
  const app = appWith({ 'public/favicon.svg': ICON })

  assert.equal((await app.fetch(get('/favicon.svg', { 'if-none-match': '*' }))).status, 304)
})

test('a stale if-none-match serves the file', async () => {
  const app = appWith({ 'public/favicon.svg': ICON })
  const response = await app.fetch(get('/favicon.svg', { 'if-none-match': 'W/"other"' }))

  assert.equal(response.status, 200)
  assert.equal(await response.text(), ICON)
})

test('if-modified-since is honoured when there is no if-none-match', async () => {
  const app = appWith({ 'public/favicon.svg': ICON })

  assert.equal((await app.fetch(get('/favicon.svg', { 'if-modified-since': MODIFIED }))).status, 304)
  assert.equal(
    (await app.fetch(get('/favicon.svg', { 'if-modified-since': 'Tue, 25 Aug 2026 00:00:00 GMT' })))
      .status,
    200,
  )
})

test('if-none-match wins over if-modified-since', async () => {
  const app = appWith({ 'public/favicon.svg': ICON })

  const response = await app.fetch(
    get('/favicon.svg', { 'if-none-match': 'W/"other"', 'if-modified-since': MODIFIED }),
  )

  assert.equal(response.status, 200)
})

test('a range is served as 206 with a content-range', async () => {
  const app = appWith({ 'public/notes.txt': 'abcdefghij' })
  const response = await app.fetch(get('/notes.txt', { range: 'bytes=2-5' }))

  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(response.headers.get('content-length'), '4')
  assert.equal(await response.text(), 'cdef')
})

test('an open-ended range runs to the last byte', async () => {
  const app = appWith({ 'public/notes.txt': 'abcdefghij' })
  const response = await app.fetch(get('/notes.txt', { range: 'bytes=7-' }))

  assert.equal(response.headers.get('content-range'), 'bytes 7-9/10')
  assert.equal(await response.text(), 'hij')
})

test('a suffix range counts back from the end', async () => {
  const app = appWith({ 'public/notes.txt': 'abcdefghij' })
  const response = await app.fetch(get('/notes.txt', { range: 'bytes=-3' }))

  assert.equal(response.headers.get('content-range'), 'bytes 7-9/10')
  assert.equal(await response.text(), 'hij')
})

test('a range past the end is a 416', async () => {
  const app = appWith({ 'public/notes.txt': 'abcdefghij' })
  const response = await app.fetch(get('/notes.txt', { range: 'bytes=50-60' }))

  assert.equal(response.status, 416)
  assert.equal(response.headers.get('content-range'), 'bytes */10')
})

test('a range the spec lets us ignore serves the whole file', async () => {
  const app = appWith({ 'public/notes.txt': 'abcdefghij' })

  for (const range of ['bytes=0-1,4-5', 'items=0-1', 'nonsense']) {
    const response = await app.fetch(get('/notes.txt', { range }))

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'abcdefghij')
  }
})

test('HEAD answers with the headers and no body', async () => {
  const app = appWith({ 'public/favicon.svg': ICON })
  const response = await app.fetch(
    new Request('http://localhost/favicon.svg', { method: 'HEAD' }),
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/svg+xml')
  assert.equal(await response.text(), '')
})

// What the router answers with when the assets plugin did not claim the path.
const notFound = defineRoute(c => {
  c.status(404)

  return 'mine'
})

test('an unknown path falls through to the router', async () => {
  const app = appWith({ 'public/favicon.svg': ICON }).notFound(notFound)
  const response = await app.fetch(get('/nope.svg'))

  assert.equal(response.status, 404)
  assert.equal(await response.text(), 'mine')
})

test('a real route is not shadowed', async () => {
  const app = appWith({ 'public/favicon.svg': ICON }).get('/', defineRoute(() => 'home'))

  assert.equal(await (await app.fetch(get('/'))).text(), 'home')
})

test('a file outside the served directory is not reachable', async () => {
  const app = appWith({ 'public/favicon.svg': ICON, 'private/secret.txt': 'no' }).notFound(
    notFound,
  )

  assert.equal((await app.fetch(get('/secret.txt'))).status, 404)
  assert.equal((await app.fetch(get('/private/secret.txt'))).status, 404)
})

test('a write method falls through', async () => {
  const app = appWith({ 'public/favicon.svg': ICON }).post('/favicon.svg', defineRoute(() => 'posted'))

  const response = await app.fetch(
    new Request('http://localhost/favicon.svg', { method: 'POST' }),
  )

  assert.equal(await response.text(), 'posted')
})

test('the url prefix is configurable', async () => {
  const app = appWith({ 'public/favicon.svg': ICON }, { base: 'static' }).notFound(notFound)

  assert.equal((await app.fetch(get('/static/favicon.svg'))).status, 200)
  assert.equal((await app.fetch(get('/favicon.svg'))).status, 404)
})

test('the directory is configurable', async () => {
  const app = appWith({ 'web/favicon.svg': ICON }, { dir: 'web' })

  assert.equal((await app.fetch(get('/favicon.svg'))).status, 200)
})

test('nested files keep their path', async () => {
  const app = appWith({ 'public/img/logo.png': 'png-bytes' })
  const response = await app.fetch(get('/img/logo.png'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
})

test('an unknown extension is served without a guessed type', async () => {
  const app = appWith({ 'public/thing.weird': 'data' })
  const response = await app.fetch(get('/thing.weird'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), null)
  assert.equal(await response.text(), 'data')
})

test('the type table can be extended', async () => {
  const app = appWith({ 'public/thing.weird': 'data' }, { types: { '.weird': 'application/weird' } })

  assert.equal(
    (await app.fetch(get('/thing.weird'))).headers.get('content-type'),
    'application/weird',
  )
})

test('a store that cannot read files says so by name', async () => {
  const listingOnly: FileStore = {
    name: 'listing-only',
    list: async () => [{ path: 'public/favicon.svg' }],
  }

  const app = newApp().plugin(assets({ store: listingOnly }))

  await assert.rejects(() => app.start(), /"listing-only" cannot read files/)
})

test('files on disk are served through nodeStore', async () => {
  const store = nodeStore(new URL('../fixtures/', import.meta.url))
  const app = newApp().plugin(assets({ store, dir: 'public' }))

  const response = await app.fetch(get('/hello.txt'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.match(await response.text(), /hello from the store/)

  const etag = response.headers.get('etag') ?? ''

  assert.equal((await app.fetch(get('/hello.txt', { 'if-none-match': etag }))).status, 304)
})

test('a content-type the store sets wins over the table', async () => {
  const store = withRead(staticStore({ 'public/odd.txt': {} }, { name: 'typed' }), async () => {
    const bytes = new TextEncoder().encode('data')

    return new Response(bytes, {
      headers: {
        'content-type': 'application/x-store-said-so',
        'content-length': String(bytes.byteLength),
        'last-modified': MODIFIED,
      },
    })
  })

  const app = newApp().plugin(assets({ store }))

  assert.equal(
    (await app.fetch(get('/odd.txt'))).headers.get('content-type'),
    'application/x-store-said-so',
  )
})
