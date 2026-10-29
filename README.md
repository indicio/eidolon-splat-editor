# EiDOlON

A designer-oriented, browser-based Gaussian splat editor: import / clean up /
organize splats, animate cameras and effects on a timeline, render MP4s, and
reconstruct new splats from photos or video via a local Spirula Studio
bridge.

## Features

- **Edit** — load `.ply` / `.compressed.ply` / `.sog` / `.splat` / `.ksplat` /
  `.spz`; brush / lasso / box selection; non-destructive delete, crop and
  layers; a modifier stack (floater removal, opacity/size thresholds, crop
  box, color grade) with undoable bake; model gizmos; full undo/redo.
- **Training** — reconstruct a new splat from 20+ overlapping photos or a
  video, driven by a local Spirula Studio bridge (real training, with its
  web viewer as the live preview), and a clearly-labeled simulation mode
  when no engine is connected.
- **Animation** — keyframed camera and model tracks with spline easing, a
  scrubbing timeline, explode/lighting effects, saved cameras, look-through
  lens, and offline MP4 rendering (H.264 via WebCodecs).
- **Export** — PLY, compressed PLY and SOG round-trips (with correct
  spherical-harmonic rotation), plus `.splatstudio` project save/load.
- Renders on WebGL2 by default with experimental WebGPU (`?gpu=webgpu`);
  2M-splat scenes stay interactive.

## Documentation

- Usage, controls and features: [`app/README.md`](app/README.md)
- Architecture, reuse analysis and roadmap: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Reconstruction bridge details: [`tools/reconstruction-server/README.md`](tools/reconstruction-server/README.md)

---

## Requirements

| Component | Requirement |
|---|---|
| OS | macOS on Apple Silicon is what's tested; the editor itself is plain web tech and should run anywhere Node + a modern browser do |
| Node.js | 18+ (developed on 26) with npm |
| Browser | Chromium (Chrome/Edge) recommended. Video export needs WebCodecs `VideoEncoder` (Chrome, Edge, Safari 16.4+). WebGL2 required; WebGPU optional |
| Spirula Studio | Optional. The Training tab's real engine; a separate GPL-3.0 app |

## 1. The editor (required)

```bash
cd app
npm install
npm run dev
```

Open the printed URL (e.g. `http://localhost:5173`). Drop a `.ply`,
`.compressed.ply`, `.sog`, `.splat`, `.ksplat` or `.spz` file to start editing.

**Synthetic test scene** (no splat file handy?):

```bash
cd app
node scripts/make-test-ply.mjs     # writes public/test-scene.ply (92k splats)
```

then open the dev URL with `?test` appended to auto-load it.

Notes:
- `app/public/lib/webp/webp.wasm` ships in the repo (copied from
  `@playcanvas/splat-transform`); refresh it if that package is upgraded.
- Production build: `npm run build` → static output in `app/dist/`.
- Experimental WebGPU rendering: open with `?gpu=webgpu` (or set localStorage
  `splatstudio.device = 'webgpu'`). WebGL2 is the default.

## 2. Reconstruction toolchain (optional)

Lets the **Training** tab train real Gaussian splats from photos/video.
Without it, Training runs a clearly-labeled demo simulation that does **not**
produce a real model.

Spirula Studio does both pose estimation and gaussian training in one binary,
and serves a web viewer the Training tab embeds while a job is running. The
finished PLY opens in this editor. Spirula is GPL-3.0 and is invoked as a
separate process; it is not part of this repository.

### 2a. Install Spirula Studio

Download the macOS build from
[Spirula Studio releases](https://github.com/harry7557558/spirula-studio/releases)
and open the app once (the bridge looks in `/Applications/Spirula Studio.app`
and on `PATH`). Or set `SPIRULA_BIN` to the `spirula` executable.

### 2b. Run the bridge

```bash
cd tools/reconstruction-server
npm install
npm start            # http://localhost:8787
```

Then in EiDOlON: **Training tab → Connect service… →
`http://localhost:8787`**. The *Test* button reports whether `spirula` was
found. A job runs `spirula sfm auto` and then `spirula train` (default
preset `3dgs`, 7000 steps — override with `SPIRULA_PRESET` and
`SPIRULA_STEPS`). During training the Reconstruct step shows Spirula's
viewer; when the run finishes that viewer stops and the splat opens here.

To verify the wiring without Spirula: `npm run start:fake` (returns a
synthesized placeholder, clearly not a trained model).

## Project layout

```
app/                          the editor (Vite + React + TypeScript + PlayCanvas)
tools/reconstruction-server/  local Spirula Studio REST bridge
reference/supersplat/         upstream SuperSplat clone (MIT), reference only
docs/                         design docs
ARCHITECTURE.md               architecture, reuse analysis, phase history
```

## Troubleshooting

- **Training says Spirula was not found** — install the macOS release (step
  2a) or set `SPIRULA_BIN` to the executable inside the app bundle
  (`Spirula Studio.app/Contents/MacOS/spirula`).
- **`VK_ERROR_INCOMPATIBLE_DRIVER` / “Metal is not available”** — the bridge
  process cannot see the GPU. Start it in a normal terminal, not a sandbox
  that hides Metal.
- **Training exits with `ColmapParser: … does not exist`** — the trainer
  expects photos under the COLMAP workspace’s `images/` folder. Current
  builds of the bridge link the uploads there before `spirula train`.
- **The finished splat is a thin horizontal smear in Edit** — Spirula’s
  metric frame is Z-up and the editor grid is Y-up. Reopen the result; the
  editor stands ground reconstructions up on the grid and looks down at them.
- **Render video… does nothing / errors about VideoEncoder** — the browser
  lacks WebCodecs. Use Chrome, Edge, or Safari 16.4+.
- **Very small custom render sizes look empty** — below ~240px gaussians
  project sub-pixel and get alpha-clipped; the dialog enforces a 240px floor.
- **Port already in use** — the dev server picks the next port automatically;
  the bridge honors `PORT=xxxx npm start`.

## Dependencies & licenses

The editor is TypeScript/React with a deliberately small dependency surface:

| Dependency | Role | License |
|---|---|---|
| [playcanvas](https://github.com/playcanvas/engine) | WebGL2/WebGPU engine, gsplat rendering & sorting | MIT |
| [@playcanvas/splat-transform](https://www.npmjs.com/package/@playcanvas/splat-transform) | Splat file format read/write (PLY, SOG, …) | MIT |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | MP4 muxing for offline video render | MPL-2.0 |
| [react](https://react.dev) / react-dom | UI | MIT |
| [busboy](https://github.com/mscdex/busboy) | Multipart upload parsing (bridge only) | MIT |
| Vite, TypeScript, sass-embedded, oxlint | Build/dev tooling only | MIT / Apache-2.0 |

External tools (invoked as separate processes by the optional reconstruction
bridge; **not** linked or redistributed):

- [Spirula Studio](https://github.com/harry7557558/spirula-studio) (GPL-3.0) —
  pose estimation and Gaussian splat training. Install it yourself (step 2a);
  its license applies to that binary, not to this repository's code.

## Acknowledgements

Core editing techniques (splat state/deletion model, transform palette,
gsplat shader hooks, SH rotation, video config) were studied and ported from
[SuperSplat](https://github.com/playcanvas/supersplat) (MIT, © PlayCanvas Ltd).
Google Fonts [Syncopate](https://fonts.google.com/specimen/Syncopate) and
[Red Hat Text](https://fonts.google.com/specimen/Red+Hat+Text) (OFL) are
loaded from the Google Fonts CDN.

## License

[MIT](LICENSE) © 2026 Craig Johnston
