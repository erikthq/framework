import type { Context } from '../context.ts'
import { listFiles, normalizePrefix } from '../file-store.ts'
import type { FileStore } from '../file-store.ts'
import { html } from '../helpers/html.ts'
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
const USED = 'scripts:used'
const TAKEN = 'scripts:taken'

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
  return String(html`<script type="module" src="${url}"></script>`)
}

// Streams need what is new since they last looked, and a Set keeps insertion
// order, so a count of what has already gone out is the whole bookmark.
export function takeScriptTags(c: Context): readonly string[] {
  const used = c.get(USED)

  if (used === undefined) return []

  const taken = c.get(TAKEN) ?? 0

  if (used.size <= taken) return []

  c.set(TAKEN, used.size)

  return [...used].slice(taken).map(scriptTag)
}

function describe(registry: ReadonlyMap<string, string>): string {
  const names = [...registry.keys()]

  return names.length === 0
    ? 'no scripts were found'
    : `known scripts are ${names.map(name => JSON.stringify(name)).join(', ')}`
}

export function useScript(c: Context, ...names: readonly string[]): void {
  const registry = c.get(REGISTRY)

  if (registry === undefined) {
    throw new TypeError(
      'useScript needs the scripts plugin — register it with app.plugin(scripts({ store }))',
    )
  }

  let used = c.get(USED)

  if (used === undefined) {
    used = new Set<string>()

    c.set(USED, used)
  }

  for (const name of names) {
    const requested = name.replace(/^\.?\//, '')
    const url = registry.get(requested) ?? registry.get(stripExtension(requested))

    if (url === undefined) {
      throw new TypeError(`No script named ${JSON.stringify(name)} — ${describe(registry)}`)
    }

    used.add(url)
  }
}

export function scripts(options: ScriptsOptions): Plugin {
  const { store } = options
  const prefix = normalizePrefix(options.dir ?? DEFAULT_DIR)
  const base = `/${normalizePrefix(options.base ?? options.dir ?? DEFAULT_DIR)}`
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS

  const byName = new Map<string, string>()
  const own = new Set<string>()

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

      for (const asset of assets) {
        byName.set(asset.name, asset.url)
        own.add(asset.url)

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
    onRequest(c) {
      const existing = c.get(REGISTRY)

      c.set(REGISTRY, existing === undefined ? byName : new Map([...existing, ...byName]))
    },

    injectHTML(c) {
      const used = c.get(USED)

      if (used === undefined) return

      // Filtered to this plugin's own assets, so two scripts plugins emit their
      // own tags rather than both emitting everything.
      const head = [...used].filter(url => own.has(url)).map(scriptTag).join('')

      if (head === '') return

      return { head }
    },
  }
}
