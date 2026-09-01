import { listFiles, normalizePrefix } from '../file-store.ts'
import type { FileStore } from '../file-store.ts'
import type { Plugin } from '../plugin.ts'

export type AssetsOptions = {
  store: FileStore
  dir?: string
  base?: string
  cacheControl?: string
  types?: Record<string, string>
}

const DEFAULT_DIR = 'public'

// Unhashed names, so the useful default is "always ask, but expect a 304".
// Content-hashed assets should override this with something immutable.
const DEFAULT_CACHE_CONTROL = 'public, max-age=0, must-revalidate'

const MIME: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip',
}

const RANGE = /^bytes=(\d*)-(\d*)$/

type Slice = { start: number; end: number }

function normalizeBase(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/g, '')

  return trimmed === '' ? '/' : `/${trimmed}/`
}

function typeFor(path: string, types: Record<string, string>): string | undefined {
  const dot = path.lastIndexOf('.')

  return dot === -1 ? undefined : types[path.slice(dot).toLowerCase()]
}

// Derived from size and mtime rather than the bytes, so serving a file never
// costs a hash of it. Weak, and says so: it is not a claim about content.
function entityTag(headers: Headers): string | null {
  const size = headers.get('content-length')
  const modified = headers.get('last-modified')

  if (size === null || modified === null) return null

  const stamp = Date.parse(modified)

  if (Number.isNaN(stamp)) return null

  return `W/"${Number(size).toString(16)}-${stamp.toString(16)}"`
}

function matchesTag(header: string | null, etag: string): boolean {
  if (header === null) return false
  if (header.trim() === '*') return true

  const bare = etag.replace(/^W\//, '')

  // If-None-Match uses the weak comparison function, so W/ prefixes are ignored
  // on both sides.
  return header.split(',').some(part => part.trim().replace(/^W\//, '') === bare)
}

function notModifiedSince(header: string | null, modified: string | null): boolean {
  if (header === null || modified === null) return false

  const since = Date.parse(header)
  const at = Date.parse(modified)

  if (Number.isNaN(since) || Number.isNaN(at)) return false

  // HTTP dates carry seconds, so a sub-second difference is not a change.
  return Math.floor(at / 1000) <= Math.floor(since / 1000)
}

// null means "ignore the header and send the whole thing", which is what the
// spec allows for anything unparseable — including the multi-range form.
function parseRange(header: string, size: number): Slice | 'unsatisfiable' | null {
  const match = RANGE.exec(header.trim())

  if (match === null) return null

  const [, rawStart = '', rawEnd = ''] = match

  if (rawStart === '' && rawEnd === '') return null

  if (rawStart === '') {
    const length = Number(rawEnd)

    if (length === 0) return 'unsatisfiable'

    return { start: Math.max(0, size - length), end: size - 1 }
  }

  const start = Number(rawStart)

  if (start >= size) return 'unsatisfiable'

  return { start, end: rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1) }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel()
}

export function assets(options: AssetsOptions): Plugin {
  const { store } = options
  const prefix = normalizePrefix(options.dir ?? DEFAULT_DIR)
  const base = normalizeBase(options.base ?? '/')
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL
  const types = { ...MIME, ...options.types }

  const paths = new Map<string, string>()

  return {
    name: 'assets',

    async setup(app) {
      const read = store.read

      if (read === undefined) {
        throw new TypeError(
          `Store ${JSON.stringify(store.name)} cannot read files, which assets needs — ` +
            'graft one on with withRead, or use nodeStore',
        )
      }

      for (const file of await listFiles(store, { prefix })) {
        paths.set(`${base}${file.path.slice(prefix.length)}`, file.path)
      }

      // Middleware rather than a route per file: the listing is a Map lookup, so
      // a request for something else costs nothing and falls straight through to
      // the router, and no pattern is registered that could shadow a real route.
      app.use(`${base}*`, async (c, next) => {
        const method = c.req.method.toUpperCase()

        if (method !== 'GET' && method !== 'HEAD') return next()

        let pathname = c.url.pathname

        try {
          pathname = decodeURIComponent(pathname)
        } catch {
          return next()
        }

        const path = paths.get(pathname)

        if (path === undefined) return next()

        const file = await read.call(store, path)

        // Listed at startup, gone now. Not this middleware's business to invent
        // a 404 — the router's notFound is the app's own.
        if (file === null) return next()

        const headers = new Headers(file.headers)
        const type = typeFor(path, types)

        if (type !== undefined && !headers.has('content-type')) headers.set('content-type', type)

        headers.set('cache-control', cacheControl)
        headers.set('accept-ranges', 'bytes')

        const etag = entityTag(headers)

        if (etag !== null) headers.set('etag', etag)

        const noneMatch = c.req.headers.get('if-none-match')
        const fresh =
          etag !== null && noneMatch !== null
            ? matchesTag(noneMatch, etag)
            : noneMatch === null &&
              notModifiedSince(c.req.headers.get('if-modified-since'), headers.get('last-modified'))

        if (fresh) {
          await discard(file)

          headers.delete('content-length')
          headers.delete('content-type')

          return new Response(null, { status: 304, headers })
        }

        const size = Number(headers.get('content-length'))
        const range = c.req.headers.get('range')
        const slice =
          range === null || !Number.isFinite(size) ? null : parseRange(range, size)

        if (slice === 'unsatisfiable') {
          await discard(file)

          headers.delete('content-length')
          headers.set('content-range', `bytes */${size}`)

          return new Response(null, { status: 416, headers })
        }

        if (slice !== null) {
          // Buffered only when a range was asked for; the whole-file path stays
          // whatever shape the store handed back.
          const bytes = new Uint8Array(await file.arrayBuffer())
          const part = bytes.slice(slice.start, slice.end + 1)

          headers.set('content-range', `bytes ${slice.start}-${slice.end}/${size}`)
          headers.set('content-length', String(part.byteLength))

          return new Response(method === 'HEAD' ? null : part, { status: 206, headers })
        }

        if (method === 'HEAD') {
          await discard(file)

          return new Response(null, { status: 200, headers })
        }

        return new Response(file.body, { status: 200, headers })
      })
    },
  }
}
