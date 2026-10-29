#!/usr/bin/env node
/**
 * EiDOlON reconstruction bridge.
 *
 * Implements the ReconstructionProvider REST contract and drives Spirula
 * Studio as a separate process (GPL-3.0 — not linked into the editor):
 *
 *   spirula sfm auto <images> -o <workspace> --progress-dir <dir>
 *   spirula train <preset> --data <workspace> …
 *
 *   GET    /health           → { ok, engine: { spirula }, fake }
 *   POST   /jobs             multipart images[] → { id }
 *   GET    /jobs/:id         → { stageIndex, stageProgress, done, viewerUrl?, diag, error? }
 *   GET    /jobs/:id/log     → text
 *   DELETE /jobs/:id         → cancel + cleanup
 *   GET    /jobs/:id/result  → binary PLY
 *
 * The trainer's web viewer (viewerUrl) is the live preview while a job
 * trains. It is shut down when the run ends; the finished PLY is what the
 * editor opens.
 *
 * Env:
 *   PORT              (default 8787)
 *   SPIRULA_BIN       override the spirula executable
 *   SPIRULA_STEPS     training iterations (default 7000; the 3dgs preset is 30000)
 *   SPIRULA_PRESET    train preset (default 3dgs)
 *   SPIRULA_ARGS      extra args appended to `spirula train`
 *   SPLAT_RECON_FAKE  =1: skip the engine and synthesize a placeholder splat
 *
 * Stage indexes match the app's RECONSTRUCTION_STAGES:
 *   0 analyze, 1 features, 2 matching, 3 poses, 4 pointcloud,
 *   5 training, 6 optimize, 7 package
 */

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, rm, stat, symlink } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import busboy from 'busboy';

const PORT = Number(process.env.PORT ?? 8787);
const FAKE = process.env.SPLAT_RECON_FAKE === '1';
const STEPS = Number(process.env.SPIRULA_STEPS ?? 7000);
const PRESET = process.env.SPIRULA_PRESET ?? '3dgs';
const EXTRA_ARGS = (process.env.SPIRULA_ARGS ?? '').split(' ').filter(Boolean);

const APP_BINARIES = [
    '/Applications/Spirula Studio.app/Contents/MacOS/spirula',
    '/Applications/Spirula Studio.app/Contents/MacOS/Spirula Studio'
];

const which = (bin) => {
    if (!bin) return null;
    if (bin.includes('/')) return existsSync(bin) ? bin : null;
    const found = spawnSync('which', [bin], { encoding: 'utf8' });
    return found.status === 0 ? found.stdout.trim() : null;
};

/** Env override, then the macOS app bundle, then PATH. */
export const resolveSpirula = () => {
    const fromEnv = which(process.env.SPIRULA_BIN);
    if (fromEnv) return fromEnv;
    for (const candidate of APP_BINARIES) {
        if (existsSync(candidate)) return candidate;
    }
    return which('spirula');
};

const SPIRULA = resolveSpirula();

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
        // MoltenVK prints its full extension list on every device open.
        if (!line.trim() || line.includes('[mvk-info]') || /^\s*VK_/.test(line)) continue;
        job.log.push(`${t} ${line}`);
    }
    if (job.log.length > 5000) job.log.splice(0, job.log.length - 5000);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        server.close(() => resolve(port));
    });
});

/**
 * Spirula SfM `--progress-dir` writes status.bin:
 *   "VKPS" u32 version=1, u32 stage, u32 flags, then i64
 *   done, total, registered, images, points, models, f64 mean reprojection.
 *   flags: 1 finished, 2 partial, 4 metric.
 * Stage enum: Extract, Match, Map, Merge, Orient, Finish.
 */
export const readStatusBin = async (file) => {
    let fh;
    try {
        fh = await open(file, 'r');
        const buf = Buffer.alloc(72);
        const { bytesRead } = await fh.read(buf, 0, 72, 0);
        if (bytesRead < 72 || buf.toString('latin1', 0, 4) !== 'VKPS') return null;
        if (buf.readUInt32LE(4) !== 1) return null;
        return {
            stage: buf.readUInt32LE(8),
            flags: buf.readUInt32LE(12),
            done: Number(buf.readBigInt64LE(16)),
            total: Number(buf.readBigInt64LE(24)),
            registered: Number(buf.readBigInt64LE(32)),
            images: Number(buf.readBigInt64LE(40)),
            points: Number(buf.readBigInt64LE(48)),
            models: Number(buf.readBigInt64LE(56)),
            reproj: buf.readDoubleLE(64)
        };
    } catch {
        return null;
    } finally {
        await fh?.close();
    }
};

/** Map a Spirula SfM stage onto the editor's 0–7 list. */
export const sfmStageIndex = (spirulaStage) => {
    if (spirulaStage <= 0) return 1;
    if (spirulaStage === 1) return 2;
    if (spirulaStage <= 4) return 3;
    return 4;
};

const applySfmStatus = (job, st) => {
    job.stageIndex = sfmStageIndex(st.stage);
    job.stageProgress = st.total > 0 ? Math.min(1, st.done / st.total) : job.stageProgress;
    if (st.images > 0) job.diag.totalImages = Number(st.images);
    if (st.registered > 0) job.diag.registeredImages = Number(st.registered);
    if (st.points > 0) job.diag.points = Number(st.points);
    if (st.models > 0) job.diag.fragments = Number(st.models);
    if (Number.isFinite(st.reproj) && st.reproj > 0) job.diag.reprojError = st.reproj;
    job.sfmPartial = (st.flags & 2) !== 0;
};

const killProc = (proc) => {
    if (!proc?.pid || proc.killed) return;
    if (process.platform !== 'win32') {
        try {
            process.kill(-proc.pid, 'SIGTERM');
            return;
        } catch { /* not a group leader */ }
    }
    proc.kill('SIGTERM');
};

const run = (job, stageIndex, cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
        job.stageIndex = stageIndex;
        job.stageProgress = 0;
        const t0 = Date.now();
        jobLog(job, `$ ${path.basename(cmd)} ${args.join(' ')}`);
        const proc = spawn(cmd, args, {
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                // 1 = errors only. Info level reprints ~150 extensions per device open.
                MVK_CONFIG_LOG_LEVEL: process.env.MVK_CONFIG_LOG_LEVEL ?? '1'
            }
        });
        job.proc = proc;
        let stderrTail = '';
        const onData = (buf) => {
            const text = buf.toString();
            stderrTail = (stderrTail + text).slice(-4000);
            jobLog(job, text);
            opts.onOutput?.(text);
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', reject);
        proc.on('close', (code) => {
            job.proc = null;
            job.diag.stageTimes.push({ stage: stageIndex, ms: Date.now() - t0 });
            const ok = new Set(opts.okCodes ?? [0]);
            if (job.cancelled) reject(new Error('cancelled'));
            else if (!ok.has(code)) reject(new Error(`${path.basename(cmd)} exited ${code}: …${stderrTail.slice(-400)}`));
            else resolve(code);
        });
    });

/** Newest splat.ply under a train output directory. */
const findSplatPly = async (dir) => {
    const hits = [];
    const walk = async (d) => {
        let entries;
        try {
            entries = await readdir(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const child = path.join(d, entry.name);
            if (entry.isDirectory()) await walk(child);
            else if (entry.name === 'splat.ply') hits.push(child);
        }
    };
    await walk(dir);
    if (hits.length === 0) return null;
    const ranked = await Promise.all(hits.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
    ranked.sort((a, b) => b.mtime - a.mtime);
    return ranked[0].file;
};

const plyStats = async (file) => {
    const st = await stat(file);
    let splats;
    try {
        const fh = await open(file, 'r');
        const buf = Buffer.alloc(4096);
        await fh.read(buf, 0, 4096, 0);
        await fh.close();
        const match = /element vertex (\d+)/.exec(buf.toString('latin1'));
        if (match) splats = Number(match[1]);
    } catch { /* header parse is best-effort */ }
    return { bytes: st.size, splats };
};

const noteLoss = (job, text) => {
    const match = /rgb_loss=([-+0-9.eE]+)/.exec(text);
    if (!match || job.diag.step == null) return;
    const loss = Number(match[1]);
    if (!Number.isFinite(loss)) return;
    const step = job.diag.step;
    const series = job.diag.loss;
    if (series.length > 0 && series[series.length - 1][0] === step) return;
    series.push([step, loss]);
    if (series.length > 400) job.diag.loss = series.filter((_, i) => i % 2 === 0);
};

/** Poll GET /progress on the trainer's viewer and publish it once it answers. */
const watchTraining = (job, port) => {
    let stop = false;
    const tick = async () => {
        while (!stop && !job.cancelled) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/progress`, { signal: AbortSignal.timeout(1000) });
                if (!stop && res.ok) {
                    job.viewerUrl = `http://127.0.0.1:${port}/`;
                    const progress = await res.json();
                    const step = Number(progress.step);
                    const total = Number(progress.total_steps);
                    if (Number.isFinite(step)) job.diag.step = step;
                    if (Number.isFinite(total) && total > 0) {
                        job.diag.totalSteps = total;
                        const t = Math.min(1, step / total);
                        job.stageIndex = t < 0.8 ? 5 : 6;
                        job.stageProgress = t < 0.8 ? t / 0.8 : (t - 0.8) / 0.2;
                    }
                }
            } catch { /* viewer not up yet, or the run already exited */ }
            await sleep(400);
        }
    };
    void tick();
    return () => { stop = true; };
};

const watchSfm = (job, statusFile) => {
    let stop = false;
    const tick = async () => {
        while (!stop && !job.cancelled) {
            const st = await readStatusBin(statusFile);
            if (!stop && st) applySfmStatus(job, st);
            await sleep(400);
        }
    };
    void tick();
    return () => { stop = true; };
};

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
                jobLog(job, `rgb_loss=${job.diag.loss[job.diag.loss.length - 1][1].toFixed(6)}`);
            }
            await sleep(80);
        }
        job.diag.stageTimes.push({ stage, ms: Date.now() - t0 });
        if (stage === 3) {
            job.diag.registeredImages = Math.max(1, images.length - 1);
            job.diag.points = 1234;
            job.diag.fragments = 2;
            job.diag.reprojError = 1.21;
            job.warning = `Only ${job.diag.registeredImages} of ${images.length} photos could be pose-registered (FAKE)`;
            jobLog(job, 'SfM (fake): registration summary emitted');
        }
    }
    job.resultPath = await synthesizeFakePly(job);
    const st = await stat(job.resultPath);
    job.diag.resultBytes = st.size;
    job.diag.resultSplats = 20000;
    jobLog(job, `result.ply: 20000 splats, ${(st.size / 1024).toFixed(0)} KB`);
};

const runRealPipeline = async (job) => {
    if (!SPIRULA) {
        throw new Error(
            'Spirula Studio was not found. Install the macOS release from ' +
            'https://github.com/harry7557558/spirula-studio/releases ' +
            'or set SPIRULA_BIN to the spirula executable.'
        );
    }
    if (!Number.isFinite(STEPS) || STEPS < 1) {
        throw new Error(`SPIRULA_STEPS must be a positive number (got ${process.env.SPIRULA_STEPS})`);
    }

    const { dir } = job;
    const imageDir = path.join(dir, 'images');
    const workspace = path.join(dir, 'workspace');
    const progressDir = path.join(dir, 'progress');
    const outputPrefix = path.join(dir, 'outputs');
    await mkdir(progressDir, { recursive: true });

    job.stageIndex = 0;
    const images = await readdir(imageDir);
    if (images.length < 2) throw new Error('Need at least 2 images');
    job.diag.totalImages = images.length;
    jobLog(job, `${images.length} input images: ${images.slice(0, 8).join(', ')}${images.length > 8 ? ', …' : ''}`);
    job.stageProgress = 1;

    const statusFile = path.join(progressDir, 'status.bin');
    const stopSfm = watchSfm(job, statusFile);
    let sfmCode = 0;
    try {
        sfmCode = await run(job, 1, SPIRULA, [
            '--lang', 'en',
            'sfm', 'auto', imageDir,
            '-o', workspace,
            '--progress-dir', progressDir
        ], { okCodes: [0, 3] });
    } finally {
        stopSfm();
    }
    const finalStatus = await readStatusBin(statusFile);
    if (finalStatus) applySfmStatus(job, finalStatus);

    const registered = job.diag.registeredImages ?? 0;
    if (registered < 1) {
        throw new Error('Spirula could not reconstruct camera poses from these images');
    }
    const regLine = `Spirula registered ${registered}/${images.length} images` +
        `${job.diag.points != null ? `, ${job.diag.points} sparse points` : ''}` +
        `${(job.diag.fragments ?? 1) > 1 ? ` (${job.diag.fragments} fragments)` : ''}`;
    console.log(`[${job.id}] ${regLine}`);
    jobLog(job, regLine);
    if (sfmCode === 3 || job.sfmPartial || registered < images.length * 0.75) {
        job.warning = `Only ${registered} of ${images.length} photos could be pose-registered` +
            `${(job.diag.fragments ?? 1) > 1 ? ` (reconstruction split into ${job.diag.fragments} fragments)` : ''} — ` +
            'expect low fidelity. Re-shoot with more overlap between consecutive photos.';
    }
    job.stageIndex = 4;
    job.stageProgress = 1;

    // The COLMAP model names files under images/, next to sparse/. The uploads
    // stay in imageDir, so the trainer's default path does not exist.
    await symlink(imageDir, path.join(workspace, 'images'));

    const viewerPort = await freePort();
    job.diag.totalSteps = STEPS;
    const stopTrain = watchTraining(job, viewerPort);
    try {
        await run(job, 5, SPIRULA, [
            '--lang', 'en',
            'train', PRESET,
            '--data', workspace,
            '--output-dir-prefix', outputPrefix,
            '--output-dir-name', 'run',
            '--num-iterations', String(STEPS),
            '--steps-per-save', String(STEPS),
            '--viewer-port', String(viewerPort),
            '--keep-viewer-alive', '0',
            '--eval-mode', 'all',
            ...EXTRA_ARGS
        ], {
            onOutput: (text) => noteLoss(job, text)
        });
    } finally {
        stopTrain();
        job.viewerUrl = null;
    }

    job.stageIndex = 7;
    const outPly = await findSplatPly(outputPrefix);
    if (!outPly) throw new Error('Spirula produced no splat.ply');
    const result = await plyStats(outPly);
    job.diag.resultBytes = result.bytes;
    if (result.splats != null) job.diag.resultSplats = result.splats;
    jobLog(job, `splat.ply: ${job.diag.resultSplats ?? '?'} splats, ${(result.bytes / 1024).toFixed(0)} KB`);
    job.stageProgress = 1;
    job.resultPath = outPly;
};

const startPipeline = (job) => {
    (FAKE ? runFakePipeline(job) : runRealPipeline(job))
        .then(() => {
            job.done = true;
        })
        .catch((err) => {
            job.viewerUrl = null;
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
        viewerUrl: null, sfmPartial: false,
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
        json(res, 200, { ok: true, engine: { spirula: Boolean(SPIRULA) }, fake: FAKE });
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
                ...(job.viewerUrl ? { viewerUrl: job.viewerUrl } : {}),
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
            job.viewerUrl = null;
            killProc(job.proc);
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

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
    server.listen(PORT, () => {
        console.log(`EiDOlON reconstruction bridge on http://localhost:${PORT}`);
        console.log(`  spirula: ${SPIRULA ?? 'NOT FOUND'}`);
        console.log(`  preset ${PRESET}, ${STEPS} steps`);
        if (FAKE) console.log('  MODE: FAKE — synthesizing placeholder results (wiring test only)');
        else if (!SPIRULA) console.log('  Jobs will fail until Spirula Studio is installed (see README).');
    });
}
