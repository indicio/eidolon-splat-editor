# EiDOlON

A designer-oriented, browser-based Gaussian splat editor: import / clean up /
organize splats, animate cameras and effects on a timeline, render MP4s, and
reconstruct new splats from photos or video via a local COLMAP + OpenSplat
bridge.

## Features

- **Edit** — load `.ply` / `.compressed.ply` / `.sog` / `.splat` / `.ksplat` /
  `.spz`; brush / lasso / box selection; non-destructive delete, crop and
  layers; a modifier stack (floater removal, opacity/size thresholds, crop
  box, color grade) with undoable bake; model gizmos; full undo/redo.
- **Training** — reconstruct a new splat from 20+ overlapping photos or a
  video, driven by a local COLMAP + OpenSplat bridge (real training), with a
  clearly-labeled simulation mode when no engine is connected.
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
| Homebrew | Only for the optional reconstruction toolchain |
| Xcode | Only for optional GPU (Metal) training |

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

### 2a. Engines

```bash
# camera pose estimation
brew install colmap

# OpenSplat build dependencies
# IMPORTANT: opencv@4, not opencv — OpenCV 5 renamed the calib3d module
# OpenSplat links against, and the build will fail at link time with it.
brew install cmake pytorch opencv@4
```

### 2b. Build OpenSplat (CPU)

```bash
git clone --depth 1 https://github.com/pierotofy/OpenSplat.git tools/OpenSplat
cd tools/OpenSplat && mkdir build && cd build
cmake -DCMAKE_PREFIX_PATH=/opt/homebrew/opt/pytorch \
      -DOpenCV_DIR=/opt/homebrew/opt/opencv@4/lib/cmake/opencv4 ..
make -j$(sysctl -n hw.logicalcpu)
./opensplat --help   # sanity check
```

The bridge auto-detects the binary at `tools/OpenSplat/build/opensplat`.

### 2c. Run the bridge

```bash
cd tools/reconstruction-server
npm install
npm start            # http://localhost:8787
```

Then in EiDOlON: **Training tab → Connect service… →
`http://localhost:8787`**. The *Test* button reports which engines the bridge
can see. CPU training of a ~25-photo set takes on the order of 10–30 minutes.

To verify the wiring without the engines: `npm run start:fake` (returns a
synthesized placeholder, clearly not a trained model).

### 2d. GPU (Metal) training — optional, much faster

Requires full Xcode and a one-time license acceptance (needs your password):

```bash
sudo xcodebuild -license accept
cd tools/OpenSplat && rm -rf build && mkdir build && cd build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  cmake -DCMAKE_PREFIX_PATH=/opt/homebrew/opt/pytorch \
        -DOpenCV_DIR=/opt/homebrew/opt/opencv@4/lib/cmake/opencv4 \
        -DGPU_RUNTIME=MPS ..
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make -j$(sysctl -n hw.logicalcpu)

# run the bridge with GPU training (drops the default --cpu flag):
cd ../../reconstruction-server
OPENSPLAT_ARGS="" npm start
```

## Project layout

```
app/                          the editor (Vite + React + TypeScript + PlayCanvas)
tools/reconstruction-server/  local COLMAP + OpenSplat REST bridge
tools/OpenSplat/              OpenSplat clone + build (created in step 2b)
reference/supersplat/         upstream SuperSplat clone (MIT), reference only
docs/                         design docs
ARCHITECTURE.md               architecture, reuse analysis, phase history
```

## Troubleshooting

- **`ld: library 'opencv_calib3d' not found`** while building OpenSplat —
  you built against OpenCV 5. Install `opencv@4` and pass
  `-DOpenCV_DIR=/opt/homebrew/opt/opencv@4/lib/cmake/opencv4` (step 2b).
- **`GPU support not built, use --cpu`** during training — CPU-only OpenSplat
  builds default to trying Metal. The bridge already passes `--cpu` by
  default; if you overrode `OPENSPLAT_ARGS`, unset it (or rebuild with MPS,
  step 2d).
- **`libc10.dylib can't be opened` (Gatekeeper)** on first OpenSplat run —
  macOS quarantine on the torch dylibs; approve in System Settings ▸ Privacy &
  Security (possibly several times), or clear quarantine on the Homebrew
  pytorch libs.
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

- [COLMAP](https://colmap.github.io/) (BSD-3-Clause) — camera pose estimation
- [OpenSplat](https://github.com/pierotofy/OpenSplat) (AGPL-3.0) — Gaussian
  splat training. You build it yourself (step 2b); its license applies to that
  binary, not to this repository's code.

## Acknowledgements

Core editing techniques (splat state/deletion model, transform palette,
gsplat shader hooks, SH rotation, video config) were studied and ported from
[SuperSplat](https://github.com/playcanvas/supersplat) (MIT, © PlayCanvas Ltd).
Google Fonts [Syncopate](https://fonts.google.com/specimen/Syncopate) and
[Red Hat Text](https://fonts.google.com/specimen/Red+Hat+Text) (OFL) are
loaded from the Google Fonts CDN.
