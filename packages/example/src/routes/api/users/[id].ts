import { defineRoute } from "@erikt/framework";

export const GET = defineRoute((c) => ({
  id: c.params.id,
  name: `user ${c.params.id}`,
}));
