import type {} from 'framework'

// The keys these tests put on the context bag, declared the way a consumer
// would. Types only, and not a *.test.ts file, so the runner never picks it up.
declare module 'framework' {
  interface ContextBag {
    title: string
    user: { id: number }
  }
}
