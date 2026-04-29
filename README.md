# car-personal-website

Personal site themed around my favorite cars. Built with Vite + Three.js +
TypeScript. Mirrors the layout of `farmer-game`'s asset library so adding a
new vehicle is a single entry in `src/library.ts`.

## Stack
- Vite 8 (dev server + bundler, multi-page setup)
- Three.js 0.183 (WebGL rendering, FBXLoader)
- TypeScript 5.9

## Layout
```
.
├── index.html              # placeholder homepage
├── library.html            # `/library.html` — 3D asset gallery
├── public/models/          # FBX assets (with .fbm texture sidecar dirs)
└── src/
    └── library.ts          # gallery loader + flying-car effects
```

## Run
```bash
npm install
npm run dev      # vite at http://localhost:5173
npm run build    # tsc + vite build
npm test         # playwright: homepage + library suites
```

## Tests
Playwright spawns its own dev server on port 5174 and reads scene state via
two test bridges:
- `window.__lib`  — library: classified wheels, accumulated roll angle, key
  injectors (`pressKey('w')`, `releaseKey('a')`, …) so the library doubles
  as a static test rig (WASD spins/steers wheels in place).
- `window.__home` — homepage: live `flightControls`, `carRig`, and
  `wheelState` snapshot.

Assertions are on quaternion / scene state rather than pixels, so they're
stable across GPU drivers. Run one file with
`npx playwright test tests/library.spec.ts`.

## Adding a new asset
Drop the `.fbx` (and its `.fbm/` texture dir, if any) into `public/models/`
and add an entry to `ASSETS` in `src/library.ts`. For wheeled ground cars
use the `buildWheeledCar` helper — it auto-detects wheels by spatial
position (front/rear and left/right are derived from world-space bbox
medians, so name collisions like Beatall's duplicate `lrWheel` still work),
reparents struts/connectors, and sits the chassis flat on the platform
with an idle wheel-roll. Use `attachHover()` for hovercraft.

To make a car drivable on the homepage, add it to the `CARS` table in
`src/main.ts` and set `mode: 'drive'`. Pick it via `index.html#car=<id>`.

## Credits
- Designersoup *Low Poly Car Pack Volume 1* — `docLorean.fbx`, `Beatall.fbx`,
  `Landyroamer.fbx`, `Toyoyo Highlight.fbx`, `Tristar Racer.fbx`.
