import type { ErrorHandler, Handler } from './app.ts'
import type { Context } from './context.ts'
import { isSafeString } from './helpers/html.ts'
import type { InjectTarget } from './plugin.ts'

// What a route answers with, which is also how it says what it is. There is no
// c.html, c.text or c.json to call: the return value carries that, so a route
// says a thing once instead of saying it and then building a response about it.
export type RouteResult = string | object

export type RouteRender = (c: Context) => RouteResult | Promise<RouteResult>

// Takes the error as its first argument, so an error page can say what went
// wrong. Everything else about it matches a page, the return value included.
export type ErrorRender = (error: unknown, c: Context) => RouteResult | Promise<RouteResult>

export type Layout = (content: string, c: Context) => string | Promise<string>

export type HtmlInjector = (html: string, c: Context, target: InjectTarget) => Promise<string>

const OK = 200
const SERVER_ERROR = 500

const HTML = 'text/html; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

const ROUTE_LAYOUT = 'route:layout'

const ROUTE = Symbol('framework.route')
const ERROR = Symbol('framework.errorPage')

type Branded = { [ROUTE]?: RouteRender }
type BrandedError = { [ERROR]?: ErrorRender }

// The whole of the framework's content-type policy, in one place. `html`
// returns a SafeString, so that is markup; a plain string is text; anything
// else is data.
//
// A string built by hand — `'<p>' + value + '</p>'`, or two `html` results
// concatenated — is a plain string and is answered as text/plain. That is
// deliberate and worth knowing: the one string that skipped `html` is the one
// whose interpolations were never escaped, and showing it verbatim is better
// than handing a browser markup to execute.
//
// `type` rather than a header, so a route that set its own content-type keeps
// it — see ResponseOptions.
function respond(c: Context, result: RouteResult): Response {
  if (isSafeString(result)) return c.body(result, { type: HTML })
  if (typeof result === 'string') return c.body(result, { type: TEXT })

  return c.body(JSON.stringify(result), { type: JSON_TYPE })
}

export function defineRoute(render: RouteRender): Handler {
  return Object.assign(async (c: Context) => respond(c, await render(c)), { [ROUTE]: render })
}

// Wraps this response in a layout. There is no app-wide default: a route that
// does not ask for one answers with its markup as-is, which is what a fragment
// wants.
//
// Read after the render rather than before, so a route — or a component it
// called — can decide partway through.
export function useLayout(c: Context, layout: Layout): void {
  c.set(ROUTE_LAYOUT, layout)
}

export function defineErrorPage(render: ErrorRender): ErrorHandler {
  return Object.assign(
    async (error: unknown, c: Context) => respond(c, await render(error, c)),
    { [ERROR]: render },
  )
}

export function defineLayout(layout: Layout): Layout {
  return layout
}

function spliceAt(html: string, index: number, markup: string): string {
  return html.slice(0, index) + markup + html.slice(index)
}

// A missing closing tag anchors at the end of the string rather than dropping
// the markup, which is what makes this work for a fragment. Both offsets are
// taken from the original, and the body one is never the earlier of the two, so
// splicing the body first cannot move the head one — that is what keeps head
// before body when a fragment sends both to the end.
export function insertMarkup(html: string, head: string, body: string): string {
  if (head === '' && body === '') return html

  const lower = html.toLowerCase()
  const headAt = lower.indexOf('</head>')
  const bodyAt = lower.lastIndexOf('</body>')

  const withBody = body === '' ? html : spliceAt(html, bodyAt === -1 ? html.length : bodyAt, body)

  return head === '' ? withBody : spliceAt(withBody, headAt === -1 ? html.length : headAt, head)
}

// Applied where the route is registered rather than inside the handler, so a
// page composes with app.get and fileRouter alike without either of them, or
// the page itself, knowing that a layout exists. A route that returns a fragment
// is the same deal minus the layout: injections land in the fragment. A route
// that returns data leaves here as JSON, untouched.
export function withMarkup(handler: Handler, inject?: HtmlInjector): Handler {
  const render = (handler as Branded)[ROUTE]

  if (render === undefined) return handler

  return async c => {
    const result = await render(c)

    // Only markup is wrapped and injected into: text and data have nothing for
    // a layout to hold or a plugin to splice into. A route that asked for a
    // layout and then returned one of those still gets it as it is — what it
    // returned is what it meant.
    //
    // Decided here, on what the render returned, and not again afterwards:
    // wrapping and injecting both concatenate, so a document is a plain string
    // by the time it is finished, and re-reading it would answer text/plain.
    if (!isSafeString(result)) return respond(c, result)

    // Whatever the route asked for, which it can only have done during the
    // render above. Nothing asked means nothing wraps it.
    const wrapper = c.get(ROUTE_LAYOUT)

    const markup = wrapper === undefined ? result : await wrapper(result, c)
    const target = wrapper === undefined ? 'fragment' : 'document'

    return c.body(inject === undefined ? markup : await inject(markup, c, target), { type: HTML })
  }
}

// The error path's counterpart to withMarkup. Kept separate rather than folded
// into it because an error render takes the error as well as the context, and
// because of the two things below, which only make sense here.
export function withErrorMarkup(handler: ErrorHandler, inject?: HtmlInjector): ErrorHandler {
  const render = (handler as BrandedError)[ERROR]

  if (render === undefined) return handler

  return async (error, c) => {
    // A handler that chose a status before throwing keeps it, so `c.status(401)`
    // followed by a throw still answers 401. Only an untouched default becomes a
    // 500 — which is what stops a page that forgets from answering a crash with
    // a 200. Either way the render can read it back with c.status().
    if (c.status() === OK) c.status(SERVER_ERROR)

    try {
      const result = await render(error, c)

      if (!isSafeString(result)) return respond(c, result)

      const wrapper = c.get(ROUTE_LAYOUT)
      const markup = wrapper === undefined ? result : await wrapper(result, c)
      const target = wrapper === undefined ? 'fragment' : 'document'

      return c.body(inject === undefined ? markup : await inject(markup, c, target), { type: HTML })
    } catch {
      // The error page itself failed — most likely the layout, which is exactly
      // when a second throw would escape app.fetch and lose the response
      // altogether. The plain 500 is the floor.
      return new Response('500 Internal Server Error', { status: 500 })
    }
  }
}
