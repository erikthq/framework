import type {} from "framework";

// Declaration merging, so c.get("title") comes back typed and the editor
// suggests it. Types only — this file has no runtime side.
declare module "framework" {
  interface ContextBag {
    title: string;
  }
}
