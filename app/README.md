# EiDOlON

Designer-oriented Gaussian splat editor. React + TypeScript + Vite + PlayCanvas,
with core editing techniques adapted from [SuperSplat](https://github.com/playcanvas/supersplat) (MIT).

See `../ARCHITECTURE.md` for the design, reuse analysis and roadmap.

## Run

```bash
npm install
npm run dev
```

Open the printed URL, then drop a `.ply`, `.compressed.ply`, `.sog`, `.splat`,
`.ksplat` or `.spz` file — or append `?test` in dev to auto-load a synthetic scene
(generate it once with `node scripts/make-test-ply.mjs`).

## Controls

- **Orbit (Q)** — drag orbits, shift-drag / middle-drag pans, scroll dollies, right-drag orbits
- **Drag (W)** — drag pans the view, alt-drag orbits, scroll dollies
- **Box select (B)** — drag a marquee; shift adds, ⌘/Ctrl removes
- **Brush (P)** — paint a selection; **[ ]** resize (or the toolbar slider); shift adds, ⌘ removes
- **Lasso (L)** — draw a freehand outline; same modifiers
- **Move / Rotate / Scale (G / R / S)** — model transform gizmos; right-drag still orbits.
  Numeric rotation and uniform scale live in Inspector ▸ Transform
- **Tab** — hide/show both side panels (tray rails at the edges reopen them individually)
- **F** frame selection · **⇧F** frame scene · **0 / Home** reset camera
- **O** pick the model origin: click a splat to make it the world origin (Esc cancels);
  Inspector ▸ Origin also has numeric X/Y/Z offsets, "From selection" and "Reset origin" — all undoable
- **⌘A** select all · **Esc** deselect · **⌫ / Delete** delete selected (non-destructive; undo restores)
- **⌘Z / ⇧⌘Z** undo / redo · **⌘S** save project · **⌘O** open

## Layers

Scene panel ▸ Layers: create layers from the selection, assign the selection to a
layer, toggle visibility (hidden splats can't be selected or deleted), lock
(excluded from selection, dimmed), rename (double-click), color labels, delete
(members return to Default). Membership changes are undoable; visibility/lock are
view state.

## Modifiers (non-destructive cleanup)

Inspector ▸ Modifiers: add **Remove floaters** (neighbor-density), **Opacity
filter**, **Size filter**, **Crop to content** (auto percentile box) or **Color
grade** (exposure / brightness / saturation / transparency). Filtered splats
disappear immediately and return when a modifier is edited, disabled, reordered
or removed — the stack is stored in `.splatstudio` projects. **Bake modifiers**
permanently deletes the filtered splats and clears the stack (undoable).

## View modes

View menu: Beauty · Opacity heatmap · Depth heatmap · Selected only.

## Selection transforms

With an active selection, the Move / Rotate / Scale gizmos (G / R / S)
transform the **selected splats** non-destructively through a GPU transform
palette; without a selection they transform the whole model. Fully undoable,
saved in projects, baked into geometry on export. Scriptable:
`studio.run('selection.transform', { translate: [0, 1, 0], rotate: [0, 45, 0], scale: 1.2 })`.

## Export

**File ▸ Export… (⌘E)**: PLY, Compressed PLY or bundled SOG, with options for
selected-only, visible-only and apply-modifiers, plus a live splat count and
size estimate. Selection transforms are baked into positions/rotations/scales
(SH coefficients are not re-rotated yet). Deleted splats are always excluded;
data is written in source space (model placement lives in the project file).

## Workspace modes

Three tabs in the menu bar, each with contextual tools and panels:

- **Edit** — selection tools (box/brush/lasso), transform gizmos, origin,
  layers, modifiers, cleanup, export. Timeline hidden.
- **Training** — the capture → review → reconstruct workspace (photos or
  video). Stays alive when you switch tabs, so a running reconstruction
  keeps going in the background; finished results open in Edit.
- **Animation** — timeline with track lanes, saved cameras, look-through /
  director view, overlay toggles and video render. Selection tools and their
  shortcuts are disabled here; keying, playback and camera controls take over.

## Timeline editor & video render

- Expand the timeline (▸ chevron) for **Camera** and **Model** track lanes:
  ◆+ keys the current pose, drag diamonds to retime, click to select
  (⌫ deletes), double-click a lane to key the interpolated pose. Timeline
  length is editable (Frames field). **K** keys the camera, **⇧K** the model.
- **Look through camera (C)**: on = frame shots from inside the shot camera;
  off = director's view with the camera drawn as a frustum, its flight path,
  and key poses. In director view, K keys the editor camera pose.
- **Overlays**: View menu toggles for grid, camera path, gizmos and selection
  tint; **⇧H** flips them all. All are hidden automatically while rendering.
- **File ▸ Render video…**: offline H.264/MP4 export (WebCodecs + mediabunny)
  of the timeline through the shot camera — presets 1080p / 4K / 720p /
  Square / 9:16 / Viewport, custom even sizes up to 7680, frame rates
  24/25/30/50/60 or custom, Low/Med/High quality with a live bitrate + size
  estimate, letterboxed aspect preview, progress with cancel. Requires
  a browser with VideoEncoder (Chrome, Edge, Safari 16.4+).

## Cameras, timeline & sequences

- **Cameras** (Scene panel): save the current viewpoint, click to fly back,
  double-click to rename. Saved in projects.
- **Camera animation**: press **K** (or the ◆+ button) to key the current view
  at the playhead; scrub applies the animation, so the authoring loop is
  *scrub → move the camera → K*. Interpolation: linear, eased, or spline.
  Timeline (**T**): **Space** play/pause, **← →** step, 12–60 fps,
  loop / once / ping-pong.
- **Explode / scatter** (Animation panel, opt-in): add it via
  Effects ▸ **＋ Add explode effect** — the controls and the red timeline lane
  only exist while the effect is added ("Remove effect" clears and hides it
  again). Every splat scatters from the model
  center with per-splat random directions shaped by **Turbulence** (layered
  noise field), **Swirl** (vortex around the vertical axis), **Gravity**
  (falling arcs), **Spread** (speed variance) and a **Reseed** button for new
  randomizations. Key the amount on the red Explode lane — the timeline tweens
  intact (0) ↔ exploded; scrubs, plays and renders to MP4. Non-destructive.
- **Camera manipulation**: in the director view (C), the Move/Rotate gizmos
  (G/R) grab the shot camera itself and write a camera key on release.
  **Aim: free / track model** chooses whether keys keep their own look-at
  targets or the camera always faces the model.
- **Timeline clarity**: lanes and key diamonds are color-coded (camera amber,
  model blue, explode red); the selected key shows as a colored chip in the
  transport bar and highlights its lane label.
- **PLY sequences**: drop multiple `.ply` files at once (or File ▸ Open PLY
  sequence) — `anim_0001.ply…` plays as a time sequence with lazy decoding and
  read-ahead caching. Modifiers and view modes re-apply per frame.
- **Performance HUD**: View ▸ Performance HUD.

Export now also rotates spherical-harmonic coefficients when baking selection
transforms.

## Create from photos / video

Start screen or File menu. Drop photos (JPG/PNG/WebP) or a video (MP4/MOV/WebM
with a frames-per-second sampling control), review the contact sheet — blur,
darkness, low-resolution and duplicate warnings are advisory; click to
include/reject — then reconstruct with staged progress.

**Important:** without a connected reconstruction service, the Training tab
uses a *demo simulation* that arranges your photos as flat gaussian panels
(`demo-preview.ply`) — it does **not** train a real 3D model; in-browser
gaussian training doesn't exist here. The Training banner says which engine is
connected and lets you connect/test/disconnect a service. To train real
models, run the local bridge in `tools/reconstruction-server` (Spirula
Studio; see its README) and connect `http://localhost:8787` — or any remote
GPU service implementing the same jobs REST contract. While a real job
trains, the Reconstruct step embeds Spirula's web viewer. The finished
splat still opens in this editor.

## Projects

**File ▸ Save project (⌘S)** downloads a `.splatstudio` JSON that references the
source splat file (never duplicates it) and stores model placement, layers,
per-splat layer membership, deleted ranges and the camera pose. Opening a
`.splatstudio` (drop or ⌘O) asks you to locate the source splat, then restores
everything. **Select ▸ Crop to selection** deletes everything outside the
selection (undoable).

## Scripting

The deterministic command API is exposed on `window.studio`:

```js
studio.list();                 // available commands
studio.run('select.invert');
studio.run('select.delete');
studio.state().stats;          // { totalSplats, selected, deleted, … }
```

## Notes

- Rendering defaults to WebGL2. **WebGPU is available experimentally**: open with
  `?gpu=webgpu` or set localStorage `splatstudio.device = 'webgpu'`. All editing
  features work on both backends (benchmarked: 2M splats at ~55 fps on Apple
  Silicon, every edit op under 150 ms, 112 MB PLY loads in ~1.1 s with the
  worker pool).
- `public/lib/webp/webp.wasm` is copied from `@playcanvas/splat-transform` and must
  be refreshed if that package is updated.
