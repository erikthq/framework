import type { Context } from '../context.ts'
import { listFiles, normalizePrefix } from '../file-store.ts'
import { appendHead, appendImport, assetId, headIds } from '../head.ts'
import type { FileStore } from '../file-store.ts'
import { html } from '../helpers/html.ts'
import { HTML_CLIENT } from '../helpers/html-client.ts'
import { stripTypes } from '../helpers/strip-types.ts'
import type { Plugin } from '../plugin.ts'

export type ScriptsOptions = {
  store: FileStore
  dir?: string
  base?: string
  extensions?: readonly string[]
}

export type ScriptAsset = {
  path: string
  name: string
  url: string
  code: string
}

const DEFAULT_DIR = 'scripts'

const DEFAULT_EXTENSIONS = ['.ts', '.js'] as const

// Node strips types from TypeScript only, and so does this: a .js file is
// already browser JavaScript, and running a TypeScript lexer over it would put
// an expression like `a < b > (c)` at risk of being read as type arguments.
const TYPED = ['.ts', '.tsx', '.mts', '.cts']

const HASH_LENGTH = 8

const RESERVED = /[:*?+{}()\\]/g

const IMMUTABLE = 'public, max-age=31536000, immutable'

const REGISTRY = 'scripts:registry'

const BASE = 'scripts:base'

// Served outside `base` so it can never collide with a file of the app's own.
const HTML_SPECIFIER = '@erikt/framework/html'

function stripExtension(path: string): string {
  const dot = path.lastIndexOf('.')

  return dot <= 0 ? path : path.slice(0, dot)
}

async function digest(code: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))

  return [...new Uint8Array(bytes)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, HASH_LENGTH)
}

function scriptTag(url: string): string {
  return String(
    html`<script type="module" id="${assetId(url)}" src="${url}"></script>`,
  )
}

export function useScript(c: Context, ...names: readonly string[]): void {
  const registry = c.get(REGISTRY)
  const base = c.get(BASE)

  // Both are set together, by the plugin's onRequest.
  if (registry === undefined || base === undefined) {
    throw new TypeError(
      'useScript needs the scripts plugin — register it with app.plugin(scripts({ store }))',
    )
  }

  for (const name of names) {
    const requested = name.replace(/^\.?\//, '')

    // A name with no file still gets its tag, pointing at a URL nothing serves.
    // The page renders and the browser reports one 404, for the file it names.
    //
    // This used to throw, on the grounds that a typo should fail where it was
    // written. It took the whole page down over a deleted or misspelt asset,
    // which is the wrong trade: a page whose script is missing is still a page,
    // and the 404 says which file it was. Unhashed on purpose — every served
    // asset carries a content hash, so this URL cannot collide with one.
    const url =
      registry.get(requested) ??
      registry.get(stripExtension(requested)) ??
      `${base}${stripExtension(requested)}.js`

    appendHead(c, assetId(url), scriptTag(url))
  }
}

export function scripts(options: ScriptsOptions): Plugin {
  const { store } = options
  const prefix = normalizePrefix(options.dir ?? DEFAULT_DIR)
  const base = `/${normalizePrefix(options.base ?? options.dir ?? DEFAULT_DIR)}`
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS

  const byName = new Map<string, string>()
  // Asset ids whose code imports the helper, so the map is claimed only for
  // a page that actually loads one of them.
  const importsHtml = new Set<string>()
  let htmlUrl = ''

  return {
    name: 'scripts',

    async setup(app) {
      const read = store.read

      if (read === undefined) {
        throw new TypeError(
          `Store ${JSON.stringify(store.name)} cannot read files, which scripts needs — ` +
            'graft one on with withRead, or use nodeStore',
        )
      }

      const assets: ScriptAsset[] = []

      for (const file of await listFiles(store, { prefix, extensions })) {
        const response = await read.call(store, file.path)

        if (response === null) {
          throw new Error(
            `Store ${JSON.stringify(store.name)} listed ${JSON.stringify(file.path)} ` +
              'but could not read it',
          )
        }

        const source = await response.text()
        const code = TYPED.some(extension => file.path.endsWith(extension))
          ? stripTypes(source, { fileName: file.path })
          : source

        const name = stripExtension(file.path.slice(prefix.length))

        assets.push({ path: file.path, name, url: `${base}${name}.${await digest(code)}.js`, code })
      }

      // The same html`` a route is written with, for browser code to import.
      // Its source is derived from helpers/html.ts, never hand-written.
      htmlUrl = `/framework/html.${await digest(HTML_CLIENT)}.js`

      app.get(htmlUrl, c =>
        c.body(HTML_CLIENT, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': IMMUTABLE,
          },
        }),
      )

      for (const asset of assets) {
        byName.set(asset.name, asset.url)

        if (asset.code.includes(HTML_SPECIFIER)) importsHtml.add(assetId(asset.url))

        // The URL is a literal, so anything URLPattern would read as syntax has
        // to be escaped — the pattern and the src then differ by backslashes.
        app.get(asset.url.replace(RESERVED, character => `\\${character}`), c =>
          c.body(asset.code, {
            headers: {
              'content-type': 'text/javascript; charset=utf-8',
              // Safe because the hash changes whenever the code does.
              'cache-control': IMMUTABLE,
            },
          }),
        )
      }
    },

    // useScript needs to resolve a name the moment a page asks for it, so that
    // a typo throws where it was written. Handing it the map costs one bag
    // write per request; the merge only allocates when a second scripts plugin
    // is registered.
    // Nothing is injected here; this is only where the import map entry is
    // claimed, and only when a script the page asked for actually imports the
    // helper. A page that loads no browser code gets no map at all.
    injectHTML(c) {
      if (headIds(c).some(id => importsHtml.has(id))) {
        appendImport(c, HTML_SPECIFIER, htmlUrl)
      }
    },

    onRequest(c) {
      const existing = c.get(REGISTRY)

      c.set(REGISTRY, existing === undefined ? byName : new Map([...existing, ...byName]))
      c.set(BASE, base)
    },
  }
}
