import { FX_DEFS } from '../core/fx';
import { runCommand, scene } from '../core/scene-manager';
import { useAppState } from '../core/store';
import { SIZE_PRESETS } from '../core/video-render';
import { fmtCount } from './fmt';
import { CrossIcon, EyeIcon, EyeOffIcon, LockIcon, UnlockIcon } from './icons';

/** "2560×1440" → "16:9" (falls back to a decimal ratio for odd sizes). */
const formatAspect = (w: number, h: number): string => {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const g = gcd(w, h);
    const rw = w / g, rh = h / g;
    return rw <= 32 && rh <= 32 ? `${rw}:${rh}` : `${(w / h).toFixed(2)}:1`;
};
import { NumberField } from './NumberField';
import styles from './Panel.module.scss';
import { Section } from './Section';

/** Right-hand inspector for the Animation workspace. */
export const AnimationPanel = () => {
    const {
        stats, cameraKeys, modelKeys, explodeKeys, explodeAmount, explodeEnabled, frame,
        explodeSeed, explodeTurbulence, explodeSwirl, explodeGravity, explodeSpread,
        lookThrough, cameraAim, fx, fxKeys,
        lights, lightingAmbient, stageSelection, canvasColor,
        renderWidth, renderHeight, viewFieldScale,
        modelVisible, modelLocked, cameraLocked,
        showGrid, showGroundPlane, showCameraViz, showGizmos, showSelectionTint
    } = useAppState();

    const activeLightId = stageSelection?.kind === 'light' ? stageSelection.lightId : null;

    if (!stats) {
        return (
            <div>
                <Section title="Animation">
                    <p className={styles.placeholder}>Open a splat to animate it.</p>
                </Section>
            </div>
        );
    }


    return (
        <div>
            <Section title="Shot camera">
                <div className={styles.buttonRow}>
                    <button
                        className={lookThrough ? styles.activeButton : ''}
                        title="View through the animated camera (C)"
                        onClick={() => runCommand('view.lookThrough')}
                    >
                        {lookThrough ? 'Looking through lens' : 'Director view'}
                    </button>
                </div>
                <div className={styles.vecRow}>
                    <NumberField
                        label="FOV"
                        step={1}
                        value={scene.lensFov}
                        onCommit={v => runCommand('camera.setFov', { fov: v })}
                    />
                </div>
                <div className={styles.buttonRow}>
                    <button
                        className={cameraAim === 'free' ? styles.activeButton : ''}
                        title="Keys keep their own look-at targets"
                        onClick={() => runCommand('camera.setAim', { aim: 'free' })}
                    >
                        Aim: free
                    </button>
                    <button
                        className={cameraAim === 'track' ? styles.activeButton : ''}
                        title="The shot camera always looks at the model, regardless of key targets"
                        onClick={() => runCommand('camera.setAim', { aim: 'track' })}
                    >
                        Aim: track model
                    </button>
                </div>
                <label className={styles.checkRow}>
                    <input type="checkbox" checked={showCameraViz} onChange={() => runCommand('view.cameraViz')} />
                    <span>Show camera avatar in the viewport</span>
                </label>
            </Section>

            <Section title="Layers">
                {(() => {
                    const rows: {
                        key: string;
                        sel: { kind: 'model' } | { kind: 'camera' } | { kind: 'light'; lightId: number };
                        label: string;
                        visible: boolean;
                        locked: boolean;
                        swatch?: string;
                        meta?: string;
                        onVisible: () => void;
                        onDelete?: () => void;
                    }[] = [
                        {
                            key: 'model', sel: { kind: 'model' }, label: 'Model',
                            visible: modelVisible, locked: modelLocked,
                            meta: stats ? fmtCount(stats.totalSplats - stats.deleted) : undefined,
                            onVisible: () => runCommand('model.setVisible', { visible: !modelVisible })
                        },
                        {
                            key: 'camera', sel: { kind: 'camera' }, label: 'Camera',
                            visible: showCameraViz, locked: cameraLocked,
                            onVisible: () => runCommand('view.cameraViz')
                        },
                        ...lights.map((l, i) => ({
                            key: `light-${l.id}`,
                            sel: { kind: 'light', lightId: l.id } as const,
                            label: `Light ${i + 1}`,
                            visible: l.visible !== false,
                            locked: l.locked === true,
                            swatch: l.color,
                            onVisible: () => runCommand('light.set', { id: l.id, visible: l.visible === false }),
                            onDelete: () => runCommand('light.remove', { id: l.id })
                        }))
                    ];
                    return rows.map(row => {
                        const isSel = stageSelection?.kind === row.sel.kind &&
                            (row.sel.kind !== 'light' || (stageSelection?.kind === 'light' && stageSelection.lightId === row.sel.lightId));
                        return (
                            <div key={row.key} className={`${styles.layerRow} ${isSel ? styles.selected : ''}`}>
                                <button
                                    className={styles.iconBtn}
                                    title={row.visible ? 'Hide' : 'Show'}
                                    onClick={row.onVisible}
                                >
                                    {row.visible ? <EyeIcon /> : <EyeOffIcon />}
                                </button>
                                <button
                                    className={styles.iconBtn}
                                    title={row.locked ? 'Unlock' : 'Lock (blocks selection)'}
                                    onClick={() => runCommand('stage.setLocked', { selection: row.sel, locked: !row.locked })}
                                >
                                    {row.locked ? <LockIcon /> : <UnlockIcon />}
                                </button>
                                {row.swatch && <span className={styles.swatch} style={{ background: row.swatch }} />}
                                <span
                                    className={styles.name}
                                    style={{ cursor: row.locked ? 'default' : 'pointer', opacity: row.locked ? 0.5 : 1 }}
                                    title={row.locked ? `${row.label} is locked` : `Select ${row.label} (G / R / S in the viewport)`}
                                    onClick={() => !row.locked && runCommand('stage.select', { selection: isSel ? null : row.sel })}
                                >
                                    {row.label}
                                </span>
                                {row.meta && <span className={styles.meta}>{row.meta}</span>}
                                {row.onDelete && (
                                    <span className={styles.rowActions}>
                                        <button className={styles.iconBtn} title="Delete light (X)" onClick={row.onDelete}>
                                            <CrossIcon />
                                        </button>
                                    </span>
                                )}
                            </div>
                        );
                    });
                })()}
                <div className={styles.buttonRow}>
                    <button disabled={lights.length >= 8} onClick={() => runCommand('light.add')}>
                        ＋ Add light
                    </button>
                </div>
                <div className={styles.buttonRow}>
                    <button disabled={cameraKeys.length === 0} onClick={() => runCommand('track.clear', { track: 'camera' })}>
                        Clear camera keys
                    </button>
                    <button disabled={modelKeys.length === 0} onClick={() => runCommand('track.clear', { track: 'model' })}>
                        Clear model keys
                    </button>
                </div>
            </Section>

            {(!explodeEnabled || FX_DEFS.some(d => !fx[d.id].enabled)) && (
                <Section title="Effects">
                    <select
                        style={{ width: '100%' }}
                        value=""
                        onChange={e => {
                            const v = e.target.value;
                            if (v === 'explode') runCommand('explode.enable');
                            else if (v) runCommand('fx.enable', { id: v });
                        }}
                    >
                        <option value="">＋ Add effect…</option>
                        {!explodeEnabled && <option value="explode">Explode — scatter from the center</option>}
                        {FX_DEFS.filter(d => !fx[d.id].enabled).map(d => (
                            <option key={d.id} value={d.id}>{d.label} — {d.hint}</option>
                        ))}
                    </select>
                </Section>
            )}

            <Section title="Lighting">
                <div className={styles.buttonRow}>
                    <button
                        disabled={lights.length >= 8}
                        title="Add a point light (position, color, intensity — up to 8)"
                        onClick={() => runCommand('light.add')}
                    >
                        ＋ Add light
                    </button>
                </div>
                {lights.length > 0 && (
                    <>
                    <div className={styles.row}>
                        <span className={styles.key}>Ambient</span>
                        <span className={styles.val}>{lightingAmbient.toFixed(2)}</span>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={lightingAmbient}
                        style={{ width: '100%', accentColor: 'var(--accent)', padding: 0, border: 'none', background: 'transparent' }}
                        onChange={e => runCommand('light.ambient', { value: Number(e.target.value) })}
                    />
                    </>
                )}
                    {lights.map((l, i) => (
                        <div
                            key={l.id}
                            className={styles.modifier}
                            style={activeLightId === l.id ? { borderColor: l.color } : undefined}
                        >
                            <div className={styles.modifierHead}>
                                <input
                                    type="color"
                                    value={l.color}
                                    title="Light color"
                                    style={{ width: 34, height: 24, padding: 1 }}
                                    onChange={e => runCommand('light.set', { id: l.id, color: e.target.value })}
                                />
                                <span
                                    className={styles.name}
                                    style={{ cursor: 'pointer', color: activeLightId === l.id ? l.color : undefined }}
                                    title="Click to grab this light with the move gizmo in the viewport (Esc deselects)"
                                    onClick={() => runCommand('light.select', { id: activeLightId === l.id ? null : l.id })}
                                >
                                    Light {i + 1}{activeLightId === l.id ? ' — moving' : ''}
                                </span>
                                <button
                                    className={styles.iconBtn}
                                    title="Remove light"
                                    onClick={() => runCommand('light.remove', { id: l.id })}
                                >
                                    ✕
                                </button>
                            </div>
                            <div className={styles.row}>
                                <span className={styles.key}>Intensity</span>
                                <span className={styles.val}>{l.intensity.toFixed(1)}</span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={10}
                                step={0.1}
                                value={l.intensity}
                                style={{ width: '100%', accentColor: l.color, padding: 0, border: 'none', background: 'transparent' }}
                                onChange={e => runCommand('light.set', { id: l.id, intensity: Number(e.target.value) })}
                            />
                            <div className={styles.vecRow}>
                                <NumberField label="X" value={l.position[0]} onCommit={v => runCommand('light.set', { id: l.id, position: [v, l.position[1], l.position[2]] })} />
                                <NumberField label="Y" value={l.position[1]} onCommit={v => runCommand('light.set', { id: l.id, position: [l.position[0], v, l.position[2]] })} />
                                <NumberField label="Z" value={l.position[2]} onCommit={v => runCommand('light.set', { id: l.id, position: [l.position[0], l.position[1], v] })} />
                            </div>
                        </div>
                    ))}
            </Section>

            {explodeEnabled && <Section title="Explode">
                {([
                    ['Amount', explodeAmount, 0, 3, (v: number) => runCommand('explode.setAmount', { amount: v })],
                    ['Turbulence', explodeTurbulence, 0, 1.5, (v: number) => runCommand('explode.setParam', { param: 'turbulence', value: v })],
                    ['Swirl', explodeSwirl, 0, 2, (v: number) => runCommand('explode.setParam', { param: 'swirl', value: v })],
                    ['Gravity', explodeGravity, 0, 3, (v: number) => runCommand('explode.setParam', { param: 'gravity', value: v })],
                    ['Spread', explodeSpread, 0, 1, (v: number) => runCommand('explode.setParam', { param: 'spread', value: v })]
                ] as [string, number, number, number, (v: number) => void][]).map(([label, value, min, max, commit]) => (
                    <div key={label}>
                        <div className={styles.row}>
                            <span className={styles.key}>{label}</span>
                            <span className={styles.val}>{value.toFixed(2)}</span>
                        </div>
                        <input
                            type="range"
                            min={min}
                            max={max}
                            step={0.01}
                            value={value}
                            style={{ width: '100%', accentColor: 'var(--accent)', padding: 0, border: 'none', background: 'transparent' }}
                            onChange={e => commit(Number(e.target.value))}
                        />
                    </div>
                ))}
                <div className={styles.buttonRow}>
                    <button
                        title="Randomize the scatter directions"
                        onClick={() => runCommand('explode.reseed')}
                    >
                        🎲 Reseed ({explodeSeed})
                    </button>
                </div>
                <div className={styles.buttonRow}>
                    <button
                        className={explodeKeys.includes(frame) ? styles.activeButton : ''}
                        title="Key the current explode amount at the playhead"
                        onClick={() => runCommand(explodeKeys.includes(frame) ? 'track.explode.removeKey' : 'track.explode.addKey')}
                    >
                        {explodeKeys.includes(frame) ? '◆− Remove key' : '◆+ Key amount'}
                    </button>
                    <button disabled={explodeKeys.length === 0} onClick={() => runCommand('track.clear', { track: 'explode' })}>
                        Clear track
                    </button>
                    <button
                        title="Remove the effect: clears the track, resets the amount and hides the lane"
                        onClick={() => runCommand('explode.enable', { on: false })}
                    >
                        Remove effect
                    </button>
                </div>
            </Section>}

            {FX_DEFS.filter(d => fx[d.id].enabled).map(def => {
                const st = fx[def.id];
                const keys = fxKeys[def.id] ?? [];
                const keyHere = keys.includes(frame);
                const sliderStyle = { width: '100%', accentColor: 'var(--accent)', padding: 0, border: 'none', background: 'transparent' } as const;
                const numberParams = def.params.filter(p => p.kind === 'number');
                return (
                    <Section key={def.id} title={def.label}>
                        <div className={styles.row}>
                            <span className={styles.key}>Amount</span>
                            <span className={styles.val}>{st.amount.toFixed(2)}</span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={def.amountMax}
                            step={0.01}
                            value={st.amount}
                            style={sliderStyle}
                            onChange={e => runCommand('fx.setAmount', { id: def.id, amount: Number(e.target.value) })}
                        />
                        {def.params.map(p => p.kind === 'slider' ? (
                            <div key={p.key}>
                                <div className={styles.row}>
                                    <span className={styles.key}>{p.label}</span>
                                    <span className={styles.val}>{st.params[p.key].toFixed(2)}</span>
                                </div>
                                <input
                                    type="range"
                                    min={p.min}
                                    max={p.max}
                                    step={p.step ?? 0.01}
                                    value={st.params[p.key]}
                                    style={sliderStyle}
                                    onChange={e => runCommand('fx.setParam', { id: def.id, key: p.key, value: Number(e.target.value) })}
                                />
                            </div>
                        ) : p.kind === 'select' ? (
                            <div key={p.key} className={styles.row}>
                                <span className={styles.key}>{p.label}</span>
                                <select
                                    value={st.params[p.key]}
                                    onChange={e => runCommand('fx.setParam', { id: def.id, key: p.key, value: Number(e.target.value) })}
                                >
                                    {p.options!.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                                </select>
                            </div>
                        ) : null)}
                        {numberParams.length > 0 && (
                            <div className={styles.vecRow}>
                                {numberParams.map(p => (
                                    <NumberField
                                        key={p.key}
                                        label={p.label}
                                        value={st.params[p.key]}
                                        onCommit={v => runCommand('fx.setParam', { id: def.id, key: p.key, value: v })}
                                    />
                                ))}
                            </div>
                        )}
                        <div className={styles.buttonRow}>
                            <button
                                className={keyHere ? styles.activeButton : ''}
                                title="Key the current amount at the playhead"
                                onClick={() => runCommand(keyHere ? 'track.fx.removeKey' : 'track.fx.addKey', { id: def.id })}
                            >
                                {keyHere ? '◆− Remove key' : '◆+ Key amount'}
                            </button>
                            <button disabled={keys.length === 0} onClick={() => runCommand('track.clear', { track: def.id })}>
                                Clear track
                            </button>
                            <button title="Remove the effect and its track" onClick={() => runCommand('fx.enable', { id: def.id, on: false })}>
                                Remove
                            </button>
                        </div>
                    </Section>
                );
            })}

            <Section title="Overlays">
                {([
                    ['Grid', showGrid, 'view.grid'],
                    ['Ground plane', showGroundPlane, 'view.groundPlane'],
                    ['Camera avatar & path', showCameraViz, 'view.cameraViz'],
                    ['Gizmos', showGizmos, 'view.gizmos'],
                    ['Selection tint', showSelectionTint, 'view.selectionTint']
                ] as const).map(([label, on, cmd]) => (
                    <label key={cmd} className={styles.checkRow}>
                        <input type="checkbox" checked={on} onChange={() => runCommand(cmd)} />
                        <span>{label}</span>
                    </label>
                ))}
            </Section>

            <Section title="Output">
                <div className={styles.row}>
                    <span className={styles.key}>View field</span>
                    <span className={styles.val}>
                        {renderWidth} × {renderHeight} · {formatAspect(renderWidth, renderHeight)}
                    </span>
                </div>
                <select
                    style={{ width: '100%', marginBottom: 6 }}
                    value={SIZE_PRESETS.find(p => p.width === renderWidth && p.height === renderHeight)?.id ?? 'custom'}
                    onChange={e => {
                        const p = SIZE_PRESETS.find(x => x.id === e.target.value);
                        if (p) runCommand('render.setSize', { width: p.width, height: p.height });
                    }}
                >
                    {SIZE_PRESETS.filter(p => p.id !== 'viewport').map(p => (
                        <option key={p.id} value={p.id}>
                            {p.label} — {p.width} × {p.height}
                        </option>
                    ))}
                    <option value="custom" disabled>Custom</option>
                </select>
                <div className={styles.vecRow}>
                    <NumberField label="W" step={2} value={renderWidth} onCommit={v => runCommand('render.setSize', { width: v, height: renderHeight })} />
                    <NumberField label="H" step={2} value={renderHeight} onCommit={v => runCommand('render.setSize', { width: renderWidth, height: v })} />
                </div>
                <div className={styles.buttonRow}>
                    <button
                        className={viewFieldScale === null ? styles.activeButton : ''}
                        title="Scale the camera view to fit this monitor"
                        onClick={() => runCommand('view.fieldScale', { scale: null })}
                    >
                        Fit
                    </button>
                    <button
                        className={viewFieldScale === 1 ? styles.activeButton : ''}
                        title="1 output pixel per screen pixel (Z)"
                        onClick={() => runCommand('view.fieldScale', { scale: 1 })}
                    >
                        100%
                    </button>
                </div>
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
                <div className={styles.buttonRow}>
                    <button onClick={() => runCommand('render.open')}>Render video…</button>
                </div>
            </Section>
        </div>
    );
};
