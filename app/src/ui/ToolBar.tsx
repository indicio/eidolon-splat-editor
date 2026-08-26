import { runCommand } from '../core/scene-manager';
import { setState, useAppState, type Tool } from '../core/store';
import { TimelineOptions } from './Timeline';
import styles from './ToolBar.module.scss';

interface ToolDef {
    id: Tool | string;
    label: string;
    hotkey: string;
    hint: string;
    enabled: boolean;
}

const tools: ToolDef[] = [
    { id: 'orbit', label: 'Orbit', hotkey: 'Q', hint: 'Orbit the camera — drag to orbit, shift-drag to pan, scroll to dolly', enabled: true },
    { id: 'drag', label: 'Drag', hotkey: 'W', hint: 'Drag to move the view — drag pans, alt-drag orbits, scroll dollies', enabled: true },
    { id: 'rect-select', label: 'Box select', hotkey: 'B', hint: 'Drag a rectangle to select splats — shift adds, ⌘ removes', enabled: true },
    { id: 'brush', label: 'Brush', hotkey: 'P', hint: 'Paint a selection — shift adds, ⌘ removes, [ ] resize', enabled: true },
    { id: 'lasso', label: 'Lasso', hotkey: 'L', hint: 'Draw a freehand selection outline — shift adds, ⌘ removes', enabled: true },
    { id: 'move', label: 'Move', hotkey: 'G', hint: 'Move the model with a gizmo — right-drag orbits', enabled: true },
    { id: 'rotate', label: 'Rotate', hotkey: 'R', hint: 'Rotate the model with a gizmo — right-drag orbits', enabled: true },
    { id: 'scale', label: 'Scale', hotkey: 'S', hint: 'Scale the model with a gizmo — right-drag orbits', enabled: true }
];

const ToolButton = ({ t, active, disabled }: { t: ToolDef; active: boolean; disabled: boolean }) => (
    <button
        className={active ? styles.active : ''}
        disabled={disabled}
        title={`${t.hint} (${t.hotkey})`}
        onClick={() => runCommand('tool.set', { tool: t.id })}
    >
        {t.label}
        <kbd className={styles.kbd}>{t.hotkey}</kbd>
    </button>
);

export const ToolBar = () => {
    const { tool, stats, canUndo, canRedo, brushRadius, mode, lookThrough, cameraKeys, modelKeys, frame, stageSelection } = useAppState();
    const hasSelection = (stats?.selected ?? 0) > 0;

    if (mode === 'training') {
        return <div className={styles.bar} />;
    }

    if (mode === 'animation') {
        const camKeyHere = cameraKeys.includes(frame);
        const modelKeyHere = modelKeys.includes(frame);
        const selName = stageSelection?.kind === 'light'
            ? 'the selected light'
            : stageSelection?.kind === 'model' ? 'the model' : 'the shot camera';
        const camBlocked = stageSelection?.kind === 'camera' && lookThrough;
        return (
            <div className={styles.bar}>
                <div className={styles.group}>
                    {tools.filter(t => t.id === 'orbit' || t.id === 'drag').map(t => (
                        <ToolButton key={t.id} t={t} active={tool === t.id} disabled={!stats} />
                    ))}
                    {tools.filter(t => t.id === 'move' || t.id === 'rotate' || t.id === 'scale').map(t => (
                        <ToolButton
                            key={t.id}
                            t={{
                                ...t,
                                hint: camBlocked
                                    ? 'Camera gizmo — switch to the director view (C) first, or click another object'
                                    : `${t.label} ${selName} — click any object in the viewport to select it (camera and model key themselves on release)`
                            }}
                            active={tool === t.id}
                            disabled={!stats || camBlocked}
                        />
                    ))}
                    <button
                        className={lookThrough ? styles.active : ''}
                        disabled={!stats}
                        title={lookThrough ? 'Detach into the director view (C)' : 'Look through the shot camera (C)'}
                        onClick={() => runCommand('view.lookThrough')}
                    >
                        {lookThrough ? 'Through lens' : 'Director view'}
                    </button>
                    <TimelineOptions />
                </div>
                <div className={styles.group}>
                    <button
                        className={camKeyHere ? styles.active : ''}
                        disabled={!stats}
                        title="Key the camera at the playhead (K)"
                        onClick={() => runCommand(camKeyHere ? 'track.removeKey' : 'track.addKey')}
                    >
                        {camKeyHere ? '◆− Camera' : '◆+ Camera'}
                    </button>
                    <button
                        className={modelKeyHere ? styles.active : ''}
                        disabled={!stats}
                        title="Key the model transform at the playhead (⇧K)"
                        onClick={() => runCommand(modelKeyHere ? 'track.model.removeKey' : 'track.model.addKey')}
                    >
                        {modelKeyHere ? '◆− Model' : '◆+ Model'}
                    </button>
                    <button disabled={!stats} title="Reset the camera to the default view (0)" onClick={() => runCommand('camera.reset')}>Reset view</button>
                    <button disabled={!stats} title="Render the timeline to MP4" onClick={() => runCommand('render.open')}>Render…</button>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.bar}>
            <div className={styles.group}>
                {tools.map(t => (
                    <ToolButton key={t.id} t={t} active={tool === t.id} disabled={!t.enabled || !stats} />
                ))}
                <TimelineOptions />
                {tool === 'brush' && (
                    <label className={styles.slider} title="Brush radius ( [ smaller, ] larger )">
                        <span>Radius</span>
                        <input
                            type="range"
                            min={5}
                            max={150}
                            value={brushRadius}
                            onChange={e => setState({ brushRadius: Number(e.target.value) })}
                        />
                        <span className={styles.sliderVal}>{brushRadius}</span>
                    </label>
                )}
            </div>
            <div className={styles.group}>
                <button disabled={!stats} title="Reset the camera to the default view (0)" onClick={() => runCommand('camera.reset')}>Reset view</button>
                <button disabled={!canUndo} title="Undo (⌘Z)" onClick={() => runCommand('edit.undo')}>Undo</button>
                <button disabled={!canRedo} title="Redo (⇧⌘Z)" onClick={() => runCommand('edit.redo')}>Redo</button>
                <button
                    className={styles.danger}
                    disabled={!hasSelection}
                    title="Delete selected splats (⌫)"
                    onClick={() => runCommand('select.delete')}
                >
                    Delete
                </button>
            </div>
        </div>
    );
};
