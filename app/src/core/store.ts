import { useSyncExternalStore } from 'react';

import type { Interpolation } from './camera-track';
import { defaultFxState, type FxId, type FxState } from './fx';
import type { Modifier } from './modifiers';

export type ViewMode = 'beauty' | 'opacity' | 'depth' | 'selected';
export type LoopMode = 'loop' | 'once' | 'pingpong';
export type WorkspaceMode = 'edit' | 'training' | 'animation';
export type TrackId = 'camera' | 'model' | 'explode' | FxId;
export type CameraAim = 'free' | 'track';

export interface LightInfo {
    id: number;
    /** model-space position */
    position: [number, number, number];
    /** hex color, e.g. #ffd9a0 */
    color: string;
    intensity: number;
    /** stage visibility (default true): hidden lights stop illuminating */
    visible?: boolean;
    /** locked layers can't be selected or manipulated */
    locked?: boolean;
}

export interface SavedCamera {
    id: number;
    name: string;
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
}

export type Screen = 'start' | 'editor';
export type Tool = 'orbit' | 'drag' | 'rect-select' | 'brush' | 'lasso' | 'move' | 'rotate' | 'scale';

/** Directly selectable object on the animation stage. */
export type StageSelection =
    | { kind: 'model' }
    | { kind: 'camera' }
    | { kind: 'light'; lightId: number };

export interface LayerInfo {
    id: number;
    name: string;
    color: string;
    visible: boolean;
    locked: boolean;
    count: number;
}

export interface SceneStats {
    fileName: string;
    fileSize: number;
    totalSplats: number;
    deleted: number;
    selected: number;
    hidden: number;
    /** excluded by the modifier stack */
    filtered: number;
    /** model rotation (euler degrees) and uniform scale */
    rotation: [number, number, number];
    scale: number;
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
    /** model offset: local position of the splat entity (world translation) */
    offset: [number, number, number];
}

export interface AppState {
    screen: Screen;
    busy: string | null;
    error: string | null;
    tool: Tool;
    /** when true, the next viewport click picks the model origin point */
    pickingOrigin: boolean;
    /** brush tool radius in px */
    brushRadius: number;
    layers: LayerInfo[];
    modifiers: Modifier[];
    viewMode: ViewMode;
    exportOpen: boolean;
    /** workspace mode: contextual tools and panels */
    mode: 'edit' | 'training' | 'animation';
    /** which capture source the training workspace starts with */
    trainingSource: 'photos' | 'video';
    /** true while the training workspace holds frames or a running job */
    trainingActive: boolean;

    // cameras & timeline
    cameras: SavedCamera[];
    timelineVisible: boolean;
    playing: boolean;
    frame: number;
    totalFrames: number;
    playbackFps: number;
    loopMode: LoopMode;
    /** frames that carry camera keys (for scrubber markers) */
    cameraKeys: number[];
    /** frames that carry model transform keys */
    modelKeys: number[];
    /** frames that carry explode-amount keys */
    explodeKeys: number[];
    /** explode is opt-in: no lane or controls until the user adds the effect */
    explodeEnabled: boolean;
    /** live explode amount (driven by the track during scrub/playback) */
    explodeAmount: number;
    explodeSeed: number;
    explodeTurbulence: number;
    explodeSwirl: number;
    explodeGravity: number;
    explodeSpread: number;
    /** shot camera aim: keys' own targets, or always look at the model */
    cameraAim: CameraAim;

    /** stylized effects (peel / dissolve / jitter / wave / twist) */
    fx: Record<FxId, FxState>;
    /** frames carrying keys, per enabled effect */
    fxKeys: Partial<Record<FxId, number[]>>;

    /** point lights (empty = unlit passthrough) */
    lights: LightInfo[];
    lightingAmbient: number;
    /** stage object selected for on-canvas gizmo manipulation */
    stageSelection: StageSelection | null;
    /** model visibility on the animation stage */
    modelVisible: boolean;
    modelLocked: boolean;
    cameraLocked: boolean;
    /** viewport + render background color (hex) */
    canvasColor: string;
    selectedKey: { track: TrackId; frame: number } | null;
    timelineExpanded: boolean;
    /** user-set timeline length in frames (sequences override) */
    duration: number;
    interpolation: Interpolation;
    sequence: { name: string; count: number } | null;
    perfHudVisible: boolean;

    /** view through the animated shot camera vs detached director's view */
    lookThrough: boolean;
    showGrid: boolean;
    /** lit, shadow-catching floor plane at y=0 */
    showGroundPlane: boolean;
    showCameraViz: boolean;
    showGizmos: boolean;
    showSelectionTint: boolean;

    renderOpen: boolean;
    renderProgress: { frame: number; total: number; etaMs: number; bytes: number } | null;
    /** output aspect for the letterbox preview while the render dialog is open */
    renderAspect: number | null;
    /** MP4 output frame (view field) — drives the animation letterbox overlay */
    renderWidth: number;
    renderHeight: number;
    /** camera-view zoom: null = fit the viewport, 1 = 100% (1 output px : 1 screen px) */
    viewFieldScale: number | null;
    /** viewport banner while a Blender-style modal transform is active */
    modalHint: string | null;
    /** project save dialog (file name prompt) */
    saveOpen: boolean;
    /** set while a .splatstudio project waits for its source splat file */
    pendingProject: { fileName: string; sourceName: string; sourceSize: number } | null;
    device: string | null;
    fps: number;
    stats: SceneStats | null;
    canUndo: boolean;
    canRedo: boolean;
    leftPanelOpen: boolean;
    rightPanelOpen: boolean;
}

let state: AppState = {
    screen: 'start',
    busy: null,
    error: null,
    tool: 'orbit',
    pickingOrigin: false,
    brushRadius: 30,
    layers: [],
    modifiers: [],
    viewMode: 'beauty',
    exportOpen: false,
    mode: 'edit',
    trainingSource: 'photos',
    trainingActive: false,
    cameras: [],
    timelineVisible: false,
    playing: false,
    frame: 0,
    totalFrames: 240,
    playbackFps: 24,
    loopMode: 'loop',
    cameraKeys: [],
    modelKeys: [],
    explodeKeys: [],
    explodeEnabled: false,
    explodeAmount: 0,
    explodeSeed: 1,
    explodeTurbulence: 0,
    explodeSwirl: 0,
    explodeGravity: 0,
    explodeSpread: 0.5,
    cameraAim: 'free',
    fx: defaultFxState(),
    fxKeys: {},
    lights: [],
    lightingAmbient: 0.25,
    stageSelection: null,
    modelVisible: true,
    modelLocked: false,
    cameraLocked: false,
    canvasColor: '#0e0f11',
    selectedKey: null,
    timelineExpanded: true,
    duration: 240,
    interpolation: 'ease-in-out',
    sequence: null,
    perfHudVisible: false,
    lookThrough: true,
    showGrid: true,
    showGroundPlane: false,
    showCameraViz: true,
    showGizmos: true,
    showSelectionTint: true,
    renderOpen: false,
    renderProgress: null,
    renderAspect: null,
    renderWidth: 2560,
    renderHeight: 1440,
    viewFieldScale: null,
    modalHint: null,
    saveOpen: false,
    pendingProject: null,
    device: null,
    fps: 0,
    stats: null,
    canUndo: false,
    canRedo: false,
    leftPanelOpen: true,
    rightPanelOpen: true
};

const listeners = new Set<() => void>();

export const getState = () => state;

export const setState = (partial: Partial<AppState>) => {
    state = { ...state, ...partial };
    listeners.forEach(l => l());
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const useAppState = (): AppState => {
    return useSyncExternalStore(subscribe, getState);
};
