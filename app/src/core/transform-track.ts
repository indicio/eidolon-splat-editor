/**
 * Model transform track: position/rotation/scale keys on the shared frame
 * timeline. Position and scale interpolate like the camera track (linear /
 * eased / cubic spline); rotation slerps pairwise between keys with the
 * eased parameter.
 */

import { Quat } from 'playcanvas';

import { applyEase, type Interpolation } from './camera-track';
import { CubicSpline } from './spline';

export interface TransformKey {
    frame: number;
    position: [number, number, number];
    rotation: [number, number, number, number]; // quat x,y,z,w
    scale: [number, number, number];
}

export interface TransformPose {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
}

const qa = new Quat();
const qb = new Quat();
const qo = new Quat();

export class TransformTrack {
    keys: TransformKey[] = [];
    interpolation: Interpolation = 'ease-in-out';

    private spline: CubicSpline | null = null;
    private splineDirty = true;

    addKey(key: TransformKey) {
        const existing = this.keys.findIndex(k => k.frame === key.frame);
        if (existing >= 0) this.keys[existing] = key;
        else this.keys.push(key);
        this.keys.sort((a, b) => a.frame - b.frame);
        this.splineDirty = true;
    }

    removeKey(frame: number): boolean {
        const idx = this.keys.findIndex(k => k.frame === frame);
        if (idx < 0) return false;
        this.keys.splice(idx, 1);
        this.splineDirty = true;
        return true;
    }

    moveKey(from: number, to: number): boolean {
        if (from === to) return true;
        const key = this.keys.find(k => k.frame === from);
        if (!key || this.keys.some(k => k.frame === to)) return false;
        key.frame = to;
        this.keys.sort((a, b) => a.frame - b.frame);
        this.splineDirty = true;
        return true;
    }

    clear() {
        this.keys = [];
        this.splineDirty = true;
    }

    get lastFrame() {
        return this.keys.length ? this.keys[this.keys.length - 1].frame : 0;
    }

    markDirty() {
        this.splineDirty = true;
    }

    private buildSpline() {
        const times = this.keys.map(k => k.frame);
        const points: number[] = [];
        for (const k of this.keys) {
            points.push(...k.position, ...k.scale);
        }
        this.spline = CubicSpline.fromPoints(times, points);
        this.splineDirty = false;
    }

    private poseFromKey(k: TransformKey): TransformPose {
        return { position: [...k.position], rotation: [...k.rotation], scale: [...k.scale] };
    }

    evaluate(frame: number): TransformPose | null {
        const { keys } = this;
        if (keys.length === 0) return null;
        if (keys.length === 1 || frame <= keys[0].frame) {
            return this.poseFromKey(frame <= keys[0].frame ? keys[0] : keys[keys.length - 1]);
        }
        if (frame >= keys[keys.length - 1].frame) {
            return this.poseFromKey(keys[keys.length - 1]);
        }

        let seg = 0;
        while (frame >= keys[seg + 1].frame) seg++;
        const k0 = keys[seg];
        const k1 = keys[seg + 1];
        const rawT = (frame - k0.frame) / (k1.frame - k0.frame);
        const t = applyEase(rawT, this.interpolation === 'spline' ? 'linear' : this.interpolation);

        // rotation always slerps pairwise
        qa.set(k0.rotation[0], k0.rotation[1], k0.rotation[2], k0.rotation[3]);
        qb.set(k1.rotation[0], k1.rotation[1], k1.rotation[2], k1.rotation[3]);
        qo.slerp(qa, qb, t);
        const rotation: [number, number, number, number] = [qo.x, qo.y, qo.z, qo.w];

        if (this.interpolation === 'spline') {
            if (this.splineDirty || !this.spline) this.buildSpline();
            const out = new Array<number>(6);
            this.spline!.evaluate(frame, out);
            return {
                position: [out[0], out[1], out[2]],
                rotation,
                scale: [out[3], out[4], out[5]]
            };
        }

        const lerp = (a: number, b: number) => a + (b - a) * t;
        return {
            position: [lerp(k0.position[0], k1.position[0]), lerp(k0.position[1], k1.position[1]), lerp(k0.position[2], k1.position[2])],
            rotation,
            scale: [lerp(k0.scale[0], k1.scale[0]), lerp(k0.scale[1], k1.scale[1]), lerp(k0.scale[2], k1.scale[2])]
        };
    }
}
