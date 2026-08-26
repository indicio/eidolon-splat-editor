/**
 * Scalar keyframe track (e.g. explode amount): same frame timeline and
 * interpolation modes as the camera/model tracks.
 */

import { applyEase, type Interpolation } from './camera-track';
import { CubicSpline } from './spline';

export interface ScalarKey {
    frame: number;
    value: number;
}

export class ScalarTrack {
    keys: ScalarKey[] = [];
    interpolation: Interpolation = 'ease-in-out';

    private spline: CubicSpline | null = null;
    private splineDirty = true;

    addKey(key: ScalarKey) {
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

    evaluate(frame: number): number | null {
        const { keys } = this;
        if (keys.length === 0) return null;
        if (keys.length === 1 || frame <= keys[0].frame) {
            return frame <= keys[0].frame ? keys[0].value : keys[keys.length - 1].value;
        }
        if (frame >= keys[keys.length - 1].frame) {
            return keys[keys.length - 1].value;
        }

        if (this.interpolation === 'spline') {
            if (this.splineDirty || !this.spline) {
                this.spline = CubicSpline.fromPoints(keys.map(k => k.frame), keys.map(k => k.value));
                this.splineDirty = false;
            }
            const out = [0];
            this.spline.evaluate(frame, out);
            return out[0];
        }

        let seg = 0;
        while (frame >= keys[seg + 1].frame) seg++;
        const k0 = keys[seg];
        const k1 = keys[seg + 1];
        const t = applyEase((frame - k0.frame) / (k1.frame - k0.frame), this.interpolation);
        return k0.value + (k1.value - k0.value) * t;
    }
}
