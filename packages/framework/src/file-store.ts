export type FileEntry = {
  path: string
  size?: number
  modified?: number
}

export type ListOptions = {
  prefix?: string
  extensions?: readonly string[]
}

export type FileRead = (path: string) => Promise<Response | null>

export type FileStore = {
  name: string
  list(options?: ListOptions): Promise<readonly FileEntry[]>
  read?: FileRead
  import?(path: string): Promise<unknown>
}

export type StaticEntry = {
  size?: number
  modified?: number
  import?(): Promise<unknown>
  read?(): Promise<Response | null>
}

export type StaticFiles = Record<string, StaticEntry | (() => Promise<unknown>)>

export type StaticStoreOptions = {
  name?: string
}

export type GenerateStoreOptions = {
  base?: string
  specifier?: string
  modules?: readonly string[]
  name?: string
  exportName?: string
}

const TRAVERSAL = /(^|\/)\.\.?(\/|$)/

export const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'] as const

export function normalizePrefix(dir: string): string {
  // Only "./" and leading slashes come off — a bare leading dot is part of the
  // name, so a directory like .well-known keeps it.
  const trimmed = dir
    .normalize('NFC')
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/+$/, '')

  return trimmed === '' || trimmed === '.' ? '' : `${trimmed}/`
}

function normalizePath(path: string, store: string): string {
  // macOS reports a filename like café.ts decomposed and Linux reports it as
  // written, so without this the same file is two different paths — and two
  // different routes — depending on where the store runs.
  const normalized = path.normalize('NFC').replace(/^\/+/, '')

  const unusable =
    normalized === '' ||
    normalized.includes('\\') ||
    normalized.includes('//') ||
    TRAVERSAL.test(normalized)

  if (unusable) {
    throw new TypeError(
      `Store ${JSON.stringify(store)} returned an unusable path ${JSON.stringify(path)} — ` +
        'paths are relative, "/"-separated, and free of "." and ".." segments',
    )
  }

  return normalized
}

function metadata(entry: { size?: number; modified?: number }): Omit<FileEntry, 'path'> {
  return {
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.modified === undefined ? {} : { modified: entry.modified }),
  }
}

export async function listFiles(store: FileStore, options: ListOptions = {}): Promise<FileEntry[]> {
  const prefix = normalizePrefix(options.prefix ?? '')
  const extensions = options.extensions
  const files: FileEntry[] = []
  const seen = new Set<string>()

  for (const entry of await store.list({ ...options, prefix })) {
    const path = normalizePath(entry.path, store.name)

    // Applied again here because a store is free to ignore the options: the
    // cheapest correct store returns everything and lets this do the filtering.
    if (!path.startsWith(prefix)) continue
    if (extensions !== undefined && !extensions.some(extension => path.endsWith(extension))) continue
    if (seen.has(path)) continue

    seen.add(path)
    files.push({ path, ...metadata(entry) })
  }

  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  return files
}

export function staticStore(files: StaticFiles, options: StaticStoreOptions = {}): FileStore {
  const entries = new Map<string, StaticEntry>(
    Object.entries(files).map(([path, entry]) => [
      path,
      typeof entry === 'function' ? { import: entry } : entry,
    ]),
  )
  const name = options.name ?? 'static'

  return {
    name,

    async list() {
      return [...entries].map(([path, entry]) => ({ path, ...metadata(entry) }))
    },

    async read(path) {
      const entry = entries.get(path)

      return entry?.read === undefined ? null : entry.read()
    },

    async import(path) {
      const entry = entries.get(path)

      if (entry?.import === undefined) {
        throw new Error(`Store ${JSON.stringify(name)} has no module for ${JSON.stringify(path)}`)
      }

      return entry.import()
    },
  }
}

export function withRead(store: FileStore, read: FileRead): FileStore {
  const load = store.import

  return {
    name: store.name,
    list: options => store.list(options),
    read,
    ...(load === undefined ? {} : { import: (path: string) => load.call(store, path) }),
  }
}

export function generateStore(
  entries: readonly FileEntry[],
  options: GenerateStoreOptions = {},
): string {
  const base = options.base ?? './'
  const specifier = options.specifier ?? '@erikt/framework'
  const modules = options.modules ?? MODULE_EXTENSIONS
  const exportName = options.exportName ?? 'store'

  if (!/^(\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(base)) {
    throw new TypeError(
      `generateStore base ${JSON.stringify(base)} would emit a bare specifier — ` +
        'use "./", a path, or a URL',
    )
  }

  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )

  const lines = sorted.map(entry => {
    const parts = [
      // Deliberately no `modified`: a timestamp would rewrite the file on every
      // build. `size` only changes when the contents do.
      ...(entry.size === undefined ? [] : [`size: ${entry.size}`]),
      ...(modules.some(extension => entry.path.endsWith(extension))
        ? [`import: () => import(${JSON.stringify(base + entry.path)})`]
        : []),
    ]

    return `    ${JSON.stringify(entry.path)}: { ${parts.join(', ')} },`
  })

  return [
    `// Generated by framework's generateStore. Do not edit.`,
    `import { staticStore } from ${JSON.stringify(specifier)}`,
    ``,
    `export const ${exportName} = staticStore(`,
    `  {`,
    ...lines,
    `  },`,
    `  { name: ${JSON.stringify(options.name ?? 'generated')} },`,
    `)`,
    ``,
  ].join('\n')
}
