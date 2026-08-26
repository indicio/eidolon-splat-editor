import { useMemo, useState } from 'react';

import { EXPORT_EXTENSIONS, type ExportFormat } from '../core/export';
import { runCommand, scene } from '../core/scene-manager';
import { useAppState } from '../core/store';
import styles from './ExportDialog.module.scss';
import { fmtBytes, fmtCount } from './fmt';

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
    { id: 'ply', label: 'PLY', hint: 'Uncompressed, universally supported' },
    { id: 'compressed-ply', label: 'Compressed PLY', hint: 'SuperSplat-compatible quantized PLY' },
    { id: 'sog', label: 'SOG', hint: 'Smallest; bundled .sog for web viewers' }
];

export const ExportDialog = () => {
    const { stats, busy } = useAppState();
    const [format, setFormat] = useState<ExportFormat>('ply');
    const [name, setName] = useState(() => scene.outputBaseName());
    const [selectedOnly, setSelectedOnly] = useState(false);
    const [visibleOnly, setVisibleOnly] = useState(true);
    const [applyModifiers, setApplyModifiers] = useState(true);

    const opts = { selectedOnly, visibleOnly, applyModifiers };
    const estimate = useMemo(
        () => scene.exportEstimate(opts, format),
        [selectedOnly, visibleOnly, applyModifiers, format, stats]
    );

    return (
        <div className={styles.backdrop}>
            <div className={styles.dialog}>
                <h2>Export</h2>

                <div className={styles.formats}>
                    {FORMATS.map(f => (
                        <button
                            key={f.id}
                            className={format === f.id ? styles.formatActive : ''}
                            title={f.hint}
                            onClick={() => setFormat(f.id)}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>

                <div className={styles.nameRow}>
                    <label>File name</label>
                    <input value={name} onChange={e => setName(e.target.value)} />
                    <span>{EXPORT_EXTENSIONS[format]}</span>
                </div>

                <label className={styles.option}>
                    <input type="checkbox" checked={applyModifiers} onChange={e => setApplyModifiers(e.target.checked)} />
                    <span>
                        Apply modifiers
                        <small>Exclude splats removed by the modifier stack</small>
                    </span>
                </label>
                <label className={styles.option}>
                    <input type="checkbox" checked={visibleOnly} onChange={e => setVisibleOnly(e.target.checked)} />
                    <span>
                        Visible only
                        <small>Exclude splats on hidden layers</small>
                    </span>
                </label>
                <label className={styles.option}>
                    <input
                        type="checkbox"
                        checked={selectedOnly}
                        disabled={(stats?.selected ?? 0) === 0}
                        onChange={e => setSelectedOnly(e.target.checked)}
                    />
                    <span>
                        Selected only
                        <small>{fmtCount(stats?.selected ?? 0)} splats currently selected</small>
                    </span>
                </label>

                <div className={styles.estimate}>
                    <span>{fmtCount(estimate.count)} splats</span>
                    <span>~{fmtBytes(estimate.size)}</span>
                </div>

                <div className={styles.buttons}>
                    <button
                        className={styles.primary}
                        disabled={estimate.count === 0 || !!busy}
                        onClick={() => runCommand('export.splat', { ...opts, format, name })}
                    >
                        {busy ? 'Exporting…' : `Export ${fmtCount(estimate.count)} splats`}
                    </button>
                    <button onClick={() => runCommand('export.close')}>Cancel</button>
                </div>
            </div>
        </div>
    );
};
