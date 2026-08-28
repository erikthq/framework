const clock = document.querySelector<HTMLTimeElement>("#clock");

const pulse = (): void => {
  if (clock === null) return;

  clock.style.opacity = "0.4";
  setTimeout(() => (clock.style.opacity = "1"), 150);
};

new MutationObserver(pulse).observe(clock ?? document.body, {
  childList: true,
  characterData: true,
  subtree: true,
});
