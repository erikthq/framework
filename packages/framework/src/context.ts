// Type-only, and page.ts imports Context back — a cycle TypeScript resolves and
// `verbatimModuleSyntax` erases entirely, so nothing circular survives to run.
import type { Layout } from './page.ts'

// `type` is a *default* content-type: it lands only when nothing has set one
// already, so a handler's own c.header('content-type', …) still wins. That is
// the behaviour c.html, c.text and c.json had, kept here now that c.body is the
// only builder on the context.
export type ResponseOptions = number | (ResponseInit & { type?: string })

const DEFAULT_STATUS = 200


// Derived from the lib in scope rather than naming BodyInit, which DOM and
// @types/node do not both declare.
export type ResponseBody = ConstructorParameters<typeof Response>[0]

// The per-request bag's keys, as an interface so an app can name its own and
// get them back typed:
//
//   declare module '@erikt/framework' {
//     interface ContextBag {
//       user: { id: number }
//     }
//   }
//
// The keys the framework's own plugins use are declared here rather than in
// each plugin, so the whole set is reviewable in one place and nothing collides
// with an app's key by accident.
export interface ContextBag {
  'logger:started': number
  'app:fetch': (request: Request) => Promise<Response>
  'head:imports': Map<string, string>
  'route:layout': Layout
  'head:markup': Map<string, string>
  'head:taken': number
  'scripts:registry': ReadonlyMap<string, string>
  'scripts:base': string
  'styles:base': string
}

// The `string & {}` half keeps an unknown key working. Written as an
// intersection rather than plain `string` because a union with `string` widens
// to `string` and the editor stops offering the keys above — which is the whole
// point of the interface.
export type ContextKey = keyof ContextBag | (string & {})

export type ContextValue<K> = K extends keyof ContextBag ? ContextBag[K] : unknown

// An interface, not a type alias, so a plugin can add to it:
//
//   declare module '../context.ts' {
//     interface Context {
//       readonly signals: Signals
//     }
//   }
//
// That is how `datastar` puts c.signals here without core knowing what a
// signal is.
export interface Context {
  req: Request
  url: URL
  params: Record<string, string | undefined>
  header(name: string, value: string): void
  status(): number
  status(code: number): void
  set<K extends ContextKey>(key: K, value: ContextValue<K>): void
  get<K extends ContextKey>(key: K): ContextValue<K> | undefined
  body(body: ResponseBody, options?: ResponseOptions): Response
  redirect(location: string | URL, status?: number): Response
}

export function createContext(
  req: Request,
  url: URL,
  params: Record<string, string | undefined>,
): Context {
  const pending = new Headers()
  const store = new Map<string, unknown>()
  let pendingStatus: number | undefined

  function build(body: ResponseBody, options: ResponseOptions | undefined): Response {
    const headers = new Headers(pending)
    let status = pendingStatus ?? DEFAULT_STATUS
    let statusText: string | undefined

    if (typeof options === 'number') {
      status = options
    } else if (options !== undefined) {
      if (options.status !== undefined) status = options.status
      if (options.statusText !== undefined) statusText = options.statusText

      for (const [name, value] of new Headers(options.headers)) headers.set(name, value)

      // Must be set before constructing: Response defaults a string body's
      // content-type to text/plain, so patching it afterwards is too late.
      if (options.type !== undefined && !headers.has('content-type')) {
        headers.set('content-type', options.type)
      }
    }

    return new Response(
      body,
      statusText === undefined ? { status, headers } : { status, statusText, headers },
    )
  }

  // Overloaded rather than split into a second name: reading and writing the
  // status are the same idea, and an error page wants both.
  function status(): number
  function status(code: number): void
  function status(code?: number): number | void {
    if (code === undefined) return pendingStatus ?? DEFAULT_STATUS

    pendingStatus = code
  }

  // Plugins add their own properties to Context — `datastar` adds `signals` —
  // so what core builds is deliberately not the whole of it; those plugins fill
  // the rest in their onRequest hook.
  //
  // A downcast, not an escape hatch. It still contextually types every method
  // below, and Context stays assignable to this literal, so a misspelt name or
  // a wrong signature is an error. Only what core cannot know about is waived.
  return {
    req,
    url,
    params,

    header(name, value) {
      pending.set(name, value)
    },

    status,


    set<K extends ContextKey>(key: K, value: ContextValue<K>) {
      store.set(key, value)
    },

    get<K extends ContextKey>(key: K) {
      return store.get(key) as ContextValue<K> | undefined
    },

    body(body, options) {
      return build(body, options)
    },

    redirect(location, status = 302) {
      const response = build(null, status)

      response.headers.set('location', String(location))

      return response
    },
  } as Context
}
