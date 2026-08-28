import type { Context } from 'framework'

export const GET = (c: Context) => c.json({ id: c.params.id })
export const POST = (c: Context) => c.text('saved', 201)
