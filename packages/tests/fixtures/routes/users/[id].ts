import { defineRoute } from '@erikt/framework'

export const GET = defineRoute(c => ({ id: c.params.id }))
export const POST = defineRoute(c => {
  c.status(201)

  return 'saved'
})
