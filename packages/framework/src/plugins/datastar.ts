import type { Handler } from '../app.ts'
import type { Context } from '../context.ts'
import { appendImport, headIds, takeHeadMarkup } from '../head.ts'
import { html } from '../helpers/html.ts'
import type { Plugin } from '../plugin.ts'
import { DATASTAR_CLIENT, DATASTAR_VERSION } from './datastar-client.ts'


// Declaration-merged, so an app names the signals it uses once and c.signals is
// typed:
//
//   declare module '@erikt/framework' {
//     interface Signals {
//       count: number
//     }
//   }
//
// Anything undeclared still reads back as `unknown` rather than erroring.
export interface Signals {
  // The framework's own, declared here so it shows as taken rather than
  // colliding with one of yours. Optional like any other: the browser decides
  // what it actually sends.
  headAssets?: Record<string, boolean>
}

export type ContextSignals = Signals & Record<string, unknown>

// This plugin owns c.signals, so it is this plugin that puts it on the context
// type. Core has no idea what a signal is.
declare module '../context.ts' {
  interface Context {
    readonly signals: ContextSignals
  }
}

export type PatchMode =
  | 'outer'
  | 'inner'
  | 'replace'
  | 'prepend'
  | 'append'
  | 'before'
  | 'after'
  | 'remove'

export type PatchElementsOptions = {
  selector?: string
  mode?: PatchMode
  namespace?: 'svg' | 'mathml'
  useViewTransition?: boolean
  viewTransitionSelector?: string
}

export type PatchSignalsOptions = {
  onlyIfMissing?: boolean
}

export type DatastarStream = {
  readonly closed: boolean
  patchElements(elements: string, options?: PatchElementsOptions): void
  patchSignals(signals: unknown, options?: PatchSignalsOptions): void
  removeElements(selector: string): void
  patchPage(target?: string | URL): Promise<void>
  event(name: string, lines: readonly string[]): void
  close(): void
}

export type StreamRender = (stream: DatastarStream, c: Context) => void | Promise<void>

export type DatastarOptions = {
  param?: string
  client?: boolean
}

const PATCH_ELEMENTS = 'datastar-patch-elements'
const PATCH_SIGNALS = 'datastar-patch-signals'


// The signal carrying which assets a document already holds. Datastar sends
// every signal that does not start with `_` on every request, so a stream is
// told what is on the page rather than having to ask the DOM — which cannot be
// done in one patch without Datastar logging a miss.
const ASSETS = 'headAssets'

// Marks a render this plugin asked for, so a page that patches itself cannot
// set off an unbounded chain of them.
const RENDER = 'x-framework-render'

// Dropped from an internal render because each one would answer with something
// other than the page's markup: a compressed body that .text() cannot decode, a
// partial one, a 304 with no body at all, or a Datastar fragment.
const STRIP = [
  'accept-encoding',
  'range',
  'if-none-match',
  'if-modified-since',
  'datastar-request',
]

async function renderPage(c: Context, target: string | URL | undefined): Promise<string> {
  if (c.req.headers.get(RENDER) !== null) {
    throw new Error('patchPage was called while rendering a page, which would not terminate')
  }

  const dispatch = c.get('app:fetch')

  if (dispatch === undefined) {
    throw new TypeError('patchPage needs a context the app created')
  }

  const from = target ?? c.req.headers.get('referer')

  if (from === null || from === undefined) {
    throw new TypeError(
      'patchPage has no page to render: the request carried no Referer, so name a url',
    )
  }

  const url = new URL(from, c.url)

  if (url.origin !== c.url.origin) {
    throw new TypeError(`patchPage will not render ${url.origin}, which is not this app`)
  }

  const headers = new Headers(c.req.headers)

  for (const name of STRIP) headers.delete(name)

  headers.set(RENDER, '1')

  const response = await dispatch(new Request(url, { method: 'GET', headers }))
  const type = response.headers.get('content-type') ?? ''

  if (!type.includes('html')) {
    throw new TypeError(
      `patchPage rendered ${url.pathname} but got ${JSON.stringify(type)}, not html`,
    )
  }

  return response.text()
}

const DEFAULT_PARAM = 'datastar'

const CLIENT_URL = `/datastar-${DATASTAR_VERSION}.js`

const CLIENT_HEADERS = {
  'content-type': 'text/javascript; charset=utf-8',
  // The version is in the path, so a given URL never changes what it serves.
  'cache-control': 'public, max-age=31536000, immutable',
}

const JSON_TYPE = /^application\/(?:[\w.-]+\+)?json\b/i

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  // no-transform is what keeps compress off this response. That middleware
  // peeks up to its threshold before deciding, which would hold the first
  // events of a long-lived stream back until enough bytes had accumulated.
  'cache-control': 'no-cache, no-transform',
}

function dataLines(key: string, value: string): string[] {
  return String(value)
    .trim()
    .split(/\r?\n/)
    .map(line => `${key} ${line}`)
}

function frame(name: string, lines: readonly string[]): string {
  return `event: ${name}\n${lines.map(line => `data: ${line}\n`).join('')}\n`
}

export function defineStream(render: StreamRender): Handler {
  return c => {
    let open = true
    let controller: ReadableStreamDefaultController<string> | null = null

    const held = new Set(Object.keys(c.signals[ASSETS] ?? {}))

    function write(name: string, lines: readonly string[]): void {
      if (!open || controller === null) return

      controller.enqueue(frame(name, lines))
    }

    // A page splices its useScript and useStyle tags into the layout's head; a
    // stream has no document to render, so it appends them to the head of the
    // one already on screen. Flushed after the event rather than before it, so
    // an asset lands once the markup it came with is in the DOM.
    //
    // Anything the page already carries is skipped, and what does go out is
    // recorded back into the signal, so a second request for the same stream
    // sends nothing. Uses `write`, not `send`, or the signal patch would
    // re-enter this function.
    function flush(): void {
      const fresh = takeHeadMarkup(c).filter(entry => !held.has(entry.id))

      if (fresh.length === 0) return

      const added: Record<string, boolean> = {}

      for (const entry of fresh) {
        write(PATCH_ELEMENTS, [
          'selector head',
          'mode append',
          ...dataLines('elements', entry.markup),
        ])

        held.add(entry.id)
        added[entry.id] = true
      }

      write(PATCH_SIGNALS, dataLines('signals', JSON.stringify({ [ASSETS]: added })))
    }

    function send(name: string, lines: readonly string[]): void {
      write(name, lines)
      flush()
    }

    const stream: DatastarStream = {
      get closed() {
        return !open
      },

      patchElements(elements, options = {}) {
        const lines: string[] = []

        if (options.selector !== undefined) lines.push(`selector ${options.selector}`)
        if (options.mode !== undefined) lines.push(`mode ${options.mode}`)
        if (options.namespace !== undefined) lines.push(`namespace ${options.namespace}`)
        if (options.useViewTransition === true) lines.push('useViewTransition true')
        if (options.viewTransitionSelector !== undefined) {
          lines.push(`viewTransitionSelector ${options.viewTransitionSelector}`)
        }

        send(PATCH_ELEMENTS, [...lines, ...dataLines('elements', elements)])
      },

      patchSignals(signals, options = {}) {
        const lines = options.onlyIfMissing === true ? ['onlyIfMissing true'] : []
        const encoded = JSON.stringify(signals)

        send(PATCH_SIGNALS, [
          ...lines,
          ...dataLines('signals', encoded === undefined ? 'null' : encoded),
        ])
      },

      removeElements(selector) {
        send(PATCH_ELEMENTS, [`selector ${selector}`, 'mode remove'])
      },

      // Datastar parses markup containing </html> as a whole document and morphs
      // it over documentElement, so no selector or mode is wanted here — the
      // default outer morph is the one that does a soft reload.
      async patchPage(target) {
        send(PATCH_ELEMENTS, dataLines('elements', await renderPage(c, target)))
      },

      event(name, lines) {
        send(name, lines)
      },

      close() {
        if (!open) return

        // Last chance for a stream that asked for a script and sent nothing.
        flush()

        open = false
        controller?.close()
      },
    }

    const source = new ReadableStream<string>({
      start(active) {
        controller = active

        // The status line is already on the wire by the time render runs, so a
        // throw can no longer become a 500 — erroring the stream is all that is
        // left. Report failures to the client by patching, the Datastar way.
        void (async () => {
          try {
            await render(stream, c)
            stream.close()
          } catch (error) {
            open = false
            active.error(error)
          }
        })()
      },

      cancel() {
        open = false
      },
    })

    // A dropped connection has to stop a render that loops on `closed`, and
    // cancel() is not guaranteed to run before its next iteration.
    c.req.signal.addEventListener('abort', () => {
      open = false
    }, { once: true })

    return c.body(source.pipeThrough(new TextEncoderStream()), { headers: SSE_HEADERS })
  }
}

// Raw client input, so a plain record — never ContextSignals. An app may
// declare a signal as required, and nothing here can promise the browser
// actually sent it; only the c.signals getter asserts that shape.
function parseSignals(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === '') return {}

  try {
    const value: unknown = JSON.parse(raw)

    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    // This hook runs on every request, including ones that were never meant for
    // Datastar, so unreadable input means "no signals" rather than a 500.
    return {}
  }
}

async function requestSignals(c: Context, param: string): Promise<Record<string, unknown>> {
  const method = c.req.method.toUpperCase()

  if (method === 'GET' || method === 'HEAD') return parseSignals(c.url.searchParams.get(param))

  if (c.req.body === null) return {}
  if (!JSON_TYPE.test(c.req.headers.get('content-type') ?? '')) return {}

  try {
    // Cloned so the handler still gets the body it was sent.
    return parseSignals(await c.req.clone().text())
  } catch {
    return {}
  }
}

export function datastar(options: DatastarOptions = {}): Plugin {
  const param = options.param ?? DEFAULT_PARAM
  const client = options.client ?? false

  return {
    name: 'datastar',

    setup(app) {
      if (!client) return

      app.get(CLIENT_URL, c => c.body(DATASTAR_CLIENT, { headers: CLIENT_HEADERS }))
    },

    // Documents only. The runtime is a page-wide concern, and a fragment is
    // patched into a page that is already running it.
    injectHTML(c, target) {
      if (target === 'fragment') return

      const parts: string[] = []

      if (client) {
        appendImport(c, 'datastar', CLIENT_URL)

        parts.push(String(html`<script type="module" src="${CLIENT_URL}"></script>`))
      }

      // Tells the page which assets it already has, so a stream can skip them.
      // Escaping is correct here: the browser decodes the entities before
      // Datastar reads the attribute.
      const ids = headIds(c)

      if (ids.length > 0) {
        const seed = JSON.stringify({ [ASSETS]: Object.fromEntries(ids.map(id => [id, true])) })

        parts.push(String(html`<meta name="framework-head-assets" data-signals="${seed}" />`))
      }

      if (parts.length === 0) return

      return { head: parts.join('') }
    },

    async onRequest(c) {
      // Parsed input is arbitrary, so nothing above can promise the browser sent
      // a signal an app declared as required. This is the single point where
      // that claim is made — which is why the README says to validate anything
      // you are going to trust. The second cast is only because the property is
      // readonly to everyone else.
      const signals = (await requestSignals(c, param)) as ContextSignals

      ;(c as { signals: ContextSignals }).signals = signals
    },
  }
}
