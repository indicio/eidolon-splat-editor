import { useState } from 'react';

import { runCommand } from '../core/scene-manager';
import { useAppState } from '../core/store';
import { fmtCount } from './fmt';
import { AssignIcon, CrossIcon, EyeIcon, EyeOffIcon, LockIcon, TargetIcon, UnlockIcon } from './icons';
import styles from './Panel.module.scss';
import { Section } from './Section';

export const ScenePanel = () => {
    const { stats, layers, cameras, mode } = useAppState();
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editingCamId, setEditingCamId] = useState<number | null>(null);
    const hasSelection = (stats?.selected ?? 0) > 0;
    const showLayers = mode === 'edit';
    const showCameras = mode === 'animation';

    return (
        <div>
            <Section title="Scene">
                {stats ? (
                    <div className={`${styles.item} ${styles.selected}`}>
                        <span className={styles.swatch} />
                        <span className={styles.name} title={stats.fileName}>{stats.fileName}</span>
                        <span className={styles.meta}>{fmtCount(stats.totalSplats - stats.deleted)}</span>
                    </div>
                ) : (
                    <p className={styles.placeholder}>Empty scene</p>
                )}
            </Section>

            {showLayers && <Section title="Layers">
                {layers.length === 0 ? (
                    <p className={styles.placeholder}>Open a splat to organize it into layers.</p>
                ) : (
                    <>
                        {layers.map(layer => (
                            <div key={layer.id} className={styles.layerRow}>
                                <button
                                    className={styles.iconBtn}
                                    title={layer.visible ? 'Hide layer' : 'Show layer'}
                                    onClick={() => runCommand('layer.setVisible', { layerId: layer.id, visible: !layer.visible })}
                                >
                                    {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
                                </button>
                                <button
                                    className={styles.iconBtn}
                                    title={layer.locked ? 'Unlock layer' : 'Lock layer (excluded from selection)'}
                                    onClick={() => runCommand('layer.setLocked', { layerId: layer.id, locked: !layer.locked })}
                                >
                                    {layer.locked ? <LockIcon /> : <UnlockIcon />}
                                </button>
                                <span className={styles.swatch} style={{ background: layer.color }} />
                                {editingId === layer.id ? (
                                    <input
                                        className={styles.renameInput}
                                        autoFocus
                                        defaultValue={layer.name}
                                        onBlur={(e) => {
                                            runCommand('layer.rename', { layerId: layer.id, name: e.target.value });
                                            setEditingId(null);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                            if (e.key === 'Escape') setEditingId(null);
                                            e.stopPropagation();
                                        }}
                                    />
                                ) : (
                                    <span
                                        className={styles.name}
                                        title={`${layer.name} — double-click to rename`}
                                        onDoubleClick={() => setEditingId(layer.id)}
                                    >
                                        {layer.name}
                                    </span>
                                )}
                                <span className={styles.meta}>{fmtCount(layer.count)}</span>
                                <span className={styles.rowActions}>
                                    <button
                                        className={styles.iconBtn}
                                        title="Select layer members"
                                        onClick={() => runCommand('layer.select', { layerId: layer.id })}
                                    >
                                        <TargetIcon />
                                    </button>
                                    <button
                                        className={styles.iconBtn}
                                        disabled={!hasSelection}
                                        title="Assign selection to this layer"
                                        onClick={() => runCommand('layer.assign', { layerId: layer.id })}
                                    >
                                        <AssignIcon />
                                    </button>
                                    {layer.id !== 0 && (
                                        <button
                                            className={styles.iconBtn}
                                            title="Delete layer (members return to Default)"
                                            onClick={() => runCommand('layer.delete', { layerId: layer.id })}
                                        >
                                            <CrossIcon />
                                        </button>
                                    )}
                                </span>
                            </div>
                        ))}
                        <div className={styles.buttonRow}>
                            <button
                                title={hasSelection ? 'New layer containing the current selection' : 'New empty layer'}
                                onClick={() => runCommand('layer.create')}
                            >
                                {hasSelection ? 'New layer from selection' : 'New layer'}
                            </button>
                        </div>
                    </>
                )}
            </Section>}

            {showCameras && <Section title="Cameras">
                {cameras.length === 0 && (
                    <p className={styles.placeholder}>Save viewpoints to jump back to them.</p>
                )}
                {cameras.map(cam => (
                    <div key={cam.id} className={styles.layerRow}>
                        {editingCamId === cam.id ? (
                            <input
                                className={styles.renameInput}
                                autoFocus
                                defaultValue={cam.name}
                                onBlur={(e) => {
                                    runCommand('camera.rename', { id: cam.id, name: e.target.value });
                                    setEditingCamId(null);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                    if (e.key === 'Escape') setEditingCamId(null);
                                    e.stopPropagation();
                                }}
                            />
                        ) : (
                            <span
                                className={styles.name}
                                title="Click to fly here — double-click to rename"
                                style={{ cursor: 'pointer' }}
                                onClick={() => runCommand('camera.goto', { id: cam.id })}
                                onDoubleClick={() => setEditingCamId(cam.id)}
                            >
                                {cam.name}
                            </span>
                        )}
                        <span className={styles.meta}>{cam.fov.toFixed(0)}°</span>
                        <span className={styles.rowActions}>
                            <button
                                className={styles.iconBtn}
                                title="Delete camera"
                                onClick={() => runCommand('camera.remove', { id: cam.id })}
                            >
                                <CrossIcon />
                            </button>
                        </span>
                    </div>
                ))}
                <div className={styles.buttonRow}>
                    <button
                        disabled={!stats}
                        title="Save the current viewpoint"
                        onClick={() => runCommand('camera.saveView')}
                    >
                        Camera from current view
                    </button>
                </div>
            </Section>}
        </div>
    );
};
