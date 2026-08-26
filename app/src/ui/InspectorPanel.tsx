import { MODIFIER_LABELS, MODIFIER_PARAMS, type ModifierType } from '../core/modifiers';
import { runCommand } from '../core/scene-manager';
import { useAppState } from '../core/store';
import { fmtBytes, fmtCount, fmtDist } from './fmt';
import { CrossIcon } from './icons';
import { NumberField } from './NumberField';
import styles from './Panel.module.scss';
import { Section } from './Section';

const ADDABLE: ModifierType[] = ['floaters', 'opacity', 'size', 'cropBox', 'colorGrade'];

export const InspectorPanel = () => {
    const { stats, pickingOrigin, modifiers, canvasColor } = useAppState();

    if (!stats) {
        return (
            <div>
                <Section title="Inspector">
                    <p className={styles.placeholder}>Open a splat to inspect it.</p>
                </Section>
            </div>
        );
    }

    const size = [
        stats.boundsMax[0] - stats.boundsMin[0],
        stats.boundsMax[1] - stats.boundsMin[1],
        stats.boundsMax[2] - stats.boundsMin[2]
    ];

    return (
        <div>
            <Section title="Statistics">
                <div className={styles.row}>
                    <span className={styles.key}>Splats</span>
                    <span className={styles.val}>{fmtCount(stats.totalSplats - stats.deleted)}</span>
                </div>
                <div className={styles.row}>
                    <span className={styles.key}>Deleted</span>
                    <span className={styles.val}>{fmtCount(stats.deleted)}</span>
                </div>
                <div className={styles.row}>
                    <span className={styles.key}>Hidden</span>
                    <span className={styles.val}>{fmtCount(stats.hidden)}</span>
                </div>
                <div className={styles.row}>
                    <span className={styles.key}>Filtered</span>
                    <span className={styles.val}>{fmtCount(stats.filtered)}</span>
                </div>
                <div className={styles.row}>
                    <span className={styles.key}>Source file</span>
                    <span className={styles.val}>{fmtBytes(stats.fileSize)}</span>
                </div>
                <div className={styles.row}>
                    <span className={styles.key}>Bounds</span>
                    <span className={styles.val}>
                        {fmtDist(size[0])} × {fmtDist(size[1])} × {fmtDist(size[2])} m
                    </span>
                </div>
            </Section>

            <Section title="Selection">
                <div className={styles.row}>
                    <span className={styles.key}>Selected</span>
                    <span className={styles.val}>{fmtCount(stats.selected)}</span>
                </div>
                <div className={styles.buttonRow}>
                    <button onClick={() => runCommand('select.all')}>All</button>
                    <button disabled={stats.selected === 0} onClick={() => runCommand('select.none')}>None</button>
                    <button onClick={() => runCommand('select.invert')}>Invert</button>
                </div>
                <div className={styles.buttonRow}>
                    <button disabled={stats.selected === 0} onClick={() => runCommand('camera.frameSelection')}>Frame</button>
                    <button disabled={stats.selected === 0} onClick={() => runCommand('select.delete')}>Delete</button>
                    <button
                        disabled={stats.selected === 0}
                        title="Delete everything outside the selection"
                        onClick={() => runCommand('select.crop')}
                    >
                        Crop
                    </button>
                </div>
            </Section>

            <Section title="Origin">
                <div className={styles.vecRow}>
                    <NumberField label="X" value={stats.offset[0]} onCommit={v => runCommand('model.setOffset', { x: v, y: stats.offset[1], z: stats.offset[2] })} />
                    <NumberField label="Y" value={stats.offset[1]} onCommit={v => runCommand('model.setOffset', { x: stats.offset[0], y: v, z: stats.offset[2] })} />
                    <NumberField label="Z" value={stats.offset[2]} onCommit={v => runCommand('model.setOffset', { x: stats.offset[0], y: stats.offset[1], z: v })} />
                </div>
                <div className={styles.buttonRow}>
                    <button
                        className={pickingOrigin ? styles.activeButton : ''}
                        title="Click a splat in the viewport to make it the origin (O)"
                        onClick={() => runCommand(pickingOrigin ? 'origin.pickCancel' : 'origin.pickStart')}
                    >
                        {pickingOrigin ? 'Picking… (Esc)' : 'Pick in viewport'}
                    </button>
                    <button
                        disabled={stats.selected === 0}
                        title="Make the center of the selection the origin"
                        onClick={() => runCommand('model.originFromSelection')}
                    >
                        From selection
                    </button>
                </div>
                <div className={styles.buttonRow}>
                    <button
                        disabled={stats.offset.every(v => v === 0)}
                        onClick={() => runCommand('model.resetOrigin')}
                    >
                        Reset origin
                    </button>
                </div>
            </Section>

            <Section title="Transform" defaultOpen={false}>
                <div className={styles.vecRow}>
                    <NumberField label="RX" step={1} value={stats.rotation[0]} onCommit={v => runCommand('model.setRotation', { x: v, y: stats.rotation[1], z: stats.rotation[2] })} />
                    <NumberField label="RY" step={1} value={stats.rotation[1]} onCommit={v => runCommand('model.setRotation', { x: stats.rotation[0], y: v, z: stats.rotation[2] })} />
                    <NumberField label="RZ" step={1} value={stats.rotation[2]} onCommit={v => runCommand('model.setRotation', { x: stats.rotation[0], y: stats.rotation[1], z: v })} />
                </div>
                <div className={styles.vecRow}>
                    <NumberField label="Scale" step={0.1} value={stats.scale} onCommit={v => runCommand('model.setScale', { scale: v })} />
                </div>
            </Section>

            <Section title="Canvas" defaultOpen={false}>
                <div className={styles.row}>
                    <span className={styles.key}>Background</span>
                    <input
                        type="color"
                        value={canvasColor}
                        title="Viewport and rendered-video background color"
                        style={{ width: 44, height: 24, padding: 1 }}
                        onChange={e => runCommand('canvas.setColor', { color: e.target.value })}
                    />
                </div>
            </Section>

            <Section title="Modifiers">
                {modifiers.map((mod, idx) => (
                    <div key={mod.id} className={styles.modifier}>
                        <div className={styles.modifierHead}>
                            <input
                                type="checkbox"
                                checked={mod.enabled}
                                title={mod.enabled ? 'Disable' : 'Enable'}
                                onChange={e => runCommand('modifier.setEnabled', { id: mod.id, enabled: e.target.checked })}
                            />
                            <span className={styles.name}>{MODIFIER_LABELS[mod.type]}</span>
                            <button
                                className={styles.iconBtn}
                                disabled={idx === 0}
                                title="Move up"
                                onClick={() => runCommand('modifier.move', { id: mod.id, dir: -1 })}
                            >
                                ↑
                            </button>
                            <button
                                className={styles.iconBtn}
                                disabled={idx === modifiers.length - 1}
                                title="Move down"
                                onClick={() => runCommand('modifier.move', { id: mod.id, dir: 1 })}
                            >
                                ↓
                            </button>
                            <button
                                className={styles.iconBtn}
                                title="Remove modifier"
                                onClick={() => runCommand('modifier.remove', { id: mod.id })}
                            >
                                <CrossIcon />
                            </button>
                        </div>
                        <div className={styles.modifierParams}>
                            {MODIFIER_PARAMS[mod.type].map(def => (
                                <NumberField
                                    key={def.key}
                                    label={def.label}
                                    step={def.step}
                                    value={mod.params[def.key] ?? 0}
                                    onCommit={v => runCommand('modifier.setParam', { id: mod.id, key: def.key, value: v })}
                                />
                            ))}
                        </div>
                    </div>
                ))}

                <div className={styles.buttonRow}>
                    <select
                        className={styles.addSelect}
                        value=""
                        onChange={e => {
                            if (e.target.value) runCommand('modifier.add', { type: e.target.value as ModifierType });
                        }}
                    >
                        <option value="" disabled>Add modifier…</option>
                        {ADDABLE.map(t => <option key={t} value={t}>{MODIFIER_LABELS[t]}</option>)}
                    </select>
                </div>

                {stats.filtered > 0 && (
                    <>
                        <div className={styles.row}>
                            <span className={styles.key}>Filtered out</span>
                            <span className={styles.val}>{fmtCount(stats.filtered)}</span>
                        </div>
                        <div className={styles.buttonRow}>
                            <button
                                title="Permanently delete filtered splats and clear the stack (undoable)"
                                onClick={() => runCommand('modifiers.bake')}
                            >
                                Bake modifiers
                            </button>
                        </div>
                    </>
                )}
            </Section>
        </div>
    );
};
