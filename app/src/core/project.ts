/**
 * .splatstudio project file: JSON that references the source splat file
 * rather than duplicating it. Stores model placement, layers, per-splat
 * layer membership, deleted-splat ranges and the camera pose.
 */

import type { CameraKey, Interpolation } from './camera-track';
import type { Modifier } from './modifiers';
import type { LayerInfo, SavedCamera } from './store';
import type { TransformKey } from './transform-track';

export const PROJECT_EXTENSION = '.splatstudio';

export const isProjectFilename = (name: string) => name.toLowerCase().endsWith(PROJECT_EXTENSION);

export interface ProjectFile {
    version: 1;
    source: { name: string; size: number };
    model: {
        offset: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
    };
    camera: {
        azim: number;
        elev: number;
        distance: number;
        target: [number, number, number];
    };
    layers: Omit<LayerInfo, 'count'>[];
    /** base64 Uint8Array of per-splat layer ids; absent when all zero */
    layerIds?: string;
    /** [lo, hi) index pairs of deleted splats */
    deleted?: [number, number][];
    /** non-destructive modifier stack */
    modifiers?: Modifier[];
    /** per-selection transforms: palette matrices (12 floats each, entries 1..count) + base64 u16 indices */
    transforms?: { indices: string; palette: number[]; count: number };
    /** saved viewpoints */
    savedCameras?: SavedCamera[];
    /** camera animation track */
    cameraTrack?: { keys: CameraKey[]; interpolation: Interpolation; fps: number; loop: string };
    /** model transform animation track */
    modelTrack?: { keys: TransformKey[] };
    /** explode effect: amount keyframes + scatter character */
    explode?: {
        keys: { frame: number; value: number }[];
        mode?: string; // legacy, ignored
        seed?: number;
        turbulence?: number;
        swirl?: number;
        gravity?: number;
        spread?: number;
    };
    /** shot camera aim mode */
    cameraAim?: string;
    /** point lights + ambient level */
    lights?: { id: number; position: [number, number, number]; color: string; intensity: number }[];
    lightingAmbient?: number;
    /** viewport / render background color */
    canvasColor?: string;
    /** user-set timeline length in frames */
    timelineDuration?: number;
    /** MP4 output frame size [width, height] */
    renderSize?: [number, number];
    /** stylized effects (peel / dissolve / jitter / wave / twist), enabled ones only */
    fxEffects?: Record<string, {
        amount: number;
        params: Record<string, number>;
        keys: { frame: number; value: number }[];
    }>;
}

// -- helpers ----------------------------------------------------------------

export const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
};

export const base64ToBytes = (b64: string): Uint8Array => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

/** RLE-encode the indices where (state[i] & bit) is set, as [lo, hi) pairs. */
export const rleFromStateBit = (state: Uint8Array, bit: number): [number, number][] => {
    const pairs: [number, number][] = [];
    let lo = -1;
    for (let i = 0; i < state.length; ++i) {
        if (state[i] & bit) {
            if (lo < 0) lo = i;
        } else if (lo >= 0) {
            pairs.push([lo, i]);
            lo = -1;
        }
    }
    if (lo >= 0) pairs.push([lo, state.length]);
    return pairs;
};

export const parseProject = (text: string): ProjectFile => {
    const json = JSON.parse(text) as ProjectFile;
    if (json.version !== 1) {
        throw new Error(`Unsupported project version: ${(json as { version: unknown }).version}`);
    }
    if (!json.source?.name || !json.model || !json.layers) {
        throw new Error('Not a valid .splatstudio project file');
    }
    return json;
};

export const downloadProject = (project: ProjectFile, fileName: string) => {
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
};
