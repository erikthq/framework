import type { App, Handler, Method, Middleware } from './app.ts'
import { listFiles, MODULE_EXTENSIONS, normalizePrefix } from './file-store.ts'
import type { FileStore } from './file-store.ts'
import { describePattern } from './plugin.ts'
import type { Plugin } from './plugin.ts'
import type { RoutePattern } from './router.ts'

export type RouteModule = Partial<Record<Method, Handler>> & {
  default?: Handler
  pattern?: RoutePattern
  use?: Middleware
}

export type FileRouterOptions = {
  store: FileStore
  dir?: string
  extensions?: readonly string[]
}

type Segment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'optional'; name: string }
  | { kind: 'rest'; name: string }

type Entry = {
  path: string
  segments: Segment[]
}

const METHODS: readonly Method[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'ALL',
]

const PARAM_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const REST = /^\[\.\.\.(.*)\]$/
const OPTIONAL = /^\[\[(.*)\]\]$/
const PARAM = /^\[(.*)\]$/

function paramName(raw: string, path: string): string {
  if (!PARAM_NAME.test(raw)) {
    throw new TypeError(
      `Route file ${JSON.stringify(path)} has an invalid parameter name ${JSON.stringify(raw)}`,
    )
  }

  return raw
}

function parseSegment(raw: string, path: string): Segment {
  const rest = REST.exec(raw)
  if (rest?.[1] !== undefined) return { kind: 'rest', name: paramName(rest[1], path) }

  const optional = OPTIONAL.exec(raw)
  if (optional?.[1] !== undefined) return { kind: 'optional', name: paramName(optional[1], path) }

  const param = PARAM.exec(raw)
  if (param?.[1] !== undefined) return { kind: 'param', name: paramName(param[1], path) }

  if (raw.includes('[') || raw.includes(']')) {
    throw new TypeError(
      `Route file ${JSON.stringify(path)} has an unbalanced bracket in ${JSON.stringify(raw)}`,
    )
  }

  return { kind: 'literal', value: raw }
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')

  return dot <= 0 ? name : name.slice(0, dot)
}

function parsePath(path: string): Segment[] | null {
  const parts = path.split('/').filter(part => part !== '')
  const last = parts.length - 1
  const segments: Segment[] = []

  for (const [index, part] of parts.entries()) {
    const name = index === last ? stripExtension(part) : part

    if (name === '' || name.startsWith('_') || name.startsWith('.')) return null
    if (name.startsWith('(') && name.endsWith(')')) continue
    if (index === last && name === 'index') continue

    segments.push(parseSegment(name, path))
  }

  for (const [index, segment] of segments.entries()) {
    if (segment.kind === 'rest' && index !== segments.length - 1) {
      throw new TypeError(
        `Route file ${JSON.stringify(path)} has a catch-all segment that is not last`,
      )
    }
  }

  return segments
}

function escapeLiteral(value: string): string {
  return value.replace(/[:*?+{}()\\]/g, character => `\\${character}`)
}

function toPattern(segments: readonly Segment[]): string {
  if (segments.length === 0) return '/'

  return segments
    .map(segment => {
      switch (segment.kind) {
        case 'literal':
          return `/${escapeLiteral(segment.value)}`
        case 'param':
          return `/:${segment.name}`
        case 'optional':
          return `{/:${segment.name}}?`
        default:
          // Braces rather than `/:name*`, so the pattern also matches the
          // parent path itself and captures every remaining segment as one group.
          return `{/:${segment.name}}*`
      }
    })
    .join('')
}

export function patternFromFilePath(path: string): string | null {
  const segments = parsePath(path)

  return segments === null ? null : toPattern(segments)
}

function rank(segment: Segment): number {
  switch (segment.kind) {
    case 'literal':
      return 0
    case 'param':
      return 1
    case 'optional':
      return 2
    default:
      return 3
  }
}

// Registration order is match priority, and a directory listing has no
// meaningful order, so specificity has to be imposed here: the least wildcard
// segment wins, then the shorter path — two paths can only tie on a shared
// prefix if the longer one's extra segments are optional or catch-all, which
// makes the shorter one the exact match. The path itself breaks the last tie so
// the result never depends on the filesystem.
function compare(left: Entry, right: Entry): number {
  for (const [index, segment] of left.segments.entries()) {
    const other = right.segments[index]
    if (other === undefined) break

    const difference = rank(segment) - rank(other)
    if (difference !== 0) return difference
  }

  if (left.segments.length !== right.segments.length) {
    return left.segments.length - right.segments.length
  }

  if (left.path === right.path) return 0

  return left.path < right.path ? -1 : 1
}

function claim(seen: Map<string, string>, method: Method, pattern: string, path: string): void {
  const key = `${method} ${pattern}`
  const taken = seen.get(key)

  if (taken !== undefined) {
    throw new Error(
      `Route ${key} from ${JSON.stringify(path)} is already registered by ${JSON.stringify(taken)}`,
    )
  }

  seen.set(key, path)
}

// The types describe what a route file should export; an imported module is
// unverified at runtime, so a non-function export has to be caught here rather
// than becoming a route that throws on its first request.
function asHandler(exported: unknown, label: string, path: string): Handler {
  if (typeof exported !== 'function') {
    throw new TypeError(
      `Route file ${JSON.stringify(path)} exports ${label} but it is not a function`,
    )
  }

  return exported as Handler
}

function asMiddleware(exported: unknown, path: string): Middleware {
  if (typeof exported !== 'function') {
    throw new TypeError(`Route file ${JSON.stringify(path)} exports use but it is not a function`)
  }

  return exported as Middleware
}

function toRouteModule(value: unknown, path: string): RouteModule {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`Route file ${JSON.stringify(path)} did not import as a module`)
  }

  return value as RouteModule
}

function register(app: App, entry: Entry, module: RouteModule, seen: Map<string, string>): void {
  const pattern = module.pattern ?? toPattern(entry.segments)
  const described = describePattern(pattern)
  const path = entry.path
  let handlers = 0

  for (const method of METHODS) {
    const exported = module[method]
    if (exported === undefined) continue

    claim(seen, method, described, path)
    app.on(method, pattern, asHandler(exported, method, path))
    handlers++
  }

  if (module.default !== undefined) {
    claim(seen, 'ALL', described, path)
    app.on('ALL', pattern, asHandler(module.default, 'default', path))
    handlers++
  }

  if (module.use !== undefined) app.use(pattern, asMiddleware(module.use, path))

  if (handlers === 0 && module.use === undefined) {
    throw new TypeError(
      `Route file ${JSON.stringify(path)} exports no handler — expected a default export, ` +
        'a method export, or use',
    )
  }
}

export function fileRouter(options: FileRouterOptions): Plugin {
  const { store } = options
  const prefix = normalizePrefix(options.dir ?? '')
  const extensions = options.extensions ?? MODULE_EXTENSIONS

  return {
    name: 'file-router',

    async setup(app) {
      const load = store.import

      if (load === undefined) {
        throw new TypeError(
          `Store ${JSON.stringify(store.name)} cannot import modules, which fileRouter needs — ` +
            'bake one with generateStore, or use staticStore',
        )
      }

      const entries: Entry[] = []

      for (const file of await listFiles(store, { prefix, extensions })) {
        // A declaration file has a routable-looking extension and no runtime
        // exports, so it would otherwise register a route that cannot answer.
        if (file.path.endsWith('.d.ts')) continue

        const segments = parsePath(file.path.slice(prefix.length))
        if (segments === null) continue

        entries.push({ path: file.path, segments })
      }

      entries.sort(compare)

      const seen = new Map<string, string>()

      for (const entry of entries) {
        register(app, entry, toRouteModule(await load.call(store, entry.path), entry.path), seen)
      }
    },
  }
}
