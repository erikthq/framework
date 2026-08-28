import type { Plugin, RouteInfo, StartInfo } from '../plugin.ts'

export type BannerOptions = {
  title?: string
  color?: boolean
  routes?: boolean
  log?: (message: string) => void
}

const RESET = '\u001b[0m'

const STYLE = {
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  magenta: '\u001b[35m',
  yellow: '\u001b[33m',
}

const METHOD_WIDTH = 6

type Paint = (value: string, style: string) => string

function visibleLength(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, '').length
}

function box(lines: string[], paint: Paint): string {
  const width = Math.max(...lines.map(visibleLength))
  const body = lines.map(line => {
    const padding = ' '.repeat(width - visibleLength(line))

    return `${paint('│', STYLE.dim)} ${line}${padding} ${paint('│', STYLE.dim)}`
  })

  const top = `╭${'─'.repeat(width + 2)}╮`
  const bottom = `╰${'─'.repeat(width + 2)}╯`

  return [paint(top, STYLE.dim), ...body, paint(bottom, STYLE.dim)].join('\n')
}

function methodStyle(method: string): string {
  if (method === 'GET') return STYLE.green
  if (method === 'ALL') return STYLE.yellow

  return STYLE.magenta
}

function routeLines(routes: readonly RouteInfo[], paint: Paint): string[] {
  return routes.map(
    route =>
      `  ${paint(route.method.padEnd(METHOD_WIDTH), methodStyle(route.method))} ${paint(route.pattern, STYLE.dim)}`,
  )
}

export function banner(options: BannerOptions = {}): Plugin {
  const title = options.title ?? 'framework'
  const showRoutes = options.routes ?? true
  const useColor = options.color ?? true
  const write = options.log ?? ((message: string) => console.log(message))

  const paint: Paint = (value, style) => (useColor ? `${style}${value}${RESET}` : value)

  return {
    name: 'banner',

    onStart(info: StartInfo) {
      const lines = [`${paint(title, STYLE.bold + STYLE.cyan)} ${paint('ready', STYLE.green)}`, '']

      if (info.url !== undefined) lines.push(`  ${paint('▸', STYLE.cyan)} ${info.url}`)

      lines.push(`  ${paint('runtime', STYLE.dim)}  ${info.runtime}`)
      lines.push(`  ${paint('routes', STYLE.dim)}   ${String(info.routes.length)}`)

      if (info.plugins.length > 0) {
        lines.push(`  ${paint('plugins', STYLE.dim)}  ${info.plugins.join(', ')}`)
      }

      if (showRoutes && info.routes.length > 0) lines.push('', ...routeLines(info.routes, paint))

      write(box(lines, paint))
    },

    onStop() {
      write(paint(`${title} stopped`, STYLE.dim))
    },
  }
}
