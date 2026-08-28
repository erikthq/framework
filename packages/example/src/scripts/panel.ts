for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
  panel.dataset["ready"] = "yes";
  panel.style.borderLeft = "3px solid currentColor";
  panel.style.paddingLeft = "0.6rem";
}
