import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  createApp,
  css,
  defineLayout,
  defineRoute,
  defineStream,
  html,
  scripts,
  useLayout,
  staticStore,
  stripTypes,
  styles,
  useScript,
  useStyle,
  withRead,
} from '@erikt/framework'
import type { AppOptions, Context, FileStore, StaticFiles } from '@erikt/framework'

// The framework enables banner, compress, datastar and logger by default. Unit
// tests opt out of the three that write to stdout or re-encode a body.
const newApp = (options: AppOptions = {}) =>
  createApp({ banner: false, compress: false, logger: false, ...options })

const get = (path = '/') => new Request(`http://localhost${path}`)

const shell = defineLayout(
  (content, c) =>
    html`<!doctype html>
      <html>
        <head>
          <title>${c.get('title') ?? 'untitled'}</title>
        </head>
        <body>
          ${content}
        </body>
      </html>`,
)

function sourceStore(files: Record<string, string>, name = 'sources'): FileStore {
  const listing: StaticFiles = Object.fromEntries(
    Object.keys(files).map(path => [path, { size: files[path]?.length ?? 0 }]),
  )

  return withRead(staticStore(listing, { name }), async path => {
    const source = files[path]

    return source === undefined ? null : new Response(source)
  })
}

const COUNTER = 'export const start = (count: number): number => count + 1\n'

// A page asks for a layout, which is what makes its response a document — and
// a document is what carries the import map. Endpoint tests build their routes
// by hand so they stay fragments.
const page = (...names: readonly string[]) =>
  defineRoute((c: Context) => {
    useLayout(c, shell)
    useScript(c, ...names)

    return html`<h1>hi</h1>`
  })

const appWith = (files: Record<string, string>, uses: readonly string[] = ['counter']) =>
  newApp()
    .plugin(scripts({ store: sourceStore(files) }))
    .get('/', page(...uses))

const tags = async (app: ReturnType<typeof newApp>, path = '/') =>
  [...(await (await app.fetch(get(path))).text()).matchAll(/src="([^"]+)"/g)].map(
    match => match[1] ?? '',
  )

test('a page gets only the script it asks for', async () => {
  const app = appWith(
    { 'scripts/counter.ts': COUNTER, 'scripts/unused.ts': 'export const x = 1\n' },
    ['counter'],
  )

  const found = await tags(app)

  assert.equal(found.length, 1)
  assert.match(found[0] ?? '', /^\/scripts\/counter\.[0-9a-f]{8}\.js$/)
})

test('a page that asks for nothing gets nothing', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/counter.ts': COUNTER }) }))
    .get('/', defineRoute(() => html`<h1>hi</h1>`))

  const body = await (await app.fetch(get())).text()

  assert.doesNotMatch(body, /<script/)
  assert.match(body, /<h1>hi<\/h1>/)
})

test('two pages get different scripts', async () => {
  const app = newApp()
    .plugin(
      scripts({
        store: sourceStore({
          'scripts/one.ts': 'export const a: number = 1\n',
          'scripts/two.ts': 'export const b: number = 2\n',
        }),
      }),
    )
    .get('/one', page('one'))
    .get('/two', page('two'))

  assert.match((await tags(app, '/one'))[0] ?? '', /^\/scripts\/one\./)
  assert.match((await tags(app, '/two'))[0] ?? '', /^\/scripts\/two\./)
})

test('a page can ask for several, and they keep the order asked', async () => {
  const app = appWith(
    {
      'scripts/a.ts': 'export const a: number = 1\n',
      'scripts/b.ts': 'export const b: number = 2\n',
    },
    ['b', 'a'],
  )

  const found = await tags(app)

  assert.equal(found.length, 2)
  assert.match(found[0] ?? '', /^\/scripts\/b\./)
  assert.match(found[1] ?? '', /^\/scripts\/a\./)
})

test('asking twice injects one tag', async () => {
  const app = appWith({ 'scripts/counter.ts': COUNTER }, ['counter', 'counter'])

  assert.equal((await tags(app)).length, 1)
})

test('the layout can ask, so a script lands on every page', async () => {
  const everywhere = defineLayout((content, c) => {
    useScript(c, 'global')

    return html`<html><head></head><body>${content}</body></html>`
  })

  const app = newApp()
    .plugin(
      scripts({
        store: sourceStore({
          'scripts/global.ts': 'export const g: number = 0\n',
          'scripts/page.ts': 'export const p: number = 1\n',
        }),
      }),
    )
    .get(
      '/bare',
      defineRoute(c => {
        useLayout(c, everywhere)

        return html`<h1>bare</h1>`
      }),
    )
    .get(
      '/rich',
      defineRoute(c => {
        useLayout(c, everywhere)
        useScript(c, 'page')

        return html`<h1>rich</h1>`
      }),
    )

  assert.equal((await tags(app, '/bare')).length, 1)
  assert.equal((await tags(app, '/rich')).length, 2)
})

test('a name may carry its extension or a leading slash', async () => {
  const app = appWith({ 'scripts/nested/counter.ts': COUNTER }, [
    'nested/counter.ts',
    './nested/counter',
    '/nested/counter',
  ])

  assert.equal((await tags(app)).length, 1)
})

test('an unknown name still renders the page, with a tag that 404s', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/counter.ts': COUNTER }) }))
    .get('/', page('countr'))
    .onError(error => new Response(String(error), { status: 500 }))

  const response = await app.fetch(get())

  assert.equal(response.status, 200)
  assert.match(await response.text(), /<h1>hi<\/h1>/)
})

test('the tag for a missing script points at the file it could not find', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/counter.ts': COUNTER }) }))
    .get('/', page('countr'))

  const found = await tags(app)

  // Unhashed, because there was nothing to hash — which is also why it cannot
  // collide with a served asset.
  assert.deepEqual(found, ['/scripts/countr.js'])
  assert.equal((await app.fetch(get('/scripts/countr.js'))).status, 404)
})

test('a missing script does not stop the ones that are there', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/counter.ts': COUNTER }) }))
    .get('/', page('countr', 'counter'))

  const found = await tags(app)

  assert.equal(found.length, 2)
  assert.equal(found[0], '/scripts/countr.js')
  assert.match(found[1] ?? '', /^\/scripts\/counter\.[0-9a-f]{8}\.js$/)
})

test('the missing tag follows a configured base', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/counter.ts': COUNTER }), base: 'assets/js' }))
    .get('/', page('countr'))

  assert.deepEqual(await tags(app), ['/assets/js/countr.js'])
})

test('useScript without the plugin says the plugin is missing', async () => {
  const app = newApp()
    .get('/', page('counter'))
    .onError(error => new Response(String(error), { status: 500 }))

  assert.match(await (await app.fetch(get())).text(), /useScript needs the scripts plugin/)
})

test('a typescript file is served as javascript at a hashed url', async () => {
  const app = appWith({ 'scripts/counter.ts': COUNTER })
  const response = await app.fetch(get((await tags(app))[0]))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(await response.text(), 'export const start = (count        )         => count + 1\n')
})

test('an unused script is still served, it just has no tag', async () => {
  const app = appWith({ 'scripts/counter.ts': COUNTER, 'scripts/spare.ts': 'export const s = 1\n' })

  const url = (await tags(app))[0] ?? ''
  const spare = url.replace(/counter\.[0-9a-f]{8}/, 'spare')

  assert.equal((await app.fetch(get(url))).status, 200)
  assert.notEqual((await app.fetch(get(spare))).status, 200)
})

test('the hash follows the content', async () => {
  const one = (await tags(appWith({ 'scripts/counter.ts': COUNTER })))[0]
  const same = (await tags(appWith({ 'scripts/counter.ts': COUNTER })))[0]
  const other = (await tags(appWith({ 'scripts/counter.ts': `${COUNTER}// changed\n` })))[0]

  assert.equal(one, same)
  assert.notEqual(one, other)
})

test('a javascript file is served unchanged', async () => {
  const source = 'const compare = (a, b) => a < b > (c)\n'
  const app = appWith({ 'scripts/plain.js': source }, ['plain'])

  assert.equal(await (await app.fetch(get((await tags(app))[0]))).text(), source)
})

test('files outside the folder and of other extensions are not scripts', async () => {
  const app = newApp()
    .plugin(
      scripts({
        store: sourceStore({
          'scripts/counter.ts': COUNTER,
          'scripts/notes.md': '# notes\n',
          'routes/index.ts': 'export const GET = () => {}\n',
        }),
      }),
    )
    .get('/', page('notes', 'index', 'counter'))

  // Only counter.ts was registered, so it is the only name that resolves to a
  // hashed, served URL. The other two are markdown and a route file.
  const found = await tags(app)

  assert.equal(found[0], '/scripts/notes.js')
  assert.equal(found[1], '/scripts/index.js')
  assert.match(found[2] ?? '', /^\/scripts\/counter\.[0-9a-f]{8}\.js$/)
})

test('the folder and the url prefix are configurable', async () => {
  const app = newApp()
    .plugin(
      scripts({
        store: sourceStore({ 'client/counter.ts': COUNTER }),
        dir: 'client',
        base: 'assets',
      }),
    )
    .get('/', page('counter'))

  const url = (await tags(app))[0] ?? ''

  assert.match(url, /^\/assets\/counter\.[0-9a-f]{8}\.js$/)
  assert.equal((await app.fetch(get(url))).status, 200)
})

test('two scripts plugins each resolve and inject their own', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/app.ts': 'export const a: number = 1\n' }) }))
    .plugin(
      scripts({
        store: sourceStore({ 'vendor/lib.ts': 'export const l: number = 2\n' }, 'vendored'),
        dir: 'vendor',
      }),
    )
    .get('/', page('app', 'lib'))

  const found = await tags(app)

  assert.equal(found.length, 2)
  assert.match(found[0] ?? '', /^\/scripts\/app\./)
  assert.match(found[1] ?? '', /^\/vendor\/lib\./)
})

test('a route that serves no layout is left alone', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/counter.ts': COUNTER }) }))
    .get('/fragment', c => c.body('<p>bare</p>', { type: 'text/html; charset=utf-8' }))

  assert.equal(await (await app.fetch(get('/fragment'))).text(), '<p>bare</p>')
})

test('the 404 page can ask for a script too', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/counter.ts': COUNTER }) }))
    .notFound(page('counter'))

  assert.equal((await tags(app, '/nowhere')).length, 1)
})

test('a store with no read method says so by name', async () => {
  const listingOnly: FileStore = {
    name: 'listing-only',
    list: async () => [{ path: 'scripts/counter.ts' }],
  }

  const app = newApp().plugin(scripts({ store: listingOnly }))

  await assert.rejects(() => app.start(), /"listing-only" cannot read files/)
})

test('a file that lists but does not read says so by path', async () => {
  const app = newApp().plugin(
    scripts({ store: staticStore({ 'scripts/counter.ts': {} }, { name: 'no-bytes' }) }),
  )

  await assert.rejects(() => app.start(), /listed "scripts\/counter\.ts" but could not read it/)
})

test('unstrippable typescript fails at startup, naming the file', async () => {
  const app = newApp().plugin(
    scripts({ store: sourceStore({ 'scripts/bad.ts': 'enum Colour { Red }\n' }) }),
  )

  await assert.rejects(() => app.start(), /scripts\/bad\.ts/)
})

test('an empty folder still renders the page', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({}) }))
    .get('/', page('counter'))

  const response = await app.fetch(get())

  assert.equal(response.status, 200)
  assert.match(await response.text(), /<h1>hi<\/h1>/)
  assert.equal((await app.fetch(get('/scripts/counter.js'))).status, 404)
})

const endpoint = (...names: readonly string[]) =>
  defineRoute((c: Context) => {
    useScript(c, ...names)

    return html`<div id="panel">open</div>`
  })

test('an endpoint carries the script it asks for in its fragment', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get('/panel', endpoint('panel'))

  const body = await (await app.fetch(get('/panel'))).text()

  assert.match(
    body,
    /^<div id="panel">open<\/div><script type="module" id="asset-scripts-panel-[0-9a-f]{8}-js" src="\/scripts\/panel\.[0-9a-f]{8}\.js"><\/script>$/,
  )
})

test('an endpoint that asks for nothing carries nothing', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get('/panel', defineRoute(c => {

      return html`<div id="panel">open</div>`
    }))

  assert.equal(await (await app.fetch(get('/panel'))).text(), '<div id="panel">open</div>')
})

test('the script an endpoint carries is served at that url', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get('/panel', endpoint('panel'))

  const url = /src="([^"]+)"/.exec(await (await app.fetch(get('/panel'))).text())?.[1] ?? ''

  assert.equal((await app.fetch(get(url))).status, 200)
})

test('an endpoint gets no layout, so its fragment stays a fragment', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get('/panel', endpoint('panel'))

  const body = await (await app.fetch(get('/panel'))).text()

  assert.doesNotMatch(body, /<!doctype html>|<head>/)
})

test('a page and an endpoint asking for the same script do not share a request', async () => {
  const app = newApp()
    .plugin(
      scripts({
        store: sourceStore({
          'scripts/panel.ts': 'export const p: number = 1\n',
          'scripts/only.ts': 'export const o: number = 2\n',
        }),
      }),
    )
    .get('/', page('only'))
    .get('/panel', endpoint('panel'))

  assert.match((await tags(app, '/'))[0] ?? '', /^\/scripts\/only\./)
  assert.match((await tags(app, '/panel'))[0] ?? '', /^\/scripts\/panel\./)
})

test('an unknown name in a fragment carries the same 404 tag', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get('/panel', endpoint('pannel'))

  const response = await app.fetch(get('/panel'))

  assert.equal(response.status, 200)
  assert.match(await response.text(), /src="\/scripts\/pannel\.js"/)
})

const HEAD_PATCH =
  /event: datastar-patch-elements\ndata: selector head\ndata: mode append\ndata: elements <script type="module" id="(asset-[a-z0-9-]+)" src="(\/scripts\/[^"]+)"><\/script>\n\n/

test('a stream appends the script it asks for to the live head', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get(
      '/panel',
      defineStream((stream, c) => {
        useScript(c, 'panel')

        stream.patchElements(html`<div id="panel">open</div>`)
      }),
    )

  const body = await (await app.fetch(get('/panel'))).text()

  assert.match(body, HEAD_PATCH)
  assert.match(HEAD_PATCH.exec(body)?.[2] ?? '', /^\/scripts\/panel\.[0-9a-f]{8}\.js$/)
})

test('the head patch follows the markup it came with', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get(
      '/panel',
      defineStream((stream, c) => {
        useScript(c, 'panel')

        stream.patchElements(html`<div id="panel">open</div>`)
      }),
    )

  const body = await (await app.fetch(get('/panel'))).text()

  assert.ok(body.indexOf('id="panel"') < body.indexOf('selector head'))
})

test('a stream that sends nothing still delivers the script', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get(
      '/panel',
      defineStream((_stream, c) => {
        useScript(c, 'panel')
      }),
    )

  assert.match(await (await app.fetch(get('/panel'))).text(), HEAD_PATCH)
})

test('a stream sends each script once, however many events follow', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get(
      '/panel',
      defineStream((stream, c) => {
        useScript(c, 'panel')

        stream.patchSignals({ a: 1 })
        stream.patchSignals({ b: 2 })
        stream.patchSignals({ c: 3 })
      }),
    )

  const body = await (await app.fetch(get('/panel'))).text()

  assert.equal([...body.matchAll(/selector head/g)].length, 1)
})

test('a script asked for later in a stream arrives later', async () => {
  const app = newApp()
    .plugin(
      scripts({
        store: sourceStore({
          'scripts/first.ts': 'export const f: number = 1\n',
          'scripts/later.ts': 'export const l: number = 2\n',
        }),
      }),
    )
    .get(
      '/panel',
      defineStream(async (stream, c) => {
        useScript(c, 'first')
        stream.patchSignals({ step: 1 })

        await Promise.resolve()

        useScript(c, 'later')
        stream.patchSignals({ step: 2 })
      }),
    )

  const body = await (await app.fetch(get('/panel'))).text()
  const order = [...body.matchAll(/src="\/scripts\/(\w+)\./g)].map(match => match[1])

  assert.deepEqual(order, ['first', 'later'])
  assert.ok(body.indexOf('"step":2') < body.indexOf('later'))
})

test('a stream asking for nothing sends no head patch', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get('/panel', defineStream(stream => stream.patchSignals({ a: 1 })))

  assert.doesNotMatch(await (await app.fetch(get('/panel'))).text(), /selector head/)
})

test('a stream without the scripts plugin aborts rather than silently skipping', async () => {
  const app = newApp().get(
    '/panel',
    defineStream((_stream, c) => useScript(c, 'panel')),
  )

  const response = await app.fetch(get('/panel'))

  await assert.rejects(() => response.text(), /useScript needs the scripts plugin/)
})

test('scripts and styles share one head queue, in the order asked', async () => {
  const sheet = css`
    .mixed {
      color: red;
    }
  `

  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .plugin(styles())
    .get(
      '/',
      defineRoute(c => {
        useStyle(c, sheet)
        useScript(c, 'panel')

        return html`<h1>hi</h1>`
      }),
    )

  const body = await (await app.fetch(get())).text()
  const head = body.slice(0, body.indexOf('</head>'))

  assert.ok(head.indexOf('<link') < head.indexOf('<script'))
  assert.match(head, new RegExp(`href="/styles/${sheet.hash}\\.css"`))
  assert.match(head, /src="\/scripts\/panel\./)
})

const htmlUrl = async (app: ReturnType<typeof newApp>) => {
  const body = await (await app.fetch(get())).text()
  const map = /<script type="importmap">(.*?)<\/script>/.exec(body)?.[1] ?? ''

  return (
    (JSON.parse(map) as { imports: Record<string, string> }).imports['@erikt/framework/html'] ?? ''
  )
}

const IMPORTER = "import { html } from '@erikt/framework/html'\nexport const tag: string = html`<p></p>`\n"

const withHtml = () =>
  newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': IMPORTER }) }))
    .get('/', page('panel'))

test('the html helper is served for browser code to import', async () => {
  const app = withHtml()
  const url = await htmlUrl(app)

  assert.match(url, /^\/framework\/html\.[0-9a-f]{8}\.js$/)

  const served = await app.fetch(get(url))

  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.match(await served.text(), /export function html/)
})

test('what is served is derived from html.ts, not hand-written beside it', async () => {
  // The one module that runs on both sides is carried as a string, because
  // `framework` cannot read its own files. This re-derives it from the real
  // file and fails if the two have drifted.
  const app = withHtml()
  const served = await (await app.fetch(get(await htmlUrl(app)))).text()

  const source = await readFile(
    new URL('../../framework/src/helpers/html.ts', import.meta.url),
    'utf8',
  )

  assert.equal(served, stripTypes(source, { fileName: 'html.ts' }))
})

test('the served build escapes exactly as the one routes use', async () => {
  const app = withHtml()
  const served = await (await app.fetch(get(await htmlUrl(app)))).text()

  const client = (await import(`data:text/javascript,${encodeURIComponent(served)}`)) as {
    html: typeof html
  }

  for (const value of ['<img onerror=alert(1)>', 'a & b', '"quoted"', "it's", '<b>ok</b>']) {
    assert.equal(String(client.html`<p>${value}</p>`), String(html`<p>${value}</p>`))
  }
})

test('a page whose scripts do not import it gets no map', async () => {
  const app = newApp()
    .plugin(scripts({ store: sourceStore({ 'scripts/panel.ts': COUNTER }) }))
    .get('/', page('panel'))

  // The helper is opt-in like everything else: nothing imports it, so no entry
  // is claimed and the page carries no import map at all.
  assert.doesNotMatch(await (await app.fetch(get())).text(), /importmap/)
})
