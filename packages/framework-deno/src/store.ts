import type { DirectoryStore, FileEntry, ListOptions } from '@erikt/framework'

export type DenoStoreOptions = {
  name?: string
}

type DenoFile = {
  readable: ReadableStream<Uint8Array>
  stat(): Promise<{ size: number; mtime: Date | null; isFile: boolean }>
  close(): void
}

declare const Deno: {
  cwd(): string
  readDir(path: URL): AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>
  open(path: URL): Promise<DenoFile>
  errors: { NotFound: new (message?: string) => Error }
}

const TRAVERSAL = /(^|\/)\.\.?(\/|$)/
const ABSOLUTE = /^(\/|[A-Za-z]:[/\\])/

// The characters a file name may contain that the URL parser would otherwise
// act on rather than carry: "\" becomes a separator, "?" and "#" truncate the
// path, and tab, newline and carriage return are dropped outright.
const RESERVED = /[#?%\\\n\r\t]/g

function escapePath(path: string): string {
  return path.replace(
    RESERVED,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

function toDirectoryURL(dir: string | URL): URL {
  if (dir instanceof URL) {
    const url = new URL(dir.href)

    if (!url.pathname.endsWith('/')) url.pathname += '/'

    return url
  }

  const path = (ABSOLUTE.test(dir) ? dir : `${Deno.cwd()}/${dir}`).replace(/\\/g, '/')
  const rooted = path.startsWith('/') ? path : `/${path}`

  return new URL(`file://${escapePath(rooted)}${rooted.endsWith('/') ? '' : '/'}`)
}

function locate(root: URL, path: string): URL {
  if (path === '' || path.startsWith('/') || TRAVERSAL.test(path)) {
    throw new TypeError(`Refusing to resolve ${JSON.stringify(path)} outside the store`)
  }

  return new URL(escapePath(path), root)
}

export function denoStore(dir: string | URL, options: DenoStoreOptions = {}): DirectoryStore {
  const root = toDirectoryURL(dir)

  return {
    name: options.name ?? 'deno',

    async list(listOptions = {}) {
      const prefix = listOptions.prefix ?? ''
      const extensions = listOptions.extensions
      const files: FileEntry[] = []

      const walk = async (directory: URL, base: string): Promise<void> => {
        for await (const entry of Deno.readDir(directory)) {
          const path = `${base}${entry.name}`

          if (entry.isDirectory) {
            await walk(new URL(`${escapePath(entry.name)}/`, directory), `${path}/`)

            continue
          }

          if (!entry.isFile) continue
          if (!path.startsWith(prefix)) continue
          if (extensions !== undefined && !extensions.some(item => path.endsWith(item))) continue

          files.push({ path })
        }
      }

      await walk(root, '')

      return files
    },

    async read(path) {
      const url = locate(root, path)

      try {
        const file = await Deno.open(url)
        const info = await file.stat()

        if (!info.isFile) {
          file.close()

          throw new TypeError(`${JSON.stringify(path)} is not a file`)
        }

        return new Response(file.readable, {
          headers: {
            'content-length': String(info.size),
            ...(info.mtime === null ? {} : { 'last-modified': info.mtime.toUTCString() }),
          },
        })
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null

        throw error
      }
    },

    async import(path) {
      return import(locate(root, path).href)
    },
  }
}
