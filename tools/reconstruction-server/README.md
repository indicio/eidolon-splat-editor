# EiDOlON reconstruction bridge

A small local server that gives the Training workspace a **real** Gaussian
splat training backend. It implements the app's `ReconstructionProvider` REST
contract and drives **Spirula Studio** (`spirula sfm auto`, then
`spirula train`) on your machine.

Spirula is GPL-3.0. The bridge shells out to it; this repository does not
vendor or link that code.

Without a connected service, the app's Training tab uses a *demo simulation*
that arranges photos as flat panels — it never trains a model. This bridge is
how you get actual reconstructions.

While training, the job reports `viewerUrl` (Spirula's web viewer on
127.0.0.1). The Training tab embeds that as a live preview. The process is
started with `--keep-viewer-alive 0`, so the viewer stops when the run
finishes and the finished `splat.ply` is what the editor opens.

## Setup

```bash
# 1. Spirula Studio (macOS arm64 build)
#    https://github.com/harry7557558/spirula-studio/releases
#    The bridge finds /Applications/Spirula Studio.app or `spirula` on PATH.
#    Override with SPIRULA_BIN.

# 2. bridge
cd tools/reconstruction-server
npm install
npm start                                # http://localhost:8787
```

Then in EiDOlON: **Training tab → Connect service… → http://localhost:8787**.
The banner's *Test* button shows whether `spirula` was found.

## Contract

| Route | Behavior |
|---|---|
| `GET /health` | `{ ok, engine: { spirula }, fake }` |
| `POST /jobs` | multipart `images[]` → `{ id }`, pipeline starts |
| `GET /jobs/:id` | `{ stageIndex (0–7), stageProgress (0–1), done, viewerUrl?, diag, warning?, error? }` |
| `GET /jobs/:id/log` | full timestamped pipeline log (text/plain) |
| `DELETE /jobs/:id` | cancel + cleanup |
| `GET /jobs/:id/result` | binary gaussian-splat PLY |

`viewerUrl` is present only while `spirula train` is serving its viewer.
`diag` carries `totalImages`, `registeredImages`, `points`, `fragments`,
`reprojError` (from SfM `status.bin`), `step` / `totalSteps` /
`loss: [step, rgb_loss][]`, `stageTimes`, and `resultSplats` / `resultBytes`.

Stage indexes map to the app's progress list: analyze, features, matching,
poses, point cloud, training, optimizing, packaging. SfM stages Extract,
Match, Map/Merge/Orient, and Finish land on features, matching, poses, and
point cloud.

## Env

- `PORT` (8787)
- `SPIRULA_BIN` — executable. Default search: that env var, then
  `Spirula Studio.app/Contents/MacOS/spirula`, then `PATH`
- `SPIRULA_STEPS` — training iterations (default 7000). Spirula's own `3dgs`
  preset is 30,000; the bridge passes an explicit count
- `SPIRULA_PRESET` — `spirula train` preset (default `3dgs`)
- `SPIRULA_ARGS` — extra arguments appended to `spirula train`
- `SPLAT_RECON_FAKE=1` — skip Spirula and return a synthesized placeholder
  (only for verifying the wiring; clearly not a trained model)

The train invocation also passes `--eval-mode all` (train on every photo,
skip the held-out eval) and `--steps-per-save` equal to the step count, so
one `splat.ply` is written at the end.

## Notes

- **Images.** `sfm auto` is given the upload folder and writes the COLMAP
  model under `workspace/`. The trainer then looks for photos in
  `workspace/images/`. The bridge symlinks the upload folder there before
  `spirula train`. Without that link, training exits immediately with
  `ColmapParser: … does not exist`.
- **Up axis.** A metric Spirula frame is east-north-up, so height is Z. The
  editor’s grid is Y-up. Opening the result (`reconstruction.ply`, or any
  ground site that is wide in X/Y and thin in Z) rotates it −90° about X and
  frames the camera from above. Left unrotated, the site stands on edge and
  reads as a horizontal smear through the grid.
- **GPU.** Spirula uses MoltenVK. The bridge process has to be able to see
  Metal; a sandbox that hides the GPU makes Spirula exit with
  `VK_ERROR_INCOMPATIBLE_DRIVER`. Bundle adjustment may still fall back to
  the CPU when the device has no double-precision arithmetic (seen on M3
  Pro); mapping still finishes. `MVK_CONFIG_LOG_LEVEL` defaults to `1` so
  the job log is not MoltenVK’s extension list.

## Tests

```bash
node --test test/*.test.mjs
```

Any other service implementing the same contract works too — point the app at
a remote GPU box that accepts the jobs API. A remote service can also return
`viewerUrl` if it has a browser preview.
