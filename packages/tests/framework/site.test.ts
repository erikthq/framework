import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createSite,
  defineConfig,
  defineErrorPage,
  defineLayout,
  defineRoute,
  html,
  useLayout,
} from '@erikt/framework'
import type { SiteConfig } from '@erikt/framework'
import { nodeStore } from '@erikt/framework-node'

const quiet = { banner: false, compress: false, logger: false } as const

const fixtures = new URL('../fixtures/', import.meta.url)

const get = (path = '/') => new Request(`http://localhost${path}`)

const wrap = defineLayout(content => html`<main>${content}</main>`)

const site = (config: SiteConfig = {}) =>
  createSite({ ...quiet, store: nodeStore(fixtures), ...config })

test('defineConfig hands back what it was given', () => {
  const config = { title: 'x' }

  assert.equal(defineConfig(config), config)
})

test('a site wires file routes from the root without being asked', async () => {
  const app = site()

  assert.equal((await app.fetch(get('/'))).status, 200)
  assert.equal((await app.fetch(get('/about'))).status, 200)
})

test('a site serves the public directory without being asked', async () => {
  const app = site()

  assert.match(await (await app.fetch(get('/hello.txt'))).text(), /hello from the store/)
})

test('routes: false leaves file routing off', async () => {
  const app = site({ routes: false })

  assert.equal((await app.fetch(get('/'))).status, 404)
})

test('assets: false leaves the public directory off', async () => {
  const app = site({ assets: false })

  assert.equal((await app.fetch(get('/hello.txt'))).status, 404)
})

test('a directory can be renamed', async () => {
  const app = site({ assets: 'nowhere', routes: false })

  assert.equal((await app.fetch(get('/hello.txt'))).status, 404)
})

test('the plugins a site registers are the expected set, in order', async () => {
  const info = await site().start()

  // logger is off via `quiet`; the rest is what a site wires by default.
  assert.deepEqual(info.plugins, [
    'datastar',
    'scripts',
    'assets',
    'conventions',
    'styles',
    'file-router',
  ])
})

test('title becomes the banner title', async () => {
  const output: string[] = []

  const app = createSite({
    compress: false,
    logger: false,
    title: 'my-site',
    banner: { color: false, title: 'my-site', log: message => output.push(message) },
  })

  await app.start()

  assert.match(output.join('\n'), /my-site ready/)
})

test('the datastar runtime is served by default, and can be turned off', async () => {
  assert.equal((await site().fetch(get('/datastar-1.0.3.js'))).status, 200)
  assert.equal(
    (await site({ datastar: { client: false } }).fetch(get('/datastar-1.0.3.js'))).status,
    404,
  )
})

test('the notFound page from the config is applied, layout and all', async () => {
  const app = site({
    routes: false,
    datastar: { client: false },
    notFound: defineRoute(c => {
      c.status(404)
      useLayout(c, wrap)

      return html`<p>gone</p>`
    }),
  })

  const response = await app.fetch(get('/nope'))

  assert.equal(response.status, 404)
  assert.equal(await response.text(), '<main><p>gone</p></main>')
})

test('extra plugins are registered, and before the file router', async () => {
  const app = site({
    plugins: [
      {
        name: 'mine',
        setup(registered) {
          registered.get('/', defineRoute(() => 'claimed'))
        },
      },
    ],
  })

  assert.equal(await (await app.fetch(get('/'))).text(), 'claimed')
})

test('a site works with no store at all', async () => {
  const app = createSite({ ...quiet }).get('/', defineRoute(() => 'hand built'))

  assert.equal(await (await app.fetch(get('/'))).text(), 'hand built')
})

test('the error page from the config is applied', async () => {
  const app = site({
    routes: false,
    datastar: { client: false },
    error: defineErrorPage((error, c) => {
      useLayout(c, wrap)

      return html`<p>${(error as Error).message}</p>`
    }),
  }).get('/', () => {
    throw new Error('it broke')
  })

  const response = await app.fetch(get('/'))

  assert.equal(response.status, 500)
  assert.equal(await response.text(), '<main><p>it broke</p></main>')
})

const conventions = new URL('../fixtures/conventions/', import.meta.url)

test('not-found.ts at the root is used without being named', async () => {
  const app = createSite({ ...quiet, datastar: { client: false }, store: nodeStore(conventions) })
  const response = await app.fetch(get('/nope'))

  assert.equal(response.status, 404)
  assert.equal(await response.text(), '<main><p>found by convention</p></main>')
})

test('error.ts at the root is used without being named', async () => {
  const app = createSite({ ...quiet, store: nodeStore(conventions) }).get('/', () => {
    throw new Error('it broke')
  })

  const response = await app.fetch(get('/'))

  assert.equal(response.status, 500)
  assert.equal(await response.text(), '<p>it broke</p>')
})

test('an explicit notFound beats the file', async () => {
  const app = createSite({
    ...quiet,
    store: nodeStore(conventions),
    notFound: defineRoute(c => {
      c.status(404)

      return html`<p>named in the config</p>`
    }),
  })

  assert.equal(await (await app.fetch(get('/nope'))).text(), '<p>named in the config</p>')
})

test('no such file falls back to the framework default', async () => {
  const app = createSite({ ...quiet, store: nodeStore(fixtures) })
  const response = await app.fetch(get('/nope'))

  assert.equal(response.status, 404)
  assert.equal(await response.text(), '404 Not Found')
})

test('a site with no store keeps the framework defaults', async () => {
  const response = await createSite({ ...quiet }).fetch(get('/nope'))

  assert.equal(await response.text(), '404 Not Found')
})

test('a convention page that is not a function says which file', async () => {
  const app = createSite({
    ...quiet,
    store: nodeStore(new URL('../fixtures/broken-conventions/', import.meta.url)),
  })

  await assert.rejects(() => app.start(), /"not-found\.ts" is the site's notFound page/)
})
