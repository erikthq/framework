import type {} from '@erikt/framework'

// The keys these tests put on the context bag, declared the way a consumer
// would. Types only, and not a *.test.ts file, so the runner never picks it up.
declare module '@erikt/framework' {
  // Signals merge the same way, so c.signals is typed without a cast. Optional,
  // because the browser decides what actually arrives.
  interface Signals {
    count?: number
  }

  interface ContextBag {
    title: string
    user: { id: number }
  }
}
