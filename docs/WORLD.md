# The World view: your own valley

> Your own Silicon Valley, drawn from your real data. It grows as your apps do.

A design record for `#/world`. It is the Apps page's data drawn as a place. Code comments
and tests refer to the rules here.

## The one rule

Everything drawn is a fact from the same data as the Apps page. Nothing looks healthy, or
moves, unless that data says so. Not knowing is shown as not knowing (fog, frost), never
as fine. There is no decoration: nothing is drawn that doesn't say something about an app,
a service, the watcher or the road.

## What each thing means

| In the valley | The fact behind it |
|---|---|
| A campus | An app. Height: a floor for each thing watched, up to 10. Width and how full the car park is: its requests over 24 hours, where Cloudflare can be read |
| Lights, sign | Known to be running |
| Smoke and red rings, fog, frost, scaffold, fenced plot | Down, unknown, no recent data, not live yet, no checks |
| An antenna's light | Only what's known: green running, amber needs attention, red down, blue maintenance, and the worse it is the faster it flashes. Fog, frost, a plot with nothing to check and a replay's provider have no light at all |
| A line between two antennas | A real dependency of that app on that service. Thin and always there, grey if the service hasn't been read. Solid when the service is in trouble or in maintenance, or when one end is selected, and only then, with the service fine and the app serving, do lights travel along it |
| Crane and a moving delivery truck | A deploy under way |
| A truck stopped at the door | A push that isn't live |
| A service plant behind the apps, on higher ground | A provider your apps rely on, with its logo and status light |
| A patrol van | One real check from the watcher's log. Its colour is the result. It drives from the dish, down the hill road and the spine, along the main road to the campus, and back once |
| A car | A share of an app's real requests. Where they can't be read, two cars say only "it's serving" |
| The dish on the hill | The watcher. It turns only while checks are being read |
| A campus coming up out of its plot, floor by floor | An app that's new or newly live since you last looked. A campus that gains floors or width is really watching more, or really has more requests. Its light and lines come on once it's up |
| The land spreading out | Your apps reached a new stage since you last looked |
| A wider valley floor | The floor widens with the number of apps: small to 3, wider to 9, widest from 10 |

Every vehicle can be clicked, and followed, to see what it stands for. A replay has no
vehicles: nothing in the past moves.

## How it's built

- **`shared/world.ts`, `shared/valley/`: the pure core.** Facts, layout, terrain heights,
  routes, trips and scenery placement, with no DOM or three.js, tested in Node. A test
  keeps it that way.
- **`web/src/views/world.ts`, `web/src/views/world/`: the page.** Real HTML over the picture:
  labels, panels, the figures across the top, replay.
- **`web/src/views/world/scene/`: the picture.** Small `createX(deps)` modules wired in
  `index.ts`. Loaded only when the page opens. It decides nothing about what's true.
- One camera and one input controller (`rig.ts`), whatever's being looked at.
- Repeated things share one mesh (instancing), and vehicles are a draw call per kind. Land is rebuilt only when its plan changes, shadows only when something built
  changes.
- Frames are frugal: smooth while being moved, calm while looked at, barely ticking
  without focus, stopped when hidden. Detail drops on its own on a slow machine.
- All models and textures are generated from code. There are no assets to load, and the
  strict CSP stays as it is.

## Decisions

- **2026-11-10: the decoration is gone: no suburb, no orchards, no oaks, no campus palms or
  oaks, no fence round the dish.** The rule at the top says everything drawn is a fact, and
  these said nothing: the suburb's houses, shops, flats, trees and water towers, its lawns
  and streets, and the palms, oaks and fence. They were also about two thirds of the
  triangles (about 304,000 of 448,000, in nine of 306 draws), though the frame time didn't
  change on a machine with a real graphics card. The stages stay (orchards, town, valley are
  still the internal names, kept because each viewer's last look is saved under them), but they
  now only widen the valley floor, and the legend and the "your valley has widened" notice say
  so. The spreading-in animation of the land is gone, and with it `landShare` and
  `Growth.land`. The meshes, and the licence note they carried, are gone with them, and are in
  git history (the suburb mesh file was `suburbModels.ts`, in 0.4.3).
- **2026-11-07: the map's lights are the same bright colours in both themes.** The scene had
  taken the page's status colours, which the light theme darkens so words stay readable on
  white, and on a sunlit map that made the lamps dull and amber brown. The scene reads its own
  `--color-world-*` tokens (`web/src/tokens.css`), which the light theme leaves alone. They're
  lights in a scene, not words on a page.
- **2026-11-07: "What am I looking at?" is the key, and how to read the map is a "?" away.**
  The owner asked for the key to stand apart from the text. The text is read once, so it
  moved to a window of its own (a native `<dialog>`: focus stays in it, Escape closes it).
  The key is what's looked back at, so it stays in the panel, grouped as Needs a look, Under
  way, Not known and Fine (`KEY_GROUPS` in `looks.ts`). What's on the map now is lit up and
  says what has it, and clicking it goes there, the same as the key row. What isn't on the
  map is dimmed, not hidden, so the key still says what everything means.
- **2026-11-07: the light stands on the sign, and the screen behind the logo says the same.**
  The antenna moved from a back corner of the roof to a short mast in the middle of the sign's
  top edge: the logo and its light are read in one place, and as the mast stands on the line
  the sign turns round, it doesn't swing. The screen behind the logo is tinted by the same rule
  as the light (`antennaLight`), in the World's status colours: a dark tint, not the colour
  itself, so coloured logos stay readable and a calm valley doesn't glow. Amber and red show
  more of their colour than green and blue (`shared/valley/screen.ts`). Where the light says
  nothing, nor does the screen.
- **2026-11-07: the figures say how things are by how much they say.**
  All's well (the title up, nothing deploying, anything not running so on purpose), the figures
  step back to one quiet line, and come forward the moment that changes (`figuresCalm` in
  `world/hudRoom.ts`). On a window too narrow for their card they're a line under the title,
  "4 of 5 running · 1 deploying · last check 2 min ago" (`briefFigures`). Apps not read: a "Try
  again" button that keeps its focus through redraws, and says it tries every minute anyway.
  Zoom buttons say when they're at the end of their range (aria-disabled, so focus stays),
  Escape leaves a replay once nothing else is open, and the key's explanations show in a bubble
  when reached by keyboard and reach screen readers through `aria-description`.
- **2026-11-07: opening the World says what happened since you last looked.**
  Once everything is read, a card says what went wrong while you were away (problems still open
  that started since), what went wrong and recovered, and apps added since, a row an app, each
  taking you to it. Only what's on the record: the bell's open problems and the last day of
  recoveries (`RECOVERED_WINDOW_MS`), so away longer it says "in the last day" of those. Deploys
  aren't kept, so they aren't counted, and a quiet stretch isn't called quiet, as nothing recorded
  isn't nothing happening with the PC off. Back within 10 minutes it says nothing. The last look
  is kept on this computer (`world/sinceLooked.ts`).
- **2026-11-07: the key takes you to what has each status.**
  Each status in the key is a button: a click brings the next app, service or the watcher with
  that status into view and opens its panel, round to the first again. It steps on from what's
  open if that has the status, so one problem in a big valley is two clicks away. A count shows
  when more than one thing has it. The rule is `nextPlace` in `world/looks.ts`.
- **2026-11-07: the page round the map is checked as a whole, and measures what it can't know.**
  An audit drove 13 situations across 12 window sizes and fixed what it found. The corner is
  told how tall the top cards are and how wide the map's buttons are (`world/hudRoom.ts`), so an
  open legend stops under the figures and "Stop tour" can't land on the key. With no map, or the
  apps not read, the zoom buttons, the legend and the key go: they'd do nothing and explain
  nothing. "Checks, 2 min" became "Last check", as a count of 0 was also what it said before the
  log had been read. A figure now takes the map to what it's about, Escape closes the legend,
  and a replay that can't be read goes on saying so. At three or more kinds of trouble the title
  gives the worst and how many more.
- **2026-11-07: "All systems normal" is only said when it's true of the services too.** With
  a service the apps rely on in trouble, by the same test as its red label, the title says
  "Apps normal · Cloudflare having trouble" with an amber light, here and on the Apps page.
- **2026-11-07: the figures say real things and go somewhere.** "On the road" is gone: it
  added cars, which are only a share of the traffic drawn, to trucks and vans, so it counted
  nothing real. It's now the watcher's checks in the last 2 minutes. Lowest uptime names its
  app, Running says what the rest are, and Deploying appears only while something is. A figure
  with something to go and see opens it. No more than this stays on screen: the rest belongs
  to the app's panel.
- **2026-11-07: the key stays in sight, and only for what's there.** A short row beside the
  legend shows every status on the map now: apps, services and the watcher, deploys and pushes
  included, worst first. It reads what each thing says from the same place the labels do
  (`world/looks.ts`), so the two can't disagree. Hovering says what it looks like and what has
  it. The card keeps every status and the long words. The corner is stacked in the flow, so
  however long the key gets it can't land on anything. A replay hides it, as it does the figures.
- **2026-11-07: opening comes down through cloud (`world/clouds.ts`).** The first picture
  costs a real stall on the main thread, so the page covers it with something that keeps
  moving: clouds drawn once to canvases, moved only by CSS transform and opacity, which run
  on the compositor. They lift when three frames of the real World are drawn (never before
  1.3 s the first time, 0.6 s after that), at once if there's no picture coming, and at 8 s
  whatever's happening. The camera comes down from higher up as they thin, to where it was
  going anyway. Reduced motion gets still cloud that fades, and no descent. They say nothing
  about the apps, and take no clicks.
- **2026-11-06: growth you can watch, including what grew while you were away.** The owner
  wants a valley that grows with their real data. Apps rarely change while the page is open,
  so this viewer's last look is remembered (`shared/valley/growth.ts`), and whatever has
  changed since plays when they return. The first look has nothing to compare with and plays
  nothing. A replay plays nothing. Traffic that hasn't been read isn't counted as traffic
  lost or gained, and nothing shrinks on show. A building comes up out of the ground rather
  than stretching, so its windows stay true.
  With reduced motion, or on a hidden page, it's simply there.
- **2026-11-06: zooming follows how far you scrolled, and glides.** Measured first: every
  wheel event was a 14% step whatever its size, so a trackpad gesture of about 20 pixels went
  to the nearest zoom in about 240 ms. The wheel now counts pixels (`zoomFeel.ts`), about 8% for
  a mouse notch, and a click of + or − is 25%, not 50%. The camera glides as a damped spring
  on the ratio of the zoom, so it starts gently and doesn't overshoot, about 250 ms to halfway.
  While the camera moves it draws every screen refresh up to 120 Hz, as the old 60 fps limit
  dropped frames unevenly on a 100 Hz screen; the machine is still judged against 60 fps when
  deciding whether to lower detail.
- **2026-11-06: the map's settings are behind a gear in its controls.** The sky choice was at
  the bottom of "What am I looking at?", which explains the map and shouldn't also change
  it. It's the only setting so far, as two labelled choices with what each one does.
- **2026-11-06: the suburb is built from ready-made house, shop, flat, tree and water-tower meshes, and stays background.**
  Height means an app's watched floors, so a shop, a block of flats or a water tower never
  comes close to an app's height, and none of them means anything. Trees cost fewer triangles
  than before and houses cost more, and on one PC it still held 120 frames a second.
- **2026-11-06: changing the detail level redraws the shadows.** Shadows are only redrawn
  when something changes, so what a slower machine hid used to leave its shadow on the ground.
- **2026-11-06: the dish is modelled as a real one, and has no beam.** The cone of light was
  left over from the island's lighthouse. A radio dish sends out nothing you can see, and
  the cone said nothing the turning didn't, so it's gone; the radar panel still follows the
  dish's bearing. The bowl is now a true parabola with panels, a sub-reflector on four struts,
  ribs and hoops behind it, a fork and jack that tilt it, and a turntable on a pedestal. The
  red aircraft light stays, small, on only while it's working. Vans used to start from the
  middle of the dish, inside the pedestal, and now start at the door of its shed
  (`DISH_DOOR`), beside the end of the road.
- **2026-11-05: a roof sign fits its roof.** Every sign used to have the same disk, which
  hung over the narrow courtyard wing and touched the rim of a setback roof, and it sat lower
  than the roof's raised edge. Now `signFit` sizes the board and disk from the roof's short
  side, so nothing reaches the edge even as the board swings round, and a fixed square base
  lifts the disk clear of the rim. The courtyard's back wing is deeper, so its sign can still
  be read.
- **2026-11-05: a highway from the side, apps in front of services.** This replaces the
  freeway as the divider below, the same day. The owner wanted the zones one in front of the
  other and a highway at the side leading in, with things spread more naturally. The highway
  comes through a gap in the hills on one side only and narrows into a main road. Apps stand
  in front of it, a green belt climbs behind it, and the services stand on the level above,
  with the dish's hill behind those. The layout is still worked out on straight lines
  (`shared/valley/plan.ts`), and one small module (`lay.ts`) bends them onto the ground: the
  road curves, block widths vary a little, and buildings turn half as far as their street, so
  they stay clear of both the straight avenues and the curving streets.
- **2026-11-05: the rise is what keeps services in view.** With services straight behind the
  apps, the buildings nearest the camera could hide them. So the ground climbs 1.5 behind the
  main road, apps spread along the road much faster than away from it, and the camera sits
  higher and more front-on. The ground has extra rows up the rise so the road on it stays on
  the ground. At 60 apps the services are small and some of their labels give way.
- **2026-11-05: streets only round what's built.** A rectangle of streets round a wedge of
  apps left a bare grid in front of them. A street now exists only beside a block in use.
- **2026-11-05: the dish stays behind the services, not at the far end of the main road.**
  The far end moves as apps are added, and the dish is meant to stand still. It's already at
  the end of its own road, on the highest ground. The radar draws real bearings from the map,
  so no building can block it.
- **2026-11-05: zones, with the freeway as the divider.** The owner asked for an apps zone,
  a services zone and the dish on a hill with a logical road to it. Apps are on the near side,
  services across the freeway on a paved yard with a green belt, and the dish behind those.
  One road, the spine, joins the three: over the freeway, along the yard, then winding up the
  hill. Apps grow one way from the spine and services the other, and each place depends only
  on its own number, so adding an app moves no service and not the dish. Only a new row of
  services moves the dish. Services now keep a saved place, as apps do. Every app gets a new
  spot once, when this arrives.
- **2026-11-05: the camera looks across the freeway, not along it.** Looking along it put
  the suburbs in the middle of the picture and the zones at its edges.
- **2026-11-05: the hill has its own mesh.** The ground's squares are too coarse to carry a
  road that winds. Rings round the hill carry a level
  shelf for the road, and it comes to about 13,000 triangles.
- **2026-11-05: suburbs gather round what's built.** They used to fill out from the middle of
  the map, which left bare streets past a big apps zone. Streets now run only beside a lot
  that exists.
- **2026-11-05: a valley, not an island.** The owner didn't want an island in the sea.
  The land now runs to the horizon, which also removed the sea, the most expensive thing
  to draw. The island is in git history before this change if it's ever wanted back.
- **2026-11-05: WareTrack's ideas, not its simulation.** From it: wide land seen at an
  angle, figures across the top, everything on the road clickable, a camera tour. Not
  from it: a made-up economy or a director building things. Here the world only ever grows
  because you really added an app, and no code was copied.
- **2026-11-05: orchards, town, valley, on one map.** Not separate levels, because a
  monitor must show every app on one screen.
- **2026-11-05: framed on what's built, from low enough to see a skyline.** The fit looks
  only at campuses, services and the dish, so there's no foreground of empty suburb. The
  camera is about 16 degrees up with a 38 degree lens, and the ranges start well back and
  stay low: any steeper and they fill the frame, and there's no sky to see them against.
- **2026-11-05: focusing aims halfway up a building.** Aiming at its foot sent tall roofs
  and their names off the top of the picture.
- **2026-11-05: antennas on the roofs, with the lines running between them.** The owner
  asked for this, after an earlier "only the sign on the roof". Lines were only drawn on
  trouble or selection, because tubes to every app tangled the town. As thin lines, one draw
  for all of them, they read as a network, and they fade as there get to be more. All the
  lights are one layer of points, so a big valley costs no more draws.
- **2026-11-05: not knowing isn't stopping.** The dish now has three states: watching (a
  fresh result is in), stopped (every check has gone stale, or checks are off) and neither
  (not read yet, or no apps). Before, "checking" counted as watching, and the map could say
  "Not checking" about nothing at all.
