import type { Context } from 'framework'

export const GET = (c: Context) => c.json({ id: 'me' })
