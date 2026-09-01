import { getPath, mergePatch } from "datastar";

// Datastar's own data-on: expressions are the usual way to touch a signal. This
// is here to show a plain browser module can too, through the import map the
// datastar plugin injects — no URL, no global.
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-bump]")) {
  button.addEventListener("click", () => {
    const step = Number(button.dataset["bump"] ?? "1");
    const count = getPath<number>("count") ?? 0;

    mergePatch({ count: count + step });
  });
}
