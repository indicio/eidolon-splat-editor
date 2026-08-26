// Generates multi-view test "photos" of a synthetic 3D scene (textured
// ground + boxes) with real parallax, for smoke-testing the COLMAP +
// OpenSplat pipeline without a camera. Writes BMPs to test/views/.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const W = 640, H = 480, VIEWS = 16;

// multi-octave value noise for feature-rich textures
const hash = (x, y) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const noise = (x, y) => {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < 4; o++) {
        const xi = Math.floor(x * f), yi = Math.floor(y * f);
        const fx = x * f - xi, fy = y * f - yi;
        const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
        v += amp * (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy);
        amp *= 0.5; f *= 2.3;
    }
    return v;
};

// scene: ground plane y=0, three axis-aligned boxes
const boxes = [
    { min: [-0.6, 0, -0.6], max: [0.6, 1.2, 0.6], hue: 0 },
    { min: [1.2, 0, -1.5], max: [2.2, 0.8, -0.5], hue: 1 },
    { min: [-2.2, 0, 0.6], max: [-1.2, 1.6, 1.6], hue: 2 }
];

const rayBox = (o, d, b) => {
    let tmin = 1e-4, tmax = 1e9, axis = -1;
    for (let i = 0; i < 3; i++) {
        const inv = 1 / d[i];
        let t0 = (b.min[i] - o[i]) * inv, t1 = (b.max[i] - o[i]) * inv;
        if (inv < 0) [t0, t1] = [t1, t0];
        if (t0 > tmin) { tmin = t0; axis = i; }
        tmax = Math.min(tmax, t1);
        if (tmax < tmin) return null;
    }
    return { t: tmin, axis };
};

const shade = (o, d) => {
    let best = null;
    for (const b of boxes) {
        const hit = rayBox(o, d, b);
        if (hit && (!best || hit.t < best.t)) best = { ...hit, box: b };
    }
    // ground
    if (d[1] < 0) {
        const t = -o[1] / d[1];
        if (t > 1e-4 && (!best || t < best.t)) {
            const px = o[0] + d[0] * t, pz = o[2] + d[2] * t;
            if (Math.abs(px) < 6 && Math.abs(pz) < 6) {
                const n = noise(px * 2 + 10, pz * 2 + 10);
                const check = ((Math.floor(px * 2) + Math.floor(pz * 2)) & 1) ? 0.75 : 0.5;
                const v = check * (0.5 + n * 0.8);
                return [v * 200, v * 185, v * 165];
            }
        }
    }
    if (best) {
        const p = [0, 1, 2].map(i => o[i] + d[i] * best.t);
        const u = p[(best.axis + 1) % 3], v = p[(best.axis + 2) % 3];
        const n = noise(u * 6 + best.box.hue * 40, v * 6 + 5);
        const base = [[210, 90, 70], [80, 160, 210], [120, 200, 110]][best.box.hue];
        const lit = 0.55 + 0.45 * n + (best.axis === 1 ? 0.15 : 0);
        return base.map(c => Math.min(255, c * lit));
    }
    // sky gradient with faint texture (helps nothing match — fine)
    const g = 200 + d[1] * 60;
    return [g * 0.8, g * 0.9, g];
};

const writeBmp = (file, pix) => {
    const rowSize = Math.ceil((W * 3) / 4) * 4;
    const dataSize = rowSize * H;
    const buf = Buffer.alloc(54 + dataSize);
    buf.write('BM'); buf.writeUInt32LE(54 + dataSize, 2); buf.writeUInt32LE(54, 10);
    buf.writeUInt32LE(40, 14); buf.writeInt32LE(W, 18); buf.writeInt32LE(H, 22);
    buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = ((H - 1 - y) * W + x) * 3;
            const off = 54 + y * rowSize + x * 3;
            buf[off] = pix[i + 2]; buf[off + 1] = pix[i + 1]; buf[off + 2] = pix[i];
        }
    }
    writeFileSync(file, buf);
};

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'views');
mkdirSync(outDir, { recursive: true });

const fov = 55 * Math.PI / 180;
const focal = (W / 2) / Math.tan(fov / 2);

for (let v = 0; v < VIEWS; v++) {
    const ang = (v / VIEWS) * Math.PI * 1.6 - Math.PI * 0.8;
    const eye = [Math.sin(ang) * 4.5, 1.8 + 0.3 * Math.sin(v * 1.7), Math.cos(ang) * 4.5];
    const look = [0, 0.5, 0];
    // camera basis
    const fwd = look.map((l, i) => l - eye[i]);
    const fl = Math.hypot(...fwd); fwd.forEach((_, i) => fwd[i] /= fl);
    const right = [fwd[2], 0, -fwd[0]];
    const rl = Math.hypot(...right); right.forEach((_, i) => right[i] /= rl);
    const up = [
        right[1] * fwd[2] - right[2] * fwd[1],
        right[2] * fwd[0] - right[0] * fwd[2],
        right[0] * fwd[1] - right[1] * fwd[0]
    ];
    const pix = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const cx = (x - W / 2) / focal, cy = (H / 2 - y) / focal;
            const d = [0, 1, 2].map(i => fwd[i] + right[i] * cx + up[i] * cy);
            const dl = Math.hypot(...d); d.forEach((_, i) => d[i] /= dl);
            const c = shade(eye, d);
            const o = (y * W + x) * 3;
            pix[o] = c[0]; pix[o + 1] = c[1]; pix[o + 2] = c[2];
        }
    }
    writeBmp(path.join(outDir, `view_${String(v).padStart(2, '0')}.bmp`), pix);
}
console.log(`wrote ${VIEWS} views to ${outDir}`);
