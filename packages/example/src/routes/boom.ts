import { defineRoute } from "@erikt/framework";

// Exists to exercise the error page: /boom is the only route here that throws.
export default defineRoute((c) => {
  c.status(401);

  throw new Error("this route always throws");
});
