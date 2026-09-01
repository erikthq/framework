import { defineStream } from "@erikt/framework"

// One endpoint for every page. It re-renders whichever page called it — taken
// from the Referer — and Datastar morphs the whole document back in.
export const GET = defineStream(async (stream) => {
  await stream.patchPage()
})
