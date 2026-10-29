import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readStatusBin, sfmStageIndex } from '../server.mjs';

const writeStatus = async (file, fields) => {
    const buf = Buffer.alloc(72);
    buf.write('VKPS', 0, 'latin1');
    buf.writeUInt32LE(1, 4);
    buf.writeUInt32LE(fields.stage, 8);
    buf.writeUInt32LE(fields.flags, 12);
    buf.writeBigInt64LE(BigInt(fields.done), 16);
    buf.writeBigInt64LE(BigInt(fields.total), 24);
    buf.writeBigInt64LE(BigInt(fields.registered), 32);
    buf.writeBigInt64LE(BigInt(fields.images), 40);
    buf.writeBigInt64LE(BigInt(fields.points), 48);
    buf.writeBigInt64LE(BigInt(fields.models), 56);
    buf.writeDoubleLE(fields.reproj, 64);
    const fh = await open(file, 'w');
    await fh.write(buf);
    await fh.close();
};

test('status.bin round-trips the SfM snapshot', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'splat-status-'));
    const file = path.join(dir, 'status.bin');
    try {
        await writeStatus(file, {
            stage: 2, flags: 2, done: 18, total: 24,
            registered: 18, images: 24, points: 4200, models: 1, reproj: 0.84
        });
        const st = await readStatusBin(file);
        assert.equal(st.stage, 2);
        assert.equal(st.flags, 2);
        assert.equal(st.done, 18);
        assert.equal(st.total, 24);
        assert.equal(st.registered, 18);
        assert.equal(st.images, 24);
        assert.equal(st.points, 4200);
        assert.equal(st.models, 1);
        assert.ok(Math.abs(st.reproj - 0.84) < 1e-9);
        assert.equal(sfmStageIndex(st.stage), 3);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('SfM stages land on the editor progress list', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(sfmStageIndex), [1, 2, 3, 3, 3, 4]);
});

test('a short or foreign file is ignored', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'splat-status-'));
    const file = path.join(dir, 'status.bin');
    try {
        const fh = await open(file, 'w');
        await fh.write(Buffer.from('nope'));
        await fh.close();
        assert.equal(await readStatusBin(file), null);
        assert.equal(await readStatusBin(path.join(dir, 'missing.bin')), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
