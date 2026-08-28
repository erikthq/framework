import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Structural counterparts of framework's FileStore port, declared here so the
// adapter still does not depend on framework.
export type FileEntryLike = {
  path: string
  size?: number
  modified?: number
}

export type ListOptionsLike = {
  prefix?: string
  extensions?: readonly string[]
}

export type FileStoreLike = {
  name: string
  list(options?: ListOptionsLike): Promise<readonly FileEntryLike[]>
  read(path: string): Promise<Response | null>
  import(path: string): Promise<unknown>
}

export type NodeStoreOptions = {
  name?: string
}

const TRAVERSAL = /(^|\/)\.\.?(\/|$)/

function toDirectoryURL(dir: string | URL): URL {
  const path = dir instanceof URL ? fileURLToPath(dir) : resolve(dir)
  const url = pathToFileURL(path)

  if (!url.pathname.endsWith('/')) url.pathname += '/'

  return url
}

function locate(root: URL, path: string): URL {
  if (path === '' || path.startsWith('/') || TRAVERSAL.test(path)) {
    throw new TypeError(`Refusing to resolve ${JSON.stringify(path)} outside the store`)
  }

  return pathToFileURL(join(fileURLToPath(root), path))
}

export function nodeStore(dir: string | URL, options: NodeStoreOptions = {}): FileStoreLike {
  const root = toDirectoryURL(dir)

  return {
    name: options.name ?? 'node',

    async list(listOptions = {}) {
      const prefix = listOptions.prefix ?? ''
      const extensions = listOptions.extensions
      const entries = await readdir(root, { recursive: true, withFileTypes: true })
      const files: FileEntryLike[] = []

      for (const entry of entries) {
        if (!entry.isFile()) continue

        // Relative paths are derived through the file URL so the separator is
        // "/" on every platform, which is what the port requires.
        const absolute = pathToFileURL(join(entry.parentPath, entry.name))
        const path = decodeURIComponent(absolute.href.slice(root.href.length))

        if (!path.startsWith(prefix)) continue
        if (extensions !== undefined && !extensions.some(item => path.endsWith(item))) continue

        files.push({ path })
      }

      return files
    },

    async read(path) {
      const url = locate(root, path)

      try {
        const [bytes, info] = await Promise.all([readFile(url), stat(url)])

        return new Response(bytes, {
          headers: {
            'content-length': String(info.size),
            'last-modified': new Date(info.mtimeMs).toUTCString(),
          },
        })
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null

        throw error
      }
    },

    async import(path) {
      return import(locate(root, path).href)
    },
  }
}
