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
```

## Adding a new asset
Drop the `.fbx` (and its `.fbm/` texture dir, if any) into `public/models/`
and add an entry to `ASSETS` in `src/library.ts`. The build callback returns
the `Object3D` to render — `attachHover()` makes it float, and the
`makeThrusterTrail()` helper adds the particle exhaust.

## Credits
- Designersoup *Low Poly Car Pack Volume 1* — `docLorean.fbx`.
