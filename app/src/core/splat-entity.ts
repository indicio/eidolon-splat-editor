/**
 * SplatEntity — an editable gaussian splat in the scene.
 *
 * Adapted from PlayCanvas SuperSplat (MIT): src/splat.ts and
 * src/splat-state.ts. Owns the per-splat state byte (CPU array mirrored
 * to an R8 GPU texture), overrides the engine gsplat shader chunks to
 * discard deleted splats and tint selected ones, and rebuilds the sorter
 * mapping when splats are deleted.
 */

import {
    ADDRESS_CLAMP_TO_EDGE,
    Asset,
    BoundingBox,
    Entity,
    FILTER_NEAREST,
    GSplatData,
    GSplatResource,
    Mat4,
    PIXELFORMAT_R8,
    PIXELFORMAT_R16U,
    Quat,
    Texture,
    Vec3,
    type AppBase
} from 'playcanvas';

import { IndexRanges, State, type StateAccess } from './edit-ops';
import { FX_UNIFORM_DEFAULTS } from './fx';
import { centerGlsl, centerWgsl, modifyGlsl, modifyWgsl } from './shaders';
import { TransformPalette } from './transform-palette';

const tmpMat = new Mat4();
const tmpVec = new Vec3();
const identityMat16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Scatter-explode parameters (amount is the keyable one). */
export interface ExplodeParams {
    amount: number;
    seed: number;
    turbulence: number;
    swirl: number;
    gravity: number;
    spread: number;
}

/** CPU/GPU mirror of the per-splat state byte. */
class SplatState implements StateAccess {
    readonly data: Uint8Array;
    private gpu: Texture;
    private dirty = true;

    numSelected = 0;
    numLocked = 0;
    numDeleted = 0;
    numHidden = 0;
    numFiltered = 0;

    constructor(data: Uint8Array, gpu: Texture) {
        this.data = data;
        this.gpu = gpu;
    }

    /**
     * Replace the filtered bit across all splats from a 0/1 mask (or clear
     * it entirely when mask is null). Produced by the modifier stack.
     */
    applyFilterMask(mask: Uint8Array | null) {
        const { data } = this;
        const keep = ~State.filtered & 0xff;
        if (mask) {
            for (let i = 0; i < data.length; ++i) {
                data[i] = (data[i] & keep) | (mask[i] ? State.filtered : 0);
            }
        } else {
            for (let i = 0; i < data.length; ++i) {
                data[i] &= keep;
            }
        }
        this.dirty = true;
    }

    /**
     * Recompute the hidden/locked bits from layer membership. LUTs map
     * layer id -> bit value to apply.
     */
    applyLayerBits(layerIds: Uint8Array, hiddenLut: Uint8Array, lockedLut: Uint8Array) {
        const { data } = this;
        const keep = ~(State.hidden | State.locked) & 0xff;
        for (let i = 0; i < data.length; ++i) {
            const layer = layerIds[i];
            data[i] = (data[i] & keep) | hiddenLut[layer] | lockedLut[layer];
        }
        this.dirty = true;
    }

    setBits(ranges: IndexRanges, mask: number) {
        const { data } = this;
        ranges.forEach((i) => {
            data[i] |= mask;
        });
        this.dirty = true;
    }

    clearBits(ranges: IndexRanges, mask: number) {
        const { data } = this;
        ranges.forEach((i) => {
            data[i] &= ~mask;
        });
        this.dirty = true;
    }

    flush() {
        if (!this.dirty) return;
        const buffer = this.gpu.lock() as Uint8Array;
        buffer.set(this.data);
        this.gpu.unlock();

        const { data } = this;
        let numSelected = 0;
        let numLocked = 0;
        let numDeleted = 0;
        let numHidden = 0;
        let numFiltered = 0;
        for (let i = 0; i < data.length; ++i) {
            const s = data[i];
            if (s & State.deleted) numDeleted++;
            else if (s & State.filtered) numFiltered++;
            else if (s & State.hidden) numHidden++;
            else if (s & State.locked) numLocked++;
            else if (s & State.selected) numSelected++;
        }
        this.numSelected = numSelected;
        this.numLocked = numLocked;
        this.numDeleted = numDeleted;
        this.numHidden = numHidden;
        this.numFiltered = numFiltered;
        this.dirty = false;
    }
}

export class SplatEntity {
    entity: Entity;
    asset: Asset;
    splatData: GSplatData;
    state: SplatState;
    stateTexture: Texture;
    /** per-splat layer membership (0 = default layer) */
    layerIds: Uint8Array;
    /** per-splat index into the transform palette (0 = identity) */
    transformIndices: Uint16Array;
    transformTexture: Texture;
    transformPalette: TransformPalette;
    /** cached palette-transformed model-space positions (null = no transforms) */
    private positionsCache: { x: Float32Array; y: Float32Array; z: Float32Array } | null = null;
    fileName: string;
    fileSize: number;

    /** local-space bounds of the source data */
    localBound: BoundingBox;

    onStateChanged?: () => void;

    constructor(app: AppBase, gsplatData: GSplatData, fileName: string, fileSize: number, rotation?: Quat) {
        this.fileName = fileName;
        this.fileSize = fileSize;
        this.splatData = gsplatData;

        const device = app.graphicsDevice;

        // wrap the data in an engine asset + resource
        this.asset = new Asset(fileName, 'gsplat', { url: `local-${fileName}-${Math.floor(performance.now())}`, filename: fileName });
        app.assets.add(this.asset);
        const resource = new GSplatResource(device, gsplatData);
        this.asset.resource = resource;

        this.entity = new Entity(fileName);
        if (rotation) {
            this.entity.setLocalRotation(rotation);
        }
        this.entity.addComponent('gsplat', {
            asset: this.asset,
            unified: false
        });

        // per-splat edit state channel (bit 1 selected, bit 2 locked, bit 4 deleted)
        if (!gsplatData.getProp('state')) {
            gsplatData.getElement('vertex').properties.push({
                type: 'uchar',
                name: 'state',
                storage: new Uint8Array(gsplatData.numSplats),
                byteSize: 1
            });
        }

        // state texture dimensions must match the engine's splat data layout
        const { x: width, y: height } = (resource as unknown as { textureDimensions: { x: number; y: number } }).textureDimensions;
        this.stateTexture = new Texture(device, {
            name: 'splatState',
            width,
            height,
            format: PIXELFORMAT_R8,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.state = new SplatState(gsplatData.getProp('state') as Uint8Array, this.stateTexture);
        this.layerIds = new Uint8Array(gsplatData.numSplats);

        // per-splat transform palette channel
        this.transformIndices = new Uint16Array(gsplatData.numSplats);
        this.transformTexture = new Texture(device, {
            name: 'splatTransform',
            width,
            height,
            format: PIXELFORMAT_R16U,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.transformPalette = new TransformPalette(device);

        this.localBound = this.instance.resource.aabb.clone();

        this.rebuildMaterial();
        this.state.flush();
    }

    get instance() {
        return this.entity.gsplat!.instance!;
    }

    get numSplats() {
        return this.splatData.numSplats;
    }

    get numSelected() {
        return this.state.numSelected;
    }

    get numDeleted() {
        return this.state.numDeleted;
    }

    get numHidden() {
        return this.state.numHidden;
    }

    get numFiltered() {
        return this.state.numFiltered;
    }

    /** Replace the modifier-derived filtered bits (null clears them all). */
    applyFilterMask(mask: Uint8Array | null) {
        this.state.applyFilterMask(mask);
    }

    // -- per-selection transforms ------------------------------------------

    get hasTransforms() {
        return this.transformPalette.nextIndex > 1;
    }

    /** Upload the CPU index mirror to the GPU and re-bind palette texture (it can realloc). */
    syncTransformTexture() {
        const buffer = this.transformTexture.lock() as Uint16Array;
        buffer.set(this.transformIndices);
        this.transformTexture.unlock();
        this.instance.material.setParameter('transformPalette', this.transformPalette.texture);
    }

    /**
     * Effective model-space positions: raw source positions when no palette
     * transforms exist, otherwise the transformed cache. Used by CPU
     * selection/picking/bounds/export.
     */
    getPositions(): { x: Float32Array; y: Float32Array; z: Float32Array } {
        const raw = {
            x: this.splatData.getProp('x') as Float32Array,
            y: this.splatData.getProp('y') as Float32Array,
            z: this.splatData.getProp('z') as Float32Array
        };
        if (!this.hasTransforms) {
            this.positionsCache = null;
            return raw;
        }
        if (!this.positionsCache) {
            this.positionsCache = {
                x: new Float32Array(this.numSplats),
                y: new Float32Array(this.numSplats),
                z: new Float32Array(this.numSplats)
            };
            this.recomputePositions(raw);
        }
        return this.positionsCache;
    }

    /**
     * Rebuild the transformed-position cache and the sorter's center array.
     * Called after palette transforms change.
     */
    refreshPositions() {
        if (!this.hasTransforms) {
            this.positionsCache = null;
            return;
        }
        if (!this.positionsCache) {
            this.getPositions();
            return;
        }
        this.recomputePositions({
            x: this.splatData.getProp('x') as Float32Array,
            y: this.splatData.getProp('y') as Float32Array,
            z: this.splatData.getProp('z') as Float32Array
        });
    }

    private recomputePositions(raw: { x: Float32Array; y: Float32Array; z: Float32Array }) {
        const cache = this.positionsCache!;
        const { transformIndices, transformPalette } = this;
        const centers = this.instance.sorter?.centers as Float32Array | undefined;

        let currentIdx = -1;
        for (let i = 0; i < this.numSplats; ++i) {
            const idx = transformIndices[i];
            if (idx === 0) {
                cache.x[i] = raw.x[i];
                cache.y[i] = raw.y[i];
                cache.z[i] = raw.z[i];
            } else {
                if (idx !== currentIdx) {
                    transformPalette.getTransform(idx, tmpMat);
                    currentIdx = idx;
                }
                tmpVec.set(raw.x[i], raw.y[i], raw.z[i]);
                tmpMat.transformPoint(tmpVec, tmpVec);
                cache.x[i] = tmpVec.x;
                cache.y[i] = tmpVec.y;
                cache.z[i] = tmpVec.z;
            }
            if (centers) {
                centers[i * 3] = cache.x[i];
                centers[i * 3 + 1] = cache.y[i];
                centers[i * 3 + 2] = cache.z[i];
            }
        }
    }

    /** Re-sync hidden/locked state bits from layer visibility/lock flags. */
    syncLayerBits(layers: { id: number; visible: boolean; locked: boolean }[]) {
        const hiddenLut = new Uint8Array(256);
        const lockedLut = new Uint8Array(256);
        for (const l of layers) {
            if (!l.visible) hiddenLut[l.id] = State.hidden;
            if (l.locked) lockedLut[l.id] = State.locked;
        }
        this.state.applyLayerBits(this.layerIds, hiddenLut, lockedLut);
    }

    /** Count non-deleted members of each layer id. */
    countLayerMembers(): Map<number, number> {
        const counts = new Map<number, number>();
        const { layerIds } = this;
        const state = this.state.data;
        for (let i = 0; i < layerIds.length; ++i) {
            if (state[i] & State.deleted) continue;
            counts.set(layerIds[i], (counts.get(layerIds[i]) ?? 0) + 1);
        }
        return counts;
    }

    private rebuildMaterial() {
        const instance = this.instance;
        const { material } = instance;
        const { glsl, wgsl } = material.shaderChunks;
        glsl.set('gsplatModifyVS', modifyGlsl);
        glsl.set('gsplatCenterVS', centerGlsl);
        wgsl.set('gsplatModifyVS', modifyWgsl);
        wgsl.set('gsplatCenterVS', centerWgsl);

        material.setDefine('SH_BANDS', `${(instance.resource as GSplatResource).shBands}`);
        material.setParameter('splatState', this.stateTexture);
        material.setParameter('selectedClr', [0.88, 0.63, 0.24, 0.75]);
        material.setParameter('lockedClr', [0.4, 0.4, 0.45, 1.0]);
        material.setParameter('clrOffset', [0, 0, 0]);
        material.setParameter('clrScale', [1, 1, 1, 1]);
        material.setParameter('saturation', 1);
        material.setParameter('viewMode', 0);
        material.setParameter('depthRange', [0, 10]);
        material.setParameter('ssModelView', identityMat16);
        material.setParameter('ssExplodeAmount', 0);
        material.setParameter('ssExplodeCenter', [0, 0, 0]);
        material.setParameter('ssExplodeSeed', 1);
        material.setParameter('ssExplodeTurb', 0);
        material.setParameter('ssExplodeSwirl', 0);
        material.setParameter('ssExplodeGravity', 0);
        material.setParameter('ssExplodeSpread', 0.5);
        material.setParameter('ssLightCount', 0);
        material.setParameter('ssLightAmbient', 1);
        material.setParameter('ssLightPos[0]', new Float32Array(32));
        material.setParameter('ssLightColor[0]', new Float32Array(32));
        material.setParameter('ssLightPos', new Float32Array(32));
        material.setParameter('ssLightColor', new Float32Array(32));
        for (const [name, value] of FX_UNIFORM_DEFAULTS) {
            material.setParameter(name, value);
        }
        material.setParameter('splatTransform', this.transformTexture);
        material.setParameter('transformPalette', this.transformPalette.texture);
        material.update();
    }

    /** Appearance grade: exposure/brightness/saturation/transparency. */
    setColorGrade(g: { exposure: number; brightness: number; saturation: number; transparency: number }) {
        const { material } = this.instance;
        material.setParameter('clrOffset', [g.brightness, g.brightness, g.brightness]);
        material.setParameter('clrScale', [g.exposure, g.exposure, g.exposure, g.transparency]);
        material.setParameter('saturation', g.saturation);
    }

    setViewMode(mode: number) {
        this.instance.material.setParameter('viewMode', mode);
    }

    /**
     * Point lights: flat vec4 arrays (pos.xyz / color.rgb + intensity in a),
     * model-space positions. Both GLSL ('name[0]') and WGSL ('name') uniform
     * ids are set so either backend picks them up.
     */
    setLights(positions: Float32Array, colors: Float32Array, count: number, ambient: number) {
        const { material } = this.instance;
        material.setParameter('ssLightCount', count);
        material.setParameter('ssLightAmbient', count > 0 ? ambient : 1);
        material.setParameter('ssLightPos[0]', positions);
        material.setParameter('ssLightColor[0]', colors);
        material.setParameter('ssLightPos', positions);
        material.setParameter('ssLightColor', colors);
    }

    /** Toggle the amber selection tint (overlay control / clean render). */
    setSelectionTint(on: boolean) {
        this.instance.material.setParameter('selectedClr', [0.88, 0.63, 0.24, on ? 0.75 : 0]);
    }

    // -- stylized effects -------------------------------------------------------

    /** Push shader uniforms for the effect system (names from fx.ts). */
    setFxParams(entries: [string, number | number[]][]) {
        const { material } = this.instance;
        for (const [name, value] of entries) {
            material.setParameter(name, value);
        }
    }

    // -- explode effect -------------------------------------------------------

    /** Drive the shader-side scatter displacement. */
    setExplode(p: ExplodeParams, center: Vec3) {
        const { material } = this.instance;
        material.setParameter('ssExplodeAmount', p.amount);
        material.setParameter('ssExplodeCenter', [center.x, center.y, center.z]);
        material.setParameter('ssExplodeSeed', p.seed);
        material.setParameter('ssExplodeTurb', p.turbulence);
        material.setParameter('ssExplodeSwirl', p.swirl);
        material.setParameter('ssExplodeGravity', p.gravity);
        material.setParameter('ssExplodeSpread', p.spread);
    }

    /** CPU mirror of the shader hash — must match ssHash in shaders.ts. */
    private static explodeHash(nIn: number): number {
        let n = ((nIn ^ 61) ^ (nIn >>> 16)) >>> 0;
        n = Math.imul(n, 9) >>> 0;
        n = (n ^ (n >>> 4)) >>> 0;
        n = Math.imul(n, 668265261) >>> 0;
        n = (n ^ (n >>> 15)) >>> 0;
        return (n & 0xffff) / 65535;
    }

    /**
     * Write scatter-displaced centers into the sorter so depth ordering
     * matches the displaced rendering (mirrors modifySplatCenter exactly).
     */
    applyExplodeToSortCenters(p: ExplodeParams, center: Vec3) {
        const centers = this.instance.sorter?.centers as Float32Array | undefined;
        if (!centers) return;
        const { x, y, z } = this.getPositions();
        const hash = SplatEntity.explodeHash;
        const amt = p.amount;
        const seedBase = (Math.trunc(p.seed) * 7919) >>> 0;

        for (let i = 0; i < this.numSplats; ++i) {
            let px = x[i], py = y[i], pz = z[i];
            if (amt > 0.0001) {
                const dx = px - center.x, dy = py - center.y, dz = pz - center.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const si = ((i * 3) + seedBase) >>> 0;

                let rx = hash(si + 1) * 2 - 1 + 0.0001;
                let ry = hash(si + 2) * 2 - 1 + 0.0001;
                let rz = hash(si + 3) * 2 - 1 + 0.0001;
                const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
                rx /= len; ry /= len; rz /= len;
                const speed = Math.max(0.05, 1 + (hash(si + 5) - 0.5) * 2 * p.spread);

                const scale = 0.3 + dist;
                let ox = rx * scale, oy = ry * scale, oz = rz * scale;

                const s = p.seed;
                ox += (Math.sin(py * 3.1 + s + pz * 1.7) + 0.5 * Math.sin(pz * 7.1 + s * 2.1)) * p.turbulence;
                oy += (Math.sin(pz * 2.9 + s * 1.3 + px * 1.9) + 0.5 * Math.sin(px * 6.7 + s * 1.7)) * p.turbulence;
                oz += (Math.sin(px * 3.3 + s * 0.7 + py * 2.1) + 0.5 * Math.sin(py * 7.3 + s)) * p.turbulence;

                const invDist = 1 / Math.max(dist, 0.05);
                const swirlScale = p.swirl * (0.5 + dist * 0.5);
                ox += -dz * invDist * swirlScale;
                oz += dx * invDist * swirlScale;

                px += ox * amt * speed;
                py += oy * amt * speed;
                pz += oz * amt * speed;
                py -= p.gravity * amt * amt * (0.5 + hash(si + 7));
            }
            centers[i * 3] = px;
            centers[i * 3 + 1] = py;
            centers[i * 3 + 2] = pz;
        }
    }

    /** Per-frame params for the depth heatmap view mode. */
    setDepthParams(near: number, far: number, modelView: Mat4) {
        const { material } = this.instance;
        material.setParameter('depthRange', [near, far]);
        material.setParameter('ssModelView', modelView.data);
    }

    /** Upload state changes to the GPU and refresh counts/sorting. */
    updateState(deletedChanged = false) {
        this.state.flush();
        if (deletedChanged) {
            this.updateSorting();
        }
        this.onStateChanged?.();
    }

    /** Exclude deleted and modifier-filtered splats from the sorter. */
    private updateSorting() {
        const state = this.state.data;
        const live = state.length - this.state.numDeleted - this.state.numFiltered;

        let mapping: Uint32Array | undefined;
        if (live !== state.length) {
            mapping = new Uint32Array(live);
            let idx = 0;
            const skip = State.deleted | State.filtered;
            for (let i = 0; i < state.length; ++i) {
                if ((state[i] & skip) === 0) {
                    mapping[idx++] = i;
                }
            }
        }
        this.instance.sorter?.setMapping(mapping);
    }

    /**
     * World-space bounds of non-deleted splat centers. Cheap single pass
     * over positions; used for camera framing.
     */
    calcWorldBound(selectedOnly = false): BoundingBox | null {
        const { x, y, z } = this.getPositions();
        const state = this.state.data;

        let minx = Infinity, miny = Infinity, minz = Infinity;
        let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        let count = 0;

        for (let i = 0; i < state.length; ++i) {
            const s = state[i];
            if (s & (State.deleted | State.filtered)) continue;
            if (selectedOnly && !(s & State.selected)) continue;
            const px = x[i], py = y[i], pz = z[i];
            if (px < minx) minx = px;
            if (py < miny) miny = py;
            if (pz < minz) minz = pz;
            if (px > maxx) maxx = px;
            if (py > maxy) maxy = py;
            if (pz > maxz) maxz = pz;
            count++;
        }

        if (count === 0) return null;

        const local = new BoundingBox();
        local.setMinMax(new Vec3(minx, miny, minz), new Vec3(maxx, maxy, maxz));

        const world = new BoundingBox();
        world.setFromTransformedAabb(local, this.entity.getWorldTransform());
        return world;
    }

    destroy() {
        this.stateTexture.destroy();
        this.transformTexture.destroy();
        this.transformPalette.destroy();
        this.entity.destroy();
        this.asset.registry?.remove(this.asset);
        this.asset.unload();
    }
}
