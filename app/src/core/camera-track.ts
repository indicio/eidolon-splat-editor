/**
 * Camera keyframe track: position/target/fov keys on a frame timeline with
 * linear, eased or cubic-spline interpolation (spline via SuperSplat's
 * CubicSpline port).
 */

import { CubicSpline } from './spline';

export interface CameraKey {
    frame: number;
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
}

export type Interpolation = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'spline';

export interface CameraPose {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
}

export const applyEase = (t: number, mode: Interpolation): number => {
    switch (mode) {
        case 'ease-in': return t * t;
        case 'ease-out': return 1 - (1 - t) * (1 - t);
        case 'ease-in-out': return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
        default: return t;
    }
};

const ease = applyEase;

export class CameraTrack {
    keys: CameraKey[] = [];
    interpolation: Interpolation = 'ease-in-out';

    private spline: CubicSpline | null = null;
    private splineDirty = true;

    /** Add or replace the key at a frame. */
    addKey(key: CameraKey) {
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

    /** Retime a key. Returns false if no key at `from` or `to` is occupied. */
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

    private buildSpline() {
        const times = this.keys.map(k => k.frame);
        const points: number[] = [];
        for (const k of this.keys) {
            points.push(...k.position, ...k.target, k.fov);
        }
        this.spline = CubicSpline.fromPoints(times, points);
        this.splineDirty = false;
    }

    evaluate(frame: number): CameraPose | null {
        const { keys } = this;
        if (keys.length === 0) return null;
        if (keys.length === 1 || frame <= keys[0].frame) {
            const k = frame <= keys[0].frame ? keys[0] : keys[keys.length - 1];
            return { position: [...k.position], target: [...k.target], fov: k.fov };
        }
        if (frame >= keys[keys.length - 1].frame) {
            const k = keys[keys.length - 1];
            return { position: [...k.position], target: [...k.target], fov: k.fov };
        }

        if (this.interpolation === 'spline') {
            if (this.splineDirty || !this.spline) this.buildSpline();
            const out = new Array<number>(7);
            this.spline!.evaluate(frame, out);
            return {
                position: [out[0], out[1], out[2]],
                target: [out[3], out[4], out[5]],
                fov: out[6]
            };
        }

        let seg = 0;
        while (frame >= keys[seg + 1].frame) seg++;
        const k0 = keys[seg];
        const k1 = keys[seg + 1];
        const t = ease((frame - k0.frame) / (k1.frame - k0.frame), this.interpolation);
        const lerp = (a: number, b: number) => a + (b - a) * t;
        return {
            position: [lerp(k0.position[0], k1.position[0]), lerp(k0.position[1], k1.position[1]), lerp(k0.position[2], k1.position[2])],
            target: [lerp(k0.target[0], k1.target[0]), lerp(k0.target[1], k1.target[1]), lerp(k0.target[2], k1.target[2])],
            fov: lerp(k0.fov, k1.fov)
        };
    }
}
