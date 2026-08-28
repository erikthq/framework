import { createApp, fileRouter, generateStore } from 'framework'
import type { FileStore, RouteInfo } from 'framework'
import { denoStore } from 'deno-adapter'

declare const Deno: {
  makeTempDir(options: { dir: string; prefix: string }): Promise<string>
  writeTextFile(path: string, data: string): Promise<void>
  remove(path: string, options: { recursive: boolean }): Promise<void>
}

const fixtures = new URL('../fixtures/', import.meta.url)
const store = denoStore(fixtures)

const newApp = (fileStore: FileStore) =>
  createApp({ banner: false, compress: false, logger: false }).plugin(
    fileRouter({ store: fileStore, dir: 'routes' }),
  )

const get = (path: string, method = 'GET') => new Request(`http://localhost${path}`, { method })

const paths = async (options?: { prefix?: string; extensions?: readonly string[] }) =>
  (await store.list(options)).map(entry => entry.path)

const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run()

    return null
  } catch (error) {
    return (error as Error).message
  }
}

const hello = await store.read('public/hello.txt')
const bracketed = (await store.import('routes/users/[id].ts')) as { GET?: unknown }

const live = newApp(store)

await live.start()

const responses = {
  root: await (await live.fetch(get('/'))).text(),
  about: await (await live.fetch(get('/about'))).text(),
  user: await (await live.fetch(get('/users/7'))).json(),
  me: await (await live.fetch(get('/users/me'))).json(),
  created: (await live.fetch(get('/users/7', 'POST'))).status,
  catchAll: await (await live.fetch(get('/notes/a/b', 'PUT'))).text(),
  underscored: (await live.fetch(get('/_lib/shared'))).status,
  markdown: (await live.fetch(get('/notes.md'))).status,
}

const directory = await Deno.makeTempDir({ dir: import.meta.dirname, prefix: '.tmp-store-' })
let baked: { routes: readonly RouteInfo[]; user: unknown; catchAll: string; capabilities: string[] }

try {
  const file = `${directory}/store.ts`
  const entries = await store.list({ prefix: 'routes/', extensions: ['.ts'] })

  await Deno.writeTextFile(file, generateStore(entries, { base: fixtures.href, name: 'baked' }))

  const generated = (await import(new URL(`file://${file}`).href)) as { store: FileStore }
  const app = newApp(generated.store)

  await app.start()

  baked = {
    routes: app.routes,
    user: await (await app.fetch(get('/users/7'))).json(),
    catchAll: await (await app.fetch(get('/notes/a/b', 'PUT'))).text(),
    capabilities: [
      ...(generated.store.read === undefined ? [] : ['read']),
      ...(generated.store.import === undefined ? [] : ['import']),
    ],
  }
} finally {
  await Deno.remove(directory, { recursive: true })
}

console.log(
  JSON.stringify({
    name: store.name,
    all: await paths(),
    narrowed: await paths({ prefix: 'routes/', extensions: ['.ts'] }),
    fromStringPath: (await denoStore('fixtures', { name: 'relative' }).list({ prefix: 'public/' }))
      .map(entry => entry.path),
    bracketedImport: typeof bracketed.GET,
    read: {
      text: await hello?.text(),
      length: hello?.headers.get('content-length'),
      modified: hello?.headers.get('last-modified'),
    },
    missing: await store.read('public/missing.txt'),
    refusals: {
      readRelative: await refusal(() => store.read('../../../etc/passwd')),
      readAbsolute: await refusal(() => store.read('/etc/passwd')),
      importRelative: await refusal(() => store.import('../../package.json')),
    },
    responses,
    routes: live.routes,
    baked,
  }),
)
