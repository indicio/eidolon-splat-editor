import { useCallback, useEffect, useState } from 'react';

import { runCommand, scene } from '../core/scene-manager';
import { getState, setState, useAppState } from '../core/store';
import { AnimationPanel } from './AnimationPanel';
import styles from './EditorShell.module.scss';
import { ExportDialog } from './ExportDialog';
import { fmtBytes } from './fmt';
import { RenderDialog, RenderProgress } from './RenderDialog';
import { SaveDialog } from './SaveDialog';
import { pickSplatFile } from './useFileDrop';
import { InspectorPanel } from './InspectorPanel';
import { MenuBar } from './MenuBar';
import { ScenePanel } from './ScenePanel';
import { StatusBar } from './StatusBar';
import { Timeline } from './Timeline';
import { ToolBar } from './ToolBar';
import { Viewport } from './Viewport';

const PANEL_MIN = 240;
const PANEL_MAX = 840;

const panelWidth = (key: string, fallback: number) => {
    const v = Number(localStorage.getItem(key));
    return v >= PANEL_MIN && v <= PANEL_MAX ? v : fallback;
};

/** Global keyboard shortcuts, conventional 3D-editor bindings. */
const useShortcuts = () => {
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            const mod = e.metaKey || e.ctrlKey;
            const key = e.key.toLowerCase();
            const editMode = getState().mode === 'edit';

            if (mod && key === 'z') {
                runCommand(e.shiftKey ? 'edit.redo' : 'edit.undo');
            } else if (mod && key === 'a' && editMode) {
                runCommand('select.all');
            } else if (mod && key === 'i' && editMode) {
                runCommand('select.invert');
            } else if (mod && key === 's') {
                runCommand('project.saveOpen');
            } else if (mod && key === 'e') {
                if (getState().stats) runCommand('export.open');
            } else if (mod && key === 'o') {
                pickSplatFile(f => scene.openAny(f));
            } else if (key === 'escape') {
                if (getState().saveOpen) {
                    runCommand('project.saveClose');
                } else if (getState().pickingOrigin) {
                    runCommand('origin.pickCancel');
                } else if (getState().stageSelection !== null) {
                    runCommand('stage.select', { selection: null });
                } else if (getState().selectedKey) {
                    setState({ selectedKey: null });
                } else if (editMode) {
                    runCommand('select.none');
                }
            } else if (key === 'delete' || key === 'backspace' || (key === 'x' && !mod && getState().mode === 'animation')) {
                // a selected timeline key wins; then a selected light (Blender's
                // X delete); then splat deletion in edit mode
                const sel = getState().stageSelection;
                if (!scene.deleteSelectedKey()) {
                    if (getState().mode === 'animation' && sel?.kind === 'light') {
                        runCommand('light.remove', { id: sel.lightId });
                    } else if (editMode && key !== 'x') {
                        runCommand('select.delete');
                    }
                }
            } else if (key === 'f') {
                runCommand(e.shiftKey ? 'camera.frameScene' : 'camera.frameSelection');
            } else if (key === '0' || key === 'home') {
                runCommand('camera.reset');
            } else if (key === 'o' && !mod && editMode) {
                runCommand(getState().pickingOrigin ? 'origin.pickCancel' : 'origin.pickStart');
            } else if (key === 'q' || key === '1') {
                runCommand('tool.set', { tool: 'orbit' });
            } else if (key === 'w' || key === '2') {
                runCommand('tool.set', { tool: 'drag' });
            } else if ((key === 'b' || key === '3') && !mod && editMode) {
                runCommand('tool.set', { tool: 'rect-select' });
            } else if ((key === 'p' || key === '4') && !mod && editMode) {
                runCommand('tool.set', { tool: 'brush' });
            } else if ((key === 'l' || key === '5') && !mod && editMode) {
                runCommand('tool.set', { tool: 'lasso' });
            } else if (key === 'g' && !mod && (editMode || getState().mode === 'animation')) {
                // camera selected → Blender modal grab (X/Y/Z constrains axis)
                if (getState().stageSelection?.kind !== 'camera' || !scene.startCameraModal('grab')) {
                    runCommand('tool.set', { tool: 'move' });
                }
            } else if (key === 'r' && !mod && (editMode || getState().mode === 'animation')) {
                if (getState().stageSelection?.kind !== 'camera' || !scene.startCameraModal('rotate')) {
                    runCommand('tool.set', { tool: 'rotate' });
                }
            } else if (key === 's' && !mod && (editMode || getState().mode === 'animation')) {
                runCommand('tool.set', { tool: 'scale' });
            } else if (key === '[' || key === ']') {
                const r = getState().brushRadius + (key === ']' ? 5 : -5);
                setState({ brushRadius: Math.min(150, Math.max(5, r)) });
            } else if (key === ' ') {
                if (getState().stats) runCommand('timeline.togglePlay');
            } else if (key === 'arrowleft') {
                if (getState().timelineVisible) runCommand('timeline.prev');
                else return;
            } else if (key === 'arrowright') {
                if (getState().timelineVisible) runCommand('timeline.next');
                else return;
            } else if (key === 'k' && !mod) {
                if (getState().stats) runCommand(e.shiftKey ? 'track.model.addKey' : 'track.addKey');
            } else if (key === 'z' && !mod && getState().mode === 'animation') {
                // camera-view zoom: 100% (1:1 output pixels) ↔ fit
                runCommand('view.fieldScale', { scale: getState().viewFieldScale === null ? 1 : null });
            } else if (key === 't' && !mod) {
                runCommand('view.timeline');
            } else if (key === 'c' && !mod) {
                if (getState().stats) runCommand('view.lookThrough');
            } else if (key === 'h' && e.shiftKey && !mod) {
                runCommand('view.overlays');
            } else if (key === 'tab' && !mod) {
                // tray toggle: hide both side panels for a full-width viewport
                const s = getState();
                const anyOpen = s.leftPanelOpen || s.rightPanelOpen;
                setState({ leftPanelOpen: !anyOpen, rightPanelOpen: !anyOpen });
            } else {
                return;
            }
            e.preventDefault();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);
};

export const EditorShell = () => {
    const { busy, error, screen, leftPanelOpen, rightPanelOpen, pendingProject, exportOpen, saveOpen, timelineVisible, renderOpen, renderProgress, mode } = useAppState();
    const [leftW, setLeftW] = useState(() => panelWidth('splatstudio.leftW', 330));
    const [rightW, setRightW] = useState(() => panelWidth('splatstudio.rightW', 420));

    useShortcuts();

    const startResize = useCallback((side: 'left' | 'right', e: React.PointerEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = side === 'left' ? leftW : rightW;

        const onMove = (ev: PointerEvent) => {
            const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
            const w = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + delta));
            if (side === 'left') setLeftW(w);
            else setRightW(w);
        };
        const onUp = (ev: PointerEvent) => {
            const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
            const w = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + delta));
            localStorage.setItem(side === 'left' ? 'splatstudio.leftW' : 'splatstudio.rightW', String(w));
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }, [leftW, rightW]);

    return (
        <div
            className={styles.shell}
            style={{ gridTemplateRows: timelineVisible ? '64px 1fr auto 44px 28px' : '64px 1fr 44px 28px' }}
        >
            <MenuBar />
            <div className={styles.main}>
                {leftPanelOpen && (
                    <aside className={styles.panel} style={{ width: leftW }}>
                        <ScenePanel />
                    </aside>
                )}
                <div
                    className={`${styles.rail} ${leftPanelOpen ? styles.railResizable : ''}`}
                    onPointerDown={leftPanelOpen ? e => startResize('left', e) : undefined}
                >
                    <button
                        className={styles.railBtn}
                        title={`${leftPanelOpen ? 'Hide' : 'Show'} project panel (Tab hides both)`}
                        onPointerDown={e => e.stopPropagation()}
                        onClick={() => setState({ leftPanelOpen: !leftPanelOpen })}
                    >
                        {leftPanelOpen ? '◂' : '▸'}
                    </button>
                </div>
                <Viewport />
                <div
                    className={`${styles.rail} ${rightPanelOpen ? styles.railResizable : ''}`}
                    onPointerDown={rightPanelOpen ? e => startResize('right', e) : undefined}
                >
                    <button
                        className={styles.railBtn}
                        title={`${rightPanelOpen ? 'Hide' : 'Show'} inspector (Tab hides both)`}
                        onPointerDown={e => e.stopPropagation()}
                        onClick={() => setState({ rightPanelOpen: !rightPanelOpen })}
                    >
                        {rightPanelOpen ? '▸' : '◂'}
                    </button>
                </div>
                {rightPanelOpen && (
                    <aside className={styles.panel} style={{ width: rightW }}>
                        {mode === 'animation' ? <AnimationPanel /> : <InspectorPanel />}
                    </aside>
                )}
            </div>
            {timelineVisible && <Timeline />}
            <ToolBar />
            <StatusBar />

            {busy && screen === 'editor' && (
                <div className={styles.busy}>
                    <div className={styles.busyCard}>
                        <div className={styles.spinner} />
                        <span>{busy}</span>
                    </div>
                </div>
            )}

            {error && screen === 'editor' && (
                <div className={styles.errorBanner}>
                    <span>{error}</span>
                    <button onClick={() => setState({ error: null })}>Dismiss</button>
                </div>
            )}

            {exportOpen && <ExportDialog />}
            {saveOpen && <SaveDialog />}
            {renderOpen && <RenderDialog />}
            {renderProgress && <RenderProgress />}

            {pendingProject && (
                <div className={styles.busy}>
                    <div className={styles.locateCard}>
                        <h2>Open project</h2>
                        <p>
                            <strong>{pendingProject.fileName}</strong> references the source splat{' '}
                            <strong>{pendingProject.sourceName}</strong> ({fmtBytes(pendingProject.sourceSize)}).
                        </p>
                        <p>Locate that file to restore the project.</p>
                        <div className={styles.locateButtons}>
                            <button
                                className={styles.locatePrimary}
                                onClick={() => pickSplatFile(f => void scene.providePendingSource(f), '.ply,.sog,.splat,.ksplat,.spz')}
                            >
                                Choose source file
                            </button>
                            <button onClick={() => scene.cancelPendingProject()}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
};
