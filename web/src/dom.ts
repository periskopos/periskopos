// A tiny DOM builder. Text always goes in as text nodes, never as HTML, so
// names and URLs from the database can't inject markup.

export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (key === "value" && "value" in el) {
      (el as HTMLInputElement).value = String(value);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (typeof child === "string" || typeof child === "number") {
      parent.appendChild(document.createTextNode(String(child)));
    } else parent.appendChild(child);
  }
}

// Draws `children` into `root` in place of what was there. Views redraw on a
// timer, so a redraw keeps what the person was in the middle of: the control
// with focus, which disclosures are open, and text typed but not yet saved
// (never a password field, and a submitted form starts clean). Elements are
// matched by what they are: id, name, link, label or text, in order.
export function mount(root: Element, ...children: Child[]) {
  watchTyping();
  const before = signatures(root);
  const focused = document.activeElement && root.contains(document.activeElement) ? before.get(document.activeElement) : undefined;
  const open = new Map<string, boolean>();
  const typed = new Map<string, string>();
  for (const [el, sig] of before) {
    if (el.tagName === "DETAILS") open.set(sig, (el as HTMLDetailsElement).open);
    else if (isTypedField(el) && el.dataset.edited) typed.set(sig, el.value);
  }

  root.replaceChildren();
  append(root, children);
  if (!focused && open.size === 0 && typed.size === 0) return;

  for (const [el, sig] of signatures(root)) {
    if (el.tagName === "DETAILS" && open.has(sig)) (el as HTMLDetailsElement).open = open.get(sig)!;
    else if (isTypedField(el) && typed.has(sig)) {
      el.value = typed.get(sig)!;
      el.dataset.edited = "1";
    }
    if (sig === focused) (el as HTMLElement).focus({ preventScroll: true });
  }
}

type TypedField = HTMLInputElement | HTMLTextAreaElement;
const TEXT_TYPES = new Set(["text", "url", "email", "search", "tel", "number", ""]);
const isTypedField = (el: Element): el is TypedField =>
  el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_TYPES.has(el.getAttribute("type") ?? ""));

const KEYED = "[id], [name], a[href], button, summary, details, select, input, textarea, [tabindex]";

// Each element worth keeping, with a name for it that a redraw reproduces.
function signatures(root: Element): Map<Element, string> {
  const seen = new Map<string, number>();
  const out = new Map<Element, string>();
  for (const el of root.querySelectorAll(KEYED)) {
    const base = describe(el);
    if (!base) continue;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(el, `${base}#${n}`);
  }
  return out;
}

function describe(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  const text = () => (el.textContent ?? "").trim().slice(0, 80);
  if (el.id) return `${tag}#${el.id}`;
  const name = el.getAttribute("name");
  if (name) return `${tag}[name=${name}]`;
  if (tag === "details") return `details:${(el.querySelector("summary")?.textContent ?? "").trim()}`;
  const label = el.getAttribute("aria-label");
  if (label) return `${tag}[label=${label}]`;
  const href = el.getAttribute("href");
  if (href !== null) return `a[href=${href}]:${text()}`;
  if (tag === "button" || tag === "summary") return `${tag}:${text()}`;
  return undefined;
}

// Marks a field as typed in, until its form is submitted.
let watching = false;
function watchTyping() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("input", (e) => {
    const el = e.target as Element | null;
    if (el?.tagName && isTypedField(el)) el.dataset.edited = "1";
  }, true);
  document.addEventListener("submit", (e) => {
    const form = e.target as Element | null;
    if (form?.tagName === "FORM") for (const el of form.querySelectorAll<HTMLElement>("[data-edited]")) delete el.dataset.edited;
  }, true);
}

// Only ever link out to http(s), whatever is stored.
export function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
