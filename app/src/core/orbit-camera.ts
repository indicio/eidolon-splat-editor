/**
 * Damped orbit camera: azimuth/elevation/distance around a target point.
 * Fly/walk modes come later; this covers orbit, pan, dolly and framing.
 */

import { Entity, Vec3, math } from 'playcanvas';

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();

export class OrbitCamera {
    entity: Entity;

    // goal values
    azim = -35;
    elev = -20;
    distance = 5;
    target = new Vec3(0, 0, 0);

    // smoothed values (chase the goals)
    private sAzim = this.azim;
    private sElev = this.elev;
    private sDistance = this.distance;
    private sTarget = this.target.clone();

    minDistance = 0.01;
    maxDistance = 5000;

    constructor(entity: Entity) {
        this.entity = entity;
    }

    orbit(dx: number, dy: number) {
        this.azim -= dx * 0.25;
        this.elev = math.clamp(this.elev - dy * 0.25, -89.9, 89.9);
    }

    pan(dx: number, dy: number, viewportHeight: number, fovDeg: number) {
        // scale pixel motion to world units at the target depth
        const worldPerPixel = (2 * Math.tan(fovDeg * math.DEG_TO_RAD * 0.5) * this.distance) / viewportHeight;
        const t = this.entity.getWorldTransform();
        t.getX(right);
        t.getY(up);
        this.target.add(right.mulScalar(-dx * worldPerPixel));
        this.target.add(up.mulScalar(dy * worldPerPixel));
    }

    dolly(factor: number) {
        this.distance = math.clamp(this.distance * factor, this.minDistance, this.maxDistance);
    }

    focus(point: Vec3, radius: number, fovDeg: number) {
        this.target.copy(point);
        this.distance = math.clamp((radius * 1.4) / Math.tan(fovDeg * math.DEG_TO_RAD * 0.5), this.minDistance, this.maxDistance);
    }

    reset() {
        this.azim = -35;
        this.elev = -20;
        this.distance = 5;
        this.target.set(0, 0, 0);
    }

    /**
     * Set the camera from an explicit position/target pose. snap=true also
     * resets the smoothing state (used by camera animation playback).
     */
    setPose(px: number, py: number, pz: number, tx: number, ty: number, tz: number, snap = true) {
        const dx = px - tx, dy = py - ty, dz = pz - tz;
        const dist = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz));
        this.target.set(tx, ty, tz);
        this.distance = math.clamp(dist, this.minDistance, this.maxDistance);
        this.elev = Math.asin(math.clamp(dy / dist, -1, 1)) * math.RAD_TO_DEG;
        this.azim = Math.atan2(dx, dz) * math.RAD_TO_DEG;
        if (snap) {
            this.sAzim = this.azim;
            this.sElev = this.elev;
            this.sDistance = this.distance;
            this.sTarget.copy(this.target);
        }
    }

    /** Restore the default viewing angles without moving the target. */
    resetAngles() {
        this.azim = -35;
        this.elev = -20;
    }

    /**
     * Shift goal and smoothed target together, keeping the view glued to
     * content that has just been translated (e.g. after an origin change).
     */
    shiftTarget(delta: Vec3) {
        this.target.add(delta);
        this.sTarget.add(delta);
    }

    /** Advance smoothing and write the camera transform. */
    update(dt: number) {
        const rate = 1 - Math.pow(0.0001, dt);
        this.sAzim += (this.azim - this.sAzim) * rate;
        this.sElev += (this.elev - this.sElev) * rate;
        this.sDistance += (this.distance - this.sDistance) * rate;
        this.sTarget.lerp(this.sTarget, this.target, rate);

        const azimRad = this.sAzim * math.DEG_TO_RAD;
        const elevRad = this.sElev * math.DEG_TO_RAD;

        forward.set(
            Math.sin(azimRad) * Math.cos(elevRad),
            Math.sin(elevRad),
            Math.cos(azimRad) * Math.cos(elevRad)
        );

        this.entity.setLocalPosition(
            this.sTarget.x + forward.x * this.sDistance,
            this.sTarget.y + forward.y * this.sDistance,
            this.sTarget.z + forward.z * this.sDistance
        );
        this.entity.lookAt(this.sTarget);
    }
}
