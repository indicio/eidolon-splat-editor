/**
 * Non-destructive modifier stack.
 *
 * Filter modifiers mark splats with the `filtered` state bit — recomputed
 * from scratch whenever the stack changes, so toggling/editing/removing a
 * modifier always restores exactly what the remaining stack dictates. The
 * color grade modifier drives shader uniforms instead of state bits.
 */

import { GSplatData } from 'playcanvas';

import { State } from './edit-ops';

export type ModifierType = 'opacity' | 'size' | 'floaters' | 'cropBox' | 'colorGrade';

export interface Modifier {
    id: number;
    type: ModifierType;
    enabled: boolean;
    params: Record<string, number>;
}

export const MODIFIER_LABELS: Record<ModifierType, string> = {
    opacity: 'Opacity filter',
    size: 'Size filter',
    floaters: 'Remove floaters',
    cropBox: 'Crop to content',
    colorGrade: 'Color grade'
};

/** Editable parameter definitions per modifier type (label, key, step). */
export const MODIFIER_PARAMS: Record<ModifierType, { key: string; label: string; step: number }[]> = {
    opacity: [{ key: 'minOpacity', label: 'Min opacity', step: 0.01 }],
    size: [
        { key: 'minSize', label: 'Min size', step: 0.001 },
        { key: 'maxSize', label: 'Max size', step: 0.05 }
    ],
    floaters: [
        { key: 'radius', label: 'Radius', step: 0.01 },
        { key: 'minNeighbors', label: 'Min neighbors', step: 1 }
    ],
    cropBox: [
        { key: 'minX', label: 'Min X', step: 0.1 }, { key: 'maxX', label: 'Max X', step: 0.1 },
        { key: 'minY', label: 'Min Y', step: 0.1 }, { key: 'maxY', label: 'Max Y', step: 0.1 },
        { key: 'minZ', label: 'Min Z', step: 0.1 }, { key: 'maxZ', label: 'Max Z', step: 0.1 }
    ],
    colorGrade: [
        { key: 'exposure', label: 'Exposure', step: 0.05 },
        { key: 'brightness', label: 'Brightness', step: 0.02 },
        { key: 'saturation', label: 'Saturation', step: 0.05 },
        { key: 'transparency', label: 'Transparency', step: 0.05 }
    ]
};

const logit = (p: number) => Math.log(p / (1 - p));

/**
 * Percentile bounding box of non-deleted splat centers (data space),
 * expanded around its center. Basis for the crop-to-content modifier.
 */
export const percentileBounds = (gsplatData: GSplatData, state: Uint8Array, expand = 1.2) => {
    const x = gsplatData.getProp('x') as Float32Array;
    const y = gsplatData.getProp('y') as Float32Array;
    const z = gsplatData.getProp('z') as Float32Array;
    const n = gsplatData.numSplats;

    // sample to bound sort cost on huge scenes
    const stride = Math.max(1, Math.floor(n / 100_000));
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < n; i += stride) {
        if (state[i] & State.deleted) continue;
        xs.push(x[i]);
        ys.push(y[i]);
        zs.push(z[i]);
    }
    const pct = (arr: number[], p: number) => {
        const sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    };
    const box = (arr: number[]): [number, number] => {
        const lo = pct(arr, 0.02);
        const hi = pct(arr, 0.98);
        const c = (lo + hi) / 2;
        const half = ((hi - lo) / 2) * expand;
        return [c - half, c + half];
    };
    const [minX, maxX] = box(xs);
    const [minY, maxY] = box(ys);
    const [minZ, maxZ] = box(zs);
    return { minX, maxX, minY, maxY, minZ, maxZ };
};

/** Neighbor counts on a uniform spatial hash grid (cell size = radius). */
const countNeighbors = (x: Float32Array, y: Float32Array, z: Float32Array, n: number, radius: number): Uint16Array => {
    const inv = 1 / radius;
    const r2 = radius * radius;

    const cellKey = (cx: number, cy: number, cz: number) =>
        ((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) >>> 0;

    const grid = new Map<number, number[]>();
    for (let i = 0; i < n; ++i) {
        const key = cellKey(Math.floor(x[i] * inv), Math.floor(y[i] * inv), Math.floor(z[i] * inv));
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
    }

    const counts = new Uint16Array(n);
    for (let i = 0; i < n; ++i) {
        const cx = Math.floor(x[i] * inv), cy = Math.floor(y[i] * inv), cz = Math.floor(z[i] * inv);
        let count = 0;
        for (let dx = -1; dx <= 1; ++dx) {
            for (let dy = -1; dy <= 1; ++dy) {
                for (let dz = -1; dz <= 1; ++dz) {
                    const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
                    if (!bucket) continue;
                    for (const j of bucket) {
                        if (j === i) continue;
                        const ddx = x[j] - x[i], ddy = y[j] - y[i], ddz = z[j] - z[i];
                        if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) {
                            if (++count >= 65535) break;
                        }
                    }
                }
            }
        }
        counts[i] = count;
    }
    return counts;
};

/**
 * Evaluate all enabled filter modifiers. Returns a 0/1 mask of splats to
 * exclude, or null when no filter modifier is enabled.
 */
export const evaluateFilters = (gsplatData: GSplatData, _state: Uint8Array, modifiers: Modifier[]): Uint8Array | null => {
    const filters = modifiers.filter(m => m.enabled && m.type !== 'colorGrade');
    if (filters.length === 0) return null;

    const n = gsplatData.numSplats;
    const mask = new Uint8Array(n);

    for (const mod of filters) {
        const p = mod.params;
        if (mod.type === 'opacity') {
            const opacity = gsplatData.getProp('opacity') as Float32Array;
            const thr = logit(Math.min(0.999, Math.max(0.001, p.minOpacity)));
            for (let i = 0; i < n; ++i) {
                if (opacity[i] < thr) mask[i] = 1;
            }
        } else if (mod.type === 'size') {
            const s0 = gsplatData.getProp('scale_0') as Float32Array;
            const s1 = gsplatData.getProp('scale_1') as Float32Array;
            const s2 = gsplatData.getProp('scale_2') as Float32Array;
            const lnMin = Math.log(Math.max(p.minSize, 1e-9));
            const lnMax = Math.log(Math.max(p.maxSize, 1e-9));
            for (let i = 0; i < n; ++i) {
                const s = Math.max(s0[i], s1[i], s2[i]);
                if (s < lnMin || s > lnMax) mask[i] = 1;
            }
        } else if (mod.type === 'cropBox') {
            const x = gsplatData.getProp('x') as Float32Array;
            const y = gsplatData.getProp('y') as Float32Array;
            const z = gsplatData.getProp('z') as Float32Array;
            for (let i = 0; i < n; ++i) {
                if (x[i] < p.minX || x[i] > p.maxX ||
                    y[i] < p.minY || y[i] > p.maxY ||
                    z[i] < p.minZ || z[i] > p.maxZ) mask[i] = 1;
            }
        } else if (mod.type === 'floaters') {
            const x = gsplatData.getProp('x') as Float32Array;
            const y = gsplatData.getProp('y') as Float32Array;
            const z = gsplatData.getProp('z') as Float32Array;
            const counts = countNeighbors(x, y, z, n, Math.max(p.radius, 1e-6));
            for (let i = 0; i < n; ++i) {
                if (counts[i] < p.minNeighbors) mask[i] = 1;
            }
        }
    }

    // never filter manually deleted splats' bits ambiguously; deleted wins anyway
    return mask;
};

/** Default parameters when adding a modifier; cropBox is filled by the caller. */
export const defaultParams = (type: ModifierType): Record<string, number> => {
    switch (type) {
        case 'opacity': return { minOpacity: 0.05 };
        case 'size': return { minSize: 0.0002, maxSize: 0.5 };
        case 'floaters': return { radius: 0.05, minNeighbors: 3 };
        case 'cropBox': return { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 };
        case 'colorGrade': return { exposure: 1, brightness: 0, saturation: 1, transparency: 1 };
    }
};
