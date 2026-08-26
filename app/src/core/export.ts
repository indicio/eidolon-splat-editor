/**
 * Splat export: PLY (own chunked writer), compressed PLY and bundled SOG
 * (via @playcanvas/splat-transform writers into a MemoryFileSystem).
 *
 * Per-selection palette transforms are baked into positions/rotations/
 * scales on the way out (SH coefficients are not rotated — a known
 * limitation until the SuperSplat SHRotation port).
 */

import {
    Column,
    DataTable,
    MemoryFileSystem,
    writeFile,
    type OutputFormat
} from '@playcanvas/splat-transform';
import { GSplatData, Mat3, Mat4, Quat, Vec3 } from 'playcanvas';

import { State } from './edit-ops';
import { SHRotation } from './sh-utils';

export type ExportFormat = 'ply' | 'compressed-ply' | 'sog';

export interface ExportOptions {
    selectedOnly: boolean;
    visibleOnly: boolean;
    /** exclude splats removed by the modifier stack */
    applyModifiers: boolean;
}

export interface TransformBake {
    indices: Uint16Array;
    getMatrix: (index: number, out: Mat4) => void;
}

interface PlyProp {
    name: string;
    storage: ArrayLike<number>;
}

const exportableProps = (gsplatData: GSplatData): PlyProp[] => {
    const props = gsplatData.getElement('vertex').properties as { name: string; storage: ArrayLike<number> }[];
    return props.filter(p => p.name !== 'state' && p.name !== 'transform');
};

const skipMaskFor = (opts: ExportOptions) =>
    State.deleted |
    (opts.applyModifiers ? State.filtered : 0) |
    (opts.visibleOnly ? State.hidden : 0);

export const countExportSplats = (state: Uint8Array, opts: ExportOptions): number => {
    const skip = skipMaskFor(opts);
    let count = 0;
    for (let i = 0; i < state.length; ++i) {
        if (state[i] & skip) continue;
        if (opts.selectedOnly && !(state[i] & State.selected)) continue;
        count++;
    }
    return count;
};

export const estimateSize = (gsplatData: GSplatData, count: number, format: ExportFormat): number => {
    const raw = count * exportableProps(gsplatData).length * 4 + 300;
    // rough empirical ratios for the compressed formats
    if (format === 'compressed-ply') return Math.round(raw * 0.25);
    if (format === 'sog') return Math.round(raw * 0.1);
    return raw;
};

/** Decomposed per-palette-entry bake data, cached per unique index. */
interface BakeEntry {
    mat: Mat4;
    rot: Quat;
    logScale: number;
    shRot: SHRotation;
}

const buildBakeCache = (bake: TransformBake) => {
    const cache = new Map<number, BakeEntry>();
    const cols = [new Vec3(), new Vec3(), new Vec3()];
    return (index: number): BakeEntry => {
        let entry = cache.get(index);
        if (!entry) {
            const mat = new Mat4();
            bake.getMatrix(index, mat);
            const d = mat.data;
            cols[0].set(d[0], d[1], d[2]);
            cols[1].set(d[4], d[5], d[6]);
            cols[2].set(d[8], d[9], d[10]);
            const sx = cols[0].length(), sy = cols[1].length(), sz = cols[2].length();
            // uniform-scale approximation for gaussian axis scales
            const logScale = Math.log(Math.cbrt(Math.max(sx * sy * sz, 1e-20)));
            const rotMat = new Mat4();
            rotMat.data.set([
                d[0] / sx, d[1] / sx, d[2] / sx, 0,
                d[4] / sy, d[5] / sy, d[6] / sy, 0,
                d[8] / sz, d[9] / sz, d[10] / sz, 0,
                0, 0, 0, 1
            ]);
            const rot = new Quat().setFromMat4(rotMat);
            const shRot = new SHRotation(new Mat3().setFromQuat(rot));
            entry = { mat, rot, logScale, shRot };
            cache.set(index, entry);
        }
        return entry;
    };
};

/**
 * Gather the export rows into per-property Float32Arrays, baking palette
 * transforms into x/y/z, rot_0..3 (w,x,y,z) and scale_0..2 (log sigma).
 */
const gatherColumns = (gsplatData: GSplatData, state: Uint8Array, opts: ExportOptions, bake?: TransformBake) => {
    const props = exportableProps(gsplatData);
    const count = countExportSplats(state, opts);
    const skip = skipMaskFor(opts);

    const arrays = props.map(() => new Float32Array(count));
    const propIndex = new Map(props.map((p, j) => [p.name, j]));
    const jx = propIndex.get('x')!, jy = propIndex.get('y')!, jz = propIndex.get('z')!;
    const jr = [propIndex.get('rot_0'), propIndex.get('rot_1'), propIndex.get('rot_2'), propIndex.get('rot_3')];
    const js = [propIndex.get('scale_0'), propIndex.get('scale_1'), propIndex.get('scale_2')];
    const canBakeRot = jr.every(j => j !== undefined);
    const canBakeScale = js.every(j => j !== undefined);

    // f_rest_* columns, channel-major (all R coeffs, then G, then B)
    const restIndices: number[] = [];
    for (let k = 0; ; ++k) {
        const j = propIndex.get(`f_rest_${k}`);
        if (j === undefined) break;
        restIndices.push(j);
    }
    const coeffsPerChannel = restIndices.length / 3;
    const canBakeSH = restIndices.length > 0 && restIndices.length % 3 === 0 && [3, 8, 15].includes(coeffsPerChannel);
    const shScratch = new Array<number>(coeffsPerChannel);

    const getBake = bake ? buildBakeCache(bake) : null;
    const v = new Vec3();

    let row = 0;
    for (let i = 0; i < state.length; ++i) {
        if (state[i] & skip) continue;
        if (opts.selectedOnly && !(state[i] & State.selected)) continue;

        for (let j = 0; j < props.length; ++j) {
            arrays[j][row] = props[j].storage[i] as number;
        }

        const tIdx = bake ? bake.indices[i] : 0;
        if (tIdx !== 0 && getBake) {
            const entry = getBake(tIdx);
            v.set(arrays[jx][row], arrays[jy][row], arrays[jz][row]);
            entry.mat.transformPoint(v, v);
            arrays[jx][row] = v.x;
            arrays[jy][row] = v.y;
            arrays[jz][row] = v.z;

            if (canBakeRot) {
                // ply quaternion order: rot_0 = w
                const qw = arrays[jr[0]!][row], qx = arrays[jr[1]!][row];
                const qy = arrays[jr[2]!][row], qz = arrays[jr[3]!][row];
                const d = entry.rot;
                arrays[jr[0]!][row] = d.w * qw - d.x * qx - d.y * qy - d.z * qz;
                arrays[jr[1]!][row] = d.w * qx + d.x * qw + d.y * qz - d.z * qy;
                arrays[jr[2]!][row] = d.w * qy - d.x * qz + d.y * qw + d.z * qx;
                arrays[jr[3]!][row] = d.w * qz + d.x * qy - d.y * qx + d.z * qw;
            }
            if (canBakeScale && entry.logScale !== 0) {
                arrays[js[0]!][row] += entry.logScale;
                arrays[js[1]!][row] += entry.logScale;
                arrays[js[2]!][row] += entry.logScale;
            }
            if (canBakeSH) {
                for (let c = 0; c < 3; ++c) {
                    for (let k = 0; k < coeffsPerChannel; ++k) {
                        shScratch[k] = arrays[restIndices[c * coeffsPerChannel + k]][row];
                    }
                    entry.shRot.apply(shScratch);
                    for (let k = 0; k < coeffsPerChannel; ++k) {
                        arrays[restIndices[c * coeffsPerChannel + k]][row] = shScratch[k];
                    }
                }
            }
        }
        row++;
    }

    return { props, arrays, count };
};

const buildRawPly = (props: PlyProp[], arrays: Float32Array[], count: number): Blob => {
    const header = [
        'ply',
        'format binary_little_endian 1.0',
        'comment generated by EiDOlON',
        `element vertex ${count}`,
        ...props.map(p => `property float ${p.name}`),
        'end_header',
        ''
    ].join('\n');

    // interleave column arrays into rows
    const numProps = props.length;
    const out = new Float32Array(count * numProps);
    for (let j = 0; j < numProps; ++j) {
        const col = arrays[j];
        for (let i = 0; i < count; ++i) {
            out[i * numProps + j] = col[i];
        }
    }
    return new Blob([new TextEncoder().encode(header), out.buffer], { type: 'application/octet-stream' });
};

const WRITE_OPTIONS = {
    iterations: 10,
    lodSelect: [],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

export const buildExportBlob = async (
    gsplatData: GSplatData,
    state: Uint8Array,
    opts: ExportOptions,
    format: ExportFormat,
    bake?: TransformBake
): Promise<Blob> => {
    const { props, arrays, count } = gatherColumns(gsplatData, state, opts, bake);

    if (format === 'ply') {
        return buildRawPly(props, arrays, count);
    }

    const table = new DataTable(props.map((p, j) => new Column(p.name, arrays[j])));
    const fs = new MemoryFileSystem();
    const filename = format === 'sog' ? 'out.sog' : 'out.ply';
    const outputFormat: OutputFormat = format === 'sog' ? 'sog-bundle' : 'compressed-ply';

    await writeFile({ filename, outputFormat, dataTable: table, options: WRITE_OPTIONS }, fs);

    const parts = [...fs.results.values()];
    if (parts.length === 0) throw new Error('Export produced no output');
    return new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
};

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
    ply: '-edit.ply',
    'compressed-ply': '-edit.compressed.ply',
    sog: '-edit.sog'
};
