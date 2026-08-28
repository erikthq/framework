import type { Context } from 'framework'

export const POST = async (c: Context) => c.json(await c.req.json(), 201)
