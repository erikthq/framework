import type { Context } from './context.ts'

export type HeadEntry = {
  id: string
  markup: string
}

const MARKUP = 'head:markup'
const TAKEN = 'head:taken'
const IMPORTS = 'head:imports'

// A stable, valid CSS identifier for an asset URL. The URL already carries a
// content hash, so this is unique per asset and changes when the asset does —
// which is what lets a live document be asked whether it already has one.
export function assetId(url: string): string {
  return `asset-${url.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

// The markup a request has asked to have in its <head>, keyed by asset id and
// kept in the order it was asked for. Keyed rather than listed, so a component
// asking twice — or two components asking for the same asset — contributes one
// tag.
//
// This lives in core rather than in the plugin that fills it because more than
// one does: `useScript` and `useStyle` both append here, `withMarkup` splices
// the lot into a document, and `defineStream` patches it into a live one. A
// per-plugin `injectHTML` could not be drained incrementally by a stream, and
// two plugins owning the same queue would each emit the other's tags.
export function appendHead(c: Context, id: string, markup: string): void {
  const pending = c.get(MARKUP)

  if (pending === undefined) {
    c.set(MARKUP, new Map([[id, markup]]))

    return
  }

  if (!pending.has(id)) pending.set(id, markup)
}

// The asset ids a request has collected, for seeding the client with what its
// document already holds.
export function headIds(c: Context): readonly string[] {
  const pending = c.get(MARKUP)

  return pending === undefined ? [] : [...pending.keys()]
}

// One import map is allowed per document, so entries are collected here rather
// than each plugin writing its own <script type="importmap">.
export function appendImport(c: Context, specifier: string, url: string): void {
  const imports = c.get(IMPORTS)

  if (imports === undefined) {
    c.set(IMPORTS, new Map([[specifier, url]]))

    return
  }

  if (!imports.has(specifier)) imports.set(specifier, url)
}

export function importMap(c: Context): string {
  const imports = c.get(IMPORTS)

  if (imports === undefined || imports.size === 0) return ''

  // Raw, not built with `html`: a <script> body is raw text, so entities are
  // not decoded inside it and an escaped quote would be a literal &quot;.
  return `<script type="importmap">${JSON.stringify({
    imports: Object.fromEntries(imports),
  })}</script>`
}

export function headMarkup(c: Context): string {
  const pending = c.get(MARKUP)

  return pending === undefined ? '' : [...pending.values()].join('')
}

// A stream wants only what is new since it last looked, and a Map keeps
// insertion order, so a count of what has gone out is the whole bookmark.
export function takeHeadMarkup(c: Context): readonly HeadEntry[] {
  const pending = c.get(MARKUP)

  if (pending === undefined) return []

  const taken = c.get(TAKEN) ?? 0

  if (pending.size <= taken) return []

  c.set(TAKEN, pending.size)

  return [...pending].slice(taken).map(([id, markup]) => ({ id, markup }))
}
