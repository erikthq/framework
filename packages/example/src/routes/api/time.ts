import type { Context } from 'framework'

export const GET = (c: Context) => c.json({ now: new Date().toISOString() })
