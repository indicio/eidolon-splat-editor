import { useEffect, useMemo, useState } from 'react';

import { runCommand, scene } from '../core/scene-manager';
import { setState, useAppState } from '../core/store';
import {
    FPS_PRESETS,
    QUALITY_PRESETS,
    SIZE_PRESETS,
    computeBitrate,
    sanitizeSize,
    videoEncodingSupported
} from '../core/video-render';
import styles from './ExportDialog.module.scss';
import { fmtBytes } from './fmt';
import { NumberField } from './NumberField';
import panelStyles from './Panel.module.scss';

export const RenderDialog = () => {
    const { totalFrames, playbackFps, renderWidth, renderHeight } = useAppState();
    const [fps, setFps] = useState(30);
    const [quality, setQuality] = useState('medium');
    const [name, setName] = useState(() => scene.outputBaseName() + '-render');

    // output size lives in the store (the animation view field), so the
    // dialog reflects and updates the same persistent setting
    const width = renderWidth;
    const height = renderHeight;
    const presetId = SIZE_PRESETS.find(p => p.width === width && p.height === height)?.id ?? 'custom';
    const setSize = (w: number, h: number) => runCommand('render.setSize', { width: w, height: h });

    const applyPreset = (id: string) => {
        const p = SIZE_PRESETS.find(x => x.id === id)!;
        if (id === 'viewport') {
            const canvas = document.querySelector('canvas');
            setSize(sanitizeSize(canvas?.clientWidth ?? 1920), sanitizeSize(canvas?.clientHeight ?? 1080));
        } else {
            setSize(p.width, p.height);
        }
    };

    // letterbox aspect preview in the viewport while the dialog is open
    useEffect(() => {
        setState({ renderAspect: width / height });
        return () => setState({ renderAspect: null });
    }, [width, height]);

    const bitsPerPixel = QUALITY_PRESETS.find(q => q.id === quality)!.bitsPerPixel;
    const bitrate = computeBitrate(width, height, fps, bitsPerPixel);
    const durationSec = totalFrames / playbackFps;
    const outFrames = Math.max(1, Math.round(durationSec * fps));
    const estBytes = (bitrate / 8) * durationSec;
    const supported = useMemo(() => videoEncodingSupported(), []);

    return (
        <div className={styles.backdrop}>
            <div className={styles.dialog}>
                <h2>Render video</h2>

                <div className={styles.formats}>
                    {SIZE_PRESETS.map(p => (
                        <button
                            key={p.id}
                            className={presetId === p.id ? styles.formatActive : ''}
                            title={p.id === 'viewport' ? 'Match the current viewport size' : `${p.width} × ${p.height}`}
                            onClick={() => applyPreset(p.id)}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>

                <div className={panelStyles.vecRow}>
                    <NumberField label="W" step={2} value={width} onCommit={v => setSize(v, height)} />
                    <NumberField label="H" step={2} value={height} onCommit={v => setSize(width, v)} />
                </div>

                <div className={styles.nameRow} style={{ marginTop: 8 }}>
                    <label>File name</label>
                    <input value={name} onChange={e => setName(e.target.value)} />
                    <span>.mp4</span>
                </div>

                <div className={styles.formats} style={{ marginTop: 8 }}>
                    {FPS_PRESETS.map(f => (
                        <button
                            key={f}
                            className={fps === f ? styles.formatActive : ''}
                            onClick={() => setFps(f)}
                        >
                            {f}
                        </button>
                    ))}
                </div>
                <div className={panelStyles.vecRow}>
                    <NumberField label="fps" step={1} value={fps} onCommit={v => setFps(Math.max(1, Math.min(120, Math.round(v))))} />
                </div>

                <div className={styles.formats} style={{ marginTop: 8 }}>
                    {QUALITY_PRESETS.map(q => (
                        <button
                            key={q.id}
                            className={quality === q.id ? styles.formatActive : ''}
                            onClick={() => setQuality(q.id)}
                        >
                            {q.label}
                        </button>
                    ))}
                </div>

                <div className={styles.estimate}>
                    <span>{width}×{height} @ {fps}</span>
                    <span>{outFrames} frames · {durationSec.toFixed(1)}s</span>
                    <span>{(bitrate / 1e6).toFixed(1)} Mbps · ~{fmtBytes(estBytes)}</span>
                </div>

                {!supported && (
                    <p className={styles.note}>
                        VideoEncoder is not available in this browser (use Chrome, Edge or Safari 16.4+).
                    </p>
                )}

                <div className={styles.buttons}>
                    <button
                        className={styles.primary}
                        disabled={!supported}
                        onClick={() => runCommand('render.start', { width, height, fps, bitrate, name })}
                    >
                        Render {outFrames} frames
                    </button>
                    <button onClick={() => runCommand('render.close')}>Cancel</button>
                </div>
            </div>
        </div>
    );
};

export const RenderProgress = () => {
    const { renderProgress } = useAppState();
    if (!renderProgress) return null;
    const pct = Math.round((renderProgress.frame / renderProgress.total) * 100);
    return (
        <div className={styles.backdrop}>
            <div className={styles.dialog}>
                <h2>Rendering… {pct}%</h2>
                <div className={styles.estimate}>
                    <span>Frame {renderProgress.frame} / {renderProgress.total}</span>
                    <span>ETA {Math.ceil(renderProgress.etaMs / 1000)}s</span>
                </div>
                <div className={styles.progressBar}>
                    <span style={{ width: `${pct}%` }} />
                </div>
                <div className={styles.buttons}>
                    <button onClick={() => runCommand('render.cancel')}>Cancel</button>
                </div>
            </div>
        </div>
    );
};
