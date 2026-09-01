import { defineRoute } from "@erikt/framework";

// The status is set on the context; the body is just returned.
export const POST = defineRoute(async (c) => {
  c.status(201);

  return await c.req.json();
});
