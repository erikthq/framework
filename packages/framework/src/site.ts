import { createApp } from './app.ts'
import type { App, AppOptions, ErrorHandler, Handler } from './app.ts'
import { fileRouter } from './file-router.ts'
import { listFiles, MODULE_EXTENSIONS } from './file-store.ts'
import type { FileStore } from './file-store.ts'
import type { Plugin } from './plugin.ts'
import { assets } from './plugins/assets.ts'
import { scripts } from './plugins/scripts.ts'
import { styles } from './plugins/styles.ts'
import type { StylesOptions } from './plugins/styles.ts'

export type SiteConfig = AppOptions & {
  store?: FileStore
  title?: string
  routes?: string | false
  scripts?: string | false
  assets?: string | false
  styles?: boolean | StylesOptions
  plugins?: readonly Plugin[]
  notFound?: Handler
  error?: ErrorHandler
}

const DEFAULT_ROUTES = 'routes'
const DEFAULT_SCRIPTS = 'scripts'
const DEFAULT_ASSETS = 'public'

// Identity at runtime. It exists for the types: a config written through it is
// checked and completed where it is written, rather than where it is used.
//
// This is the runtime-agnostic half. A runtime that has to bind a port re-exports
// its own defineConfig on top of this one — see @erikt/framework-node — adding `root`,
// `port` and `hostname`, which mean nothing without a server.
export function defineConfig(config: SiteConfig): SiteConfig {
  return config
}

const CONVENTIONS = [
  { file: 'not-found', option: 'notFound' },
  { file: 'error', option: 'error' },
] as const

// The two pages a site almost always has, found by name rather than named in
// the config. Done in a plugin because setup() may be async and createSite may
// not: importing a module is the store's job, and the store is a port.
//
// Existence is decided from a listing, not from catching the import — otherwise
// a syntax error inside not-found.ts would look exactly like not having one.
function conventions(store: FileStore, wanted: readonly string[]): Plugin {
  return {
    name: 'conventions',

    async setup(app) {
      const load = store.import

      if (load === undefined) return

      const listed = await listFiles(store, { extensions: MODULE_EXTENSIONS })
      const present = new Set(listed.filter(entry => !entry.path.includes('/')).map(e => e.path))

      for (const { file, option } of CONVENTIONS) {
        if (!wanted.includes(option)) continue

        const path = MODULE_EXTENSIONS.map(extension => `${file}${extension}`).find(name =>
          present.has(name),
        )

        if (path === undefined) continue

        const module = await load.call(store, path)
        const handler = (module as { default?: unknown }).default

        if (typeof handler !== 'function') {
          throw new TypeError(
            `${JSON.stringify(path)} is the site's ${option} page, so it must default-export a ` +
              'function',
          )
        }

        if (option === 'notFound') app.notFound(handler as Handler)
        else app.onError(handler as ErrorHandler)
      }
    },
  }
}

export function createSite(config: SiteConfig = {}): App {
  const { store } = config
  const banner = config.banner ?? (config.title === undefined ? undefined : { title: config.title })

  const app = createApp({
    // Every slot is spread conditionally: under exactOptionalPropertyTypes an
    // explicit undefined is not the same as an absent key, and createApp reads
    // absence as "use the default".
    ...(config.base === undefined ? {} : { base: config.base }),
    ...(config.compress === undefined ? {} : { compress: config.compress }),
    ...(config.logger === undefined ? {} : { logger: config.logger }),
    ...(banner === undefined ? {} : { banner }),
    // A site serves its own runtime rather than reaching for a CDN. This is the
    // one default createSite adds that createApp does not.
    datastar: config.datastar ?? { client: true },
  })

  if (store !== undefined) {
    if (config.scripts !== false) {
      app.plugin(scripts({ store, dir: config.scripts ?? DEFAULT_SCRIPTS }))
    }

    if (config.assets !== false) {
      app.plugin(assets({ store, dir: config.assets ?? DEFAULT_ASSETS }))
    }
  }

  // Only what the config left unsaid: an explicit notFound or error always wins,
  // and is applied below, after every plugin has had its say.
  const wanted = CONVENTIONS.filter(item => config[item.option] === undefined).map(
    item => item.option as string,
  )

  if (store !== undefined && wanted.length > 0) app.plugin(conventions(store, wanted))

  if (config.styles !== false) {
    app.plugin(styles(config.styles === undefined || config.styles === true ? {} : config.styles))
  }

  for (const plugin of config.plugins ?? []) app.plugin(plugin)

  // Last, so a route registered by hand or by one of your own plugins is
  // matched before a file route that would also match it.
  if (store !== undefined && config.routes !== false) {
    app.plugin(fileRouter({ store, dir: config.routes ?? DEFAULT_ROUTES }))
  }

  if (config.notFound !== undefined) app.notFound(config.notFound)
  if (config.error !== undefined) app.onError(config.error)

  return app
}
