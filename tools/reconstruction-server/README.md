# EiDOlON reconstruction bridge

A small local server that gives the Training workspace a **real** Gaussian
splat training backend. It implements the app's `ReconstructionProvider` REST
contract and drives **COLMAP** (camera poses) + **OpenSplat** (gaussian
training) on your machine.

Without a connected service, the app's Training tab uses a *demo simulation*
that arranges photos as flat panels — it never trains a model. This bridge is
how you get actual reconstructions.

## Setup

```bash
# 1. engines
brew install colmap                      # camera pose estimation
# OpenSplat: build from https://github.com/pierotofy/OpenSplat
#            then put `opensplat` on PATH or set OPENSPLAT_BIN

# 2. bridge
cd tools/reconstruction-server
npm install
npm start                                # http://localhost:8787
```

Then in EiDOlON: **Training tab → Connect service… → http://localhost:8787**.
The banner's *Test* button shows which engines the bridge can see.

## Contract

| Route | Behavior |
|---|---|
| `GET /health` | `{ ok, engine: { colmap, opensplat }, fake }` |
| `POST /jobs` | multipart `images[]` → `{ id }`, pipeline starts |
| `GET /jobs/:id` | `{ stageIndex (0–7), stageProgress (0–1), done, diag, warning?, error? }` |
| `GET /jobs/:id/log` | full timestamped pipeline log (text/plain) |
| `DELETE /jobs/:id` | cancel + cleanup |
| `GET /jobs/:id/result` | binary gaussian-splat PLY |

`diag` carries the monitoring payload: `totalImages`, `registeredImages`,
`points`, `fragments`, `reprojError` (COLMAP), `step` / `totalSteps` /
`loss: [step, value][]` (OpenSplat), `stageTimes: { stage, ms }[]` and
`resultSplats` / `resultBytes`.

Stage indexes map to the app's progress list: analyze, features, matching,
poses, point cloud, training, optimizing, packaging.

## Env

- `PORT` (8787), `COLMAP_BIN`, `OPENSPLAT_BIN` (auto-detects
  `../OpenSplat/build/opensplat`)
- `OPENSPLAT_STEPS` — training iterations (default 2000; more = better/slower;
  densification only starts after step 500, so don't go below ~1000)
- `OPENSPLAT_ARGS` — extra opensplat flags (default none, i.e. GPU training;
  set to `"--cpu"` if your opensplat build was made without `-DGPU_RUNTIME=MPS`)
- `SPLAT_RECON_FAKE=1` — skip the engines and return a synthesized placeholder
  (only for verifying the wiring; clearly not a trained model)

## Metal (GPU) training

The bridge assumes a Metal-capable opensplat build (the default here). To
build one:

```bash
sudo xcodebuild -license accept            # one-time Xcode license
cd tools/OpenSplat && rm -rf build && mkdir build && cd build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  cmake -DCMAKE_PREFIX_PATH=/opt/homebrew/opt/pytorch \
        -DOpenCV_DIR=/opt/homebrew/opt/opencv@4/lib/cmake/opencv4 \
        -DGPU_RUNTIME=MPS ..
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make -j12
```

If you're stuck with a CPU-only build, run the bridge with
`OPENSPLAT_ARGS="--cpu" npm start`.

Note: build against **opencv@4** (OpenCV 5 renamed the calib3d module
OpenSplat links against).

Any other service implementing the same contract works too — point the app at
a remote GPU box running Brush, OpenSplat or a Nerfstudio wrapper.
