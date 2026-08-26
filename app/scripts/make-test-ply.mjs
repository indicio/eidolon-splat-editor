// Generate a synthetic gaussian splat PLY for testing: a colored torus
// above a disc of ground splats, plus scattered floaters to clean up.
import { writeFileSync } from 'node:fs';

const N_TORUS = 60000;
const N_GROUND = 30000;
const N_FLOATERS = 2000;
const N = N_TORUS + N_GROUND + N_FLOATERS;

const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${N}`,
    ...props.map(p => `property float ${p}`),
    'end_header',
    ''
].join('\n');

const SH_C0 = 0.28209479177387814;
const col = c => (c - 0.5) / SH_C0;
const logit = a => Math.log(a / (1 - a));

const data = new Float32Array(N * props.length);
let o = 0;

const push = (x, y, z, r, g, b, opacity, sigma) => {
    data[o++] = x; data[o++] = y; data[o++] = z;
    data[o++] = col(r); data[o++] = col(g); data[o++] = col(b);
    data[o++] = logit(opacity);
    const ls = Math.log(sigma);
    data[o++] = ls; data[o++] = ls; data[o++] = ls;
    data[o++] = 1; data[o++] = 0; data[o++] = 0; data[o++] = 0;
};

// torus, major radius 1, minor 0.35, centered at y=1
for (let i = 0; i < N_TORUS; i++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.random() * Math.PI * 2;
    const rr = 0.35 * Math.sqrt(Math.random());
    const x = (1 + rr * Math.cos(v)) * Math.cos(u);
    const z = (1 + rr * Math.cos(v)) * Math.sin(u);
    const y = 1 + rr * Math.sin(v);
    // hue varies around the ring
    const r = 0.5 + 0.45 * Math.cos(u);
    const g = 0.5 + 0.45 * Math.cos(u + 2.1);
    const b = 0.5 + 0.45 * Math.cos(u + 4.2);
    push(x, y, z, r, g, b, 0.85, 0.02);
}

// ground disc, radius 2.5
for (let i = 0; i < N_GROUND; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 2.5 * Math.sqrt(Math.random());
    push(r * Math.cos(a), 0, r * Math.sin(a), 0.42, 0.4, 0.38, 0.8, 0.03);
}

// floaters scattered in a 6m cube
for (let i = 0; i < N_FLOATERS; i++) {
    push((Math.random() - 0.5) * 6, Math.random() * 3, (Math.random() - 0.5) * 6, 0.9, 0.9, 0.9, 0.5, 0.015);
}

const buf = Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(data.buffer)]);
writeFileSync(new URL('../public/test-scene.ply', import.meta.url), buf);
console.log(`wrote test-scene.ply: ${N} splats, ${buf.length} bytes`);
