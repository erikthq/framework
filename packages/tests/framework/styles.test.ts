import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createApp,
  css,
  defineLayout,
  defineRoute,
  defineStream,
  html,
  styles,
  useLayout,
  useStyle,
} from '@erikt/framework'
import type { AppOptions, Style } from '@erikt/framework'

// The framework enables banner, compress, datastar and logger by default. Unit
// tests opt out of the three that write to stdout or re-encode a body.
const newApp = (options: AppOptions = {}) =>
  createApp({ banner: false, compress: false, logger: false, ...options })

const get = (path = '/') => new Request(`http://localhost${path}`)

const shell = defineLayout(
  content => html`<!doctype html><html><head></head><body>${content}</body></html>`,
)

const PANEL = css`
  .panel {
    color: rebeccapurple;
  }
`

// A page asks for a layout, which is what makes its response a document. The
// endpoint tests below build their routes by hand so they stay fragments.
const page = (...used: readonly Style[]) =>
  defineRoute(c => {
    useLayout(c, shell)
    useStyle(c, ...used)

    return html`<div class="panel">hi</div>`
  })

const appWith = (...used: readonly Style[]) =>
  newApp()
    .plugin(styles())
    .get('/', page(...used))

const links = async (app: ReturnType<typeof newApp>, path = '/') =>
  [...(await (await app.fetch(get(path))).text()).matchAll(/href="([^"]+)"/g)].map(
    match => match[1] ?? '',
  )

test('css returns a stable hash for the same text', () => {
  const one = css`
    .a {
      color: red;
    }
  `
  const same = css`
    .a {
      color: red;
    }
  `
  const other = css`
    .a {
      color: blue;
    }
  `

  assert.match(one.hash, /^[0-9a-f]{12}$/)
  assert.equal(one.hash, same.hash)
  assert.notEqual(one.hash, other.hash)
})

test('identical css is one stylesheet, whoever wrote it', () => {
  const one = css`
    .b {
      margin: 0;
    }
  `
  const same = css`
    .b {
      margin: 0;
    }
  `

  assert.equal(one, same)
})

test('surrounding whitespace does not change the hash', () => {
  const tight = css`.c { padding: 0 }`
  const loose = css`
    .c { padding: 0 }
  `

  assert.equal(tight.hash, loose.hash)
})

test('interpolated values become part of the css', () => {
  const colour = 'tomato'
  const style = css`
    .d {
      color: ${colour};
    }
  `

  assert.match(style.text, /color: tomato;/)
})

test('a page gets a link for the stylesheet it asks for', async () => {
  const found = await links(appWith(PANEL))

  assert.equal(found.length, 1)
  assert.equal(found[0], `/styles/${PANEL.hash}.css`)
})

test('the link lands in the head', async () => {
  const body = await (await appWith(PANEL).fetch(get())).text()

  assert.match(
    body,
    new RegExp(
      `<link rel="stylesheet" id="asset-styles-${PANEL.hash}-css" href="/styles/${PANEL.hash}\\.css" /></head>`,
    ),
  )
})

test('a page that asks for nothing gets no link', async () => {
  const app = newApp()
    .plugin(styles())
    .get('/', defineRoute(() => html`<p>plain</p>`))

  assert.doesNotMatch(await (await app.fetch(get())).text(), /<link/)
})

test('the stylesheet is served at its hashed url', async () => {
  const app = appWith(PANEL)
  const response = await app.fetch(get(`/styles/${PANEL.hash}.css`))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(await response.text(), PANEL.text)
  assert.match(await (await app.fetch(get(`/styles/${PANEL.hash}.css`))).text(), /rebeccapurple/)
})

test('an unknown hash is a 404', async () => {
  const app = appWith(PANEL)

  assert.equal((await app.fetch(get('/styles/deadbeefcafe.css'))).status, 404)
})

test('a stylesheet is served even before any page has asked for it', async () => {
  const orphan = css`
    .orphan {
      display: none;
    }
  `
  const app = newApp().plugin(styles()).get('/', defineRoute(() => html`<p>x</p>`))

  assert.equal((await app.fetch(get(`/styles/${orphan.hash}.css`))).status, 200)
})

test('asking twice injects one link', async () => {
  const found = await links(appWith(PANEL, PANEL))

  assert.equal(found.length, 1)
})

test('several stylesheets keep the order asked', async () => {
  const first = css`
    .e {
      top: 0;
    }
  `
  const second = css`
    .f {
      top: 1px;
    }
  `

  const found = await links(appWith(second, first))

  assert.deepEqual(found, [`/styles/${second.hash}.css`, `/styles/${first.hash}.css`])
})

test('the url prefix is configurable', async () => {
  const app = newApp()
    .plugin(styles({ base: 'assets/css' }))
    .get('/', page(PANEL))

  const found = await links(app)

  assert.equal(found[0], `/assets/css/${PANEL.hash}.css`)
  assert.equal((await app.fetch(get(found[0] ?? ''))).status, 200)
})

test('useStyle without the plugin says the plugin is missing', async () => {
  const app = newApp()
    .get('/', page(PANEL))
    .onError(error => new Response(String(error), { status: 500 }))

  assert.match(await (await app.fetch(get())).text(), /useStyle needs the styles plugin/)
})

test('an endpoint carries its link in the fragment', async () => {
  const app = newApp()
    .plugin(styles())
    .get(
      '/panel',
      defineRoute(c => {
        useStyle(c, PANEL)

        return html`<div class="panel">hi</div>`
      }),
    )

  assert.equal(
    await (await app.fetch(get('/panel'))).text(),
    `<div class="panel">hi</div><link rel="stylesheet" id="asset-styles-${PANEL.hash}-css" ` +
      `href="/styles/${PANEL.hash}.css" />`,
  )
})

test('a stream appends its link to the live head', async () => {
  const app = newApp()
    .plugin(styles())
    .get(
      '/panel',
      defineStream((stream, c) => {
        useStyle(c, PANEL)

        stream.patchElements(html`<div class="panel">hi</div>`)
      }),
    )

  const body = await (await app.fetch(get('/panel'))).text()

  assert.match(body, /data: selector head\ndata: mode append\n/)
  assert.match(body, new RegExp(`href="/styles/${PANEL.hash}\\.css"`))
  assert.ok(body.indexOf('class="panel"') < body.indexOf('selector head'))
})

test('a document seeds the client with the assets it holds', async () => {
  const sheet = css`
    .seeded {
      color: green;
    }
  `

  const body = await (await appWith(sheet).fetch(get())).text()
  const seed = /data-signals="([^"]+)"/.exec(body)?.[1]

  assert.ok(seed !== undefined)

  const decoded = JSON.parse(seed.replaceAll('&quot;', '"')) as {
    headAssets: Record<string, boolean>
  }

  assert.deepEqual(Object.keys(decoded.headAssets), [`asset-styles-${sheet.hash}-css`])
})

test('a stream skips an asset the page says it already has', async () => {
  const sheet = css`
    .shared {
      color: green;
    }
  `

  const app = newApp()
    .plugin(styles())
    .get('/', page(sheet))
    .get(
      '/patch',
      defineStream((stream, c) => {
        useStyle(c, sheet)

        stream.patchElements(html`<div class="shared">hi</div>`)
      }),
    )

  // What the browser would send back: the signal the document seeded.
  const rendered = await (await app.fetch(get())).text()
  const seed = /data-signals="([^"]+)"/.exec(rendered)?.[1]?.replaceAll('&quot;', '"') ?? ''

  const told = await (
    await app.fetch(get(`/patch?datastar=${encodeURIComponent(seed)}`))
  ).text()
  const untold = await (await app.fetch(get('/patch'))).text()

  assert.doesNotMatch(told, /mode append/)
  assert.match(untold, /mode append/)
})

test('what a stream does send is recorded back into the signal', async () => {
  const sheet = css`
    .recorded {
      color: blue;
    }
  `

  const app = newApp()
    .plugin(styles())
    .get('/patch', defineStream((_stream, c) => useStyle(c, sheet)))

  const body = await (await app.fetch(get('/patch'))).text()

  assert.match(body, /mode append/)
  assert.match(
    body,
    new RegExp(`event: datastar-patch-signals\\ndata: signals \\{"headAssets":\\{"asset-styles-${sheet.hash}-css":true\\}\\}`),
  )
})

test('two assets are both sent and both recorded', async () => {
  const a = css`
    .g {
      left: 0;
    }
  `
  const b = css`
    .h {
      left: 1px;
    }
  `

  const app = newApp()
    .plugin(styles())
    .get(
      '/patch',
      defineStream((stream, c) => {
        useStyle(c, a, b)

        stream.patchElements(html`<div>hi</div>`)
      }),
    )

  const body = await (await app.fetch(get('/patch'))).text()

  assert.equal([...body.matchAll(/mode append/g)].length, 2)
  assert.match(body, new RegExp(`"asset-styles-${a.hash}-css":true`))
  assert.match(body, new RegExp(`"asset-styles-${b.hash}-css":true`))
})

test('asking twice in one stream still sends one append', async () => {
  const sheet = css`
    .twice {
      right: 0;
    }
  `

  const app = newApp()
    .plugin(styles())
    .get(
      '/patch',
      defineStream((stream, c) => {
        useStyle(c, sheet)
        stream.patchSignals({ a: 1 })
        useStyle(c, sheet)
        stream.patchSignals({ b: 2 })
      }),
    )

  const body = await (await app.fetch(get('/patch'))).text()

  assert.equal([...body.matchAll(/mode append/g)].length, 1)
})
