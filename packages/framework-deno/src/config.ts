import { createSite as createPortableSite } from '@erikt/framework'
import type { AdapterConfig, App, ServeHandle, ServeOptions } from '@erikt/framework'

import { serve } from './serve.ts'
import { denoStore } from './store.ts'

export type DenoSiteConfig = AdapterConfig

// The config file is the entry point — exporting it is the whole of a user's
// setup — so the server starts here rather than in a second file whose only job
// is to call start(). `listen: false` is the way out, for a test or for a
// runtime that does its own listening.
export function defineConfig(config: DenoSiteConfig = {}): DenoSiteConfig {
  if (config.listen !== false) {
    void start(config).catch((error: unknown) => {
      
      console.error(error)
    })
  }

  return config
}

export function createSite(config: DenoSiteConfig = {}): App {
  const store = config.store ?? (config.root === undefined ? undefined : denoStore(config.root))

  return createPortableSite({ ...config, ...(store === undefined ? {} : { store }) })
}

export async function start(
  config: DenoSiteConfig = {},
  options: ServeOptions = {},
): Promise<ServeHandle> {
  const port = options.port ?? config.port
  const hostname = options.hostname ?? config.hostname

  return serve(createSite(config), {
    ...(port === undefined ? {} : { port }),
    ...(hostname === undefined ? {} : { hostname }),
  })
}
