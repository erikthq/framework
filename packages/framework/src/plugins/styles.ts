import type { Context } from '../context.ts'
import { appendHead, assetId } from '../head.ts'
import { html } from '../helpers/html.ts'
import type { Plugin } from '../plugin.ts'

export type Style = {
  readonly hash: string
  readonly text: string
}

export type StylesOptions = {
  base?: string
}

const DEFAULT_BASE = 'styles'

const BASE = 'styles:base'

const IMMUTABLE = 'public, max-age=31536000, immutable'

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

const HASH_LENGTH = 12

// FNV-1a rather than crypto.subtle, which is async: `css` is called while a
// module is being evaluated and has to hand back a usable hash there and then.
// This is a cache key, not a signature — 48 bits is far more than enough to
// tell a handful of stylesheets apart, and none of it is security.
function fingerprint(text: string): string {
  let hash = FNV_OFFSET

  // Over UTF-8 bytes, not UTF-16 units, so the same stylesheet fingerprints the
  // same whatever it contains.
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK
  }

  return hash.toString(16).padStart(16, '0').slice(0, HASH_LENGTH)
}

// Module-level, because a css`` block is created while its module is evaluated,
// long before any app exists. Keyed by text so identical CSS written in two
// places is one stylesheet, and so calling css`` again at the same site returns
// the same Style rather than growing the registry.
const byText = new Map<string, Style>()
const byHash = new Map<string, Style>()

export function css(strings: TemplateStringsArray, ...values: unknown[]): Style {
  let text = strings[0] ?? ''

  for (const [index, value] of values.entries()) {
    text += String(value) + (strings[index + 1] ?? '')
  }

  text = text.trim()

  const existing = byText.get(text)

  if (existing !== undefined) return existing

  const style: Style = { hash: fingerprint(text), text }

  byText.set(text, style)
  byHash.set(style.hash, style)

  return style
}

export function useStyle(c: Context, ...used: readonly Style[]): void {
  const base = c.get(BASE)

  if (base === undefined) {
    throw new TypeError(
      'useStyle needs the styles plugin — register it with app.plugin(styles())',
    )
  }

  for (const style of used) {
    const url = `${base}${style.hash}.css`

    appendHead(
      c,
      assetId(url),
      String(html`<link rel="stylesheet" id="${assetId(url)}" href="${url}" />`),
    )
  }
}

export function styles(options: StylesOptions = {}): Plugin {
  const base = `/${(options.base ?? DEFAULT_BASE).replace(/^\/+|\/+$/g, '')}/`

  return {
    name: 'styles',

    setup(app) {
      // One route for every stylesheet: the hash is the lookup key, so nothing
      // has to be registered as css`` blocks are discovered.
      app.get(`${base}:hash.css`, c => {
        const style = byHash.get(c.params.hash ?? '')

        if (style === undefined)
          return c.body('404 Not Found', { status: 404, type: 'text/plain; charset=utf-8' })

        return c.body(style.text, {
          headers: {
            'content-type': 'text/css; charset=utf-8',
            // Safe because the hash changes whenever the css does.
            'cache-control': IMMUTABLE,
          },
        })
      })
    },

    onRequest(c) {
      c.set(BASE, base)
    },
  }
}
