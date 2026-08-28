import type { Context } from '../context.ts'
import type { Middleware } from '../app.ts'

export type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw'

export type CompressOptions = {
  encodings?: readonly CompressionFormat[]
  threshold?: number
  types?: RegExp
  filter?: (c: Context, response: Response) => boolean
}

const DEFAULT_ENCODINGS: readonly CompressionFormat[] = ['gzip', 'deflate']

const DEFAULT_THRESHOLD = 1024

const DEFAULT_TYPES =
  /^(?:text\/|application\/(?:json|xml|javascript|ecmascript|wasm|manifest\+json|[\w.-]+\+(?:json|xml))|image\/svg\+xml)/i

const UNCOMPRESSABLE_STATUS = new Set([204, 205, 206, 304])

function parseAcceptEncoding(header: string): Map<string, number> {
  const accepted = new Map<string, number>()

  for (const part of header.split(',')) {
    const [rawName, ...parameters] = part.split(';')
    const name = rawName?.trim().toLowerCase()

    if (name === undefined || name === '') continue

    const q = parameters
      .map(parameter => parameter.trim())
      .find(parameter => parameter.startsWith('q='))
      ?.slice(2)

    const quality = q === undefined ? 1 : Number.parseFloat(q)

    accepted.set(name, Number.isNaN(quality) ? 0 : quality)
  }

  return accepted
}

function negotiate(
  header: string | null,
  encodings: readonly CompressionFormat[],
): CompressionFormat | null {
  if (header === null || header.trim() === '') return null

  const accepted = parseAcceptEncoding(header)
  const wildcard = accepted.get('*')

  let best: CompressionFormat | null = null
  let bestQuality = 0

  for (const encoding of encodings) {
    const quality = accepted.get(encoding) ?? wildcard ?? 0

    if (quality > bestQuality) {
      best = encoding
      bestQuality = quality
    }
  }

  return best
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('vary')

  if (existing === null) {
    headers.set('vary', value)

    return
  }

  const listed = existing.split(',').map(part => part.trim().toLowerCase())

  if (listed.includes('*') || listed.includes(value.toLowerCase())) return

  headers.set('vary', `${existing}, ${value}`)
}

function declaredBelowThreshold(response: Response, threshold: number): boolean {
  const length = response.headers.get('content-length')

  if (length === null) return false

  const size = Number.parseInt(length, 10)

  return !Number.isNaN(size) && size < threshold
}

// Derived from Response rather than written as Uint8Array: the DOM lib and
// @types/node disagree on its ArrayBuffer type parameter, and this file must
// typecheck under both.
type ByteChunk = NonNullable<Response['body']> extends ReadableStream<infer T> ? T : never
type ByteReader = ReadableStreamDefaultReader<ByteChunk>

type Peeked = {
  head: ByteChunk[]
  size: number
  ended: boolean
}

// Most responses carry no content-length, so the threshold would never apply
// without reading a little of the body first. Never buffers more than the
// threshold, so streaming is preserved for anything larger.
async function peek(reader: ByteReader, limit: number): Promise<Peeked> {
  const head: ByteChunk[] = []
  let size = 0

  while (size < limit) {
    const { done, value } = await reader.read()

    if (done) return { head, size, ended: true }

    head.push(value)
    size += value.byteLength
  }

  return { head, size, ended: false }
}

function replay(head: readonly ByteChunk[], reader: ByteReader): ReadableStream<ByteChunk> {
  return new ReadableStream<ByteChunk>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk)
    },

    async pull(controller) {
      const { done, value } = await reader.read()

      if (done) {
        controller.close()

        return
      }

      controller.enqueue(value)
    },

    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function join(chunks: readonly ByteChunk[], size: number): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(size)
  let offset = 0

  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }

  return joined
}

function forbidsTransform(response: Response): boolean {
  return (response.headers.get('cache-control') ?? '').toLowerCase().includes('no-transform')
}

export function compress(options: CompressOptions = {}): Middleware {
  const encodings = options.encodings ?? DEFAULT_ENCODINGS
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const types = options.types ?? DEFAULT_TYPES
  const { filter } = options

  return async (c, next) => {
    const response = await next()

    if (response.body === null) return response
    if (response.headers.has('content-encoding')) return response
    if (UNCOMPRESSABLE_STATUS.has(response.status)) return response
    if (forbidsTransform(response)) return response

    const compressible =
      filter === undefined ? types.test(response.headers.get('content-type') ?? '') : filter(c, response)

    if (!compressible) return response
    if (declaredBelowThreshold(response, threshold)) return response

    const headers = new Headers(response.headers)

    appendVary(headers, 'Accept-Encoding')

    const rest = {
      status: response.status,
      statusText: response.statusText,
      headers,
    }

    const encoding = negotiate(c.req.headers.get('accept-encoding'), encodings)

    if (encoding === null) return new Response(response.body, rest)

    const reader = response.body.getReader()
    const { head, size, ended } = await peek(reader, threshold)

    if (ended && size < threshold) return new Response(join(head, size), rest)

    headers.set('content-encoding', encoding)
    headers.delete('content-length')

    return new Response(replay(head, reader).pipeThrough(new CompressionStream(encoding)), rest)
  }
}
