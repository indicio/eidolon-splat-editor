#!/usr/bin/env node
/**
 * Splat Studio reconstruction bridge.
 *
 * Implements the ReconstructionProvider REST contract and drives a local
 * COLMAP + OpenSplat pipeline:
 *
 *   GET    /health           → { ok, engine: { colmap, opensplat }, fake }
 *   POST   /jobs             multipart images[] → { id }
 *   GET    /jobs/:id         → { stageIndex, stageProgress, done, error? }
 *   DELETE /jobs/:id         → cancel + cleanup
 *   GET    /jobs/:id/result  → binary PLY
 *
 * Requirements for real training:
 *   - colmap    (e.g. `brew install colmap`)
 *   - opensplat (https://github.com/pierotofy/OpenSplat — build & put on PATH,
 *                or set OPENSPLAT_BIN)
 *
 * Env:
 *   PORT              (default 8787)
 *   COLMAP_BIN        override colmap path
 *   OPENSPLAT_BIN     override opensplat path
 *   OPENSPLAT_STEPS   training iterations (default 2000)
 *   SPLAT_RECON_FAKE  =1: skip the engines and synthesize a placeholder splat
 *                     (for wiring tests only — clearly not a trained model)
 *
 * Stage indexes match the app's RECONSTRUCTION_STAGES:
 *   0 analyze, 1 features, 2 matching, 3 poses, 4 pointcloud,
 *   5 training, 6 optimize, 7 package
 */

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import busboy from 'busboy';

const PORT = Number(process.env.PORT ?? 8787);
const FAKE = process.env.SPLAT_RECON_FAKE === '1';
const COLMAP = process.env.COLMAP_BIN ?? 'colmap';
const STEPS = Number(process.env.OPENSPLAT_STEPS ?? 2000);
// GPU (Metal) training by default; set OPENSPLAT_ARGS="--cpu" if running
// a CPU-only opensplat build (one made without -DGPU_RUNTIME=MPS)
const EXTRA_ARGS = (process.env.OPENSPLAT_ARGS ?? '').split(' ').filter(Boolean);

// opensplat: env override → sibling build in this repo → PATH
const HERE = path.dirname(new URL(import.meta.url).pathname);
const LOCAL_OPENSPLAT = path.join(HERE, '..', 'OpenSplat', 'build', 'opensplat');
const OPENSPLAT = process.env.OPENSPLAT_BIN ?? (existsSync(LOCAL_OPENSPLAT) ? LOCAL_OPENSPLAT : 'opensplat');

const which = (bin) => bin.includes('/')
    ? existsSync(bin)
    : spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
const engineStatus = () => ({ colmap: which(COLMAP), opensplat: which(OPENSPLAT) });

const jobs = new Map();
let nextJobId = 1;

const json = (res, code, body) => {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(body));
};

/** Append timestamped lines to the job's diagnostic log (capped ring). */
const jobLog = (job, text) => {
    const t = `[${((Date.now() - job.startedAt) / 1000).toFixed(1).padStart(7)}s]`;
    for (const line of String(text).split('\n')) {
        if (line.trim()) job.log.push(`${t} ${line}`);
    }
    if (job.log.length > 5000) job.log.splice(0, job.log.length - 5000);
};

const run = (job, stageIndex, cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
        job.stageIndex = stageIndex;
        job.stageProgress = 0;
        const t0 = Date.now();
        jobLog(job, `$ ${path.basename(cmd)} ${args.join(' ')}`);
        const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        job.proc = proc;
        let stderrTail = '';
        const onData = (buf) => {
            const text = buf.toString();
            stderrTail = (stderrTail + text).slice(-2000);
            jobLog(job, text);
            opts.onOutput?.(text);
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', reject);
        proc.on('close', (code) => {
            job.proc = null;
            job.diag.stageTimes.push({ stage: stageIndex, ms: Date.now() - t0 });
            if (job.cancelled) reject(new Error('cancelled'));
            else if (code !== 0) reject(new Error(`${path.basename(cmd)} exited ${code}: …${stderrTail.slice(-400)}`));
            else resolve();
        });
    });

/** Registered-image / point counts of one COLMAP sparse model. */
const analyzeModel = (modelDir) => new Promise((resolve) => {
    const proc = spawn(COLMAP, ['model_analyzer', '--path', modelDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', b => { out += b; });
    proc.stderr.on('data', b => { out += b; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
        const images = /Registered images: (\d+)/.exec(out);
        const points = /Points: (\d+)/.exec(out);
        const err = /Mean reprojection error: ([\d.]+)/.exec(out);
        resolve(images ? {
            images: Number(images[1]),
            points: Number(points?.[1] ?? 0),
            reprojError: err ? Number(err[1]) : undefined
        } : null);
    });
});

/** Placeholder result for fake mode: a colored gaussian blob cloud. */
const synthesizeFakePly = async (job) => {
    const N = 20000;
    const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${N}`,
        ...props.map(p => `property float ${p}`), 'end_header', ''].join('\n');
    const data = new Float32Array(N * props.length);
    let o = 0;
    const SH_C0 = 0.28209479177387814;
    for (let i = 0; i < N; i++) {
        const r = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.8;
        const x = r(), y = Math.abs(r()), z = r();
        data[o++] = x; data[o++] = y; data[o++] = z;
        data[o++] = (0.5 + 0.4 * Math.sin(x * 3) - 0.5) / SH_C0;
        data[o++] = (0.5 + 0.4 * Math.sin(y * 4) - 0.5) / SH_C0;
        data[o++] = (0.5 + 0.4 * Math.cos(z * 3) - 0.5) / SH_C0;
        data[o++] = Math.log(0.8 / 0.2);
        const s = Math.log(0.02);
        data[o++] = s; data[o++] = s; data[o++] = s;
        data[o++] = 1; data[o++] = 0; data[o++] = 0; data[o++] = 0;
    }
    const out = path.join(job.dir, 'result.ply');
    await new Promise((resolve, reject) => {
        const ws = createWriteStream(out);
        ws.on('finish', resolve);
        ws.on('error', reject);
        ws.write(Buffer.from(header, 'ascii'));
        ws.end(Buffer.from(data.buffer));
    });
    return out;
};

const runFakePipeline = async (job) => {
    // fake diagnostics so the client's monitoring UI can be exercised end to end
    const images = await readdir(path.join(job.dir, 'images')).catch(() => []);
    job.diag.totalImages = images.length;
    jobLog(job, `FAKE pipeline: ${images.length} input images`);
    for (let stage = 0; stage < 8; stage++) {
        if (job.cancelled) throw new Error('cancelled');
        job.stageIndex = stage;
        const t0 = Date.now();
        jobLog(job, `stage ${stage} started`);
        for (let p = 0; p <= 4; p++) {
            job.stageProgress = p / 4;
            if (stage === 5 || stage === 6) {
                const step = Math.round(((stage - 5) * 5 + p + 1) / 10 * 2000);
                job.diag.step = step;
                job.diag.totalSteps = 2000;
                job.diag.loss.push([step, 0.4 * Math.exp(-step / 600) + 0.02 + Math.random() * 0.01]);
                jobLog(job, `Step ${step}: ${job.diag.loss[job.diag.loss.length - 1][1].toFixed(6)}`);
            }
            await new Promise(r => setTimeout(r, 80));
        }
        job.diag.stageTimes.push({ stage, ms: Date.now() - t0 });
        if (stage === 3) {
            job.diag.registeredImages = Math.max(1, images.length - 1);
            job.diag.points = 1234;
            job.diag.fragments = 2;
            job.diag.reprojError = 1.21;
            job.warning = `Only ${job.diag.registeredImages} of ${images.length} photos could be pose-registered (FAKE)`;
            jobLog(job, 'COLMAP (fake): registration summary emitted');
        }
    }
    job.resultPath = await synthesizeFakePly(job);
    const st = await stat(job.resultPath);
    job.diag.resultBytes = st.size;
    job.diag.resultSplats = 20000;
    jobLog(job, `result.ply: 20000 splats, ${(st.size / 1024).toFixed(0)} KB`);
};

const runRealPipeline = async (job) => {
    const engines = engineStatus();
    const missing = Object.entries(engines).filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) {
        throw new Error(
            `Missing engines: ${missing.join(', ')}. Install colmap (brew install colmap) and ` +
            'OpenSplat (github.com/pierotofy/OpenSplat), or set COLMAP_BIN / OPENSPLAT_BIN.'
        );
    }

    const { dir } = job;
    const imageDir = path.join(dir, 'images');
    const dbPath = path.join(dir, 'database.db');
    const sparseDir = path.join(dir, 'sparse');
    await mkdir(sparseDir, { recursive: true });

    // 0 analyze — sanity check
    job.stageIndex = 0;
    const images = await readdir(imageDir);
    if (images.length < 2) throw new Error('Need at least 2 images');
    job.diag.totalImages = images.length;
    jobLog(job, `${images.length} input images: ${images.slice(0, 8).join(', ')}${images.length > 8 ? ', …' : ''}`);
    job.stageProgress = 1;

    // 1 features — no single_camera: phone photo sets routinely mix lenses /
    // resolutions, and forcing shared intrinsics fragments registration.
    // Affine shape + domain-size pooling cost time but rescue low-texture scenes.
    await run(job, 1, COLMAP, ['feature_extractor', '--database_path', dbPath, '--image_path', imageDir,
        '--SiftExtraction.estimate_affine_shape', '1',
        '--SiftExtraction.domain_size_pooling', '1']);

    // 2 matching
    // COLMAP ≥3.10 renamed SiftMatching.guided_matching → FeatureMatching.guided_matching
    await run(job, 2, COLMAP, ['exhaustive_matcher', '--database_path', dbPath,
        '--FeatureMatching.guided_matching', '1']);

    // 3-4 poses + point cloud
    await run(job, 3, COLMAP, ['mapper', '--database_path', dbPath, '--image_path', imageDir,
        '--output_path', sparseDir]);

    // The mapper emits several disconnected models (sparse/0, sparse/1, …)
    // when registration fragments. opensplat only reads sparse/0, so promote
    // the largest model there and surface poor registration to the client.
    const models = (await readdir(sparseDir)).filter(n => /^\d+$/.test(n)).sort();
    if (models.length === 0) throw new Error('COLMAP could not reconstruct camera poses from these images');
    let best = models[0];
    let bestStats = { images: 0, points: 0 };
    for (const m of models) {
        const s = await analyzeModel(path.join(sparseDir, m));
        if (s && s.images > bestStats.images) {
            best = m;
            bestStats = s;
        }
    }
    if (best !== '0') {
        const tmp = path.join(sparseDir, 'swap-tmp');
        await rename(path.join(sparseDir, '0'), tmp);
        await rename(path.join(sparseDir, best), path.join(sparseDir, '0'));
        await rename(tmp, path.join(sparseDir, best));
    }
    job.diag.registeredImages = bestStats.images;
    job.diag.points = bestStats.points;
    job.diag.fragments = models.length;
    job.diag.reprojError = bestStats.reprojError;
    const regLine = `COLMAP registered ${bestStats.images}/${images.length} images, ` +
        `${bestStats.points} sparse points${models.length > 1 ? ` (${models.length} fragments — largest promoted)` : ''}`;
    console.log(`[${job.id}] ${regLine}`);
    jobLog(job, regLine);
    if (bestStats.images < images.length * 0.75) {
        job.warning = `Only ${bestStats.images} of ${images.length} photos could be pose-registered` +
            `${models.length > 1 ? ` (reconstruction split into ${models.length} fragments)` : ''} — ` +
            'expect low fidelity. Re-shoot with more overlap between consecutive photos.';
    }
    job.stageIndex = 4;
    job.stageProgress = 1;

    // 5-6 gaussian training (opensplat reads the colmap project dir)
    const outPly = path.join(dir, 'result.ply');
    job.diag.totalSteps = STEPS;
    await run(job, 5, OPENSPLAT, ['-i', dir, '-n', String(STEPS), '-o', outPly, ...EXTRA_ARGS], {
        onOutput: (text) => {
            // opensplat logs "Step N: <loss>"
            const stepRe = /Step (\d+):\s*([-+0-9.eE]+)/g;
            let m;
            let last = null;
            while ((m = stepRe.exec(text)) !== null) last = m;
            if (!last) {
                const bare = /Step (\d+)/.exec(text);
                if (bare) last = bare;
            }
            if (last) {
                const step = Number(last[1]);
                const loss = last[2] !== undefined ? Number(last[2]) : NaN;
                job.diag.step = step;
                if (Number.isFinite(loss)) {
                    job.diag.loss.push([step, loss]);
                    // cap the series; halve resolution when it grows too long
                    if (job.diag.loss.length > 400) {
                        job.diag.loss = job.diag.loss.filter((_, i) => i % 2 === 0);
                    }
                }
                const t = Math.min(1, step / STEPS);
                job.stageIndex = t < 0.8 ? 5 : 6;
                job.stageProgress = t < 0.8 ? t / 0.8 : (t - 0.8) / 0.2;
            }
        }
    });

    // 7 package
    job.stageIndex = 7;
    if (!existsSync(outPly)) throw new Error('OpenSplat produced no output PLY');
    const st = await stat(outPly);
    job.diag.resultBytes = st.size;
    // splat count from the PLY header
    try {
        const fd = await open(outPly, 'r');
        const buf = Buffer.alloc(4096);
        await fd.read(buf, 0, 4096, 0);
        await fd.close();
        const v = /element vertex (\d+)/.exec(buf.toString('latin1'));
        if (v) job.diag.resultSplats = Number(v[1]);
    } catch { /* header parse is best-effort */ }
    jobLog(job, `result.ply: ${job.diag.resultSplats ?? '?'} splats, ${(st.size / 1024).toFixed(0)} KB`);
    job.stageProgress = 1;
    job.resultPath = outPly;
};

const startPipeline = (job) => {
    (FAKE ? runFakePipeline(job) : runRealPipeline(job))
        .then(() => {
            job.done = true;
        })
        .catch((err) => {
            job.error = job.cancelled ? 'Cancelled' : (err instanceof Error ? err.message : String(err));
            job.done = false;
            jobLog(job, `ERROR: ${job.error}`);
            console.error(`[${job.id}] failed: ${job.error}`);
        });
};

const handlePost = (req, res) => {
    const id = `job-${nextJobId++}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(os.tmpdir(), `splat-recon-${id}`);
    const imageDir = path.join(dir, 'images');
    const job = {
        id, dir, stageIndex: 0, stageProgress: 0, done: false, error: null,
        resultPath: null, proc: null, cancelled: false, startedAt: Date.now(),
        log: [],
        diag: { stageTimes: [], loss: [] }
    };

    mkdir(imageDir, { recursive: true }).then(() => {
        const bb = busboy({ headers: req.headers });
        const writes = [];
        bb.on('file', (_name, file, info) => {
            const safe = path.basename(info.filename || `image-${writes.length}.jpg`).replace(/[^\w.-]/g, '_');
            const ws = createWriteStream(path.join(imageDir, safe));
            file.pipe(ws);
            writes.push(new Promise((resolve, reject) => {
                ws.on('finish', resolve);
                ws.on('error', reject);
            }));
        });
        bb.on('close', async () => {
            try {
                await Promise.all(writes);
                jobs.set(id, job);
                startPipeline(job);
                json(res, 200, { id });
            } catch (err) {
                json(res, 500, { error: String(err) });
            }
        });
        bb.on('error', err => json(res, 400, { error: String(err) }));
        req.pipe(bb);
    }).catch(err => json(res, 500, { error: String(err) }));
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*'
        });
        res.end();
        return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true, engine: engineStatus(), fake: FAKE });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/jobs') {
        handlePost(req, res);
        return;
    }

    if (parts[0] === 'jobs' && parts[1]) {
        const job = jobs.get(parts[1]);
        if (!job) {
            json(res, 404, { error: 'unknown job' });
            return;
        }

        if (req.method === 'GET' && parts.length === 2) {
            json(res, 200, {
                stageIndex: job.stageIndex,
                stageProgress: job.stageProgress,
                done: job.done,
                diag: job.diag,
                ...(job.warning ? { warning: job.warning } : {}),
                ...(job.error ? { error: job.error } : {})
            });
            return;
        }

        if (req.method === 'GET' && parts[2] === 'log') {
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(job.log.join('\n'));
            return;
        }

        if (req.method === 'DELETE' && parts.length === 2) {
            job.cancelled = true;
            job.proc?.kill('SIGTERM');
            jobs.delete(job.id);
            rm(job.dir, { recursive: true, force: true }).catch(() => {});
            json(res, 200, { ok: true });
            return;
        }

        if (req.method === 'GET' && parts[2] === 'result') {
            if (!job.done || !job.resultPath) {
                json(res, 409, { error: 'not finished' });
                return;
            }
            stat(job.resultPath).then((st) => {
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': st.size,
                    'Access-Control-Allow-Origin': '*'
                });
                createReadStream(job.resultPath).pipe(res);
            }).catch(err => json(res, 500, { error: String(err) }));
            return;
        }
    }

    json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
    const engines = engineStatus();
    console.log(`Splat Studio reconstruction bridge on http://localhost:${PORT}`);
    console.log(`  colmap:    ${engines.colmap ? 'found' : 'NOT FOUND'}`);
    console.log(`  opensplat: ${engines.opensplat ? 'found' : 'NOT FOUND'}`);
    if (FAKE) console.log('  MODE: FAKE — synthesizing placeholder results (wiring test only)');
    else if (!engines.colmap || !engines.opensplat) {
        console.log('  Jobs will fail until both engines are installed (see README).');
    }
});
