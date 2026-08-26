# EiDOlON — Architecture

A designer-oriented Gaussian splat editor built on PlayCanvas rendering technology,
reusing the open-source SuperSplat editor's core where practical.

- `app/` — the EiDOlON application (Vite + React + TypeScript + SCSS modules)
- `reference/supersplat/` — upstream SuperSplat clone (MIT), used as reference and code source

## 1. SuperSplat reuse analysis

SuperSplat (MIT, PlayCanvas Ltd, ~30k LOC TS) splits cleanly into a framework-agnostic
editing core under a string event bus, and a PCUI-based UI layer. Verdicts:

| Area | Upstream files | Verdict |
|---|---|---|
| File format IO | `@playcanvas/splat-transform` npm pkg + `src/io/*` | **Reuse** — direct dependency; `io/read` glue ported to `app/src/core/io.ts` |
| Splat rendering + edit state | `splat.ts`, `splat-state.ts`, `shaders/splat-shader.ts` | **Reuse (ported)** — state byte per splat (1 selected / 2 locked / 4 deleted) mirrored to an R8 texture; gsplat shader chunk overrides discard deleted and tint selected; deletion never touches source data |
| Edit ops / undo | `edit-ops.ts`, `edit-history.ts`, `index-ranges.ts` | **Reuse (ported)** — ops store RLE index ranges + reversible bit ops, no data copies |
| GPU selection (`data-processor/`) | intersect/bounds/histogram passes | **Adopt later** — Phase 1 uses a CPU projection pass; GPU intersect is the upgrade path for >5M splats |
| Serialization/export | `splat-serialize.ts`, `io/write` | **Adopt in Phase 3** — streams live scene state into splat-transform writers (PLY/compressed PLY/SOG/SPZ) |
| Timeline/animation math | `anim/spline.ts`, `anim-track.ts`, `camera-poses.ts`, `sequence.ts` | **Adopt in Phase 5** — small, near-pure modules |
| Camera/controls | `camera.ts`, `controllers.ts` | **Wrap** — good damping/focus math but entangled with their Scene/Element lifecycle; Phase 1 uses a compact orbit controller |
| All UI (`ui/`, `tools/`) | PCUI widgets + SVG tool shells | **Reimplement in React** — wrong framework; tool event contracts kept |
| Reconstruction | — | Not in SuperSplat; separate `ReconstructionProvider` service (Phase 4) |

## 2. Application architecture

Hard rule: **splat data never enters React state.** React renders UI from a small
snapshot store; the editor core owns engine objects and typed arrays.

```
app/src/
├── core/                     # non-React editor core
│   ├── store.ts              # UI snapshot store (useSyncExternalStore)
│   ├── edit-ops.ts           # State bits, IndexRanges, SelectionOp/DeleteSelectionOp, EditHistory
│   ├── io.ts                 # splat-transform loading (ply/compressed.ply/sog/splat/ksplat/spz)
│   ├── shaders.ts            # gsplat chunk overrides (state discard + selection tint)
│   ├── splat-entity.ts       # editable splat: state texture, sorter mapping, bounds
│   ├── orbit-camera.ts       # damped orbit/pan/dolly/focus
│   └── scene-manager.ts      # engine app, load, selection, command registry
└── ui/                       # React shell (SCSS modules)
    ├── App / StartScreen / EditorShell
    ├── MenuBar / ToolBar / StatusBar
    ├── ScenePanel / InspectorPanel / Section
    └── Viewport (canvas + marquee + drop target)
```

### Command architecture (AI-ready)

Every UI action routes through a deterministic registry in `scene-manager.ts`:
`runCommand('select.rect', {x0,y0,x1,y1,canvasW,canvasH,mode})`, `select.all|none|invert`,
`select.delete`, `edit.undo|redo`, `camera.frameScene|frameSelection`, `tool.set`,
`scene.close`. Exposed as `window.studio.run/list/state` for scripting and future
agent control. Ops carry their JSON params for inspectability.

### Undo/redo

Linear history of `EditOp`s. Selection ops diff wanted-vs-current into two RLE range
sets (became-selected / became-deselected); delete ops record the selected ranges and
toggle the deleted bit. Undo of a 2M-splat delete costs one bit-clear pass + sorter
remap, no snapshots.

### Large-file strategy

Typed arrays end to end (splat-transform DataTable columns become GSplatData storage
without copies); deletion is a state bit + sorter mapping, so no rebuilds; state
uploads are a single R8 texture write; stats/bounds are single linear passes. Next
steps: move selection projection and bounds to a worker or the GPU intersect pass,
sub-rect state texture uploads, render-on-demand.

## 3. Project document schema (`.splatstudio`, Phase 2)

JSON, versioned, references sources rather than duplicating them:

```json
{
  "version": 1,
  "scene": { "up": "y", "units": "m" },
  "assets": [{ "id": "a1", "path": "garden.ply", "hash": "sha256-…", "transform": {} }],
  "layers": [{ "id": "l1", "name": "Vegetation", "members": "rle-base64", "visible": true, "locked": false, "color": "#8fbf6f" }],
  "selections": [{ "name": "floaters", "members": "rle-base64" }],
  "modifiers": [{ "id": "m1", "type": "removeFloaters", "enabled": true, "params": { "radius": 0.05, "minNeighbors": 8 } }],
  "cameras": [{ "name": "Hero", "position": [0, 1, 5], "target": [0, 0.5, 0], "fov": 60 }],
  "settings": {},
  "export": {}
}
```

Per-splat memberships serialize as the same RLE index ranges the ops use.
Deleted state is representable as a modifier (`{"type": "delete", "members": …}`),
which is what "Bake Modifiers" will collapse at export.

## 4. Technical risks

1. **Non-unified gsplat deprecation** — engine 2.21 warns `unified: false` will be
   removed. Mitigated in phase 6: the integration now rides the engine's sanctioned
   `gsplatModifyVS` hook chunk (state/tint/grade/view-modes) plus one small
   `gsplatCenterVS` override for the transform palette, in both GLSL and WGSL —
   only the center override needs porting when unified lands (unified's
   work-buffer hooks even include `modifySplatRotationScale`, the natural palette
   home).
2. **WebGPU** — supported (experimental, opt-in via `?gpu=webgpu` or localStorage
   `splatstudio.device`); verified on Chrome/Apple Silicon: 2M splats at ~55 fps,
   all edit ops < 150 ms. WebGL2 remains the default.
3. **CPU selection scaling** — benchmarked fine at 2M splats (rect select 55 ms,
   select-all 48 ms, delete 32 ms). The floaters modifier is the real hotspot
   (5.5 s at 2M) — move its spatial hash to a worker or GPU next.
4. **splat-transform workers** — enabled (phase 6): the package's shipped
   `worker.mjs` is wired via `WorkerQueue.workerUrl`; a 112 MB / 2M-splat PLY
   parses + morton-sorts in ~1.1 s.
5. **Reconstruction is out of scope for the editor core** — must stay behind
   `ReconstructionProvider` so Brush/OpenSplat/Nerfstudio/remote GPU are swappable.

## 5. Phase status

- **Phase 1 (done)**: shell, PLY/SOG/splat import with drag-drop, orbit/pan/dolly,
  frame scene/selection, rect selection (set/add/remove), non-destructive delete,
  full undo/redo, stats, deterministic command API, resizable/collapsible panels,
  keyboard shortcuts, start screen.
- **Phase 2 (done)**: drag/pan tool, camera reset, model origin UI (numeric /
  pick-in-viewport / from-selection), brush + lasso selection (screen-space mask →
  one op per stroke), layers (membership via per-splat `layerIds`, visibility =
  hidden state bit, lock, rename, color labels, undoable membership ops), crop to
  selection, model transform gizmos (engine TranslateGizmo/RotateGizmo/ScaleGizmo
  + numeric rotation/scale, undoable `EntityTransformOp`), `.splatstudio` project
  save/load (source-referencing JSON with RLE deleted ranges + base64 layer ids,
  locate-source dialog on open).
- **Phase 3 (done)**: non-destructive modifier stack doubling as the cleanup
  system (remove floaters via spatial-hash neighbor counts, opacity filter, size
  filter, crop-to-content percentile box, color grade driving shader uniforms) —
  filtered splats carry a dedicated state bit recomputed from the stack, so
  toggling/editing/reordering/removing always restores exactly; undoable Bake
  converts filtered → deleted and clears the stack; modifiers persist in
  `.splatstudio`. Diagnostic view modes (beauty / opacity heatmap / depth
  heatmap / selected-only) as shader view-mode uniform. PLY export dialog
  (selected-only / visible-only / apply-modifiers, live size estimate, chunked
  writer; verified re-importable through splat-transform).
- **Phase 4 (done)**: per-selection transforms via the ported TransformPalette
  (R16U index texture + RGBA32F matrix palette, gsplatCenterVS override; gizmos
  drive the selection when one exists, the model otherwise; undoable
  `SplatsTransformOp` with stack-disciplined palette alloc/free; CPU
  position cache keeps picking/bounds/export consistent; persisted in
  `.splatstudio`; `selection.transform` command for agents). Compressed PLY and
  bundled SOG export through `@playcanvas/splat-transform`'s `writeFile` +
  `MemoryFileSystem` (SOG WebP encoding in-browser), with palette transforms
  baked into positions/rotations/scales on export (SH rotation still pending).
  Create-from-photos/video wizard: contact-sheet review with advisory blur /
  darkness / resolution / duplicate analysis, video frame extraction with fps
  sampling, staged reconstruction progress UI, and the `ReconstructionProvider`
  abstraction — `RemoteProvider` (generic REST contract) when a service URL is
  configured, `DemoProvider` (local simulation synthesizing a splat from the
  photos) otherwise.
- **Phase 5 (done)**: saved cameras (save/rename/delete/fly-to, persisted in
  projects); camera keyframe animation (position/target/fov keys, linear /
  eased / cubic-spline interpolation via the ported CubicSpline, timeline with
  transport, scrubber + key markers, 12–60 fps, loop/once/ping-pong, persisted
  in projects); PLY sequence playback (multi-file drop or File ▸ Open PLY
  sequence, natural-order sorting, lazy decode with 24-frame LRU cache +
  read-ahead prefetch, per-frame entity swap carrying view mode and re-applying
  modifiers); SH rotation on export (SuperSplat SHRotation port — verified
  norm-preserving, correct band-1 behavior); performance HUD (View menu).
- **Phase 6 (done)**: shader integration rewritten from whole-shader forks onto
  the engine's `gsplatModifyVS` hook + a minimal `gsplatCenterVS` palette
  override, symmetric GLSL/WGSL; experimental WebGPU device (opt-in
  `?gpu=webgpu`), verified feature-complete at 120 fps (92k) and ~55 fps (2M);
  splat-transform worker pool enabled (2M-splat PLY loads in ~1.1 s);
  2M-splat benchmark: all interactive edit ops < 150 ms.
- **Phase 7 (done)** — timeline editor + MP4 render (plan:
  `docs/timeline-editor-plan.md`): model TransformTrack (position/rotation/
  scale keys, slerped rotation) alongside the camera track; expandable
  multi-lane timeline (key select / drag-retime / delete, double-click to key,
  editable duration); dual-camera model with look-through toggle (C) and
  director's-view visualization (flight path + key frustums + current-pose
  frustum via immediate lines); overlay toggles (grid / camera viz / gizmos /
  selection tint, ⇧H master, all forced off during render); offline MP4 export
  via WebCodecs H.264 + mediabunny (per-frame sorter settling, offscreen
  render target, size presets 1080p/4K/720p/square/9:16/viewport + custom
  even-rounded sizes, fps 24–60 + custom, quality→bitrate, progress/cancel,
  letterbox aspect preview). Verified: browser-decoded 2.00 s outputs at
  480×270 and 1280×720; ~37 fps offline render throughput at 720p.
- **Phase 7.1 (done)** — workspace modes: Edit / Training / Animation tabs in
  the menu bar (`mode.set` command). Contextual controls per mode: Edit keeps
  the full selection/transform toolbar, Layers and the editing inspector;
  Animation swaps to orbit/drag + look-through + key/render toolbar, a
  Cameras-focused left panel and an Animation inspector (shot camera FOV,
  track summary/clear, overlay checkboxes, render), forces the timeline
  visible and gates selection shortcuts; Training hosts the capture →
  reconstruct workspace, which stays mounted (hidden) while it holds frames or
  a running job so reconstructions survive tab switches and finish into Edit.
- Remaining: unified-rendering migration (hooks already carry over), floaters
  spatial hash → worker/GPU (5.5 s at 2M), GPU intersect selection, sequence
  swap without entity recreation (replaceData port), timeline key edits in undo
  history, stats refresh during timeline scrubs. Reconstruction backend: a
  local COLMAP + OpenSplat bridge now exists (`tools/reconstruction-server`,
  REST contract verified end-to-end in fake mode); real-engine runs still need
  colmap + opensplat installed.
- Phase 4: photo/video ingestion, ReconstructionProvider + job UI.
- Phase 5: PLY sequences, camera animation, WebGPU/unified migration, agent API surface.

## Attribution

Portions adapted from [SuperSplat](https://github.com/playcanvas/supersplat)
(MIT © PlayCanvas Ltd) — see file headers in `app/src/core/`. File format handling
via [@playcanvas/splat-transform](https://www.npmjs.com/package/@playcanvas/splat-transform) (MIT).
