/**
 * SceneManager — owns the PlayCanvas application, the loaded splat, the
 * camera and the edit history. React components call methods here; splat
 * data never enters React state.
 */

import {
    BufferTarget,
    EncodedPacket,
    EncodedVideoPacketSource,
    Mp4OutputFormat,
    Output
} from 'mediabunny';
import {
    AppBase,
    AppOptions,
    BoundingBox,
    CameraComponentSystem,
    Color,
    Entity,
    FILLMODE_NONE,
    Gizmo,
    GSplatComponentSystem,
    LightComponentSystem,
    Mat4,
    PIXELFORMAT_RGBA8,
    Quat,
    Ray,
    RenderComponentSystem,
    RenderTarget,
    RESOLUTION_AUTO,
    RotateGizmo,
    ScaleGizmo,
    StandardMaterial,
    Texture,
    TONEMAP_NONE,
    TransformGizmo,
    TranslateGizmo,
    Vec3,
    createGraphicsDevice,
    type GraphicsDevice,
    type Layer
} from 'playcanvas';

import {
    AssignLayerOp,
    DeleteRangesOp,
    DeleteSelectionOp,
    EditHistory,
    IndexRanges,
    SelectionOp,
    State,
    type EditOp
} from './edit-ops';
import {
    EXPORT_EXTENSIONS,
    buildExportBlob,
    countExportSplats,
    estimateSize,
    type ExportFormat,
    type ExportOptions
} from './export';
import { loadSplatFromFile } from './io';
import {
    defaultParams,
    evaluateFilters,
    percentileBounds,
    type Modifier,
    type ModifierType
} from './modifiers';
import { CameraTrack, type CameraPose, type Interpolation } from './camera-track';
import { FX_DEFS, defaultFxState, fxDef, type FxId } from './fx';
import { OrbitCamera } from './orbit-camera';
import { ScalarTrack } from './scalar-track';
import { SequenceSource } from './sequence';
import { TransformTrack } from './transform-track';
import { buildEncoderConfig, sanitizeSize, videoEncodingSupported, type VideoSettings } from './video-render';
import {
    base64ToBytes,
    bytesToBase64,
    downloadProject,
    parseProject,
    rleFromStateBit,
    type ProjectFile
} from './project';
import { SplatEntity, type ExplodeParams } from './splat-entity';
import { getState, setState, type CameraAim, type LayerInfo, type LightInfo, type LoopMode, type SavedCamera, type StageSelection, type Tool, type TrackId, type ViewMode, type WorkspaceMode } from './store';

const hexToRgb = (hex: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const v = m ? parseInt(m[1], 16) : 0xffffff;
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

const lightVizColor = new Color();

const VIEW_MODE_INDEX: Record<ViewMode, number> = { beauty: 0, opacity: 1, depth: 2, selected: 3 };

const tmpBound = new BoundingBox();
const tmpVec = new Vec3();
const tmpVecB = new Vec3();
const tmpQuat = new Quat();
const tmpRay = new Ray();

// camera visualization scratch
const fwd = new Vec3();
const rgt = new Vec3();
const upv = new Vec3();
const corners = [new Vec3(), new Vec3(), new Vec3(), new Vec3()];
const vizPathColor = new Color(0.88, 0.63, 0.24, 1);
const vizKeyColor = new Color(0.5, 0.42, 0.28, 1);
const vizCurrentColor = new Color(1, 0.8, 0.45, 1);
const vizSelectedColor = new Color(1, 0.95, 0.75, 1);

const GRID_EXTENT = 5;
const gridColor = new Color(0.22, 0.23, 0.26, 1);
const gridColorMajor = new Color(0.32, 0.33, 0.37, 1);
const xAxisColor = new Color(0.55, 0.3, 0.28, 1);
const zAxisColor = new Color(0.28, 0.38, 0.55, 1);
const va = new Vec3();
const vb = new Vec3();

export type SelectMode = 'set' | 'add' | 'remove';

interface TransformSnapshot {
    pos: Vec3;
    rot: Quat;
    scale: Vec3;
}

const snapshotTransform = (entity: Entity): TransformSnapshot => ({
    pos: entity.getLocalPosition().clone(),
    rot: entity.getLocalRotation().clone(),
    scale: entity.getLocalScale().clone()
});

/** Undoable full local-transform change of the model entity (gizmo drags, numeric edits). */
class EntityTransformOp implements EditOp {
    name: string;
    params?: Record<string, unknown>;
    private entity: Entity;
    private prev: TransformSnapshot;
    private next: TransformSnapshot;

    constructor(entity: Entity, prev: TransformSnapshot, next: TransformSnapshot, name = 'model.transform') {
        this.entity = entity;
        this.prev = prev;
        this.next = next;
        this.name = name;
        this.params = {
            pos: [next.pos.x, next.pos.y, next.pos.z],
            scale: [next.scale.x, next.scale.y, next.scale.z]
        };
    }

    get changed() {
        return !this.prev.pos.equals(this.next.pos) ||
            !this.prev.rot.equals(this.next.rot) ||
            !this.prev.scale.equals(this.next.scale);
    }

    private apply(t: TransformSnapshot) {
        this.entity.setLocalPosition(t.pos);
        this.entity.setLocalRotation(t.rot);
        this.entity.setLocalScale(t.scale);
    }

    do() {
        this.apply(this.next);
    }

    undo() {
        this.apply(this.prev);
    }
}

const LAYER_COLORS = ['#e0a03c', '#8fbf6f', '#5f9fd4', '#c97fb8', '#d4634f', '#5fd4d0', '#b8a05f', '#9f8fd4'];

const tmpMatA = new Mat4();
const tmpMatB = new Mat4();

/**
 * Undoable per-selection transform via the palette. Stores the affected
 * ranges, each splat's previous palette index and the old→new index map;
 * do() allocates palette entries (stack discipline mirrors the linear
 * history, matching SuperSplat's design) and composes delta × old matrix.
 */
class SplatsTransformOp implements EditOp {
    name = 'selection.transform';
    params?: Record<string, unknown>;
    /** forces sorter mapping rebuild + re-sort with the new centers */
    changesDeleted = true;

    private splat: SplatEntity;
    private ranges: IndexRanges;
    private oldIndices: Uint16Array;
    private paletteMap: Map<number, number>;
    private delta: Mat4;

    constructor(splat: SplatEntity, ranges: IndexRanges, oldIndices: Uint16Array, delta: Mat4) {
        this.splat = splat;
        this.ranges = ranges;
        this.oldIndices = oldIndices;
        this.delta = delta.clone();

        // map each distinct previous index to a new palette slot, in the
        // order they'll be allocated at do() time
        const map = new Map<number, number>();
        let next = splat.transformPalette.nextIndex;
        for (let k = 0; k < oldIndices.length; ++k) {
            if (!map.has(oldIndices[k])) map.set(oldIndices[k], next++);
        }
        this.paletteMap = map;
        this.params = { count: ranges.size, uniqueTransforms: map.size };
    }

    get changed() {
        return this.ranges.size;
    }

    do() {
        const { splat, paletteMap, delta } = this;
        splat.transformPalette.alloc(paletteMap.size);
        paletteMap.forEach((newIdx, oldIdx) => {
            splat.transformPalette.getTransform(oldIdx, tmpMatA);
            tmpMatB.mul2(delta, tmpMatA);
            splat.transformPalette.setTransform(newIdx, tmpMatB);
        });
        let k = 0;
        this.ranges.forEach((i) => {
            splat.transformIndices[i] = paletteMap.get(this.oldIndices[k++])!;
        });
        splat.syncTransformTexture();
        splat.refreshPositions();
    }

    undo() {
        const { splat, paletteMap } = this;
        let k = 0;
        this.ranges.forEach((i) => {
            splat.transformIndices[i] = this.oldIndices[k++];
        });
        splat.transformPalette.free(paletteMap.size);
        splat.syncTransformTexture();
        splat.refreshPositions();
    }
}

/** Undoable change of the model's world translation (origin placement). */
class ModelOffsetOp implements EditOp {
    name = 'model.offset';
    params: Record<string, unknown>;
    private entity: Entity;
    private oldPos: Vec3;
    private newPos: Vec3;

    constructor(entity: Entity, oldPos: Vec3, newPos: Vec3) {
        this.entity = entity;
        this.oldPos = oldPos.clone();
        this.newPos = newPos.clone();
        this.params = { x: this.newPos.x, y: this.newPos.y, z: this.newPos.z };
    }

    get changed() {
        return !this.oldPos.equals(this.newPos);
    }

    do() {
        this.entity.setLocalPosition(this.newPos);
    }

    undo() {
        this.entity.setLocalPosition(this.oldPos);
    }
}

class SceneManager {
    app: AppBase | null = null;
    cameraEntity!: Entity;
    orbit!: OrbitCamera;
    splat: SplatEntity | null = null;
    history = new EditHistory();

    private layerList: LayerInfo[] = [];
    private nextLayerId = 1;

    private modifierList: Modifier[] = [];
    private nextModifierId = 1;

    private gizmo: TransformGizmo | null = null;
    private gizmoLayer: Layer | null = null;
    private gizmoStart: TransformSnapshot | null = null;

    private pendingProject: ProjectFile | null = null;

    private savedCameras: SavedCamera[] = [];
    private nextCameraId = 1;
    readonly cameraTrack = new CameraTrack();
    readonly modelTrack = new TransformTrack();
    readonly explodeTrack = new ScalarTrack();

    private explodeCenter = new Vec3();
    private lastSortAmount = 0;
    private lastSortRecompute = 0;

    private nextLightId = 1;

    /** entity holding the animated shot pose; also the offline render camera */
    shotCamera: Entity | null = null;
    private pathSamples: number[] | null = null;
    private pathDirty = true;

    private sequenceSource: SequenceSource | null = null;
    private sequenceFrame = -1;
    private sequenceSwapping = false;

    /** float playback head; store carries the rounded frame */
    private playFrame = 0;
    private playDir = 1;

    private frames = 0;
    private fpsTimer = 0;

    get fov() {
        return this.cameraEntity?.camera?.fov ?? 60;
    }

    /**
     * The true lens FOV. In camera view the editor camera's fov carries the
     * view-field zoom on top of the lens, so read the shot camera instead.
     */
    get lensFov() {
        const s = getState();
        if (s.mode === 'animation' && s.lookThrough && this.shotCamera?.camera) {
            return this.shotCamera.camera.fov;
        }
        return this.fov;
    }

    /**
     * Camera view (Blender-style): widen/narrow the editor camera so the lens
     * frame maps exactly onto the view-field guide box — fit by default, or a
     * fixed scale (1 = one output pixel per screen pixel).
     */
    syncViewZoom() {
        const cam = this.cameraEntity?.camera;
        const canvas = this.app?.graphicsDevice.canvas as HTMLCanvasElement | undefined;
        if (!cam || !canvas) return;
        const s = getState();
        if (s.mode !== 'animation' || !s.lookThrough) return;
        const lens = this.shotCamera?.camera?.fov ?? cam.fov;
        const w = Math.max(1, canvas.clientWidth);
        const h = Math.max(1, canvas.clientHeight);
        const aspect = s.renderWidth / s.renderHeight;
        const boxH = s.viewFieldScale === null
            ? (w / h > aspect ? h : w / aspect)
            : s.renderHeight * s.viewFieldScale;
        const t = Math.tan((lens * Math.PI) / 360) * (h / Math.max(1, boxH));
        cam.fov = Math.max(5, Math.min(175, (Math.atan(t) * 360) / Math.PI));
    }

    setViewFieldScale(scale: number | null) {
        setState({ viewFieldScale: scale === null ? null : Math.max(0.05, Math.min(4, scale)) });
        this.syncViewZoom();
    }

    /**
     * Create the engine against the given canvas. WebGPU is opt-in via
     * ?gpu=webgpu or localStorage 'splatstudio.device' = 'webgpu'
     * (experimental); WebGL2 is the default.
     */
    async init(canvas: HTMLCanvasElement) {
        if (this.app) return;

        const wantWebGpu =
            new URLSearchParams(location.search).get('gpu') === 'webgpu' ||
            localStorage.getItem('splatstudio.device') === 'webgpu';

        const device = await createGraphicsDevice(canvas, {
            deviceTypes: wantWebGpu ? ['webgpu', 'webgl2'] : ['webgl2'],
            antialias: false,
            depth: true,
            stencil: false,
            powerPreference: 'high-performance'
        });

        const app = new AppBase(canvas);
        const options = new AppOptions();
        options.graphicsDevice = device;
        options.componentSystems = [RenderComponentSystem, CameraComponentSystem, GSplatComponentSystem, LightComponentSystem];
        options.resourceHandlers = [];
        app.init(options);
        this.app = app;

        app.setCanvasFillMode(FILLMODE_NONE);
        app.setCanvasResolution(RESOLUTION_AUTO);
        app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

        const camera = new Entity('camera');
        camera.addComponent('camera', {
            clearColor: new Color(0.055, 0.059, 0.067, 1),
            fov: 60,
            nearClip: 0.02,
            farClip: 5000,
            toneMapping: TONEMAP_NONE
        });
        app.root.addChild(camera);
        this.cameraEntity = camera;
        this.orbit = new OrbitCamera(camera);

        // shot camera: carries the animated pose, renders the video export
        const shot = new Entity('shotCamera');
        shot.addComponent('camera', {
            clearColor: new Color(0.055, 0.059, 0.067, 1),
            fov: 60,
            nearClip: 0.02,
            farClip: 5000,
            toneMapping: TONEMAP_NONE,
            enabled: false
        });
        app.root.addChild(shot);
        this.shotCamera = shot;

        app.on('update', (dt: number) => {
            this.tickTimeline(dt);
            this.orbit.update(dt);
            if (getState().showGrid) this.drawGrid();
            this.drawCameraViz();
            this.drawLightViz();
            this.tickFps(dt);
            this.updateDepthRange();
        });

        app.start();

        const gd = app.graphicsDevice as GraphicsDevice & { isWebGPU?: boolean };
        setState({ device: gd.isWebGPU ? 'WebGPU' : 'WebGL2' });

        this.history.onChange = (op) => {
            if (op.changesLayers) {
                this.splat?.syncLayerBits(this.layerList);
            }
            this.splat?.updateState(!!op.changesDeleted);
            setState({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
        };
    }

    resize(width: number, height: number) {
        this.app?.resizeCanvas(width, height);
        this.syncViewZoom();
    }

    private tickFps(dt: number) {
        this.frames++;
        this.fpsTimer += dt;
        if (this.fpsTimer >= 0.5) {
            setState({ fps: Math.round(this.frames / this.fpsTimer) });
            this.frames = 0;
            this.fpsTimer = 0;
        }
    }

    private drawGrid() {
        const app = this.app!;
        for (let i = -GRID_EXTENT; i <= GRID_EXTENT; i++) {
            const color = i === 0 ? gridColorMajor : gridColor;
            if (i !== 0) {
                app.drawLine(va.set(i, 0, -GRID_EXTENT), vb.set(i, 0, GRID_EXTENT), color);
                app.drawLine(va.set(-GRID_EXTENT, 0, i), vb.set(GRID_EXTENT, 0, i), color);
            }
        }
        // origin axes
        app.drawLine(va.set(-GRID_EXTENT, 0, 0), vb.set(GRID_EXTENT, 0, 0), xAxisColor);
        app.drawLine(va.set(0, 0, -GRID_EXTENT), vb.set(0, 0, GRID_EXTENT), zAxisColor);
    }

    // -- loading ------------------------------------------------------------

    private pendingFile: File | null = null;

    /** Route any opened/dropped file: .splatstudio projects vs splat data. */
    openAny(file: File) {
        if (file.name.toLowerCase().endsWith('.splatstudio')) {
            void this.openProjectFile(file);
        } else {
            this.openFile(file);
        }
    }

    /** Multiple .ply files dropped together are treated as a time sequence. */
    openDropped(files: File[]) {
        if (files.length > 1 && files.every(f => f.name.toLowerCase().endsWith('.ply'))) {
            void this.openSequence(files);
        } else {
            this.openAny(files[0]);
        }
    }

    /** Entry point from UI. Safe to call before the engine exists. */
    openFile(file: File) {
        setState({ screen: 'editor', error: null });
        if (this.app) {
            void this.loadFile(file).catch(() => {});
        } else {
            this.pendingFile = file;
            setState({ busy: `Loading ${file.name}…` });
        }
    }

    private initPromise: Promise<void> | null = null;

    /** Called by the viewport once its canvas is in the DOM. */
    onViewportReady(canvas: HTMLCanvasElement) {
        this.initPromise ??= this.init(canvas).catch((err) => {
            setState({ error: `Engine init failed: ${err instanceof Error ? err.message : String(err)}` });
        });
        void this.initPromise.then(() => {
            if (this.pendingFile && this.app) {
                const file = this.pendingFile;
                this.pendingFile = null;
                void this.loadFile(file).catch(() => {});
            }
        });
    }

    async loadFile(file: File) {
        if (!this.app) throw new Error('Engine not initialized');

        setState({ busy: `Loading ${file.name}…`, error: null });
        try {
            const { gsplatData, transform } = await loadSplatFromFile(file);

            // replace any existing scene content
            this.closeScene();

            const rotation = new Quat().copy(transform.rotation as Quat);
            const splat = new SplatEntity(this.app, gsplatData, file.name, file.size, rotation);
            this.app.root.addChild(splat.entity);
            this.splat = splat;

            splat.onStateChanged = () => this.publishStats();
            splat.setSelectionTint(getState().showSelectionTint);
            this.explodeCenter.copy(splat.localBound.center);
            this.pushFxUniforms();

            this.layerList = [{ id: 0, name: 'Default', color: '#8b8e96', visible: true, locked: false, count: splat.numSplats }];
            this.nextLayerId = 1;
            this.modifierList = [];
            this.nextModifierId = 1;

            this.history.clear();
            setState({ screen: 'editor', canUndo: false, canRedo: false, modifiers: [], viewMode: 'beauty' });
            this.publishStats();
            this.frameScene();
            this.initShotFromOrbit();
            this.pushLights();
            this.applyGroundPlane();
            this.setCanvasColor(getState().canvasColor);
            // animation mode starts with the shot camera selected
            if (getState().mode === 'animation' && !getState().stageSelection) {
                setState({ stageSelection: { kind: 'camera' } });
            }
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
            throw err;
        } finally {
            setState({ busy: null });
        }
    }

    closeScene() {
        this.detachGizmo();
        // mirrored omnis are children of the splat entity and die with it
        this.groundPointLights.clear();
        if (this.splat) {
            this.splat.destroy();
            this.splat = null;
        }
        this.layerList = [];
        this.nextLayerId = 1;
        this.modifierList = [];
        this.nextModifierId = 1;
        this.savedCameras = [];
        this.nextCameraId = 1;
        this.cameraTrack.clear();
        this.modelTrack.clear();
        this.explodeTrack.clear();
        this.fxTracks.clear();
        this.lastSortAmount = 0;
        this.pathDirty = true;
        this.sequenceSource = null;
        this.sequenceFrame = -1;
        this.playFrame = 0;
        this.history.clear();
        setState({
            stats: null, layers: [], modifiers: [], viewMode: 'beauty', exportOpen: false,
            cameras: [], cameraKeys: [], modelKeys: [], explodeKeys: [], explodeAmount: 0,
            explodeEnabled: false, selectedKey: null, duration: 240, lights: [], stageSelection: null,
            modelVisible: true, modelLocked: false, cameraLocked: false,
            fx: defaultFxState(), fxKeys: {},
            timelineVisible: false, playing: false, frame: 0,
            totalFrames: 240, sequence: null, canUndo: false, canRedo: false
        });
    }

    private publishStats() {
        const { splat } = this;
        if (!splat) return;
        const bound = splat.calcWorldBound() ?? splat.localBound;
        const min = bound.getMin();
        const max = bound.getMax();
        const pos = splat.entity.getLocalPosition();
        const rot = splat.entity.getLocalEulerAngles();
        const scl = splat.entity.getLocalScale();

        const counts = splat.countLayerMembers();
        const layers = this.layerList.map(l => ({ ...l, count: counts.get(l.id) ?? 0 }));

        setState({
            stats: {
                fileName: splat.fileName,
                fileSize: splat.fileSize,
                totalSplats: splat.numSplats,
                deleted: splat.numDeleted,
                selected: splat.numSelected,
                hidden: splat.numHidden,
                filtered: splat.numFiltered,
                boundsMin: [min.x, min.y, min.z],
                boundsMax: [max.x, max.y, max.z],
                offset: [pos.x, pos.y, pos.z],
                rotation: [rot.x, rot.y, rot.z],
                scale: scl.x
            },
            layers
        });

        // keep the transform gizmo centered on the (possibly changed) selection
        const { tool } = getState();
        if ((tool === 'move' || tool === 'rotate' || tool === 'scale') && !this.dragging) {
            this.rebuildGizmo(tool);
        }
    }

    // -- selection ----------------------------------------------------------

    /**
     * Rectangle selection. Projects splat centers with the current camera
     * and tests against a canvas-space rect. CPU pass for now; the GPU
     * intersect pass from SuperSplat is the planned upgrade for very large
     * scenes.
     */
    selectRect(x0: number, y0: number, x1: number, y1: number, canvasW: number, canvasH: number, mode: SelectMode) {
        const { splat } = this;
        if (!splat || !this.cameraEntity.camera) return;

        // normalize rect to NDC
        const nx0 = (Math.min(x0, x1) / canvasW) * 2 - 1;
        const nx1 = (Math.max(x0, x1) / canvasW) * 2 - 1;
        const ny0 = -((Math.max(y0, y1) / canvasH) * 2 - 1);
        const ny1 = -((Math.min(y0, y1) / canvasH) * 2 - 1);

        const cam = this.cameraEntity.camera;
        const mvp = cam.projectionMatrix.clone().mul(cam.viewMatrix).mul(splat.entity.getWorldTransform());
        const m = mvp.data;

        const { x: px, y: py, z: pz } = splat.getPositions();

        const hit = new Uint8Array(splat.numSplats);
        for (let i = 0; i < splat.numSplats; ++i) {
            const x = px[i], y = py[i], z = pz[i];
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (w <= 0) continue;
            const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
            if (sx < nx0 || sx > nx1) continue;
            const sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
            if (sy < ny0 || sy > ny1) continue;
            hit[i] = 1;
        }

        this.applySelection(new SelectionOp(splat.state, 'select.rect', mode, i => hit[i] === 1, { x0, y0, x1, y1 }));
    }

    selectAll() {
        if (!this.splat) return;
        this.applySelection(new SelectionOp(this.splat.state, 'select.all', 'set', () => true));
    }

    selectNone() {
        if (!this.splat) return;
        this.applySelection(new SelectionOp(this.splat.state, 'select.none', 'set', () => false));
    }

    selectInvert() {
        if (!this.splat) return;
        const data = this.splat.state.data;
        this.applySelection(new SelectionOp(this.splat.state, 'select.invert', 'set', i => (data[i] & State.selected) === 0));
    }

    private applySelection(op: SelectionOp) {
        if (op.changed === 0) return;
        this.history.add(op);
    }

    deleteSelection() {
        if (!this.splat) return;
        const op = new DeleteSelectionOp(this.splat.state);
        if (op.changed === 0) return;
        this.history.add(op);
    }

    undo() {
        this.history.undo();
    }

    redo() {
        this.history.redo();
    }

    // -- camera -------------------------------------------------------------

    frameScene() {
        const bound = this.splat?.calcWorldBound();
        if (bound) {
            this.orbit.focus(bound.center, Math.max(bound.halfExtents.length(), 0.1), this.fov);
        } else {
            this.orbit.reset();
        }
    }

    frameSelection() {
        const bound = this.splat?.calcWorldBound(true);
        if (bound) {
            this.orbit.focus(bound.center, Math.max(bound.halfExtents.length(), 0.1), this.fov);
        } else {
            this.frameScene();
        }
    }

    /** Return to the default viewing angles, framed on the scene. */
    resetCamera() {
        this.orbit.resetAngles();
        this.frameScene();
    }

    // -- model origin ---------------------------------------------------------

    /** Directly set the model's world translation (numeric origin fields). */
    setModelOffset(x: number, y: number, z: number) {
        const { splat } = this;
        if (!splat) return;
        const op = new ModelOffsetOp(splat.entity, splat.entity.getLocalPosition(), new Vec3(x, y, z));
        if (op.changed) this.history.add(op);
    }

    /**
     * Translate the model so the given world-space point becomes the world
     * origin. The camera target shifts with the model so the view stays put.
     */
    setOriginPoint(px: number, py: number, pz: number) {
        const { splat } = this;
        if (!splat) return;
        const point = new Vec3(px, py, pz);
        const oldPos = splat.entity.getLocalPosition();
        const op = new ModelOffsetOp(splat.entity, oldPos, oldPos.clone().sub(point));
        if (!op.changed) return;
        this.history.add(op);
        this.orbit.shiftTarget(point.clone().mulScalar(-1));
    }

    /** Make the center of the current selection the model origin. */
    originFromSelection() {
        const bound = this.splat?.calcWorldBound(true);
        if (!bound) return;
        this.setOriginPoint(bound.center.x, bound.center.y, bound.center.z);
    }

    resetOrigin() {
        this.setModelOffset(0, 0, 0);
    }

    /**
     * Pick the splat nearest the cursor (within a pixel radius) and make it
     * the model origin. Returns true on a hit. CPU pass, same projection as
     * rect selection.
     */
    pickOriginAt(cx: number, cy: number, canvasW: number, canvasH: number, radiusPx = 12): boolean {
        const { splat } = this;
        if (!splat || !this.cameraEntity.camera) return false;

        const cam = this.cameraEntity.camera;
        const world = splat.entity.getWorldTransform();
        const mvp = cam.projectionMatrix.clone().mul(cam.viewMatrix).mul(world);
        const m = mvp.data;

        const { x: px, y: py, z: pz } = splat.getPositions();
        const state = splat.state.data;

        const r2 = radiusPx * radiusPx;
        let best = -1;
        let bestDepth = Infinity;

        for (let i = 0; i < splat.numSplats; ++i) {
            if (state[i] & State.deleted) continue;
            const x = px[i], y = py[i], z = pz[i];
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (w <= 0 || w >= bestDepth) continue;
            const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * canvasW;
            const sy = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w + 1) * 0.5) * canvasH;
            const dx = sx - cx, dy = sy - cy;
            if (dx * dx + dy * dy > r2) continue;
            best = i;
            bestDepth = w;
        }

        if (best < 0) return false;

        const worldPoint = world.transformPoint(new Vec3(px[best], py[best], pz[best]));
        this.setOriginPoint(worldPoint.x, worldPoint.y, worldPoint.z);
        return true;
    }

    // -- mask selection (brush / lasso) ---------------------------------------

    /**
     * Select splats whose projected center lands on a set pixel of a
     * screen-space mask (canvas-CSS-pixel resolution). Brush and lasso both
     * commit through here, one op per stroke.
     */
    selectByMask(mask: Uint8Array, canvasW: number, canvasH: number, mode: SelectMode, source: string) {
        const { splat } = this;
        if (!splat || !this.cameraEntity.camera) return;

        const cam = this.cameraEntity.camera;
        const mvp = cam.projectionMatrix.clone().mul(cam.viewMatrix).mul(splat.entity.getWorldTransform());
        const m = mvp.data;

        const { x: px, y: py, z: pz } = splat.getPositions();

        const hit = new Uint8Array(splat.numSplats);
        for (let i = 0; i < splat.numSplats; ++i) {
            const x = px[i], y = py[i], z = pz[i];
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (w <= 0) continue;
            const sx = Math.floor(((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * canvasW);
            if (sx < 0 || sx >= canvasW) continue;
            const sy = Math.floor((1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w + 1) * 0.5) * canvasH);
            if (sy < 0 || sy >= canvasH) continue;
            if (mask[sy * canvasW + sx]) hit[i] = 1;
        }

        this.applySelection(new SelectionOp(splat.state, `select.${source}`, mode, i => hit[i] === 1));
    }

    /** Delete every visible, unlocked, unselected splat. */
    cropToSelection() {
        const { splat } = this;
        if (!splat || splat.numSelected === 0) return;
        const data = splat.state.data;
        const ranges = new IndexRanges();
        const skip = State.deleted | State.hidden | State.locked | State.selected;
        for (let i = 0; i < data.length; ++i) {
            if ((data[i] & skip) === 0) ranges.add(i);
        }
        if (ranges.size === 0) return;
        this.history.add(new DeleteRangesOp(splat.state, ranges, 'select.crop'));
    }

    // -- layers ---------------------------------------------------------------

    private selectionRanges(): IndexRanges {
        const ranges = new IndexRanges();
        const data = this.splat!.state.data;
        const skip = State.deleted | State.hidden;
        for (let i = 0; i < data.length; ++i) {
            if ((data[i] & (State.selected | skip)) === State.selected) ranges.add(i);
        }
        return ranges;
    }

    /** Create a layer; assigns the current selection to it when one exists. */
    createLayer(name?: string) {
        const { splat } = this;
        if (!splat) return;
        if (this.layerList.length >= 255) return;

        const id = this.nextLayerId++;
        const layer: LayerInfo = {
            id,
            name: name?.trim() || `Layer ${id}`,
            color: LAYER_COLORS[(id - 1) % LAYER_COLORS.length],
            visible: true,
            locked: false,
            count: 0
        };
        this.layerList.push(layer);

        const ranges = this.selectionRanges();
        if (ranges.size > 0) {
            this.history.add(new AssignLayerOp(splat.layerIds, ranges, id, 'layer.create'));
        } else {
            this.publishStats();
        }
    }

    assignSelectionToLayer(layerId: number) {
        const { splat } = this;
        if (!splat || !this.layerList.some(l => l.id === layerId)) return;
        const ranges = this.selectionRanges();
        if (ranges.size === 0) return;
        this.history.add(new AssignLayerOp(splat.layerIds, ranges, layerId));
    }

    /** Delete a layer: members return to the default layer. Undoable. */
    deleteLayer(layerId: number) {
        const { splat } = this;
        if (!splat || layerId === 0) return;
        const idx = this.layerList.findIndex(l => l.id === layerId);
        if (idx < 0) return;

        const layer = this.layerList[idx];
        const ranges = new IndexRanges();
        for (let i = 0; i < splat.layerIds.length; ++i) {
            if (splat.layerIds[i] === layerId) ranges.add(i);
        }
        const assign = new AssignLayerOp(splat.layerIds, ranges, 0, 'layer.delete');

        const list = this.layerList;
        this.history.add({
            name: 'layer.delete',
            params: { layerId, name: layer.name },
            changesLayers: true,
            do() {
                assign.do();
                const at = list.findIndex(l => l.id === layerId);
                if (at >= 0) list.splice(at, 1);
            },
            undo() {
                if (!list.some(l => l.id === layerId)) list.splice(Math.min(idx, list.length), 0, layer);
                assign.undo();
            }
        });
    }

    /** View-state toggles: not part of the undo history. */
    setLayerVisible(layerId: number, visible: boolean) {
        const layer = this.layerList.find(l => l.id === layerId);
        if (!layer || layer.visible === visible) return;
        layer.visible = visible;
        this.refreshLayerBits();
    }

    setLayerLocked(layerId: number, locked: boolean) {
        const layer = this.layerList.find(l => l.id === layerId);
        if (!layer || layer.locked === locked) return;
        layer.locked = locked;
        this.refreshLayerBits();
    }

    renameLayer(layerId: number, name: string) {
        const layer = this.layerList.find(l => l.id === layerId);
        if (!layer || !name.trim()) return;
        layer.name = name.trim();
        this.publishStats();
    }

    selectLayerMembers(layerId: number) {
        const { splat } = this;
        if (!splat) return;
        const ids = splat.layerIds;
        this.applySelection(new SelectionOp(splat.state, 'layer.select', 'set', i => ids[i] === layerId, { layerId }));
    }

    private refreshLayerBits() {
        const { splat } = this;
        if (!splat) return;
        splat.syncLayerBits(this.layerList);
        splat.updateState(false);
    }

    // -- transform gizmos -------------------------------------------------------
    // Two modes: with a selection the gizmo drives the transform palette
    // (per-splat, non-destructive); without one it transforms the model entity.

    private pivotEntity: Entity | null = null;
    private lightProxy: Entity | null = null;
    private ground: Entity | null = null;
    private groundKeyLight: Entity | null = null;
    /** engine omnis mirroring the splat's point lights so the floor picks them up */
    private groundPointLights = new Map<number, Entity>();
    private dragging = false;
    /** true while the shot camera itself is being gizmo-dragged */
    private shotDragging = false;
    private selDrag: {
        ranges: IndexRanges;
        oldIndices: Uint16Array;
        uniqueOld: number[];
        oldMats: Mat4[];
        startIdx: number;
        pivotStartInv: Mat4;
        modelWorld: Mat4;
        modelWorldInv: Mat4;
        lastDelta: Mat4;
    } | null = null;

    /** Switch the active tool, attaching/detaching the transform gizmo. */
    setActiveTool(tool: Tool) {
        setState({ tool, pickingOrigin: false });
        this.rebuildGizmo(tool);
    }

    /** Re-target the gizmo when the tool or selection changes. */
    private rebuildGizmo(tool: Tool) {
        if (this.dragging) return;
        this.detachGizmo();
        if (!this.app || !this.splat || !this.cameraEntity.camera) return;

        const kinds = { move: TranslateGizmo, rotate: RotateGizmo, scale: ScaleGizmo } as const;
        const Ctor = kinds[tool as keyof typeof kinds];
        if (!Ctor) return;

        if (!getState().showGizmos) return;

        if (!this.gizmoLayer) {
            this.gizmoLayer = Gizmo.createLayer(this.app);
        }
        if (!this.pivotEntity) {
            this.pivotEntity = new Entity('selectionPivot');
            this.app.root.addChild(this.pivotEntity);
        }
        if (!this.lightProxy) {
            this.lightProxy = new Entity('lightProxy');
            this.app.root.addChild(this.lightProxy);
        }

        const sel = getState().stageSelection;

        // a selected light always takes the translate gizmo (rotate/scale are
        // meaningless for a point light), in any mode
        if (sel?.kind === 'light') {
            const light = getState().lights.find(l => l.id === sel.lightId);
            if (light) {
                tmpVec.set(light.position[0], light.position[1], light.position[2]);
                this.splat.entity.getWorldTransform().transformPoint(tmpVec, tmpVec);
                this.lightProxy.setPosition(tmpVec);
                const lightGizmo = new TranslateGizmo(this.cameraEntity.camera, this.gizmoLayer);
                lightGizmo.attach([this.lightProxy]);
                this.wireLightDrag(lightGizmo, sel.lightId);
                this.trackGizmoPointer(lightGizmo);
                this.gizmo = lightGizmo;
                return;
            }
        }

        // animation mode: the gizmo follows the stage selection
        if (getState().mode === 'animation') {
            if (sel?.kind === 'camera') {
                // shot camera: director view only (can't grab the lens you look
                // through), no scale; auto-keys on release
                if (getState().lookThrough || tool === 'scale' || !this.shotCamera) return;
                const camGizmo = new Ctor(this.cameraEntity.camera, this.gizmoLayer);
                camGizmo.attach([this.shotCamera]);
                this.wireShotCameraDrag(camGizmo);
                this.trackGizmoPointer(camGizmo);
                this.gizmo = camGizmo;
            } else if (sel?.kind === 'model') {
                const modelGizmo = new Ctor(this.cameraEntity.camera, this.gizmoLayer);
                modelGizmo.attach([this.splat.entity]);
                this.wireModelDrag(modelGizmo, tool);
                this.trackGizmoPointer(modelGizmo);
                this.gizmo = modelGizmo;
            }
            return;
        }

        const selectionMode = this.splat.numSelected > 0;
        const gizmo = new Ctor(this.cameraEntity.camera, this.gizmoLayer);

        if (selectionMode) {
            const bound = this.splat.calcWorldBound(true);
            this.pivotEntity.setLocalPosition(bound ? bound.center : Vec3.ZERO);
            this.pivotEntity.setLocalRotation(Quat.IDENTITY);
            this.pivotEntity.setLocalScale(1, 1, 1);
            gizmo.attach([this.pivotEntity]);
            this.wireSelectionDrag(gizmo);
        } else {
            gizmo.attach([this.splat.entity]);
            this.wireModelDrag(gizmo, tool);
        }
        this.trackGizmoPointer(gizmo);
        this.gizmo = gizmo;
    }

    /**
     * True while the pointer went down on a gizmo handle — the viewport uses
     * it to keep click-to-select from stealing gizmo drags. The gizmo's native
     * canvas listener runs before React's synthetic pointerdown, so the flag
     * is valid by the time the viewport reads it.
     */
    private gizmoPointerBusy = false;

    get gizmoOwnsPointer() {
        return this.gizmoPointerBusy;
    }

    private trackGizmoPointer(gizmo: TransformGizmo) {
        gizmo.on('pointer:down', (_x: number, _y: number, meshInstance: unknown) => {
            this.gizmoPointerBusy = !!meshInstance;
        });
    }

    private wireModelDrag(gizmo: TransformGizmo, tool: Tool) {
        const entity = this.splat!.entity;
        gizmo.on(TransformGizmo.EVENT_TRANSFORMSTART, () => {
            this.dragging = true;
            this.gizmoStart = snapshotTransform(entity);
        });
        gizmo.on(TransformGizmo.EVENT_TRANSFORMEND, () => {
            this.dragging = false;
            if (!this.gizmoStart) return;
            const op = new EntityTransformOp(entity, this.gizmoStart, snapshotTransform(entity), `model.${tool}`);
            this.gizmoStart = null;
            if (op.changed) {
                this.history.add(op);
                // animation mode: keys the model at the playhead on release,
                // matching the shot camera's auto-key behavior
                if (getState().mode === 'animation') this.addModelKey();
            }
        });
    }

    private wireSelectionDrag(gizmo: TransformGizmo) {
        gizmo.on(TransformGizmo.EVENT_TRANSFORMSTART, () => {
            const { splat, pivotEntity } = this;
            if (!splat || !pivotEntity) return;
            this.dragging = true;

            const ranges = this.selectionRanges();
            const oldIndices = new Uint16Array(ranges.size);
            const uniqueOld: number[] = [];
            const seen = new Set<number>();
            let k = 0;
            ranges.forEach((i) => {
                const idx = splat.transformIndices[i];
                oldIndices[k++] = idx;
                if (!seen.has(idx)) {
                    seen.add(idx);
                    uniqueOld.push(idx);
                }
            });

            // preview allocation: new entries initialized to the old matrices
            const startIdx = splat.transformPalette.alloc(uniqueOld.length);
            const oldMats = uniqueOld.map((oldIdx, j) => {
                const m = new Mat4();
                splat.transformPalette.getTransform(oldIdx, m);
                splat.transformPalette.setTransform(startIdx + j, m);
                return m;
            });
            const remap = new Map<number, number>(uniqueOld.map((o, j) => [o, startIdx + j]));
            ranges.forEach((i) => {
                splat.transformIndices[i] = remap.get(splat.transformIndices[i])!;
            });
            splat.syncTransformTexture();

            const modelWorld = splat.entity.getWorldTransform().clone();
            this.selDrag = {
                ranges,
                oldIndices,
                uniqueOld,
                oldMats,
                startIdx,
                pivotStartInv: pivotEntity.getWorldTransform().clone().invert(),
                modelWorld,
                modelWorldInv: modelWorld.clone().invert(),
                lastDelta: new Mat4()
            };
        });

        gizmo.on(TransformGizmo.EVENT_TRANSFORMMOVE, () => {
            const drag = this.selDrag;
            const { splat, pivotEntity } = this;
            if (!drag || !splat || !pivotEntity) return;

            // delta in model space: Minv * (pivotNow * pivotStartInv) * M
            tmpMatA.mul2(pivotEntity.getWorldTransform(), drag.pivotStartInv);
            tmpMatB.mul2(drag.modelWorldInv, tmpMatA);
            drag.lastDelta.mul2(tmpMatB, drag.modelWorld);

            for (let j = 0; j < drag.uniqueOld.length; ++j) {
                tmpMatA.mul2(drag.lastDelta, drag.oldMats[j]);
                splat.transformPalette.setTransform(drag.startIdx + j, tmpMatA);
            }
        });

        gizmo.on(TransformGizmo.EVENT_TRANSFORMEND, () => {
            const drag = this.selDrag;
            this.selDrag = null;
            this.dragging = false;
            const { splat } = this;
            if (!drag || !splat) return;

            // revert the preview, then re-apply through an undoable op
            let k = 0;
            drag.ranges.forEach((i) => {
                splat.transformIndices[i] = drag.oldIndices[k++];
            });
            splat.transformPalette.free(drag.uniqueOld.length);
            splat.syncTransformTexture();

            const d = drag.lastDelta.data;
            const identity = Math.abs(d[0] - 1) + Math.abs(d[5] - 1) + Math.abs(d[10] - 1) +
                Math.abs(d[12]) + Math.abs(d[13]) + Math.abs(d[14]) +
                Math.abs(d[1]) + Math.abs(d[2]) + Math.abs(d[4]) +
                Math.abs(d[6]) + Math.abs(d[8]) + Math.abs(d[9]) < 1e-6;

            if (!identity) {
                this.history.add(new SplatsTransformOp(splat, drag.ranges, drag.oldIndices, drag.lastDelta));
            }
            // re-center the gizmo on the moved selection
            this.rebuildGizmo(getState().tool);
        });
    }

    /** Dragging a selected light moves it live (world → model space). */
    private wireLightDrag(gizmo: TransformGizmo, lightId: number) {
        const applyProxy = () => {
            const { splat, lightProxy } = this;
            if (!splat || !lightProxy) return;
            const inv = splat.entity.getWorldTransform().clone().invert();
            inv.transformPoint(lightProxy.getPosition(), tmpVec);
            this.setLight(lightId, {
                position: [+tmpVec.x.toFixed(3), +tmpVec.y.toFixed(3), +tmpVec.z.toFixed(3)]
            });
        };
        gizmo.on(TransformGizmo.EVENT_TRANSFORMSTART, () => {
            this.dragging = true;
        });
        gizmo.on(TransformGizmo.EVENT_TRANSFORMMOVE, applyProxy);
        gizmo.on(TransformGizmo.EVENT_TRANSFORMEND, () => {
            this.dragging = false;
            applyProxy();
        });
    }

    /** Dragging the shot camera writes/updates the camera key at the playhead. */
    private wireShotCameraDrag(gizmo: TransformGizmo) {
        gizmo.on(TransformGizmo.EVENT_TRANSFORMSTART, () => {
            this.dragging = true;
            this.shotDragging = true;
        });
        gizmo.on(TransformGizmo.EVENT_TRANSFORMEND, () => {
            this.dragging = false;
            this.shotDragging = false;
            const shot = this.shotCamera;
            if (!shot) return;

            const p = shot.getPosition();
            const fwd = shot.forward;

            // keep the previous key's target distance where possible
            const prev = this.cameraTrack.evaluate(getState().frame);
            let distT = 3;
            if (prev) {
                distT = Math.max(0.2, Math.hypot(
                    prev.target[0] - prev.position[0],
                    prev.target[1] - prev.position[1],
                    prev.target[2] - prev.position[2]
                ));
            }
            let target: [number, number, number] = [p.x + fwd.x * distT, p.y + fwd.y * distT, p.z + fwd.z * distT];
            if (getState().cameraAim === 'track') {
                const t = this.aimTargetWorld(tmpVec);
                if (t) target = [t.x, t.y, t.z];
            }

            const frame = getState().frame;
            this.cameraTrack.addKey({
                frame,
                position: [p.x, p.y, p.z],
                target,
                fov: shot.camera?.fov ?? this.fov
            });
            setState({ selectedKey: { track: 'camera', frame }, timelineVisible: true });
            this.publishTimeline();
            this.applyFrame(this.playFrame);
        });
    }

    private detachGizmo() {
        if (this.gizmo) {
            this.gizmo.destroy();
            this.gizmo = null;
        }
        this.gizmoStart = null;
        this.selDrag = null;
        this.shotDragging = false;
        this.gizmoPointerBusy = false;
    }

    // -- stage object selection (animation mode) --------------------------------

    // -- Blender-style modal camera transform (G / R + X/Y/Z) -------------------

    private modal: {
        kind: 'grab' | 'rotate';
        axis: 'x' | 'y' | 'z' | null;
        startPos: [number, number, number];
        startTarget: [number, number, number];
        fov: number;
        accumX: number;
        accumY: number;
        cleanup: () => void;
    } | null = null;

    get modalActive() {
        return this.modal !== null;
    }

    /**
     * Enter a Blender-style modal transform of the shot camera: mouse moves
     * it, X/Y/Z constrains the axis, G/R switches mode, click or Enter
     * confirms (keys at the playhead), Esc or right-click cancels. Rotation
     * honors aim-tracking: with "track model" the camera orbits the model.
     */
    startCameraModal(kind: 'grab' | 'rotate'): boolean {
        if (this.modal) return true;
        const s = getState();
        const shot = this.shotCamera;
        if (s.mode !== 'animation' || s.playing || s.cameraLocked || !shot || !this.splat) return false;

        const p = shot.getPosition();
        const fwd = shot.forward;
        const prev = this.cameraTrack.evaluate(s.frame);
        let dist = 3;
        if (prev) {
            dist = Math.max(0.2, Math.hypot(
                prev.target[0] - prev.position[0],
                prev.target[1] - prev.position[1],
                prev.target[2] - prev.position[2]
            ));
        }
        let target: [number, number, number] = [p.x + fwd.x * dist, p.y + fwd.y * dist, p.z + fwd.z * dist];
        if (s.cameraAim === 'track') {
            const t = this.aimTargetWorld(tmpVec);
            if (t) target = [t.x, t.y, t.z];
        }

        const onMove = (e: PointerEvent) => {
            const m = this.modal;
            if (!m) return;
            m.accumX += e.movementX;
            m.accumY += e.movementY;
            this.applyModal();
        };
        const onDown = (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.button === 2) this.cancelModal();
            else this.confirmModal();
        };
        const onKey = (e: KeyboardEvent) => {
            const m = this.modal;
            if (!m) return;
            const k = e.key.toLowerCase();
            if (k === 'x' || k === 'y' || k === 'z') {
                m.axis = m.axis === k ? null : k;
                this.applyModal();
            } else if (k === 'g' || k === 'r') {
                m.kind = k === 'g' ? 'grab' : 'rotate';
                m.accumX = 0;
                m.accumY = 0;
                this.applyModal();
            } else if (k === 'escape') {
                this.cancelModal();
            } else if (k === 'enter') {
                this.confirmModal();
            } else {
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey, true);

        this.modal = {
            kind,
            axis: null,
            startPos: [p.x, p.y, p.z],
            startTarget: target,
            fov: this.lensFov,
            accumX: 0,
            accumY: 0,
            cleanup: () => {
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerdown', onDown, true);
                window.removeEventListener('keydown', onKey, true);
            }
        };
        this.detachGizmo();
        this.applyModal();
        return true;
    }

    private applyModal() {
        const m = this.modal;
        const shot = this.shotCamera;
        if (!m || !shot) return;

        const axisVec = m.axis === 'x' ? tmpVec.set(1, 0, 0)
            : m.axis === 'y' ? tmpVec.set(0, 1, 0)
            : m.axis === 'z' ? tmpVec.set(0, 0, 1)
            : null;

        const pos: [number, number, number] = [...m.startPos];
        const target: [number, number, number] = [...m.startTarget];
        const dist = Math.max(0.2, Math.hypot(
            target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]
        ));

        if (m.kind === 'grab') {
            const scale = dist * 0.0025;
            if (axisVec) {
                const d = m.accumX * scale;
                pos[0] += axisVec.x * d; pos[1] += axisVec.y * d; pos[2] += axisVec.z * d;
                target[0] += axisVec.x * d; target[1] += axisVec.y * d; target[2] += axisVec.z * d;
            } else {
                // view-plane move, from the start pose's right/up
                fwd.set(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]).normalize();
                rgt.cross(fwd, Vec3.UP);
                if (rgt.lengthSq() < 1e-6) rgt.set(1, 0, 0);
                rgt.normalize();
                upv.cross(rgt, fwd);
                const dx = m.accumX * scale, dy = -m.accumY * scale;
                for (const v of [pos, target]) {
                    v[0] += rgt.x * dx + upv.x * dy;
                    v[1] += rgt.y * dx + upv.y * dy;
                    v[2] += rgt.z * dx + upv.z * dy;
                }
            }
        } else {
            const angle = m.accumX * 0.4; // degrees per px
            if (axisVec) {
                tmpQuat.setFromAxisAngle(axisVec, angle);
            } else {
                // no axis: turn about the view's up axis
                fwd.set(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]).normalize();
                rgt.cross(fwd, Vec3.UP);
                if (rgt.lengthSq() < 1e-6) rgt.set(1, 0, 0);
                rgt.normalize();
                upv.cross(rgt, fwd);
                tmpQuat.setFromAxisAngle(upv, angle);
            }
            if (getState().cameraAim === 'track') {
                // observe tracking: orbit the camera around the model target
                tmpVecB.set(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
                tmpQuat.transformVector(tmpVecB, tmpVecB);
                pos[0] = target[0] + tmpVecB.x;
                pos[1] = target[1] + tmpVecB.y;
                pos[2] = target[2] + tmpVecB.z;
            } else {
                // free aim: re-aim the lens from a fixed position
                tmpVecB.set(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
                tmpQuat.transformVector(tmpVecB, tmpVecB);
                target[0] = pos[0] + tmpVecB.x;
                target[1] = pos[1] + tmpVecB.y;
                target[2] = pos[2] + tmpVecB.z;
            }
        }

        this.syncShotCamera({ position: pos, target, fov: m.fov });
        if (getState().lookThrough) {
            this.orbit.setPose(pos[0], pos[1], pos[2], target[0], target[1], target[2], true);
            this.syncViewZoom();
        }

        const verb = m.kind === 'grab' ? 'Move' : 'Rotate';
        const axis = m.axis ? ` ${m.axis.toUpperCase()}` : '';
        setState({ modalHint: `${verb} camera${axis} — X/Y/Z axis · click/Enter confirm · Esc cancel` });
    }

    private confirmModal() {
        const m = this.modal;
        const shot = this.shotCamera;
        if (!m || !shot) return;
        m.cleanup();
        this.modal = null;

        const p = shot.getPosition();
        const f = shot.forward;
        const dist = Math.max(0.2, Math.hypot(
            m.startTarget[0] - m.startPos[0],
            m.startTarget[1] - m.startPos[1],
            m.startTarget[2] - m.startPos[2]
        ));
        let target: [number, number, number] = [p.x + f.x * dist, p.y + f.y * dist, p.z + f.z * dist];
        if (getState().cameraAim === 'track') {
            const t = this.aimTargetWorld(tmpVec);
            if (t) target = [t.x, t.y, t.z];
        }
        const frame = getState().frame;
        this.cameraTrack.addKey({ frame, position: [p.x, p.y, p.z], target, fov: m.fov });
        setState({ modalHint: null, selectedKey: { track: 'camera', frame }, timelineVisible: true });
        this.publishTimeline();
        this.applyFrame(this.playFrame);
        this.rebuildGizmo(getState().tool);
    }

    private cancelModal() {
        const m = this.modal;
        if (!m) return;
        m.cleanup();
        this.modal = null;
        this.syncShotCamera({ position: m.startPos, target: m.startTarget, fov: m.fov });
        if (getState().lookThrough) {
            this.orbit.setPose(m.startPos[0], m.startPos[1], m.startPos[2], m.startTarget[0], m.startTarget[1], m.startTarget[2], true);
            this.syncViewZoom();
        }
        setState({ modalHint: null });
        this.rebuildGizmo(getState().tool);
    }

    /** True when the stage object is locked against selection/manipulation. */
    private stageLocked(sel: StageSelection): boolean {
        const s = getState();
        if (sel.kind === 'model') return s.modelLocked;
        if (sel.kind === 'camera') return s.cameraLocked;
        return s.lights.find(l => l.id === sel.lightId)?.locked === true;
    }

    /** Lock / unlock a stage layer; locking a selected object deselects it. */
    setStageLocked(sel: StageSelection, locked: boolean) {
        if (sel.kind === 'model') setState({ modelLocked: locked });
        else if (sel.kind === 'camera') setState({ cameraLocked: locked });
        else setState({ lights: getState().lights.map(l => (l.id === sel.lightId ? { ...l, locked } : l)) });

        const cur = getState().stageSelection;
        if (locked && cur && cur.kind === sel.kind &&
            (cur.kind !== 'light' || (sel.kind === 'light' && cur.lightId === sel.lightId))) {
            this.selectStageObject(null);
        }
    }

    /** Select a stage object (model / shot camera / light) for gizmo manipulation. */
    selectStageObject(sel: StageSelection | null) {
        if (sel && this.stageLocked(sel)) return;
        setState({ stageSelection: sel });
        const tool = getState().tool;
        if (sel && tool !== 'move' && tool !== 'rotate' && tool !== 'scale') {
            this.setActiveTool('move');
        } else {
            this.rebuildGizmo(tool);
        }
    }

    /**
     * Viewport click: pick the stage object under the cursor. Light and camera
     * markers win over the model (small targets first); empty space deselects.
     */
    pickStageObject(cx: number, cy: number, canvasW: number, canvasH: number) {
        const cam = this.cameraEntity?.camera;
        if (!cam || !this.splat) return;

        const view = cam.projectionMatrix.clone().mul(cam.viewMatrix);
        const m = view.data;
        const project = (p: Vec3): { x: number; y: number } | null => {
            const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
            if (w <= 0) return null;
            return {
                x: ((m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w + 1) * 0.5 * canvasW,
                y: (1 - ((m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w + 1) * 0.5) * canvasH
            };
        };

        let best: StageSelection | null = null;
        let bestDist = 22; // px hit radius for markers

        const world = this.splat.entity.getWorldTransform();
        for (const light of getState().lights) {
            if (light.visible === false || light.locked) continue;
            tmpVec.set(light.position[0], light.position[1], light.position[2]);
            world.transformPoint(tmpVec, tmpVec);
            const s = project(tmpVec);
            if (!s) continue;
            const d = Math.hypot(s.x - cx, s.y - cy);
            if (d < bestDist) {
                bestDist = d;
                best = { kind: 'light', lightId: light.id };
            }
        }

        // camera avatar is only clickable where it's visible (director view)
        if (!getState().lookThrough && getState().showCameraViz && !getState().cameraLocked && this.shotCamera) {
            const s = project(this.shotCamera.getPosition());
            if (s) {
                const d = Math.hypot(s.x - cx, s.y - cy);
                if (d < bestDist) {
                    bestDist = d;
                    best = { kind: 'camera' };
                }
            }
        }

        if (!best && !getState().modelLocked && getState().modelVisible && this.splatHitTest(cx, cy, canvasW, canvasH)) {
            best = { kind: 'model' };
        }
        this.selectStageObject(best);
    }

    /** True when a live splat projects within radiusPx of the cursor. */
    private splatHitTest(cx: number, cy: number, canvasW: number, canvasH: number, radiusPx = 10): boolean {
        const { splat } = this;
        const cam = this.cameraEntity?.camera;
        if (!splat || !cam) return false;

        const mvp = cam.projectionMatrix.clone().mul(cam.viewMatrix).mul(splat.entity.getWorldTransform());
        const m = mvp.data;
        const { x: px, y: py, z: pz } = splat.getPositions();
        const state = splat.state.data;
        const r2 = radiusPx * radiusPx;

        for (let i = 0; i < splat.numSplats; ++i) {
            if (state[i] & State.deleted) continue;
            const x = px[i], y = py[i], z = pz[i];
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (w <= 0) continue;
            const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * canvasW;
            const sy = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w + 1) * 0.5) * canvasH;
            const dx = sx - cx, dy = sy - cy;
            if (dx * dx + dy * dy <= r2) return true;
        }

        // sparse scenes render huge diffuse gaussians whose centers can sit
        // far from a visually covered pixel — fall back to ray vs world bound
        tmpBound.setFromTransformedAabb(splat.localBound, splat.entity.getWorldTransform());
        cam.screenToWorld(cx, cy, cam.nearClip, tmpRay.origin);
        cam.screenToWorld(cx, cy, cam.farClip, tmpVecB);
        tmpRay.direction.sub2(tmpVecB, tmpRay.origin).normalize();
        return tmpBound.intersectsRay(tmpRay);
    }

    /**
     * Programmatic selection transform (command API / agents): world-space
     * translate plus rotate/scale about the selection center.
     */
    transformSelection(params: { translate?: [number, number, number]; rotate?: [number, number, number]; scale?: number }) {
        const { splat } = this;
        if (!splat || splat.numSelected === 0) return;

        const ranges = this.selectionRanges();
        if (ranges.size === 0) return;
        const oldIndices = new Uint16Array(ranges.size);
        let k = 0;
        ranges.forEach((i) => {
            oldIndices[k++] = splat.transformIndices[i];
        });

        // world-space delta: T * (Tc * R*S * Tc^-1)
        const world = new Mat4();
        const center = splat.calcWorldBound(true)?.center ?? new Vec3();
        const rs = new Mat4().setTRS(
            Vec3.ZERO,
            params.rotate ? new Quat().setFromEulerAngles(params.rotate[0], params.rotate[1], params.rotate[2]) : Quat.IDENTITY,
            new Vec3(params.scale ?? 1, params.scale ?? 1, params.scale ?? 1)
        );
        const toC = new Mat4().setTranslate(center.x, center.y, center.z);
        const fromC = new Mat4().setTranslate(-center.x, -center.y, -center.z);
        world.mul2(toC, rs).mul(fromC);
        if (params.translate) {
            const t = new Mat4().setTranslate(params.translate[0], params.translate[1], params.translate[2]);
            world.mul2(t, world.clone());
        }

        // convert to model space
        const modelWorld = splat.entity.getWorldTransform();
        const delta = modelWorld.clone().invert().mul(world).mul(modelWorld);

        const op = new SplatsTransformOp(splat, ranges, oldIndices, delta);
        op.name = 'selection.transform';
        op.params = { ...op.params, ...params };
        this.history.add(op);
    }

    /** Numeric rotation edit (euler degrees), undoable. */
    setModelRotation(x: number, y: number, z: number) {
        const { splat } = this;
        if (!splat) return;
        const prev = snapshotTransform(splat.entity);
        const next = { ...prev, rot: new Quat().setFromEulerAngles(x, y, z) };
        const op = new EntityTransformOp(splat.entity, prev, next, 'model.setRotation');
        if (op.changed) this.history.add(op);
    }

    /** Numeric uniform scale edit, undoable. */
    setModelScale(s: number) {
        const { splat } = this;
        if (!splat || !(s > 0)) return;
        const prev = snapshotTransform(splat.entity);
        const next = { ...prev, scale: new Vec3(s, s, s) };
        const op = new EntityTransformOp(splat.entity, prev, next, 'model.setScale');
        if (op.changed) this.history.add(op);
    }

    // -- project save / load -----------------------------------------------------

    /** Suggested base name (no extension) for save / export / render outputs. */
    outputBaseName(): string {
        return (this.splat?.fileName ?? 'scene').replace(/(\.compressed)?\.[^.]+$/, '');
    }

    saveProject(name?: string) {
        const { splat } = this;
        if (!splat) return;

        const e = splat.entity;
        const pos = e.getLocalPosition();
        const rot = e.getLocalRotation();
        const scl = e.getLocalScale();
        const anyLayerIds = splat.layerIds.some(v => v !== 0);
        const deleted = rleFromStateBit(splat.state.data, State.deleted);

        const project: ProjectFile = {
            version: 1,
            source: { name: splat.fileName, size: splat.fileSize },
            model: {
                offset: [pos.x, pos.y, pos.z],
                rotation: [rot.x, rot.y, rot.z, rot.w],
                scale: [scl.x, scl.y, scl.z]
            },
            camera: {
                azim: this.orbit.azim,
                elev: this.orbit.elev,
                distance: this.orbit.distance,
                target: [this.orbit.target.x, this.orbit.target.y, this.orbit.target.z]
            },
            layers: this.layerList.map(({ count: _count, ...rest }) => rest),
            ...(anyLayerIds ? { layerIds: bytesToBase64(splat.layerIds) } : {}),
            ...(deleted.length ? { deleted } : {}),
            ...(this.modifierList.length ? { modifiers: this.modifierList.map(m => ({ ...m, params: { ...m.params } })) } : {}),
            ...(splat.hasTransforms ? { transforms: this.serializeTransforms(splat) } : {}),
            ...(this.savedCameras.length ? { savedCameras: this.savedCameras.map(c => ({ ...c })) } : {}),
            ...(this.cameraTrack.keys.length ? {
                cameraTrack: {
                    keys: this.cameraTrack.keys.map(k => ({ ...k })),
                    interpolation: this.cameraTrack.interpolation,
                    fps: getState().playbackFps,
                    loop: getState().loopMode
                }
            } : {}),
            ...(this.modelTrack.keys.length ? {
                modelTrack: { keys: this.modelTrack.keys.map(k => ({ ...k })) }
            } : {}),
            ...(this.explodeTrack.keys.length ? {
                explode: {
                    keys: this.explodeTrack.keys.map(k => ({ ...k })),
                    seed: getState().explodeSeed,
                    turbulence: getState().explodeTurbulence,
                    swirl: getState().explodeSwirl,
                    gravity: getState().explodeGravity,
                    spread: getState().explodeSpread
                }
            } : {}),
            cameraAim: getState().cameraAim,
            ...(getState().lights.length ? {
                lights: getState().lights.map(l => ({ ...l, position: [...l.position] as [number, number, number] })),
                lightingAmbient: getState().lightingAmbient
            } : {}),
            canvasColor: getState().canvasColor,
            timelineDuration: getState().duration,
            renderSize: [getState().renderWidth, getState().renderHeight],
            ...(this.fxTracks.size || FX_DEFS.some(d => getState().fx[d.id].enabled) ? {
                fxEffects: Object.fromEntries(
                    FX_DEFS.filter(d => getState().fx[d.id].enabled).map(d => [d.id, {
                        amount: getState().fx[d.id].amount,
                        params: { ...getState().fx[d.id].params },
                        keys: (this.fxTracks.get(d.id)?.keys ?? []).map(k => ({ ...k }))
                    }])
                )
            } : {})
        };

        const base = (name?.trim() || splat.fileName.replace(/\.[^.]+$/, '')).replace(/\.splatstudio$/i, '');
        downloadProject(project, base + '.splatstudio');
        setState({ saveOpen: false });
    }

    /** Open a .splatstudio file: parses it, then asks the UI to locate the source splat. */
    async openProjectFile(file: File) {
        try {
            const project = parseProject(await file.text());
            this.pendingProject = project;
            setState({
                pendingProject: {
                    fileName: file.name,
                    sourceName: project.source.name,
                    sourceSize: project.source.size
                },
                error: null
            });
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
        }
    }

    cancelPendingProject() {
        this.pendingProject = null;
        setState({ pendingProject: null });
    }

    /** Called by the locate dialog with the user-provided source splat file. */
    async providePendingSource(file: File) {
        const project = this.pendingProject;
        if (!project) return;
        this.pendingProject = null;
        setState({ pendingProject: null });
        await this.loadFile(file);
        this.applyProject(project);
    }

    private applyProject(project: ProjectFile) {
        const { splat } = this;
        if (!splat) return;

        const e = splat.entity;
        e.setLocalPosition(project.model.offset[0], project.model.offset[1], project.model.offset[2]);
        const [rx, ry, rz, rw] = project.model.rotation;
        e.setLocalRotation(new Quat(rx, ry, rz, rw));
        e.setLocalScale(project.model.scale[0], project.model.scale[1], project.model.scale[2]);

        this.layerList = project.layers.map(l => ({ ...l, count: 0 }));
        if (!this.layerList.some(l => l.id === 0)) {
            this.layerList.unshift({ id: 0, name: 'Default', color: '#8b8e96', visible: true, locked: false, count: 0 });
        }
        this.nextLayerId = Math.max(...this.layerList.map(l => l.id)) + 1;

        if (project.layerIds) {
            const bytes = base64ToBytes(project.layerIds);
            if (bytes.length === splat.layerIds.length) {
                splat.layerIds.set(bytes);
            }
        }

        if (project.deleted?.length) {
            const ranges = new IndexRanges();
            for (const [lo, hi] of project.deleted) {
                for (let i = lo; i < Math.min(hi, splat.numSplats); ++i) ranges.add(i);
            }
            splat.state.setBits(ranges, State.deleted);
        }

        splat.syncLayerBits(this.layerList);
        this.history.clear();
        splat.updateState(true);
        setState({ canUndo: false, canRedo: false });

        const cam = project.camera;
        this.orbit.azim = cam.azim;
        this.orbit.elev = cam.elev;
        this.orbit.distance = cam.distance;
        this.orbit.target.set(cam.target[0], cam.target[1], cam.target[2]);

        if (project.modifiers?.length) {
            this.modifierList = project.modifiers.map(m => ({ ...m, params: { ...m.params } }));
            this.nextModifierId = Math.max(...this.modifierList.map(m => m.id)) + 1;
            this.recomputeModifiers();
        }

        if (project.savedCameras?.length) {
            this.savedCameras = project.savedCameras.map(c => ({ ...c }));
            this.nextCameraId = Math.max(...this.savedCameras.map(c => c.id)) + 1;
            this.publishCameras();
        }

        if (project.timelineDuration) {
            setState({ duration: project.timelineDuration });
        }

        if (project.cameraTrack?.keys.length) {
            this.cameraTrack.clear();
            for (const k of project.cameraTrack.keys) this.cameraTrack.addKey({ ...k });
            this.cameraTrack.interpolation = project.cameraTrack.interpolation;
            setState({
                playbackFps: project.cameraTrack.fps,
                loopMode: (project.cameraTrack.loop as LoopMode) || 'loop',
                timelineVisible: true
            });
        }

        if (project.modelTrack?.keys.length) {
            this.modelTrack.clear();
            for (const k of project.modelTrack.keys) this.modelTrack.addKey({ ...k });
            this.modelTrack.interpolation = this.cameraTrack.interpolation;
            setState({ timelineVisible: true });
        }

        if (project.explode?.keys.length) {
            this.explodeTrack.clear();
            for (const k of project.explode.keys) this.explodeTrack.addKey({ ...k });
            setState({
                explodeSeed: project.explode.seed ?? 1,
                explodeTurbulence: project.explode.turbulence ?? 0,
                explodeSwirl: project.explode.swirl ?? 0,
                explodeGravity: project.explode.gravity ?? 0,
                explodeSpread: project.explode.spread ?? 0.5,
                explodeEnabled: true,
                timelineVisible: true
            });
        }
        if (project.cameraAim) {
            setState({ cameraAim: project.cameraAim as CameraAim });
        }

        if (project.lights?.length) {
            setState({
                lights: project.lights.map(l => ({ ...l })),
                lightingAmbient: project.lightingAmbient ?? 0.25
            });
            this.nextLightId = Math.max(...project.lights.map(l => l.id)) + 1;
            this.pushLights();
        }
        if (project.canvasColor) {
            this.setCanvasColor(project.canvasColor);
        }
        if (project.renderSize) {
            setState({
                renderWidth: sanitizeSize(project.renderSize[0]),
                renderHeight: sanitizeSize(project.renderSize[1])
            });
        }
        if (project.fxEffects) {
            for (const def of FX_DEFS) {
                const saved = project.fxEffects[def.id];
                if (!saved) continue;
                this.setFxEnabled(def.id, true);
                for (const [key, value] of Object.entries(saved.params)) {
                    if (key in getState().fx[def.id].params) this.setFxParam(def.id, key, value);
                }
                const track = this.fxTracks.get(def.id);
                if (track) {
                    for (const k of saved.keys) track.addKey({ ...k });
                }
                this.setFxAmount(def.id, saved.amount);
            }
            this.publishTimeline();
        }

        if (project.cameraTrack || project.modelTrack || project.explode || project.timelineDuration) {
            this.publishTimeline();
        }

        if (project.transforms) {
            const t = project.transforms;
            const bytes = base64ToBytes(t.indices);
            const indices = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
            if (indices.length === splat.transformIndices.length) {
                splat.transformIndices.set(indices);
                splat.transformPalette.alloc(t.count);
                const mat = new Mat4();
                for (let e = 0; e < t.count; ++e) {
                    const src = t.palette.slice(e * 16, e * 16 + 16);
                    mat.set(src);
                    splat.transformPalette.setTransform(e + 1, mat);
                }
                splat.syncTransformTexture();
                splat.refreshPositions();
                splat.updateState(true);
            }
        }
    }

    private serializeTransforms(splat: SplatEntity) {
        const count = splat.transformPalette.nextIndex - 1;
        const palette: number[] = [];
        const mat = new Mat4();
        for (let e = 1; e <= count; ++e) {
            splat.transformPalette.getTransform(e, mat);
            for (let j = 0; j < 16; ++j) palette.push(mat.data[j]);
        }
        const u16 = splat.transformIndices;
        return {
            indices: bytesToBase64(new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength)),
            palette,
            count
        };
    }

    // -- modifier stack -----------------------------------------------------------

    /** Re-derive filtered bits and grade uniforms from the stack, then publish. */
    recomputeModifiers() {
        const { splat } = this;
        if (!splat) return;

        const mask = evaluateFilters(splat.splatData, splat.state.data, this.modifierList);
        splat.applyFilterMask(mask);

        const grade = [...this.modifierList].reverse().find(m => m.enabled && m.type === 'colorGrade');
        splat.setColorGrade(grade
            ? { exposure: grade.params.exposure, brightness: grade.params.brightness, saturation: grade.params.saturation, transparency: grade.params.transparency }
            : { exposure: 1, brightness: 0, saturation: 1, transparency: 1 });

        splat.updateState(true);
        this.publishModifiers();
    }

    private publishModifiers() {
        setState({ modifiers: this.modifierList.map(m => ({ ...m, params: { ...m.params } })) });
    }

    addModifier(type: ModifierType) {
        const { splat } = this;
        if (!splat) return;
        const params = type === 'cropBox'
            ? percentileBounds(splat.splatData, splat.state.data)
            : defaultParams(type);
        this.modifierList.push({ id: this.nextModifierId++, type, enabled: true, params });
        this.recomputeModifiers();
    }

    removeModifier(id: number) {
        const idx = this.modifierList.findIndex(m => m.id === id);
        if (idx < 0) return;
        this.modifierList.splice(idx, 1);
        this.recomputeModifiers();
    }

    setModifierEnabled(id: number, enabled: boolean) {
        const mod = this.modifierList.find(m => m.id === id);
        if (!mod || mod.enabled === enabled) return;
        mod.enabled = enabled;
        this.recomputeModifiers();
    }

    setModifierParam(id: number, key: string, value: number) {
        const mod = this.modifierList.find(m => m.id === id);
        if (!mod || mod.params[key] === value) return;
        mod.params[key] = value;
        this.recomputeModifiers();
    }

    moveModifier(id: number, dir: -1 | 1) {
        const idx = this.modifierList.findIndex(m => m.id === id);
        const to = idx + dir;
        if (idx < 0 || to < 0 || to >= this.modifierList.length) return;
        const [mod] = this.modifierList.splice(idx, 1);
        this.modifierList.splice(to, 0, mod);
        this.recomputeModifiers();
    }

    /**
     * Bake: permanently delete everything the stack currently filters and
     * clear the stack. Undo restores both the splats and the stack.
     */
    bakeModifiers() {
        const { splat } = this;
        if (!splat || splat.numFiltered === 0) return;

        const ranges = new IndexRanges();
        const data = splat.state.data;
        for (let i = 0; i < data.length; ++i) {
            if ((data[i] & (State.filtered | State.deleted)) === State.filtered) ranges.add(i);
        }
        const deleteOp = new DeleteRangesOp(splat.state, ranges, 'modifiers.bake');
        const stack = this.modifierList;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const mgr = this;

        this.history.add({
            name: 'modifiers.bake',
            params: { baked: ranges.size, modifiers: stack.length },
            changesDeleted: true,
            do() {
                deleteOp.do();
                mgr.modifierList = [];
                mgr.recomputeModifiers();
            },
            undo() {
                deleteOp.undo();
                mgr.modifierList = stack;
                mgr.recomputeModifiers();
            }
        });
    }

    get modifiers() {
        return this.modifierList;
    }

    // -- view modes -----------------------------------------------------------

    setViewMode(mode: ViewMode) {
        setState({ viewMode: mode });
        this.splat?.setViewMode(VIEW_MODE_INDEX[mode]);
    }

    /** Keep the depth heatmap normalized to the visible bounds each frame. */
    private updateDepthRange() {
        const { splat } = this;
        if (!splat || getState().viewMode !== 'depth' || !this.cameraEntity.camera) return;
        tmpBound.setFromTransformedAabb(splat.localBound, splat.entity.getWorldTransform());
        const radius = tmpBound.halfExtents.length();
        const dist = tmpVec.sub2(this.cameraEntity.getPosition(), tmpBound.center).length();
        tmpMatA.mul2(this.cameraEntity.camera.viewMatrix, splat.entity.getWorldTransform());
        splat.setDepthParams(Math.max(0.01, dist - radius), dist + radius, tmpMatA);
    }

    // -- export -----------------------------------------------------------------

    exportEstimate(opts: ExportOptions, format: ExportFormat = 'ply') {
        const { splat } = this;
        if (!splat) return { count: 0, size: 0 };
        const count = countExportSplats(splat.state.data, opts);
        return { count, size: estimateSize(splat.splatData, count, format) };
    }

    // -- workspace modes ----------------------------------------------------------

    /**
     * Switch workspace mode. Each mode brings its own contextual controls:
     * edit = selection/cleanup tools, animation = timeline/cameras/render,
     * training = the capture → reconstruct workspace.
     */
    setMode(mode: WorkspaceMode) {
        const prev = getState().mode;
        if (mode === prev) return;
        setState({ mode });

        if (mode === 'animation') {
            // selection tools belong to edit mode; move/rotate/scale stay
            // (they manipulate the selected stage object)
            const { tool, stageSelection } = getState();
            if (tool !== 'orbit' && tool !== 'drag' && tool !== 'move' && tool !== 'rotate' && tool !== 'scale') {
                this.setActiveTool('orbit');
            }
            // animation mode always shows the individual track lanes; the shot
            // camera starts selected so G/R grab it immediately
            setState({
                timelineVisible: true, timelineExpanded: true, pickingOrigin: false,
                stageSelection: stageSelection ?? { kind: 'camera' },
                showCameraViz: true
            });
        } else if (mode === 'edit') {
            const sel = getState().stageSelection;
            // model/camera selection is an animation concept; lights stay grabbable
            setState({ timelineVisible: false, stageSelection: sel?.kind === 'light' ? sel : null });
        }
        this.rebuildGizmo(getState().tool);
    }

    // -- saved cameras -----------------------------------------------------------

    private publishCameras() {
        setState({ cameras: this.savedCameras.map(c => ({ ...c })) });
    }

    private currentPose() {
        const p = this.cameraEntity.getPosition();
        const t = this.orbit.target;
        return {
            position: [p.x, p.y, p.z] as [number, number, number],
            target: [t.x, t.y, t.z] as [number, number, number],
            fov: this.lensFov
        };
    }

    addCameraFromView(name?: string) {
        if (!this.app) return;
        const id = this.nextCameraId++;
        this.savedCameras.push({ id, name: name?.trim() || `Camera ${id}`, ...this.currentPose() });
        this.publishCameras();
    }

    renameCamera(id: number, name: string) {
        const cam = this.savedCameras.find(c => c.id === id);
        if (!cam || !name.trim()) return;
        cam.name = name.trim();
        this.publishCameras();
    }

    deleteCamera(id: number) {
        const idx = this.savedCameras.findIndex(c => c.id === id);
        if (idx < 0) return;
        this.savedCameras.splice(idx, 1);
        this.publishCameras();
    }

    gotoCamera(id: number) {
        const cam = this.savedCameras.find(c => c.id === id);
        if (!cam) return;
        // damped fly: set goals without snapping the smoothing state
        this.orbit.setPose(cam.position[0], cam.position[1], cam.position[2], cam.target[0], cam.target[1], cam.target[2], false);
        if (this.cameraEntity.camera) this.cameraEntity.camera.fov = cam.fov;
    }

    // -- timeline & camera animation ------------------------------------------------

    private publishTimeline() {
        const seq = this.sequenceSource;
        let lastFx = 0;
        const fxKeys: Partial<Record<FxId, number[]>> = {};
        for (const [id, track] of this.fxTracks) {
            fxKeys[id] = track.keys.map(k => k.frame);
            lastFx = Math.max(lastFx, track.lastFrame + 1);
        }
        const totalFrames = seq
            ? seq.count
            : Math.max(getState().duration, this.cameraTrack.lastFrame + 1, this.modelTrack.lastFrame + 1, this.explodeTrack.lastFrame + 1, lastFx);
        this.pathDirty = true;
        setState({
            cameraKeys: this.cameraTrack.keys.map(k => k.frame),
            modelKeys: this.modelTrack.keys.map(k => k.frame),
            explodeKeys: this.explodeTrack.keys.map(k => k.frame),
            fxKeys,
            interpolation: this.cameraTrack.interpolation,
            totalFrames
        });
    }

    addModelKey() {
        if (!this.splat) return;
        const frame = getState().frame;
        const e = this.splat.entity;
        const p = e.getLocalPosition();
        const r = e.getLocalRotation();
        const s = e.getLocalScale();
        this.modelTrack.addKey({
            frame,
            position: [p.x, p.y, p.z],
            rotation: [r.x, r.y, r.z, r.w],
            scale: [s.x, s.y, s.z]
        });
        setState({ timelineVisible: true, selectedKey: { track: 'model', frame } });
        this.publishTimeline();
    }

    removeModelKey(frame?: number) {
        if (this.modelTrack.removeKey(frame ?? getState().frame)) {
            setState({ selectedKey: null });
            this.publishTimeline();
        }
    }

    /** The scalar track behind a track id (explode or an fx effect). */
    private scalarTrackFor(track: TrackId): ScalarTrack | null {
        if (track === 'explode') return this.explodeTrack;
        if (track === 'camera' || track === 'model') return null;
        return this.fxTracks.get(track) ?? null;
    }

    /** Retime a key on any track (lane drag). */
    moveTrackKey(track: TrackId, from: number, to: number) {
        const total = getState().totalFrames;
        const clamped = Math.max(0, Math.min(total - 1, Math.round(to)));
        const t = track === 'camera' ? this.cameraTrack
            : track === 'model' ? this.modelTrack
            : this.scalarTrackFor(track) ?? this.explodeTrack;
        if (t.moveKey(from, clamped)) {
            const sel = getState().selectedKey;
            if (sel && sel.track === track && sel.frame === from) {
                setState({ selectedKey: { track, frame: clamped } });
            }
            this.publishTimeline();
            this.applyFrame(this.playFrame);
        }
    }

    /** Select a key and jump the playhead to it. */
    selectTrackKey(track: TrackId, frame: number) {
        setState({ selectedKey: { track, frame } });
        this.setFrame(frame);
    }

    /** Delete whichever key is selected (⌫ handler). Returns true if consumed. */
    deleteSelectedKey(): boolean {
        const sel = getState().selectedKey;
        if (!sel) return false;
        if (sel.track === 'camera') this.removeCameraKey(sel.frame);
        else if (sel.track === 'model') this.removeModelKey(sel.frame);
        else if (sel.track === 'explode') this.removeExplodeKey(sel.frame);
        else this.removeFxKey(sel.track, sel.frame);
        return true;
    }

    /** Remove every key from a track. */
    clearTrack(track: TrackId) {
        if (track === 'camera') this.cameraTrack.clear();
        else if (track === 'model') this.modelTrack.clear();
        else (this.scalarTrackFor(track) ?? this.explodeTrack).clear();
        setState({ selectedKey: null });
        this.publishTimeline();
    }

    // -- explode effect --------------------------------------------------------

    private explodeParams(amount: number): ExplodeParams {
        const s = getState();
        return {
            amount,
            seed: s.explodeSeed,
            turbulence: s.explodeTurbulence,
            swirl: s.explodeSwirl,
            gravity: s.explodeGravity,
            spread: s.explodeSpread
        };
    }

    /** Apply an explode amount: shader uniforms + throttled sort-center mirror. */
    private applyExplode(amount: number, forceSort = false) {
        const { splat } = this;
        if (!splat) return;
        const params = this.explodeParams(amount);
        splat.setExplode(params, this.explodeCenter);
        if (getState().explodeAmount !== amount) {
            setState({ explodeAmount: amount });
        }

        // keep depth sorting roughly honest without an O(n) pass per tick
        const now = performance.now();
        const changed = Math.abs(amount - this.lastSortAmount) > 0.08;
        if (forceSort || (changed && (now - this.lastSortRecompute > 250 || splat.numSplats < 200_000))) {
            splat.applyExplodeToSortCenters(params, this.explodeCenter);
            splat.instance.sort(this.cameraEntity);
            this.lastSortAmount = amount;
            this.lastSortRecompute = now;
        }
    }

    /** Add/remove the explode effect (opt-in: lane + controls appear only when enabled). */
    setExplodeEnabled(on: boolean) {
        if (on) {
            setState({ explodeEnabled: true });
        } else {
            this.explodeTrack.clear();
            this.applyExplode(0, true);
            setState({ explodeEnabled: false, selectedKey: getState().selectedKey?.track === 'explode' ? null : getState().selectedKey });
            this.publishTimeline();
        }
    }

    /** Manual amount (Animation panel slider); keys capture this value. */
    setExplodeAmount(amount: number) {
        if (!getState().explodeEnabled && amount > 0) setState({ explodeEnabled: true });
        this.applyExplode(Math.max(0, Math.min(4, amount)));
    }

    /** Scatter character params (seed / turbulence / swirl / gravity / spread). */
    setExplodeParam(param: 'seed' | 'turbulence' | 'swirl' | 'gravity' | 'spread', value: number) {
        const key = param === 'seed' ? 'explodeSeed'
            : param === 'turbulence' ? 'explodeTurbulence'
            : param === 'swirl' ? 'explodeSwirl'
            : param === 'gravity' ? 'explodeGravity'
            : 'explodeSpread';
        setState({ [key]: value } as Parameters<typeof setState>[0]);
        this.applyExplode(getState().explodeAmount, true);
    }

    reseedExplode() {
        this.setExplodeParam('seed', Math.floor(Math.random() * 9999) + 1);
    }

    // -- stylized effects (peel / dissolve / jitter / wave / twist) --------------

    private fxTracks = new Map<FxId, ScalarTrack>();

    /** Push every shader uniform of one effect (or the shared ones for all). */
    private pushFxUniforms(id?: FxId) {
        const { splat } = this;
        if (!splat) return;
        const s = getState();
        const he = splat.localBound.halfExtents;
        const entries: [string, number | number[]][] = [
            ['ssFxCenter', [this.explodeCenter.x, this.explodeCenter.y, this.explodeCenter.z]],
            ['ssFxRadius', Math.max(0.001, he.length())],
            ['ssFxExtents', [Math.max(0.001, he.x), Math.max(0.001, he.y), Math.max(0.001, he.z)]]
        ];
        for (const def of FX_DEFS) {
            if (id && def.id !== id) continue;
            const fx = s.fx[def.id];
            entries.push([def.amountUniform, fx.enabled ? fx.amount : 0]);
            for (const p of def.params) {
                if (p.uniform) entries.push([p.uniform, fx.params[p.key]]);
            }
            for (const v of def.vectors ?? []) {
                entries.push([v.uniform, [fx.params[v.keys[0]], fx.params[v.keys[1]], fx.params[v.keys[2]]]]);
            }
        }
        splat.setFxParams(entries);
    }

    /** Add/remove an effect (lane + controls appear only when enabled). */
    setFxEnabled(id: FxId, on: boolean) {
        const s = getState();
        const fx = { ...s.fx, [id]: { ...s.fx[id], enabled: on, ...(on ? {} : { amount: 0 }) } };
        if (on) {
            if (!this.fxTracks.has(id)) {
                const track = new ScalarTrack();
                track.interpolation = this.cameraTrack.interpolation;
                this.fxTracks.set(id, track);
            }
            setState({ fx });
        } else {
            this.fxTracks.delete(id);
            const sel = s.selectedKey;
            setState({ fx, selectedKey: sel?.track === id ? null : sel });
        }
        this.pushFxUniforms(id);
        this.publishTimeline();
    }

    /** Live keyable value (panel slider / track playback). */
    setFxAmount(id: FxId, amount: number) {
        const s = getState();
        const def = fxDef(id);
        const v = Math.max(0, Math.min(def.amountMax, amount));
        if (s.fx[id].amount !== v) {
            setState({ fx: { ...s.fx, [id]: { ...s.fx[id], amount: v } } });
        }
        this.splat?.setFxParams([[def.amountUniform, s.fx[id].enabled ? v : 0]]);
    }

    setFxParam(id: FxId, key: string, value: number) {
        const s = getState();
        setState({ fx: { ...s.fx, [id]: { ...s.fx[id], params: { ...s.fx[id].params, [key]: value } } } });
        this.pushFxUniforms(id);
    }

    addFxKey(id: FxId) {
        const track = this.fxTracks.get(id);
        if (!this.splat || !track) return;
        const frame = getState().frame;
        track.addKey({ frame, value: getState().fx[id].amount });
        setState({ timelineVisible: true, selectedKey: { track: id, frame } });
        this.publishTimeline();
    }

    removeFxKey(id: FxId, frame?: number) {
        if (this.fxTracks.get(id)?.removeKey(frame ?? getState().frame)) {
            setState({ selectedKey: null });
            this.publishTimeline();
        }
    }

    addExplodeKey() {
        if (!this.splat) return;
        const frame = getState().frame;
        this.explodeTrack.addKey({ frame, value: getState().explodeAmount });
        setState({ timelineVisible: true, explodeEnabled: true, selectedKey: { track: 'explode', frame } });
        this.publishTimeline();
    }

    removeExplodeKey(frame?: number) {
        if (this.explodeTrack.removeKey(frame ?? getState().frame)) {
            setState({ selectedKey: null });
            this.publishTimeline();
        }
    }

    /** Editor-camera field of view (captured into subsequent camera keys). */
    setFov(fov: number) {
        const v = Math.max(10, Math.min(140, fov));
        if (this.cameraEntity.camera) this.cameraEntity.camera.fov = v;
        if (this.shotCamera?.camera && this.cameraTrack.keys.length === 0) this.shotCamera.camera.fov = v;
        const s = getState();
        if (s.mode === 'animation' && s.lookThrough) {
            // camera view: the value is the lens; the editor camera carries
            // the view-field zoom on top of it
            if (this.shotCamera?.camera) this.shotCamera.camera.fov = v;
            this.syncViewZoom();
        }
        this.publishStats();
    }

    /** Wheel zoom in animation mode: scales the lens FOV (the view field). */
    zoomFov(factor: number) {
        const lens = Math.max(10, Math.min(140, this.lensFov * factor));
        if (getState().lookThrough) {
            // camera view: the zoom belongs to the shot camera (keys at playhead)
            if (this.shotCamera?.camera) this.shotCamera.camera.fov = lens;
            this.lockCameraToView();
            this.syncViewZoom();
            this.publishStats();
        } else {
            this.setFov(lens);
        }
    }

    setDuration(frames: number) {
        const duration = Math.max(2, Math.min(100_000, Math.round(frames)));
        setState({ duration });
        this.publishTimeline();
        if (this.playFrame > duration - 1) this.setFrame(duration - 1);
    }

    addCameraKey() {
        const frame = getState().frame;
        this.cameraTrack.addKey({ frame, ...this.currentPose() });
        setState({ timelineVisible: true, selectedKey: { track: 'camera', frame } });
        this.publishTimeline();
    }

    /**
     * Blender-style camera view: while looking through the lens, navigation
     * IS the camera — sync the shot camera to the view's goal pose and key it
     * at the playhead.
     */
    lockCameraToView() {
        if (getState().playing || getState().cameraLocked) return;
        const o = this.orbit;
        const azim = o.azim * Math.PI / 180;
        const elev = o.elev * Math.PI / 180;
        const fx = Math.sin(azim) * Math.cos(elev);
        const fy = Math.sin(elev);
        const fz = Math.cos(azim) * Math.cos(elev);
        const pose: CameraPose = {
            position: [o.target.x + fx * o.distance, o.target.y + fy * o.distance, o.target.z + fz * o.distance],
            target: [o.target.x, o.target.y, o.target.z],
            fov: this.lensFov
        };
        this.syncShotCamera(pose);
        const frame = getState().frame;
        this.cameraTrack.addKey({ frame, ...pose });
        setState({ timelineVisible: true, selectedKey: { track: 'camera', frame } });
        this.publishTimeline();
    }

    removeCameraKey(frame?: number) {
        if (this.cameraTrack.removeKey(frame ?? getState().frame)) {
            setState({ selectedKey: null });
            this.publishTimeline();
        }
    }

    setInterpolation(mode: Interpolation) {
        this.cameraTrack.interpolation = mode;
        this.modelTrack.interpolation = mode;
        this.modelTrack.markDirty();
        this.explodeTrack.interpolation = mode;
        this.explodeTrack.markDirty();
        for (const track of this.fxTracks.values()) {
            track.interpolation = mode;
            track.markDirty();
        }
        this.publishTimeline();
        this.applyFrame(this.playFrame);
    }

    // -- shot camera & viewport overlays -----------------------------------------

    private syncShotCamera(pose: CameraPose) {
        const shot = this.shotCamera;
        if (!shot) return;
        shot.setLocalPosition(pose.position[0], pose.position[1], pose.position[2]);
        tmpVec.set(pose.target[0], pose.target[1], pose.target[2]);
        shot.lookAt(tmpVec);
        if (shot.camera) shot.camera.fov = pose.fov;
    }

    setLookThrough(on: boolean) {
        const lens = this.lensFov;
        setState({ lookThrough: on });
        if (on) {
            // snap the editor camera onto the shot pose at the playhead
            this.applyFrame(this.playFrame);
            this.syncViewZoom();
        } else if (this.cameraEntity.camera) {
            // leaving camera view: drop the view-field zoom, keep the lens fov
            this.cameraEntity.camera.fov = lens;
        }
        // director view exposes the shot-camera gizmo
        this.rebuildGizmo(getState().tool);
    }

    setShowGizmos(on: boolean) {
        setState({ showGizmos: on });
        if (!on) this.detachGizmo();
        else this.rebuildGizmo(getState().tool);
    }

    setShowSelectionTint(on: boolean) {
        setState({ showSelectionTint: on });
        this.splat?.setSelectionTint(on);
    }

    /** Master overlays toggle: if anything is on, hide all; else show all. */
    toggleOverlays() {
        const s = getState();
        const anyOn = s.showGrid || s.showCameraViz || s.showGizmos || s.showSelectionTint;
        const on = !anyOn;
        setState({ showGrid: on, showCameraViz: on });
        this.setShowGizmos(on);
        this.setShowSelectionTint(on);
    }

    /** Place the shot camera at the editor camera's goal pose (used when trackless). */
    private initShotFromOrbit() {
        if (this.cameraTrack.keys.length > 0) return;
        const o = this.orbit;
        const azim = o.azim * Math.PI / 180;
        const elev = o.elev * Math.PI / 180;
        const fx = Math.sin(azim) * Math.cos(elev);
        const fy = Math.sin(elev);
        const fz = Math.cos(azim) * Math.cos(elev);
        this.syncShotCamera({
            position: [o.target.x + fx * o.distance, o.target.y + fy * o.distance, o.target.z + fz * o.distance],
            target: [o.target.x, o.target.y, o.target.z],
            fov: this.fov
        });
    }

    /** Camera avatar + flight-path visualization (hidden while looking through it). */
    private drawCameraViz() {
        const s = getState();
        if (!this.app || s.lookThrough || !s.showCameraViz || !this.shotCamera) return;

        // the avatar itself: live entity pose, so it follows gizmo drags
        const p = this.shotCamera.getPosition();
        const f = this.shotCamera.forward;
        this.drawFrustum(
            [p.x, p.y, p.z],
            [p.x + f.x, p.y + f.y, p.z + f.z],
            this.shotCamera.camera?.fov ?? 60,
            0.5,
            s.stageSelection?.kind === 'camera' ? vizSelectedColor : vizCurrentColor
        );

        if (this.cameraTrack.keys.length === 0) return;

        // flight path
        if (this.cameraTrack.keys.length > 1) {
            if (this.pathDirty || !this.pathSamples) {
                const first = this.cameraTrack.keys[0].frame;
                const last = this.cameraTrack.lastFrame;
                const steps = Math.min(240, Math.max(16, (last - first)));
                const pts: number[] = [];
                for (let i = 0; i <= steps; ++i) {
                    const p = this.cameraTrack.evaluate(first + ((last - first) * i) / steps)!;
                    pts.push(p.position[0], p.position[1], p.position[2]);
                }
                this.pathSamples = pts;
                this.pathDirty = false;
            }
            const pts = this.pathSamples;
            for (let i = 0; i + 5 < pts.length; i += 3) {
                this.app.drawLine(
                    va.set(pts[i], pts[i + 1], pts[i + 2]),
                    vb.set(pts[i + 3], pts[i + 4], pts[i + 5]),
                    vizPathColor
                );
            }
        }

        // key pose frustums (dim)
        for (const k of this.cameraTrack.keys) {
            this.drawFrustum(k.position, k.target, k.fov, 0.22, vizKeyColor);
        }
    }

    private drawFrustum(position: number[], target: number[], fovDeg: number, depth: number, color: Color) {
        const app = this.app!;
        fwd.set(target[0] - position[0], target[1] - position[1], target[2] - position[2]).normalize();
        rgt.cross(fwd, Vec3.UP);
        if (rgt.lengthSq() < 1e-6) rgt.set(1, 0, 0);
        rgt.normalize();
        upv.cross(rgt, fwd);

        const aspect = this.app!.graphicsDevice.width / Math.max(1, this.app!.graphicsDevice.height);
        const halfH = Math.tan((fovDeg * Math.PI) / 360) * depth;
        const halfW = halfH * aspect;

        const px = position[0], py = position[1], pz = position[2];
        const cx = px + fwd.x * depth, cy = py + fwd.y * depth, cz = pz + fwd.z * depth;

        // 4 frustum corners
        for (let i = 0; i < 4; ++i) {
            const sx = i & 1 ? 1 : -1;
            const sy = i & 2 ? 1 : -1;
            corners[i].set(
                cx + rgt.x * halfW * sx + upv.x * halfH * sy,
                cy + rgt.y * halfW * sx + upv.y * halfH * sy,
                cz + rgt.z * halfW * sx + upv.z * halfH * sy
            );
        }
        // rays from eye + far rect (corner order: 0=(-,-) 1=(+,-) 2=(-,+) 3=(+,+))
        for (let i = 0; i < 4; ++i) {
            app.drawLine(va.set(px, py, pz), corners[i], color);
        }
        app.drawLine(corners[0], corners[1], color);
        app.drawLine(corners[1], corners[3], color);
        app.drawLine(corners[3], corners[2], color);
        app.drawLine(corners[2], corners[0], color);

        // up indicator: small triangle above the top edge
        va.set(
            (corners[2].x + corners[3].x) / 2 + upv.x * halfH * 0.6,
            (corners[2].y + corners[3].y) / 2 + upv.y * halfH * 0.6,
            (corners[2].z + corners[3].z) / 2 + upv.z * halfH * 0.6
        );
        app.drawLine(corners[2], va, color);
        app.drawLine(va, corners[3], color);
    }

    setPlaying(playing: boolean) {
        const s = getState();
        if (playing && s.loopMode === 'once' && s.frame >= s.totalFrames - 1) {
            this.playFrame = 0;
        }
        this.playDir = 1;
        setState({ playing });
    }

    setFrame(frame: number) {
        const total = getState().totalFrames;
        this.playFrame = Math.max(0, Math.min(total - 1, frame));
        this.applyFrame(this.playFrame);
    }

    stepFrame(delta: number) {
        this.setFrame(Math.round(this.playFrame) + delta);
    }

    private tickTimeline(dt: number) {
        const s = getState();
        if (!s.playing) return;

        const total = Math.max(1, s.totalFrames);
        let f = this.playFrame + dt * s.playbackFps * this.playDir;

        if (s.loopMode === 'once') {
            if (f >= total - 1) {
                f = total - 1;
                setState({ playing: false });
            }
        } else if (s.loopMode === 'loop') {
            if (f >= total) f -= total;
        } else {
            // pingpong
            if (f >= total - 1) {
                f = total - 1;
                this.playDir = -1;
            } else if (f <= 0) {
                f = 0;
                this.playDir = 1;
            }
        }

        this.playFrame = f;
        this.applyFrame(f);
    }

    /** World-space aim point for 'track model' camera mode (cheap: transformed bound center). */
    private aimTargetWorld(out: Vec3): Vec3 | null {
        const { splat } = this;
        if (!splat) return null;
        tmpBound.setFromTransformedAabb(splat.localBound, splat.entity.getWorldTransform());
        return out.copy(tmpBound.center);
    }

    setCameraAim(aim: CameraAim) {
        setState({ cameraAim: aim });
        this.applyFrame(this.playFrame);
    }

    /** Apply the (float) playback head: camera/model poses and sequence frame. */
    private applyFrame(f: number) {
        const pose = this.cameraTrack.evaluate(f);
        if (pose && !this.shotDragging) {
            if (getState().cameraAim === 'track') {
                const t = this.aimTargetWorld(tmpVec);
                if (t) pose.target = [t.x, t.y, t.z];
            }
            this.syncShotCamera(pose);
            if (getState().lookThrough) {
                this.orbit.setPose(pose.position[0], pose.position[1], pose.position[2], pose.target[0], pose.target[1], pose.target[2], true);
                if (this.cameraEntity.camera) this.cameraEntity.camera.fov = pose.fov;
                this.syncViewZoom();
            }
        }

        const mp = this.modelTrack.evaluate(f);
        if (mp && this.splat) {
            const e = this.splat.entity;
            e.setLocalPosition(mp.position[0], mp.position[1], mp.position[2]);
            tmpQuat.set(mp.rotation[0], mp.rotation[1], mp.rotation[2], mp.rotation[3]);
            e.setLocalRotation(tmpQuat);
            e.setLocalScale(mp.scale[0], mp.scale[1], mp.scale[2]);
        }

        const explode = this.explodeTrack.evaluate(f);
        if (explode !== null) {
            this.applyExplode(explode);
        }

        // stylized effects: keyed amounts + the shared animation clock
        for (const [id, track] of this.fxTracks) {
            const v = track.evaluate(f);
            if (v !== null) this.setFxAmount(id, v);
        }
        this.splat?.setFxParams([['ssFxTime', f / Math.max(1, getState().playbackFps)]]);

        if (this.sequenceSource) {
            const idx = Math.max(0, Math.min(this.sequenceSource.count - 1, Math.round(f)));
            if (idx !== this.sequenceFrame && !this.sequenceSwapping) {
                void this.showSequenceFrame(idx);
            }
        }

        const rounded = Math.round(f);
        if (rounded !== getState().frame) {
            setState({ frame: rounded });
        }
    }

    // -- PLY sequences -----------------------------------------------------------

    async openSequence(files: File[]) {
        if (!this.app) throw new Error('Engine not initialized');
        const source = new SequenceSource(files);
        setState({ busy: `Loading sequence frame 1/${source.count}…`, error: null, screen: 'editor' });
        try {
            const { data, rotation } = await source.getFrame(0);
            this.closeScene();
            this.sequenceSource = source;
            this.sequenceFrame = 0;
            this.playFrame = 0;

            const splat = new SplatEntity(this.app, data, source.name, files.reduce((a, f) => a + f.size, 0), rotation);
            this.app.root.addChild(splat.entity);
            this.splat = splat;
            splat.onStateChanged = () => this.publishStats();
            this.explodeCenter.copy(splat.localBound.center);
            this.pushFxUniforms();

            this.layerList = [{ id: 0, name: 'Default', color: '#8b8e96', visible: true, locked: false, count: splat.numSplats }];
            this.nextLayerId = 1;
            this.history.clear();

            setState({
                screen: 'editor',
                canUndo: false,
                canRedo: false,
                modifiers: [],
                viewMode: 'beauty',
                sequence: { name: source.name, count: source.count },
                timelineVisible: true,
                frame: 0,
                playing: false
            });
            this.publishTimeline();
            this.publishStats();
            this.frameScene();
            this.initShotFromOrbit();
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
        } finally {
            setState({ busy: null });
        }
    }

    /** Swap the displayed sequence frame; edits/layers are per-frame, modifiers re-apply. */
    private async showSequenceFrame(index: number) {
        const source = this.sequenceSource;
        if (!source || !this.app || this.sequenceSwapping) return;
        this.sequenceSwapping = true;
        try {
            const { data, rotation } = await source.getFrame(index);
            if (!this.sequenceSource) return; // scene closed while decoding

            const old = this.splat;
            const splat = new SplatEntity(this.app, data, source.name, old?.fileSize ?? 0, rotation);
            if (old) {
                splat.entity.setLocalPosition(old.entity.getLocalPosition());
                splat.entity.setLocalRotation(old.entity.getLocalRotation());
                splat.entity.setLocalScale(old.entity.getLocalScale());
            }
            this.app.root.addChild(splat.entity);
            this.splat = splat;
            splat.onStateChanged = () => this.publishStats();
            old?.destroy();

            this.sequenceFrame = index;

            // carry view-level state onto the new frame
            splat.setViewMode(VIEW_MODE_INDEX[getState().viewMode]);
            splat.setSelectionTint(getState().showSelectionTint);
            this.pushLights();
            if (this.modifierList.length) {
                this.recomputeModifiers();
            } else {
                this.publishStats();
            }
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err), playing: false });
        } finally {
            this.sequenceSwapping = false;
        }
    }

    // -- performance stats ---------------------------------------------------------

    memoryStats() {
        const { splat } = this;
        if (!splat) return { sceneBytes: 0, textureBytes: 0 };
        let sceneBytes = 0;
        const props = splat.splatData.getElement('vertex').properties as { storage: { byteLength: number } }[];
        for (const p of props) sceneBytes += p.storage.byteLength;

        const texBytes = (t: { width: number; height: number } | null, bpp: number) =>
            t ? t.width * t.height * bpp : 0;
        const textureBytes =
            texBytes(splat.stateTexture, 1) +
            texBytes(splat.transformTexture, 2) +
            texBytes(splat.transformPalette.texture, 16);

        return { sceneBytes, textureBytes };
    }

    // -- ground plane ---------------------------------------------------------------

    setShowGroundPlane(on: boolean) {
        setState({ showGroundPlane: on });
        this.applyGroundPlane();
    }

    /** Lazily build the floor plane + key light, then apply current visibility. */
    private applyGroundPlane() {
        const app = this.app;
        if (!app) return;
        const on = getState().showGroundPlane;
        if (on && !this.ground) {
            const material = new StandardMaterial();
            material.diffuse.set(0.42, 0.43, 0.46);
            material.gloss = 0.3;
            material.update();

            const ground = new Entity('groundPlane');
            ground.addComponent('render', {
                type: 'plane',
                material,
                castShadows: false,
                receiveShadows: true
            });
            ground.setLocalScale(GRID_EXTENT * 4, 1, GRID_EXTENT * 4);
            // a hair below y=0 so the grid lines stay visible on top of it
            ground.setLocalPosition(0, -0.002, 0);
            app.root.addChild(ground);
            this.ground = ground;

            const key = new Entity('groundKeyLight');
            key.addComponent('light', {
                type: 'directional',
                color: new Color(1, 0.98, 0.92),
                intensity: 1.4,
                castShadows: true,
                shadowResolution: 2048,
                shadowDistance: GRID_EXTENT * 12,
                shadowBias: 0.2,
                normalOffsetBias: 0.05
            });
            key.setEulerAngles(55, 30, 0);
            app.root.addChild(key);
            this.groundKeyLight = key;
            // only the plane uses StandardMaterial, so this can't tint the splat
            app.scene.ambientLight.set(0.28, 0.29, 0.32);
        }
        if (this.ground) this.ground.enabled = on;
        if (this.groundKeyLight) this.groundKeyLight.enabled = on;
        // splats only render into the shadow map while the plane needs it
        if (this.splat?.entity.gsplat) this.splat.entity.gsplat.castShadows = on;
        this.syncGroundPointLights();
    }

    /** Mirror active point lights as engine omnis (model space, no shadows). */
    private syncGroundPointLights() {
        const { splat, groundPointLights } = this;
        const s = getState();
        const active = s.showGroundPlane && splat
            ? s.lights.filter(l => l.visible !== false).slice(0, 8)
            : [];
        for (const [id, e] of groundPointLights) {
            if (!active.some(l => l.id === id)) {
                e.destroy();
                groundPointLights.delete(id);
            }
        }
        if (!splat || active.length === 0) return;
        const range = Math.max(20, splat.localBound.halfExtents.length() * 4);
        for (const light of active) {
            let e = groundPointLights.get(light.id);
            if (!e) {
                e = new Entity(`groundLight-${light.id}`);
                e.addComponent('light', { type: 'omni', castShadows: false });
                // child of the splat: model-space position, follows the model transform
                splat.entity.addChild(e);
                groundPointLights.set(light.id, e);
            }
            const [r, g, b] = hexToRgb(light.color);
            e.light!.color = new Color(r, g, b);
            e.light!.intensity = light.intensity * 0.5;
            e.light!.range = range;
            e.setLocalPosition(light.position[0], light.position[1], light.position[2]);
        }
    }

    // -- point lights & canvas color ----------------------------------------------

    /** Upload the light list to the splat material. */
    pushLights() {
        const { splat } = this;
        if (!splat) return;
        const s = getState();
        const positions = new Float32Array(32);
        const colors = new Float32Array(32);
        const active = s.lights.filter(l => l.visible !== false);
        const count = Math.min(8, active.length);
        for (let i = 0; i < count; ++i) {
            const light = active[i];
            positions[i * 4] = light.position[0];
            positions[i * 4 + 1] = light.position[1];
            positions[i * 4 + 2] = light.position[2];
            const [r, g, b] = hexToRgb(light.color);
            colors[i * 4] = r;
            colors[i * 4 + 1] = g;
            colors[i * 4 + 2] = b;
            colors[i * 4 + 3] = light.intensity;
        }
        splat.setLights(positions, colors, count, s.lightingAmbient);
        this.syncGroundPointLights();
    }

    addLight() {
        const s = getState();
        if (!this.splat || s.lights.length >= 8) return;
        const id = this.nextLightId++;
        // ring placement above the model center so new lights don't overlap
        const c = this.explodeCenter;
        const angle = s.lights.length * 2.4;
        const light: LightInfo = {
            id,
            position: [
                +(c.x + Math.cos(angle) * 1.5).toFixed(2),
                +(c.y + 1.5).toFixed(2),
                +(c.z + Math.sin(angle) * 1.5).toFixed(2)
            ],
            color: ['#ffd9a0', '#9fd4ff', '#ff9fb0', '#b0ffa8'][s.lights.length % 4],
            intensity: 3
        };
        setState({ lights: [...s.lights, light] });
        this.pushLights();
    }

    removeLight(id: number) {
        const sel = getState().stageSelection;
        setState({
            lights: getState().lights.filter(l => l.id !== id),
            stageSelection: sel?.kind === 'light' && sel.lightId === id ? null : sel
        });
        this.pushLights();
        if (!this.dragging) this.rebuildGizmo(getState().tool);
    }

    setLight(id: number, patch: Partial<Omit<LightInfo, 'id'>>) {
        setState({ lights: getState().lights.map(l => (l.id === id ? { ...l, ...patch } : l)) });
        this.pushLights();
        // keep the gizmo proxy on the light if it was edited numerically
        const sel = getState().stageSelection;
        if (!this.dragging && patch.position && sel?.kind === 'light' && sel.lightId === id) {
            this.rebuildGizmo(getState().tool);
        }
    }

    setLightAmbient(value: number) {
        setState({ lightingAmbient: Math.max(0, Math.min(1, value)) });
        this.pushLights();
    }

    /** Select a light for direct on-canvas manipulation (Move gizmo attaches to it). */
    setActiveLight(id: number | null) {
        this.selectStageObject(id === null ? null : { kind: 'light', lightId: id });
    }

    /** Viewport + render background color (the shot camera renders the video). */
    setCanvasColor(hex: string) {
        setState({ canvasColor: hex });
        const [r, g, b] = hexToRgb(hex);
        if (this.cameraEntity?.camera) this.cameraEntity.camera.clearColor = new Color(r, g, b, 1);
        if (this.shotCamera?.camera) this.shotCamera.camera.clearColor = new Color(r, g, b, 1);
    }

    /** Small colored star markers at light positions (hidden with gizmos overlay). */
    private drawLightViz() {
        const s = getState();
        const { splat, app } = this;
        if (!app || !splat || !s.showGizmos || s.lights.length === 0) return;
        const wt = splat.entity.getWorldTransform();
        const sel = s.stageSelection;
        for (const light of s.lights) {
            if (light.visible === false) continue;
            const r = sel?.kind === 'light' && sel.lightId === light.id ? 0.2 : 0.12;
            tmpVec.set(light.position[0], light.position[1], light.position[2]);
            wt.transformPoint(tmpVec, tmpVec);
            const [cr, cg, cb] = hexToRgb(light.color);
            lightVizColor.set(cr, cg, cb, 1);
            const { x, y, z } = tmpVec;
            app.drawLine(va.set(x - r, y, z), vb.set(x + r, y, z), lightVizColor);
            app.drawLine(va.set(x, y - r, z), vb.set(x, y + r, z), lightVizColor);
            app.drawLine(va.set(x, y, z - r), vb.set(x, y, z + r), lightVizColor);
            const d = r * 0.55;
            app.drawLine(va.set(x - d, y - d, z - d), vb.set(x + d, y + d, z + d), lightVizColor);
            app.drawLine(va.set(x - d, y + d, z - d), vb.set(x + d, y - d, z + d), lightVizColor);
        }
    }

    // -- MP4 video render ---------------------------------------------------------

    private renderCancelled = false;

    cancelRender() {
        this.renderCancelled = true;
    }

    /**
     * Offline MP4 render: steps the timeline frame by frame, renders the shot
     * camera into an offscreen target at the output resolution, waits for the
     * gaussian sort to settle per frame, and encodes via WebCodecs H.264 into
     * an mp4 (mediabunny muxer).
     */
    /** Stage visibility of the model (renders into video output too). */
    setModelVisible(visible: boolean) {
        setState({ modelVisible: visible });
        if (this.splat) this.splat.entity.enabled = visible;
    }

    /** Persistent MP4 output frame (the animation view field). */
    setRenderSize(width: number, height: number) {
        setState({ renderWidth: sanitizeSize(width), renderHeight: sanitizeSize(height) });
        this.syncViewZoom();
    }

    async renderVideo(settings: VideoSettings, fileName?: string) {
        const app = this.app;
        const shot = this.shotCamera;
        if (!app || !this.splat || !shot?.camera || !this.cameraEntity.camera) return;
        if (!videoEncodingSupported()) {
            setState({ error: 'Video export needs WebCodecs (VideoEncoder) — use Chrome, Edge or Safari 16.4+.' });
            return;
        }

        const { width, height, fps } = settings;
        const s0 = getState();
        const outFrames = Math.max(1, Math.round((s0.totalFrames / s0.playbackFps) * fps));

        const config = buildEncoderConfig(settings);
        const support = await VideoEncoder.isConfigSupported(config);
        if (!support.supported) {
            setState({ error: `Unsupported video configuration (H.264 ${width}×${height} @ ${fps} fps)` });
            return;
        }

        this.renderCancelled = false;
        setState({
            renderOpen: false,
            renderAspect: null,
            playing: false,
            renderProgress: { frame: 0, total: outFrames, etaMs: 0, bytes: 0 }
        });

        // hide every overlay for a clean pass; restored in finally
        const saved = { grid: s0.showGrid, viz: s0.showCameraViz, gizmos: s0.showGizmos, tint: s0.showSelectionTint };
        setState({ showGrid: false, showCameraViz: false, showGizmos: false });
        this.detachGizmo();
        this.splat.setSelectionTint(false);

        const device = app.graphicsDevice;
        const colorBuffer = new Texture(device, {
            name: 'videoRenderTarget',
            width,
            height,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false
        });
        const rt = new RenderTarget({ colorBuffer, depth: true });

        // static shot from the current editor view when there are no camera keys
        if (this.cameraTrack.keys.length === 0) {
            this.syncShotCamera(this.currentPose());
        }
        shot.camera.renderTarget = rt;
        shot.camera.enabled = true;
        const mainCam = this.cameraEntity.camera;
        mainCam.enabled = false;

        const target = new BufferTarget();
        const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
        const videoSource = new EncodedVideoPacketSource('avc');
        output.addVideoTrack(videoSource, { rotation: 0, frameRate: fps });
        await output.start();

        // chain muxer writes: WebCodecs ignores promises returned from its
        // output callback, so serialize them and surface failures explicitly
        let muxerWrites = Promise.resolve();
        let muxerError: Error | null = null;
        let encoderError: Error | null = null;
        const encoder = new VideoEncoder({
            output: (chunk, meta) => {
                const packet = EncodedPacket.fromEncodedChunk(chunk);
                muxerWrites = muxerWrites
                    .then(async () => {
                        if (!muxerError) await videoSource.add(packet, meta);
                    })
                    .catch((err) => {
                        muxerError = err instanceof Error ? err : new Error(String(err));
                    });
            },
            error: (e) => {
                encoderError = e;
            }
        });
        encoder.configure(config);

        const data = new Uint8Array(width * height * 4);
        const line = new Uint8Array(width * 4);
        const started = performance.now();

        // drive engine frames manually: rAF is throttled/stopped in background
        // tabs, which would hang (or slow) the offline render — and manual
        // stepping also frees the render from the display refresh rate
        const stepFrame = () => {
            app.update(1 / fps);
            app.render();
        };
        const sortAndWait = () => new Promise<void>((resolve) => {
            const inst = this.splat?.instance;
            if (!inst?.sorter) {
                resolve();
                return;
            }
            const timeout = setTimeout(resolve, 1000);
            inst.sorter.once('updated', () => {
                clearTimeout(timeout);
                resolve();
            });
            inst.sort(shot);
        });

        // only wait on the sorter when the view/content actually changed —
        // static frames would otherwise burn the full timeout every frame
        let lastSortSig = '';

        try {
            for (let i = 0; i < outFrames; ++i) {
                if (this.renderCancelled) break;
                if (encoderError) throw encoderError;
                if (muxerError) throw muxerError;

                // map output frame to (float) timeline frame
                const tf = Math.min(s0.totalFrames - 1, (i * s0.playbackFps) / fps);

                const pose = this.cameraTrack.evaluate(tf);
                if (pose) {
                    if (getState().cameraAim === 'track') {
                        const t = this.aimTargetWorld(tmpVec);
                        if (t) pose.target = [t.x, t.y, t.z];
                    }
                    this.syncShotCamera(pose);
                }
                const mp = this.modelTrack.evaluate(tf);
                if (mp && this.splat) {
                    const e = this.splat.entity;
                    e.setLocalPosition(mp.position[0], mp.position[1], mp.position[2]);
                    tmpQuat.set(mp.rotation[0], mp.rotation[1], mp.rotation[2], mp.rotation[3]);
                    e.setLocalRotation(tmpQuat);
                    e.setLocalScale(mp.scale[0], mp.scale[1], mp.scale[2]);
                }
                const explodeAmt = this.explodeTrack.evaluate(tf);
                if (explodeAmt !== null && this.splat) {
                    // exact per-frame sort centers for a clean offline render
                    const eparams = this.explodeParams(explodeAmt);
                    this.splat.setExplode(eparams, this.explodeCenter);
                    this.splat.applyExplodeToSortCenters(eparams, this.explodeCenter);
                    setState({ explodeAmount: explodeAmt });
                }
                // stylized effects: keyed amounts + the animation clock
                let fxSig = '';
                for (const [id, track] of this.fxTracks) {
                    const v = track.evaluate(tf);
                    if (v !== null) this.setFxAmount(id, v);
                    fxSig += `${id}:${v ?? ''};`;
                }
                this.splat?.setFxParams([['ssFxTime', tf / Math.max(1, s0.playbackFps)]]);
                if (this.sequenceSource) {
                    const idx = Math.max(0, Math.min(this.sequenceSource.count - 1, Math.round(tf)));
                    if (idx !== this.sequenceFrame) await this.showSequenceFrame(idx);
                }

                const sortSig = `${pose ? pose.position.join(',') + pose.target.join(',') : 'static'}|${explodeAmt ?? ''}|${fxSig}|${this.sequenceFrame}|${mp ? mp.position.join(',') : ''}`;
                if (sortSig !== lastSortSig) {
                    await sortAndWait();
                    lastSortSig = sortSig;
                }
                stepFrame();

                await colorBuffer.read(0, 0, width, height, { renderTarget: rt, data });

                // flip rows: GPU readback has 0,0 at the bottom
                for (let y = 0; y < height >> 1; ++y) {
                    const top = y * width * 4;
                    const bottom = (height - y - 1) * width * 4;
                    line.set(data.subarray(top, top + width * 4));
                    data.copyWithin(top, bottom, bottom + width * 4);
                    data.set(line, bottom);
                }

                const frame = new VideoFrame(data, {
                    format: 'RGBA',
                    codedWidth: width,
                    codedHeight: height,
                    timestamp: Math.round((i * 1e6) / fps),
                    duration: Math.round(1e6 / fps)
                });
                encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
                frame.close();

                // backpressure
                while (encoder.encodeQueueSize > 4) {
                    await new Promise(r => setTimeout(r, 5));
                }

                const elapsed = performance.now() - started;
                setState({
                    renderProgress: {
                        frame: i + 1,
                        total: outFrames,
                        etaMs: (elapsed / (i + 1)) * (outFrames - i - 1),
                        bytes: 0
                    }
                });
            }

            if (!this.renderCancelled) {
                await encoder.flush();
                await muxerWrites;
                if (muxerError) throw muxerError;
                await output.finalize();
                const buffer = target.buffer;
                if (!buffer) throw new Error('Video muxing produced no output');

                const blob = new Blob([buffer], { type: 'video/mp4' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = (fileName?.trim().replace(/\.mp4$/i, '') || this.outputBaseName() + '-render') + '.mp4';
                a.click();
                URL.revokeObjectURL(url);
            } else {
                try {
                    encoder.close();
                } catch { /* already closed */ }
            }
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
        } finally {
            shot.camera.renderTarget = null as unknown as RenderTarget;
            shot.camera.enabled = false;
            mainCam.enabled = true;
            rt.destroy();
            colorBuffer.destroy();

            setState({ renderProgress: null, showGrid: saved.grid, showCameraViz: saved.viz, showSelectionTint: saved.tint });
            this.splat?.setSelectionTint(saved.tint);
            this.setShowGizmos(saved.gizmos);
            this.applyFrame(this.playFrame);
        }
    }

    async exportSplat(opts: ExportOptions, format: ExportFormat = 'ply', fileName?: string) {
        const { splat } = this;
        if (!splat) return;
        setState({ busy: `Exporting ${format}…` });
        try {
            const bake = splat.hasTransforms
                ? { indices: splat.transformIndices, getMatrix: (i: number, out: Mat4) => splat.transformPalette.getTransform(i, out) }
                : undefined;
            const blob = await buildExportBlob(splat.splatData, splat.state.data, opts, format, bake);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const ext = EXPORT_EXTENSIONS[format];
            const base = fileName?.trim() || this.outputBaseName();
            a.download = (base.toLowerCase().endsWith(ext) ? base.slice(0, -ext.length) : base) + ext;
            a.click();
            URL.revokeObjectURL(url);
            setState({ exportOpen: false });
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
        } finally {
            setState({ busy: null });
        }
    }
}

export const scene = new SceneManager();

// -- deterministic command API ------------------------------------------
// Every UI action routes through here so an agent (or script) can drive
// the editor with inspectable commands.

type CommandFn = (params?: Record<string, unknown>) => void;

const commandTable: Record<string, CommandFn> = {
    'select.all': () => scene.selectAll(),
    'select.none': () => scene.selectNone(),
    'select.invert': () => scene.selectInvert(),
    'select.delete': () => scene.deleteSelection(),
    'select.rect': (p) => {
        const { x0, y0, x1, y1, canvasW, canvasH, mode } = p as {
            x0: number; y0: number; x1: number; y1: number;
            canvasW: number; canvasH: number; mode?: SelectMode;
        };
        scene.selectRect(x0, y0, x1, y1, canvasW, canvasH, mode ?? 'set');
    },
    'edit.undo': () => scene.undo(),
    'edit.redo': () => scene.redo(),
    'camera.frameScene': () => scene.frameScene(),
    'camera.frameSelection': () => scene.frameSelection(),
    'camera.reset': () => scene.resetCamera(),
    'tool.set': (p) => scene.setActiveTool((p as { tool: Tool }).tool),
    'select.byMask': (p) => {
        const { mask, canvasW, canvasH, mode, source } = p as {
            mask: Uint8Array; canvasW: number; canvasH: number; mode?: SelectMode; source?: string;
        };
        scene.selectByMask(mask, canvasW, canvasH, mode ?? 'set', source ?? 'mask');
    },
    'select.crop': () => scene.cropToSelection(),
    'layer.create': (p) => scene.createLayer((p as { name?: string } | undefined)?.name),
    'layer.assign': (p) => scene.assignSelectionToLayer((p as { layerId: number }).layerId),
    'layer.delete': (p) => scene.deleteLayer((p as { layerId: number }).layerId),
    'layer.rename': (p) => {
        const { layerId, name } = p as { layerId: number; name: string };
        scene.renameLayer(layerId, name);
    },
    'layer.setVisible': (p) => {
        const { layerId, visible } = p as { layerId: number; visible: boolean };
        scene.setLayerVisible(layerId, visible);
    },
    'layer.setLocked': (p) => {
        const { layerId, locked } = p as { layerId: number; locked: boolean };
        scene.setLayerLocked(layerId, locked);
    },
    'layer.select': (p) => scene.selectLayerMembers((p as { layerId: number }).layerId),
    'model.setRotation': (p) => {
        const { x, y, z } = p as { x: number; y: number; z: number };
        scene.setModelRotation(x, y, z);
    },
    'model.setScale': (p) => scene.setModelScale((p as { scale: number }).scale),
    'project.save': (p) => scene.saveProject((p as { name?: string } | undefined)?.name),
    'project.saveOpen': () => {
        if (getState().stats) setState({ saveOpen: true });
    },
    'project.saveClose': () => setState({ saveOpen: false }),
    'modifier.add': (p) => scene.addModifier((p as { type: ModifierType }).type),
    'modifier.remove': (p) => scene.removeModifier((p as { id: number }).id),
    'modifier.setEnabled': (p) => {
        const { id, enabled } = p as { id: number; enabled: boolean };
        scene.setModifierEnabled(id, enabled);
    },
    'modifier.setParam': (p) => {
        const { id, key, value } = p as { id: number; key: string; value: number };
        scene.setModifierParam(id, key, value);
    },
    'modifier.move': (p) => {
        const { id, dir } = p as { id: number; dir: -1 | 1 };
        scene.moveModifier(id, dir);
    },
    'modifiers.bake': () => scene.bakeModifiers(),
    'selection.transform': (p) => scene.transformSelection((p ?? {}) as {
        translate?: [number, number, number]; rotate?: [number, number, number]; scale?: number;
    }),
    'view.setMode': (p) => scene.setViewMode((p as { mode: ViewMode }).mode),
    'view.perfHud': () => setState({ perfHudVisible: !getState().perfHudVisible }),
    'view.timeline': () => setState({ timelineVisible: !getState().timelineVisible }),
    'camera.saveView': (p) => scene.addCameraFromView((p as { name?: string } | undefined)?.name),
    'camera.rename': (p) => {
        const { id, name } = p as { id: number; name: string };
        scene.renameCamera(id, name);
    },
    'camera.remove': (p) => scene.deleteCamera((p as { id: number }).id),
    'camera.goto': (p) => scene.gotoCamera((p as { id: number }).id),
    'timeline.play': () => scene.setPlaying(true),
    'timeline.pause': () => scene.setPlaying(false),
    'timeline.togglePlay': () => scene.setPlaying(!getState().playing),
    'timeline.setFrame': (p) => scene.setFrame((p as { frame: number }).frame),
    'timeline.prev': () => scene.stepFrame(-1),
    'timeline.next': () => scene.stepFrame(1),
    'timeline.setFps': (p) => setState({ playbackFps: (p as { fps: number }).fps }),
    'timeline.setLoop': (p) => setState({ loopMode: (p as { mode: LoopMode }).mode }),
    'track.addKey': () => scene.addCameraKey(),
    'track.removeKey': (p) => scene.removeCameraKey((p as { frame?: number } | undefined)?.frame),
    'track.setInterpolation': (p) => scene.setInterpolation((p as { mode: Interpolation }).mode),
    'track.model.addKey': () => scene.addModelKey(),
    'track.model.removeKey': (p) => scene.removeModelKey((p as { frame?: number } | undefined)?.frame),
    'track.explode.addKey': () => scene.addExplodeKey(),
    'track.explode.removeKey': (p) => scene.removeExplodeKey((p as { frame?: number } | undefined)?.frame),
    'explode.setAmount': (p) => scene.setExplodeAmount((p as { amount: number }).amount),
    'explode.setParam': (p) => {
        const { param, value } = p as { param: 'seed' | 'turbulence' | 'swirl' | 'gravity' | 'spread'; value: number };
        scene.setExplodeParam(param, value);
    },
    'explode.reseed': () => scene.reseedExplode(),
    'explode.enable': (p) => scene.setExplodeEnabled((p as { on: boolean } | undefined)?.on !== false),
    'fx.enable': (p) => {
        const { id, on } = p as { id: FxId; on?: boolean };
        scene.setFxEnabled(id, on !== false);
    },
    'fx.setAmount': (p) => {
        const { id, amount } = p as { id: FxId; amount: number };
        scene.setFxAmount(id, amount);
    },
    'fx.setParam': (p) => {
        const { id, key, value } = p as { id: FxId; key: string; value: number };
        scene.setFxParam(id, key, value);
    },
    'track.fx.addKey': (p) => scene.addFxKey((p as { id: FxId }).id),
    'track.fx.removeKey': (p) => {
        const { id, frame } = p as { id: FxId; frame?: number };
        scene.removeFxKey(id, frame);
    },
    'camera.setAim': (p) => scene.setCameraAim((p as { aim: CameraAim }).aim),
    'light.add': () => scene.addLight(),
    'light.remove': (p) => scene.removeLight((p as { id: number }).id),
    'light.set': (p) => {
        const { id, ...patch } = p as { id: number; position?: [number, number, number]; color?: string; intensity?: number };
        scene.setLight(id, patch);
    },
    'light.ambient': (p) => scene.setLightAmbient((p as { value: number }).value),
    'light.select': (p) => scene.setActiveLight((p as { id: number | null }).id),
    'model.setVisible': (p) => scene.setModelVisible((p as { visible: boolean }).visible),
    'canvas.setColor': (p) => scene.setCanvasColor((p as { color: string }).color),
    'track.moveKey': (p) => {
        const { track, from, to } = p as { track: TrackId; from: number; to: number };
        scene.moveTrackKey(track, from, to);
    },
    'track.selectKey': (p) => {
        const { track, frame } = p as { track: TrackId; frame: number };
        scene.selectTrackKey(track, frame);
    },
    'timeline.setDuration': (p) => scene.setDuration((p as { frames: number }).frames),
    'track.clear': (p) => scene.clearTrack((p as { track: 'camera' | 'model' }).track),
    'camera.setFov': (p) => scene.setFov((p as { fov: number }).fov),
    'timeline.expand': () => setState({ timelineExpanded: !getState().timelineExpanded }),
    'view.lookThrough': () => scene.setLookThrough(!getState().lookThrough),
    'view.grid': () => setState({ showGrid: !getState().showGrid }),
    'view.groundPlane': () => scene.setShowGroundPlane(!getState().showGroundPlane),
    'view.cameraViz': () => setState({ showCameraViz: !getState().showCameraViz }),
    'view.gizmos': () => scene.setShowGizmos(!getState().showGizmos),
    'view.selectionTint': () => scene.setShowSelectionTint(!getState().showSelectionTint),
    'view.overlays': () => scene.toggleOverlays(),
    'mode.set': (p) => scene.setMode((p as { mode: WorkspaceMode }).mode),
    'render.open': () => setState({ renderOpen: true }),
    'render.close': () => setState({ renderOpen: false, renderAspect: null }),
    'render.start': (p) => {
        const { width, height, fps, bitrate, name } = p as { width: number; height: number; fps: number; bitrate: number; name?: string };
        void scene.renderVideo({ width, height, fps, bitrate }, name);
    },
    'render.setSize': (p) => {
        const { width, height } = p as { width: number; height: number };
        scene.setRenderSize(width, height);
    },
    'stage.select': (p) => scene.selectStageObject((p as { selection: StageSelection | null }).selection),
    'stage.setLocked': (p) => {
        const { selection, locked } = p as { selection: StageSelection; locked: boolean };
        scene.setStageLocked(selection, locked);
    },
    'view.fieldScale': (p) => scene.setViewFieldScale((p as { scale: number | null }).scale),
    'stage.pick': (p) => {
        const { x, y, canvasW, canvasH } = p as { x: number; y: number; canvasW: number; canvasH: number };
        scene.pickStageObject(x, y, canvasW, canvasH);
    },
    'render.cancel': () => scene.cancelRender(),
    'export.open': () => setState({ exportOpen: true }),
    'export.close': () => setState({ exportOpen: false }),
    'export.splat': (p) => {
        const { selectedOnly, visibleOnly, applyModifiers, format, name } = (p ?? {}) as Partial<ExportOptions> & { format?: ExportFormat; name?: string };
        void scene.exportSplat({
            selectedOnly: !!selectedOnly,
            visibleOnly: !!visibleOnly,
            applyModifiers: applyModifiers !== false
        }, format ?? 'ply', name);
    },
    'model.setOffset': (p) => {
        const { x, y, z } = p as { x: number; y: number; z: number };
        scene.setModelOffset(x, y, z);
    },
    'model.setOrigin': (p) => {
        const { x, y, z } = p as { x: number; y: number; z: number };
        scene.setOriginPoint(x, y, z);
    },
    'model.originFromSelection': () => scene.originFromSelection(),
    'model.resetOrigin': () => scene.resetOrigin(),
    'origin.pickStart': () => setState({ pickingOrigin: true }),
    'origin.pickCancel': () => setState({ pickingOrigin: false }),
    'origin.pickAt': (p) => {
        const { x, y, canvasW, canvasH } = p as { x: number; y: number; canvasW: number; canvasH: number };
        if (scene.pickOriginAt(x, y, canvasW, canvasH)) {
            setState({ pickingOrigin: false });
        }
    },
    'scene.close': () => {
        scene.closeScene();
        setState({ screen: 'start' });
    }
};

export const runCommand = (name: string, params?: Record<string, unknown>) => {
    const fn = commandTable[name];
    if (!fn) throw new Error(`Unknown command: ${name}`);
    fn(params);
};

export const listCommands = () => Object.keys(commandTable);

// expose for debugging and future agent control
declare global {
    interface Window {
        studio: { run: typeof runCommand; list: typeof listCommands; scene: SceneManager; state: typeof getState };
    }
}
window.studio = { run: runCommand, list: listCommands, scene, state: getState };
