# Plan: Timeline Editor + Camera Visualization + MP4 Render (Phase 7)

Builds on the phase-5 timeline (CameraTrack, transport, scrubber, key markers).
Three workstreams: multi-track timeline editing, camera visualization with a
director's view, and offline MP4 rendering with output presets.

## 1. Goals

- Keyframe **model transform** (position/rotation/scale) alongside the existing
  camera track, in a multi-lane timeline editor with per-key editing.
- **Visual representation of the shot camera** (frustum + path + key poses) with
  a "look through camera" toggle, so the user can either frame shots from inside
  the camera or watch it fly from a detached director's view.
- **Toggleable viewport controls/overlays** (grid, axes, camera viz, gizmos,
  selection tint) — one master toggle, per-item switches, all forced off during
  render.
- **Render to MP4** with curated standard sizes, custom width/height, and
  selectable/custom frame rates, with progress and cancel.

## 2. Data model (core, non-React)

```
core/tracks.ts
  TransformKey   { frame, position: [3], rotation: [4] (quat), scale: [3] }
  TransformTrack { keys, addKey/removeKey/moveKey, evaluate(frame) }
     - position/scale: same interpolation modes as CameraTrack
       (linear / eased / spline via existing CubicSpline)
     - rotation: slerp between keys (eased t); spline mode still slerps
  CameraTrack    — existing; gains moveKey(frame → frame)
```

- Both tracks live in SceneManager; store mirrors key frames + selected key.
- Scrub/playback applies: camera pose (existing) + model entity transform
  (new). Rule: while the model track has keys, the timeline owns the entity
  transform during scrub/play — identical to how the camera works today.
- Authoring loop stays uniform: *scrub → move the thing (orbit / gizmos /
  numeric fields) → press its key button*. Model keys capture the entity's
  current local transform, so all existing transform tools become keyable.
- Key editing is not in the undo history in v1 (matches camera keys today);
  an `AnimTrackEditOp` port is a later enhancement.
- Persistence: additive `.splatstudio` fields — `modelTrack`, `timeline:
  { duration }` (user-settable total frames), alongside existing `cameraTrack`.

## 3. Cameras & visualization

Two-camera model:

- **Editor camera** — the existing orbit camera; always what the user drives.
- **Shot camera** — a dedicated entity holding the animated pose evaluated from
  the camera track (also the render camera for MP4).

`lookThroughShot` toggle (Timeline bar + View menu, shortcut **C**):

- **ON** (current behavior): the viewport IS the shot camera; scrubbing snaps
  the view along the track; K keys the current view. No camera viz needed.
- **OFF** (director's view): the editor camera roams freely while the shot
  camera is drawn in the viewport — wireframe frustum pyramid + up-indicator at
  the current frame pose (bright amber), small dimmed frustums at each key, and
  the interpolated flight path as a polyline (sampled from
  `CameraTrack.evaluate`, cached, invalidated on key edits). Drawn with the
  existing immediate-mode `drawLine` path, so it costs nothing when hidden.
  Pressing K in director view keys the *editor* camera pose — a fast way to
  block out a path from outside.

Overlay controls (store flags + View menu + master toggle, shortcut **⇧H**):
`showGrid`, `showCameraViz`, `showGizmos`, `showSelectionTint` (implemented by
zeroing the `selectedClr` alpha uniform — no state-texture change). Master
"Show overlays" flips all; the MP4 renderer forces everything off and restores
after.

## 4. Timeline editor UI

The current single-row bar gains an expand chevron:

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⏮ ▶ ⏭   0124/0240  ────────────●────────────  ◆+  interp fps loop ▣ │  transport (existing)
├──────────┬───────────────────────────────────────────────────────────┤
│ Camera ◆+│      ◆        ◆          ◇selected  ◆                     │  lane
│ Model  ◆+│  ◆       ◆                                                │  lane
└──────────┴───────────────────────────────────────────────────────────┘
```

- Lane rows: label + per-track key button; diamonds positioned by frame.
- Click diamond → select key (playhead jumps to it); drag horizontally → move
  key (snaps to integer frames); **⌫** with a key selected deletes it;
  double-click empty lane space → add key at that frame from the current pose.
- Prev/next-key buttons per lane; duration (total frames) becomes an editable
  field for pure camera animations (sequences still pin duration to frame
  count).
- Existing fps/loop/interpolation selectors stay in the transport row.

## 5. MP4 rendering

Pipeline (same technology SuperSplat's render path uses):

- **Encoder**: WebCodecs `VideoEncoder` (H.264/avc1, level chosen from
  resolution × fps) muxed into MP4 by **mediabunny** (npm, ~already proven in
  SuperSplat). No audio. Clear error if `VideoEncoder` is unavailable
  (Safari < 16.4 / Firefox) — feature-detect and disable the menu item with a
  tooltip.
- **Offline frame stepping** (deterministic, not screen capture):
  1. Create an offscreen RenderTarget at the output resolution; point the shot
     camera at it; hide all overlays; lock UI input behind the progress modal.
  2. For each output frame `i`: evaluate both tracks at the mapped timeline
     time, apply poses, force a render, **wait for the gaussian sorter to
     settle** (listen to the sorter's `updated` event with a timeout fallback —
     without this, fast camera moves ship half-sorted frames), render again,
     then read back pixels (async GPU readback via the engine's texture read).
  3. Wrap the RGBA buffer in a `VideoFrame` (timestamp = i/fps), feed the
     encoder; mediabunny streams encoded chunks into the growing MP4 so memory
     stays flat on long renders.
  4. Finalize → download `<scene>-render.mp4`. Cancel flushes and aborts
     cleanly at any frame.
- Render fps is independent of playback fps: output frame `i` samples timeline
  time `i × playbackFps / renderFps` (float frames — camera/model interpolate
  smoothly; PLY sequences snap to nearest frame).
- Progress modal: frame n/N, elapsed + ETA, output size so far, Cancel.

### Output settings dialog

| Preset | Size |
|---|---|
| 1080p (default) | 1920 × 1080 |
| 4K UHD | 3840 × 2160 |
| 720p | 1280 × 720 |
| Square | 1080 × 1080 |
| Vertical 9:16 | 1080 × 1920 |
| Viewport | current canvas size (rounded to even) |

- **Custom**: free width/height fields (clamped 16–7680, rounded to even —
  H.264 requirement), with a lock-aspect toggle.
- **Frame rate**: 24 / 25 / 30 / 50 / 60 + custom field (1–120).
- **Quality**: Low / Medium / High mapped to bitrate ≈ 0.1 / 0.2 / 0.4
  bits·px⁻¹·frame⁻¹ (shown as the computed Mbps).
- Live summary line: duration, frame count, estimated file size.
- A letterboxed aspect-preview overlay in the viewport while the dialog is open
  so framing matches the chosen output.

## 6. New commands (AI/scripting surface)

`track.model.addKey / removeKey`, `track.moveKey {track, from, to}`,
`track.selectKey`, `timeline.setDuration {frames}`, `view.lookThrough`,
`view.overlays {on}` (+ per-item), `render.open`,
`render.start {width, height, fps, quality}` — enabling e.g. *"render a 4K/30
orbit of this scene"* as a single scripted sequence.

## 7. Implementation order & verification

1. **A — tracks & lanes**: TransformTrack, model keying, expanded timeline UI,
   key select/drag/delete, duration field, persistence.
   *Verify*: scripted key add/move/delete; scrub applies model transform;
   project round-trip.
2. **B — cameras & overlays**: shot camera entity, look-through toggle, frustum
   + path drawing, overlay flags/master toggle.
   *Verify*: screenshots in both modes; overlay toggle removes all helpers.
3. **C — MP4 render**: mediabunny dep, dialog, offline renderer with sorter
   settling, progress/cancel.
   *Verify*: render a 2-s 640×360 test clip headlessly; assert MP4 magic bytes
   (`ftyp`), then load into a `<video>` element and check `duration`,
   `videoWidth/Height`; spot-check a 1080p render manually.

## 8. Risks / notes

- **WebCodecs H.264 support** varies (Chrome/Edge solid; Safari 16.4+ mostly;
  Firefox behind flags) — feature-detect, fail with guidance, keep WebGL2/GPU
  choice orthogonal.
- **Sorter settling** is the correctness crux for offline rendering; the
  event-plus-timeout approach mirrors SuperSplat's forceRender pattern.
- **4K readback cost** (~33 MB/frame) is fine for offline rendering but ETA
  display matters; readback + encode overlap (encode previous while rendering
  next) is a stretch goal.
- **Rotation keys through spline mode** slerp pairwise rather than
  spline-smoothing orientation — acceptable v1, matches most lightweight tools.
- Single model track for now; becomes per-object lanes when multi-splat scenes
  land.
