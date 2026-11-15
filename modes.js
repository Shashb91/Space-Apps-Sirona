// The mode buttons at the top left (Visualisation, Custom Point, Parametric Search, Sirona Maps).
// Each button shows its own pane underneath; onChange gets the new mode's name.

export function setupModes(onChange) {
  const buttons = [...document.querySelectorAll(".modes .mode")];

  function show(active) {
    for (const button of buttons) {
      const on = button === active;
      button.setAttribute("aria-selected", String(on));
      document.getElementById(button.getAttribute("aria-controls")).hidden = !on;
    }
    onChange?.(active.dataset.mode);
  }

  for (const button of buttons) button.addEventListener("click", () => show(button));
  show(buttons[0]);
  return { select: (name) => show(buttons.find((b) => b.dataset.mode === name)) };
}
