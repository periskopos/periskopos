// A title-bar button that opens a small panel under it (updates,
// notifications): it opens and closes on click, closes on Escape from
// wherever focus is (focus back on the button) and on a click anywhere else,
// and says so to screen readers (aria-expanded). The first control in the
// panel gets focus.

export type Popover = { isOpen: () => boolean; open: () => void; close: (returnFocus?: boolean) => void };

export function popover(root: HTMLElement, button: HTMLButtonElement, panel: HTMLElement, onOpen?: () => void): Popover {
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", panel.id);
  panel.hidden = true;

  const isOpen = () => !panel.hidden;
  const open = () => {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    onOpen?.();
    panel.querySelector<HTMLElement>("a[href], button")?.focus();
  };
  const close = (returnFocus = false) => {
    if (!isOpen()) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (returnFocus) button.focus();
  };

  button.addEventListener("click", () => (isOpen() ? close() : open()));
  // Heard anywhere while it's open: a redraw of the panel can take focus
  // with it (its button gone, say), and Escape must still close it.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      e.stopPropagation();
      close(true);
    }
  });
  document.addEventListener("click", (e) => {
    if (isOpen() && !root.contains(e.target as Node)) close();
  });
  return { isOpen, open, close };
}
