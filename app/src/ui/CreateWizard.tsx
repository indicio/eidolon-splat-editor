import { useEffect, useMemo, useRef, useState } from 'react';

import {
    ACCEPTED_IMAGE_TYPES,
    ACCEPTED_VIDEO_TYPES,
    analyzeImage,
    extractVideoFrames,
    markDuplicates,
    type FrameInfo,
    type SamplingMode
} from '../core/ingest';
import {
    DemoProvider,
    RemoteProvider,
    getServiceUrl,
    pingService,
    setServiceUrl,
    type JobProgress,
    type ReconstructionProvider
} from '../core/reconstruction';
import { runCommand, scene } from '../core/scene-manager';
import { setState } from '../core/store';
import styles from './CreateWizard.module.scss';
import { fmtBytes } from './fmt';
import { CrossIcon } from './icons';

type Step = 'capture' | 'review' | 'reconstruct';

/** Training-loss sparkline: single series, hover reads out the nearest step. */
const LossSparkline = ({ series }: { series: [number, number][] }) => {
    const [hover, setHover] = useState<[number, number] | null>(null);
    if (series.length < 2) return null;
    const w = 240, h = 48, pad = 3;
    const x0 = series[0][0], x1 = series[series.length - 1][0];
    const ys = series.map(p => p[1]);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const X = (x: number) => pad + ((x - x0) / Math.max(1e-9, x1 - x0)) * (w - pad * 2);
    const Y = (y: number) => h - pad - ((y - yMin) / Math.max(1e-9, yMax - yMin)) * (h - pad * 2);
    const d = series.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
    const cur = hover ?? series[series.length - 1];
    return (
        <div className={styles.spark} title="Training loss — lower is better">
            <svg
                width={w}
                height={h}
                onMouseMove={e => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const fx = x0 + ((e.clientX - r.left - pad) / (w - pad * 2)) * (x1 - x0);
                    let best = series[0];
                    for (const p of series) {
                        if (Math.abs(p[0] - fx) < Math.abs(best[0] - fx)) best = p;
                    }
                    setHover(best);
                }}
                onMouseLeave={() => setHover(null)}
            >
                <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
                {hover && <circle cx={X(hover[0])} cy={Y(hover[1])} r="3.5" fill="var(--accent)" />}
            </svg>
            <span className={styles.sparkLabel}>loss {cur[1].toPrecision(3)} · step {cur[0]}</span>
        </div>
    );
};

const STEPS: { id: Step | 'edit'; label: string }[] = [
    { id: 'capture', label: 'Capture' },
    { id: 'review', label: 'Review' },
    { id: 'reconstruct', label: 'Reconstruct' },
    { id: 'edit', label: 'Edit' }
];

const FPS_OPTIONS = [1, 2, 5, 10] as const;

export const CreateWizard = () => {
    const [step, setStep] = useState<Step>('capture');
    const [frames, setFrames] = useState<FrameInfo[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const [fps, setFps] = useState<1 | 2 | 5 | 10>(2);
    const [videoFile, setVideoFile] = useState<File | null>(null);

    const [serviceUrl, setServiceUrlState] = useState<string | null>(() => getServiceUrl());
    const [urlDraft, setUrlDraft] = useState('');
    const [configOpen, setConfigOpen] = useState(false);
    const [pingResult, setPingResult] = useState<string | null>(null);
    const provider: ReconstructionProvider = useMemo(
        () => (serviceUrl ? new RemoteProvider(serviceUrl) : new DemoProvider()),
        [serviceUrl]
    );
    const [progress, setProgress] = useState<JobProgress | null>(null);
    const jobRef = useRef<string | null>(null);
    const cancelledRef = useRef(false);

    // pipeline log viewer (diagnosis): polls {base}/jobs/:id/log while open
    const [logOpen, setLogOpen] = useState(false);
    const [logText, setLogText] = useState('');
    const logRef = useRef<HTMLPreElement>(null);
    const hadError = !!progress?.error;
    useEffect(() => {
        if (!logOpen || !provider.getLog) return;
        let stop = false;
        const pull = async () => {
            const id = jobRef.current;
            if (!id) return;
            const text = await provider.getLog!(id).catch(() => '');
            if (!stop && text) setLogText(text);
        };
        void pull();
        // keep polling while the job is live; a failed job's log is static
        const timer = hadError ? 0 : window.setInterval(() => void pull(), 2000);
        return () => {
            stop = true;
            if (timer) clearInterval(timer);
        };
    }, [logOpen, provider, hadError]);
    useEffect(() => {
        // auto-open the log on failure so the post-mortem is one glance away
        if (hadError && provider.getLog) setLogOpen(true);
    }, [hadError, provider]);
    useEffect(() => {
        logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    }, [logText]);

    const close = () => {
        frames.forEach(f => URL.revokeObjectURL(f.thumbUrl));
        if (jobRef.current) void provider.cancelJob(jobRef.current);
        setFrames([]);
        setStep('capture');
        setState({ trainingActive: false });
        runCommand('mode.set', { mode: 'edit' });
    };

    // -- capture ----------------------------------------------------------

    const addImageFiles = async (files: File[]) => {
        const images = files.filter(f => ACCEPTED_IMAGE_TYPES.includes(f.type));
        if (images.length === 0) return;
        setBusy(`Analyzing ${images.length} images…`);
        const analyzed: FrameInfo[] = [];
        for (const f of images) {
            try {
                analyzed.push(await analyzeImage(f, f.name));
            } catch { /* unreadable image — skip */ }
        }
        setFrames(prev => {
            const next = [...prev, ...analyzed];
            markDuplicates(next);
            return next;
        });
        setBusy(null);
        setState({ trainingActive: true });
        setStep('review');
    };

    const extractVideo = async (file: File, mode: SamplingMode) => {
        setBusy('Extracting frames…');
        try {
            const extracted = await extractVideoFrames(file, mode, (done, total) => {
                setBusy(`Extracting frames… ${done}/${total}`);
            });
            frames.forEach(f => URL.revokeObjectURL(f.thumbUrl));
            setFrames(extracted);
            setState({ trainingActive: true });
            setStep('review');
        } catch (err) {
            setBusy(null);
            alert(err instanceof Error ? err.message : String(err));
            return;
        }
        setBusy(null);
    };

    const onFiles = (files: File[]) => {
        const video = files.find(f => ACCEPTED_VIDEO_TYPES.includes(f.type));
        if (video) {
            setVideoFile(video);
            void extractVideo(video, { kind: 'fps', fps });
        } else {
            void addImageFiles(files);
        }
    };

    const pick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_VIDEO_TYPES].join(',');
        input.onchange = () => onFiles(Array.from(input.files ?? []));
        input.click();
    };

    // -- review helpers ------------------------------------------------------

    const setAll = (accepted: boolean) => {
        setFrames(prev => prev.map(f => ({ ...f, accepted })));
    };

    const toggle = (id: number) => {
        setFrames(prev => prev.map(f => (f.id === id ? { ...f, accepted: !f.accepted } : f)));
    };

    const remove = (id: number) => {
        setFrames(prev => {
            const gone = prev.find(f => f.id === id);
            if (gone) URL.revokeObjectURL(gone.thumbUrl);
            return prev.filter(f => f.id !== id);
        });
    };

    const move = (id: number, dir: -1 | 1) => {
        setFrames(prev => {
            const idx = prev.findIndex(f => f.id === id);
            const to = idx + dir;
            if (idx < 0 || to < 0 || to >= prev.length) return prev;
            const next = [...prev];
            const [f] = next.splice(idx, 1);
            next.splice(to, 0, f);
            return next;
        });
    };

    const acceptedFrames = frames.filter(f => f.accepted);

    // -- reconstruction ------------------------------------------------------

    const startReconstruction = async () => {
        setStep('reconstruct');
        cancelledRef.current = false;
        setLogOpen(false);
        setLogText('');
        setProgress({ stageIndex: 0, stageProgress: 0, done: false, elapsedMs: 0 });
        try {
            const job = await provider.createJob({
                images: acceptedFrames.map(f => ({ name: f.name, blob: f.blob }))
            });
            jobRef.current = job.id;

            for (;;) {
                if (cancelledRef.current) return;
                const p = await provider.getProgress(job.id);
                setProgress(p);
                if (p.error) throw new Error(p.error);
                if (p.done) break;
                await new Promise(r => setTimeout(r, 300));
            }

            const result = await provider.getResult(job.id);
            jobRef.current = null;
            scene.openFile(result.file);
            close();
        } catch (err) {
            // keep jobRef: the failed job's log stays fetchable for diagnosis
            setProgress(p => p ? { ...p, error: err instanceof Error ? err.message : String(err) } : p);
        }
    };

    const cancelReconstruction = () => {
        cancelledRef.current = true;
        if (jobRef.current) void provider.cancelJob(jobRef.current);
        jobRef.current = null;
        setProgress(null);
        setStep('review');
    };

    useEffect(() => () => {
        // unmount safety: stop polling loop
        cancelledRef.current = true;
    }, []);

    const stepIndex = STEPS.findIndex(s => s.id === step);

    const providerBanner = (
        <div className={provider.isSimulation ? styles.bannerWarn : styles.bannerOk}>
            {provider.isSimulation ? (
                <span>
                    <strong>No reconstruction engine connected.</strong> The demo provider
                    simulates the pipeline and arranges your photos as flat panels — it
                    does <strong>not</strong> train a real 3D model.
                </span>
            ) : (
                <span>Reconstruction service: <strong>{serviceUrl}</strong>{pingResult ? ` — ${pingResult}` : ''}</span>
            )}
            <span className={styles.bannerActions}>
                {!provider.isSimulation && (
                    <button onClick={async () => {
                        const r = await pingService(serviceUrl!);
                        setPingResult(r.ok ? r.detail : `unreachable (${r.detail})`);
                    }}>
                        Test
                    </button>
                )}
                <button onClick={() => { setUrlDraft(serviceUrl ?? 'http://localhost:8787'); setConfigOpen(!configOpen); }}>
                    {provider.isSimulation ? 'Connect service…' : 'Change…'}
                </button>
                {!provider.isSimulation && (
                    <button onClick={() => { setServiceUrl(null); setServiceUrlState(null); setPingResult(null); }}>
                        Disconnect
                    </button>
                )}
            </span>
        </div>
    );

    const configRow = configOpen && (
        <div className={styles.configRow}>
            <input
                type="text"
                placeholder="http://localhost:8787"
                value={urlDraft}
                onChange={e => setUrlDraft(e.target.value)}
                onKeyDown={e => e.stopPropagation()}
            />
            <button
                onClick={async () => {
                    const url = urlDraft.trim().replace(/\/$/, '');
                    if (!url) return;
                    const r = await pingService(url);
                    if (r.ok) {
                        setServiceUrl(url);
                        setServiceUrlState(url);
                        setPingResult(r.detail);
                        setConfigOpen(false);
                    } else {
                        setPingResult(`unreachable (${r.detail})`);
                    }
                }}
            >
                Connect
            </button>
            <span className={styles.configHint}>
                Any service implementing the jobs REST contract — see tools/reconstruction-server for the local
                Spirula Studio bridge. {pingResult && !serviceUrl ? pingResult : ''}
            </span>
        </div>
    );

    return (
        <div className={styles.screen}>
            <header className={styles.header}>
                <h1>Create splat</h1>
                <nav className={styles.steps}>
                    {STEPS.map((s, i) => (
                        <span key={s.id} className={i === stepIndex ? styles.stepActive : i < stepIndex ? styles.stepDone : ''}>
                            {i + 1} {s.label}
                        </span>
                    ))}
                </nav>
                <button className={styles.close} title="Discard and return to Edit mode" onClick={close}><CrossIcon /></button>
            </header>

            {step === 'capture' && (
                <>
                {providerBanner}
                {configRow}
                <div
                    className={`${styles.dropZone} ${dragOver ? styles.dragOver : ''}`}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => {
                        e.preventDefault();
                        setDragOver(false);
                        onFiles(Array.from(e.dataTransfer.files));
                    }}
                >
                    <h2>Drop photos or a video</h2>
                    <p>20+ overlapping photos (JPG · PNG · WebP) or a video (MP4 · MOV · WebM)</p>
                    <button className={styles.primary} onClick={pick}>
                        Choose files
                    </button>
                    {busy && <p className={styles.busyLine}>{busy}</p>}
                </div>
                </>
            )}

            {step === 'review' && (
                <div className={styles.review}>
                    {providerBanner}
                    {configRow}
                    <div className={styles.reviewBar}>
                        <span>{acceptedFrames.length} of {frames.length} frames selected</span>
                        {videoFile && (
                            <label className={styles.sampling}>
                                Frames per second
                                <select
                                    value={fps}
                                    onChange={e => {
                                        const v = Number(e.target.value) as 1 | 2 | 5 | 10;
                                        setFps(v);
                                        void extractVideo(videoFile, { kind: 'fps', fps: v });
                                    }}
                                >
                                    {FPS_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
                                </select>
                            </label>
                        )}
                        <span className={styles.spacer} />
                        <button onClick={() => setAll(true)}>Select all</button>
                        <button onClick={() => setAll(false)}>Deselect all</button>
                        <button onClick={() => setStep('capture')}>Add more</button>
                        <button
                            className={styles.primary}
                            disabled={acceptedFrames.length < 2 || !!busy}
                            title={acceptedFrames.length < 2 ? 'Select at least 2 frames' : `Run with ${provider.name}`}
                            onClick={() => void startReconstruction()}
                        >
                            {provider.isSimulation
                                ? `Simulate with ${acceptedFrames.length} frames`
                                : `Reconstruct ${acceptedFrames.length} frames`}
                        </button>
                    </div>
                    {busy && <p className={styles.busyLine}>{busy}</p>}
                    <div className={styles.grid}>
                        {frames.map(f => (
                            <div
                                key={f.id}
                                className={`${styles.frame} ${f.accepted ? '' : styles.rejected}`}
                                onClick={() => toggle(f.id)}
                                title={f.accepted ? 'Click to reject' : 'Click to include'}
                            >
                                <img src={f.thumbUrl} alt={f.name} />
                                <div className={styles.frameMeta}>
                                    <span className={styles.frameName}>{f.name}</span>
                                    <span>{f.width}×{f.height} · {fmtBytes(f.size)}</span>
                                    {f.warnings.map(w => <span key={w} className={styles.warning}>{w}</span>)}
                                </div>
                                <div className={styles.frameActions} onClick={e => e.stopPropagation()}>
                                    <button title="Move earlier" onClick={() => move(f.id, -1)}>↑</button>
                                    <button title="Move later" onClick={() => move(f.id, 1)}>↓</button>
                                    <button title="Remove frame" onClick={() => remove(f.id)}><CrossIcon /></button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {step === 'reconstruct' && progress && (() => {
                const diag = progress.diag;
                const stageMs = new Map((diag?.stageTimes ?? []).map(t => [t.stage, t.ms]));
                const regBad = diag?.registeredImages !== undefined && diag.totalImages
                    ? diag.registeredImages < diag.totalImages * 0.75
                    : false;
                return (
                    <div className={`${styles.reconstruct} ${progress.viewerUrl ? styles.withPreview : ''}`}>
                        {progress.viewerUrl && (
                            <iframe
                                className={styles.livePreview}
                                src={progress.viewerUrl}
                                title="Live training preview"
                            />
                        )}
                        <div className={styles.reconstructBody}>
                        <h2>{provider.name}</h2>
                        {progress.viewerUrl && (
                            <p className={styles.previewNote}>
                                Live preview from the trainer. The finished splat opens in the editor.
                            </p>
                        )}
                        <ul className={styles.stages}>
                            {provider.stages.map((s, i) => (
                                <li key={s.id} className={i < progress.stageIndex || progress.done ? styles.stageDone : i === progress.stageIndex ? styles.stageActive : ''}>
                                    <span className={styles.stageMark}>
                                        {i < progress.stageIndex || progress.done ? '✓' : i === progress.stageIndex ? `${Math.round(progress.stageProgress * 100)}%` : ''}
                                    </span>
                                    {s.label}
                                    {stageMs.has(i) && <span className={styles.stageTime}>{(stageMs.get(i)! / 1000).toFixed(1)}s</span>}
                                </li>
                            ))}
                        </ul>

                        {progress.warning && <p className={styles.warnLine}>⚠ {progress.warning}</p>}

                        {diag?.registeredImages !== undefined && (
                            <p className={`${styles.diagLine} ${regBad ? styles.diagBad : ''}`}>
                                poses: {diag.registeredImages}/{diag.totalImages ?? '?'} photos registered
                                {diag.points !== undefined ? ` · ${diag.points.toLocaleString()} points` : ''}
                                {diag.fragments !== undefined && diag.fragments > 1 ? ` · ${diag.fragments} fragments` : ''}
                                {diag.reprojError !== undefined ? ` · reproj ${diag.reprojError.toFixed(2)}px` : ''}
                            </p>
                        )}
                        {diag?.step !== undefined && (
                            <p className={styles.diagLine}>
                                training: step {diag.step.toLocaleString()}{diag.totalSteps ? ` / ${diag.totalSteps.toLocaleString()}` : ''}
                            </p>
                        )}
                        {diag?.loss && diag.loss.length >= 2 && <LossSparkline series={diag.loss} />}
                        {diag?.resultSplats !== undefined && (
                            <p className={styles.diagLine}>
                                result: {diag.resultSplats.toLocaleString()} splats
                                {diag.resultBytes !== undefined ? ` · ${fmtBytes(diag.resultBytes)}` : ''}
                            </p>
                        )}

                        <p className={styles.elapsed}>
                            {acceptedFrames.length} images · {(progress.elapsedMs / 1000).toFixed(0)}s elapsed
                        </p>
                        {progress.error && <p className={styles.error}>{progress.error}</p>}

                        <div className={styles.diagActions}>
                            {provider.getLog && (
                                <button onClick={() => setLogOpen(!logOpen)}>
                                    {logOpen ? 'Hide log' : 'Show log'}
                                </button>
                            )}
                            {logOpen && logText && (
                                <button onClick={() => void navigator.clipboard.writeText(logText)}>
                                    Copy log
                                </button>
                            )}
                            <button onClick={cancelReconstruction}>{progress.error ? 'Back' : 'Cancel'}</button>
                        </div>
                        {logOpen && <pre ref={logRef} className={styles.logView}>{logText || 'Waiting for log…'}</pre>}
                        </div>
                    </div>
                );
            })()}
        </div>
    );
};
