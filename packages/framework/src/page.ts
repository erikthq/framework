import type { Handler } from './app.ts'
import type { Context } from './context.ts'
import type { InjectTarget } from './plugin.ts'

export type PageRender = (c: Context) => string | Promise<string>

export type EndpointRender = PageRender

export type Layout = (content: string, c: Context) => string | Promise<string>

export type HtmlInjector = (html: string, c: Context, target: InjectTarget) => Promise<string>

const PAGE = Symbol('framework.page')
const ENDPOINT = Symbol('framework.endpoint')

type Branded = { [PAGE]?: PageRender; [ENDPOINT]?: EndpointRender }

export function definePage(render: PageRender): Handler {
  return Object.assign(async (c: Context) => c.html(await render(c)), { [PAGE]: render })
}

export function defineEndpoint(render: EndpointRender): Handler {
  return Object.assign(async (c: Context) => c.html(await render(c)), { [ENDPOINT]: render })
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
// the page itself, knowing that a layout exists. An endpoint is the same deal
// minus the layout: it renders a fragment, and injections land in the fragment.
export function withMarkup(
  handler: Handler,
  layout: Layout | undefined,
  inject?: HtmlInjector,
): Handler {
  const branded = handler as Branded
  const page = branded[PAGE]
  const render = page ?? branded[ENDPOINT]

  if (render === undefined) return handler

  const wrapper = page === undefined ? undefined : layout

  if (wrapper === undefined && inject === undefined) return handler

  return async c => {
    const rendered = await render(c)
    const markup = wrapper === undefined ? rendered : await wrapper(rendered, c)

    return c.html(
      inject === undefined
        ? markup
        : await inject(markup, c, wrapper === undefined ? 'fragment' : 'document'),
    )
  }
}
