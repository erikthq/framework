const output = document.querySelector<HTMLPreElement>("#output");

const show = (text: string): void => {
  if (output !== null) output.textContent = text;
};

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-url]")) {
  button.addEventListener("click", async () => {
    const url = button.dataset["url"];

    if (url === undefined) return;

    show("…");

    const response = await fetch(url);
    const body = await response.text();

    show(`${response.status} ${response.statusText}\n\n${body}`);
  });
}
