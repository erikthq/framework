import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSite, defineConfig, nodeStore, start } from '@erikt/framework-node'
import { defineRoute } from '@erikt/framework'

const quiet = { banner: false, compress: false, logger: false, datastar: false } as const

const fixtures = new URL('../fixtures/', import.meta.url)

test('defineConfig hands back what it was given', () => {
  // listen: false, or this would bind a port just by being called.
  const config = { title: 'x', listen: false }

  assert.equal(defineConfig(config), config)
})

test('a root becomes a store, so file routes just work', async () => {
  const app = createSite({ ...quiet, root: fixtures })

  assert.equal((await app.fetch(new Request('http://localhost/about'))).status, 200)
  assert.match(
    await (await app.fetch(new Request('http://localhost/hello.txt'))).text(),
    /hello from the store/,
  )
})

test('an explicit store beats root', async () => {
  const app = createSite({
    ...quiet,
    // A root that does not exist, so only the store can be answering.
    root: new URL('./nowhere/', import.meta.url),
    store: nodeStore(fixtures),
  })

  assert.equal((await app.fetch(new Request('http://localhost/about'))).status, 200)
})

test('a config with no root still builds an app', async () => {
  const app = createSite({ ...quiet }).get('/', defineRoute(() => 'hand built'))

  assert.equal(await (await app.fetch(new Request('http://localhost/'))).text(), 'hand built')
})

test('start serves the site over http', async () => {
  // Port 0 so the test never collides with a real server.
  const handle = await start({ ...quiet, root: fixtures }, { port: 0 })

  try {
    assert.ok(handle.port > 0)

    const response = await fetch(`${handle.url}/about`)

    assert.equal(response.status, 200)
  } finally {
    await handle.close()
  }
})

test('start options beat the config', async () => {
  const handle = await start({ ...quiet, root: fixtures, port: 1 }, { port: 0 })

  try {
    assert.notEqual(handle.port, 1)
  } finally {
    await handle.close()
  }
})

test('listen: false builds nothing that binds a port', async () => {
  const config = defineConfig({ ...quiet, root: fixtures, listen: false })

  // Nothing is listening, but the config is still a usable one.
  const app = createSite(config)

  assert.equal((await app.fetch(new Request('http://localhost/about'))).status, 200)
})
