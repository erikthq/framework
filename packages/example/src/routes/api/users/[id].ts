import type { Context } from 'framework'

export const GET = (c: Context) => c.json({ id: c.params.id, name: `user ${c.params.id}` })
