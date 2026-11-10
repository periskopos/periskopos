# Design

How Periskopos looks and why, and the pieces to build a screen from. The values
live in [`web/src/tokens.css`](../web/src/tokens.css); the pieces in
[`web/src/styles/`](../web/src/styles) and [`web/src/ui.ts`](../web/src/ui.ts).
[`test/design-tokens.test.ts`](../test/design-tokens.test.ts) checks the rules
that can be checked.

## The idea: mission control

A calm instrument panel. Neutrals carry the layout; colour is kept for status,
so a problem is the loudest thing on screen. Dark is the main theme, and light
follows the system. The light theme is designed in its own right (a cool paper
canvas with white surfaces), not a flipped dark one.

## Rules

1. **Every value is a token.** A style takes its colours, sizes, spacing, radii,
   shadows and timings from `tokens.css` (`var(--…)`), never a raw value. Need
   one that's missing? Add it to `tokens.css`, with both themes, and a comment
   saying what it's for. The test fails on a raw colour outside the named
   exceptions, and on a `var(--…)` that isn't defined.
2. **Colour means status.** Green up, red down, amber needs attention, blue in
   progress, grey unknown. Nothing else is coloured, apart from the accent blue
   for links, focus and what's selected. Status colours are never decoration.
3. **Never colour alone.** A lamp's shape says its state too (dot, square,
   half-filled dot, pulsing dot, ring, dash), and a status always has a word
   beside it or a label for screen readers.
4. **Contrast is checked.** Text at least 4.5:1 and field borders and focus
   at least 3:1, on its surface, in both themes. Check a new pair before adding it.
5. **Targets are big enough.** At least 24px to click (a disclosure's toggle
   included), 44px for touch (`responsive.css`). List rows are 44px.
6. **Motion only where something changes under you.** A page opening, a panel
   dropping from its button, a layout switching. Nothing moves on the
   minute-by-minute refresh, and it all stops for reduced motion (the duration
   tokens go to 0). See `motion.css`.
7. **Lay out by the room there is.** The page is a container, and its parts use
   container queries (`@container page`), so they fit the space they're given
   rather than the window's width.
8. **No inline styles.** The content security policy forbids them. Styling is
   by class, and state by attribute (`hidden`, `aria-*`, `data-*`).

### The exceptions

Places where a raw colour is right, each named in the test with its reason:

- **Service logos** (`accounts.css`, `.service-logo--*`): each service's own
  brand colour.
- **The World's sky** (`world.css`, `.world-clouds*`): a picture, not a surface.

The World's 3D scene reads its status colours from the `--color-world-*`
tokens, which are the bright hues in both themes, because they're lights in a
sunlit scene rather than words on a page. The scene's own materials and canvas
textures are in TypeScript under `web/src/views/world/`, outside this test.

## Tokens

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--color-bg-canvas`, `-surface`, `-raised`, `-sunken`, `-inverse` | Stepped by a few % of light. Raised is hover, selected and menus; sunken is inputs and code. |
| Text | `--color-text-primary`, `-secondary`, `-tertiary`, `-inverse`, `-link` | Secondary for labels and supporting text, tertiary for times, hashes and hints. |
| Lines | `--color-border-subtle`, `-default`, `-strong`, `-focus` | Subtle divides rows, default outlines sections, strong outlines fields (3:1). |
| Accent | `--color-accent-primary`, `-hover` | Interaction only. |
| Status | `--color-status-{up,down,attention,info,unknown}` and `-tint` | Light theme darkens them so words stay readable on white. |
| World | `--color-world-{up,down,attention,info,unknown}` | The same bright hues in both themes. |
| Special | `--color-on-solid`, `--color-scrim`, `--color-scrollbar-thumb(-hover)` | A mark on a solid fill; the page dimmed behind a tour stop. |
| Type | `--font-family-body` (Geist), `--font-family-mono` (Geist Mono), `--font-size-xs`…`3xl` (11–32px), weights, line heights, letter spacing | Body 14px. |
| Space | `--space-0`…`--space-12` | 4px steps. |
| Shape | `--border-width`, `--border-radius-sm/md/lg/full` | Small, precise radii: 4 chips, 6 controls, 8 sections. |
| Depth | `--shadow-sm/md`, `--shadow-over-map(-sm)`, `--focus-ring` | Dark relies on borders, not shadows; the map's floating cards are the exception. |
| Motion | `--duration-fast/normal/page/pulse`, `--easing-default` | |
| Layout | `--layout-max-width(-wide)`, `--layout-gutter`, `--row-height`, `--lamp-size`, `--topbar-height` | |

The root font size grows from 16px to 18px on wide windows, and every size is in
rem, so the whole window scales with it.

## Type

| Role | Use |
|---|---|
| `h1` | Page title, 20px semibold. |
| `h2` | Section title, 16px semibold. |
| Body | 14px, `--color-text-primary`. |
| `.label` | Small mono capitals: section and figure labels. |
| `.meta` | 12px tertiary: times and other metadata. |
| `.secondary` | Supporting text; inside a section it drops to 12px, so the title and controls stay the loudest. |
| `.num`, `time`, tables | Tabular figures, so numbers line up. |
| `.mono`, `code`, `.hash` | Paths, commands, commit hashes. |

## Components

Build a screen from these before writing new CSS. The TypeScript builders are in
`web/src/ui.ts` and `web/src/settingRows.ts`, using `h` and `mount` from
`web/src/dom.ts`.

| Piece | Builder | Classes |
|---|---|---|
| Section | `section()` | `.section`, `.section-head`, `.section-body`, `.section-foot` |
| Row in a list | | `.item`, `.item-main`, `.item-title`, `.item-end` |
| Status lamp | `lamp()` | `.lamp`, `.lamp--{up,down,attention,checking,unknown,stale,prelaunch,none}`, `.lamp--lg` |
| Status with its word | `status()` | `.status`, `.status--{down,attention,checking}` |
| Figure | `figure()` | `.figure`, `.figure-value` |
| Empty state | `empty()` | `.empty`, `.empty-hero` |
| Error | `errorBox()` | `.notice--error` |
| Notice | | `.notice`, `.notice--ok`, `.notice--error` |
| Toast | `toast()` | `panels.css` |
| Button | `busyButton()` for one that waits | `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--danger-solid`, `.btn--sm` |
| Field | `field()`, `checkbox()` | `.form`, `.form-row`, `.field`, `.field-label`, `.field-hint` |
| Setting row | `settingRow()`, `inputRow()`, `toggleRow()` | `.setting-row`, `.toggle` |
| Choice of a few | `segmented()` | `.segmented`, `.segmented-option` |
| Tag | | `.tag` |
| Tabs | | `.tabs` |
| Popover | `popover()` | |
| App icon | `appIcon()` | `.app-icon` |

One primary button per view, for the thing most people came to do. A
destructive action is `.btn--danger-solid` and asks first.

## Words

The UI talks to one person, plainly. Sentence case for everything, titles and
buttons included. Buttons say what they do ("Connect", "Check now"). An error says
what happened and what to do next. Times are relative ("2 min ago"), with the
exact time on hover.

## Adding to it

1. Look for a component above that fits.
2. If none does, add the new piece to the right file in `web/src/styles/` with a
   comment saying what it's for, built from tokens.
3. If it needs a value that isn't a token, add the token first, in both themes.
4. Run `npm test`. The design test tells you if a raw colour or a missing token
   slipped in.
