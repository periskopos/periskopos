// A title-bar button that opens a small panel under it (updates,
// notifications): it opens and closes on click, closes on Escape from
// wherever focus is (focus back on the button) and on a click anywhere else,
// and says so to screen readers (aria-expanded). The first control in the
// panel gets focus.

export type Popover = { isOpen: () => boolean; open: () => void; close: (returnFocus?: boolean) => void; destroy: () => void };

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
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && isOpen()) {
      e.stopPropagation();
      close(true);
    }
  };
  const onClick = (e: MouseEvent) => {
    if (isOpen() && !root.contains(e.target as Node)) close();
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onClick);
  // For one that goes away with its page, rather than living in the title bar.
  const destroy = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onClick);
  };
  return { isOpen, open, close, destroy };
}
