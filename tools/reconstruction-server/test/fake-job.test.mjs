import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

const startServer = (port) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverPath], {
        env: { ...process.env, PORT: String(port), SPLAT_RECON_FAKE: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    const onData = (buf) => {
        log += buf.toString();
        if (log.includes('reconstruction bridge')) resolve(proc);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => {
        if (!log.includes('reconstruction bridge')) reject(new Error(`server exited ${code}: ${log}`));
    });
});

test('fake mode still serves a ply through the jobs contract', async () => {
    const port = 8791;
    const proc = await startServer(port);
    try {
        const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
        assert.equal(health.ok, true);
        assert.equal(health.fake, true);
        assert.equal(typeof health.engine.spirula, 'boolean');
        assert.equal(health.engine.colmap, undefined);

        const form = new FormData();
        const blob = new Blob([Buffer.from('not-a-real-image')], { type: 'image/jpeg' });
        form.append('images', blob, 'a.jpg');
        form.append('images', blob, 'b.jpg');
        const created = await fetch(`http://127.0.0.1:${port}/jobs`, { method: 'POST', body: form });
        assert.equal(created.status, 200);
        const { id } = await created.json();

        let progress;
        for (let i = 0; i < 50; i++) {
            progress = await fetch(`http://127.0.0.1:${port}/jobs/${id}`).then(r => r.json());
            if (progress.done || progress.error) break;
            await new Promise(r => setTimeout(r, 100));
        }
        assert.equal(progress.done, true, progress.error);
        assert.equal(progress.viewerUrl, undefined);
        assert.ok(progress.diag.loss.length >= 2);

        const result = await fetch(`http://127.0.0.1:${port}/jobs/${id}/result`);
        assert.equal(result.status, 200);
        const bytes = Buffer.from(await result.arrayBuffer());
        assert.match(bytes.subarray(0, 3).toString(), /^ply/);
    } finally {
        proc.kill('SIGTERM');
    }
});
