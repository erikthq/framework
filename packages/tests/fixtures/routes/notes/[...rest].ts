import type { Context } from 'framework'

export default (c: Context) => c.text(`${c.req.method} ${c.params.rest}`)
