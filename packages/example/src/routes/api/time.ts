import { defineRoute } from "@erikt/framework";

export const GET = defineRoute(() => ({ now: new Date().toISOString() }));
