import type {} from "@erikt/framework";

// Declaration merging, so c.get("title") comes back typed and the editor
// suggests it. Types only — this file has no runtime side.
declare module "@erikt/framework" {
  // Every signal this app defines. Adding one here is what gives it a type on
  // c.signals — undeclared keys still read, as unknown.
  //
  // Optional, all of them: the browser decides what arrives, so a route should
  // still say what it wants when nothing comes.
  interface Signals {
    count?: number;
  }

  interface ContextBag {
    title: string;
  }
}
