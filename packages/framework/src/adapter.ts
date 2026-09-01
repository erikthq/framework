import type { App } from './app.ts'
import type { FileStore } from './file-store.ts'
import type { SiteConfig } from './site.ts'

// The whole contract an adapter implements, in one place. Adapters import these
// rather than redeclaring them: they depend on `framework` already, and a
// contract kept in two copies is a contract that drifts.
//
// What each part must *do* — the path rules a store obeys, what the request
// bridge has to get right — is in ADAPTERS.md. Types cannot say most of it.

export type ServeOptions = {
  port?: number
  hostname?: string
}

export type ServeHandle = {
  url: string
  hostname: string
  port: number
  close(): Promise<void>
}

// What `serve` accepts. Deliberately just `fetch` plus two optional hooks, so an
// adapter hosts any WinterTC handler and not only an App — there is a test
// holding each adapter to that.
export type FetchHandler = {
  fetch(request: Request): Response | Promise<Response>
  start?(info: { url?: string; hostname?: string; port?: number }): unknown
  stop?(): unknown
}

export type Serve = (handler: FetchHandler, options?: ServeOptions) => Promise<ServeHandle>

export type StoreOptions = {
  name?: string
}

// A store over a real directory. `read` and `import` are optional on the port
// because a bundled runtime cannot offer them; a runtime that can walk a
// filesystem can, so they are required here.
export type DirectoryStore = FileStore & {
  read: NonNullable<FileStore['read']>
  import: NonNullable<FileStore['import']>
}

export type CreateStore = (root: string | URL, options?: StoreOptions) => DirectoryStore

// What an adapter adds to the portable config: the three things a runtime with
// a server can honour and a Request/Response one cannot.
export type AdapterConfig = SiteConfig & {
  root?: string | URL
  port?: number
  hostname?: string
  // False builds the site without binding anything. It exists so calling
  // defineConfig is safe in a test — without it every such test takes a port.
  listen?: boolean
}

// The shape of an adapter package's exports. Assert conformance with
// `satisfies` or a typed alias, so a missing or mis-shaped export is a
// typecheck failure rather than a surprise at someone's call site.
export type Adapter<Config extends AdapterConfig = AdapterConfig> = {
  serve: Serve
  // Returns its argument, and starts the server unless `listen` is false: the
  // config file is the entry point, so nothing else has to call start.
  defineConfig(config?: Config): Config
  // The same wiring without a server, for a test or another host.
  createSite(config?: Config): App
  start(config?: Config, options?: ServeOptions): Promise<ServeHandle>
}

// The store factory is named for its runtime — `nodeStore`, `denoStore` — since
// that is what reads well at a call site, so it is not part of the module shape
// above. It conforms by satisfying CreateStore. A runtime that cannot enumerate
// a directory has none, and such a site passes `store` in its config instead,
// built with staticStore and withRead.
