import type {} from '@erikt/framework'

declare module '@erikt/framework' {
  interface Signals {
    theme?: string
    counting?: boolean
  }

  interface ContextBag {
    title: string
  }
}
