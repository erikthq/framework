import { defineRoute } from '@erikt/framework'

export default defineRoute(c => `${c.req.method} ${c.params.rest}`)
