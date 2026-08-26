import { useState } from 'react';

import { runCommand, scene } from '../core/scene-manager';
import { setState, useAppState } from '../core/store';
import styles from './MenuBar.module.scss';
import { pickSplatFile } from './useFileDrop';

interface MenuItem {
    label?: string;
    shortcut?: string;
    action?: () => void;
    disabled?: boolean;
    separator?: boolean;
}

export const MenuBar = () => {
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const app = useAppState();
    const hasScene = app.stats !== null;
    const hasSelection = (app.stats?.selected ?? 0) > 0;

    const menus: Record<string, MenuItem[]> = {
        File: [
            { label: 'Open…', shortcut: '⌘O', action: () => pickSplatFile(f => scene.openAny(f)) },
            {
                label: 'Open PLY sequence…',
                action: () => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.multiple = true;
                    input.accept = '.ply';
                    input.onchange = () => {
                        const files = Array.from(input.files ?? []);
                        if (files.length) scene.openDropped(files);
                    };
                    input.click();
                }
            },
            { label: 'Create splat…', action: () => { setState({ trainingSource: 'photos' }); runCommand('mode.set', { mode: 'training' }); } },
            { label: 'Save project…', shortcut: '⌘S', disabled: !hasScene, action: () => runCommand('project.saveOpen') },
            { separator: true },
            { label: 'Export…', shortcut: '⌘E', disabled: !hasScene, action: () => runCommand('export.open') },
            { label: 'Render video…', disabled: !hasScene, action: () => runCommand('render.open') },
            { separator: true },
            { label: 'Close scene', disabled: !hasScene, action: () => runCommand('scene.close') }
        ],
        Edit: [
            { label: 'Undo', shortcut: '⌘Z', disabled: !app.canUndo, action: () => runCommand('edit.undo') },
            { label: 'Redo', shortcut: '⇧⌘Z', disabled: !app.canRedo, action: () => runCommand('edit.redo') },
            { separator: true },
            { label: 'Delete selected', shortcut: '⌫', disabled: !hasSelection, action: () => runCommand('select.delete') },
            { separator: true },
            { label: 'Pick origin point', shortcut: 'O', disabled: !hasScene, action: () => runCommand('origin.pickStart') },
            { label: 'Origin from selection', disabled: !hasSelection, action: () => runCommand('model.originFromSelection') },
            { label: 'Reset origin', disabled: !hasScene, action: () => runCommand('model.resetOrigin') }
        ],
        Select: [
            { label: 'All', shortcut: '⌘A', disabled: !hasScene, action: () => runCommand('select.all') },
            { label: 'None', shortcut: 'Esc', disabled: !hasSelection, action: () => runCommand('select.none') },
            { label: 'Invert', shortcut: '⌘I', disabled: !hasScene, action: () => runCommand('select.invert') },
            { separator: true },
            { label: 'Crop to selection', disabled: !hasSelection, action: () => runCommand('select.crop') },
            { separator: true },
            { label: 'New layer from selection', disabled: !hasSelection, action: () => runCommand('layer.create') }
        ],
        View: [
            { label: 'Frame selection', shortcut: 'F', disabled: !hasScene, action: () => runCommand('camera.frameSelection') },
            { label: 'Frame scene', shortcut: '⇧F', disabled: !hasScene, action: () => runCommand('camera.frameScene') },
            { label: 'Reset camera', shortcut: '0', disabled: !hasScene, action: () => runCommand('camera.reset') },
            { separator: true },
            ...([
                ['beauty', 'Beauty'],
                ['opacity', 'Opacity heatmap'],
                ['depth', 'Depth heatmap'],
                ['selected', 'Selected only']
            ] as const).map(([mode, label]) => ({
                label: `${app.viewMode === mode ? '● ' : '○ '}${label}`,
                disabled: !hasScene,
                action: () => runCommand('view.setMode', { mode })
            })),
            { separator: true },
            { label: `${app.lookThrough ? '● ' : '○ '}Look through shot camera`, shortcut: 'C', disabled: !hasScene, action: () => runCommand('view.lookThrough') },
            { label: `${app.showGrid ? '● ' : '○ '}Grid`, action: () => runCommand('view.grid') },
            { label: `${app.showGroundPlane ? '● ' : '○ '}Ground plane`, action: () => runCommand('view.groundPlane') },
            { label: `${app.showCameraViz ? '● ' : '○ '}Camera avatar & path`, action: () => runCommand('view.cameraViz') },
            { label: `${app.showGizmos ? '● ' : '○ '}Gizmos`, action: () => runCommand('view.gizmos') },
            { label: `${app.showSelectionTint ? '● ' : '○ '}Selection tint`, action: () => runCommand('view.selectionTint') },
            { label: 'Toggle all overlays', shortcut: '⇧H', action: () => runCommand('view.overlays') },
            { separator: true },
            { label: `${app.timelineVisible ? 'Hide' : 'Show'} timeline`, shortcut: 'T', action: () => runCommand('view.timeline') },
            { label: `${app.perfHudVisible ? 'Hide' : 'Show'} performance HUD`, action: () => runCommand('view.perfHud') },
            { label: 'Save camera from view', disabled: !hasScene, action: () => runCommand('camera.saveView') },
            { separator: true },
            { label: `${app.leftPanelOpen ? 'Hide' : 'Show'} project panel`, action: () => setState({ leftPanelOpen: !app.leftPanelOpen }) },
            { label: `${app.rightPanelOpen ? 'Hide' : 'Show'} inspector`, action: () => setState({ rightPanelOpen: !app.rightPanelOpen }) },
            {
                label: 'Toggle side panels',
                shortcut: 'Tab',
                action: () => {
                    const anyOpen = app.leftPanelOpen || app.rightPanelOpen;
                    setState({ leftPanelOpen: !anyOpen, rightPanelOpen: !anyOpen });
                }
            }
        ]
    };

    const modes = [
        { id: 'edit', label: 'Edit', hint: 'Select, clean up and organize splats' },
        { id: 'training', label: 'Training', hint: 'Reconstruct a splat from photos or video' },
        { id: 'animation', label: 'Animation', hint: 'Camera and model animation, video render' }
    ] as const;

    return (
        <nav className={styles.bar}>
            <span className={styles.logo}>EiDOlON</span>
            <div className={styles.modeTabs}>
                {modes.map(m => (
                    <button
                        key={m.id}
                        className={`${styles.modeTab} ${app.mode === m.id ? styles.modeActive : ''}`}
                        title={m.hint}
                        onClick={() => runCommand('mode.set', { mode: m.id })}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            {Object.entries(menus).map(([name, items]) => (
                <div key={name} className={styles.menu}>
                    <button
                        className={openMenu === name ? styles.open : ''}
                        onClick={() => setOpenMenu(openMenu === name ? null : name)}
                        onMouseEnter={() => openMenu && setOpenMenu(name)}
                    >
                        {name}
                    </button>
                    {openMenu === name && (
                        <div className={styles.dropdown}>
                            {items.map((item, i) => item.separator ? (
                                <div key={i} className={styles.separator} />
                            ) : (
                                <button
                                    key={item.label}
                                    disabled={item.disabled}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        item.action?.();
                                    }}
                                >
                                    <span>{item.label}</span>
                                    {item.shortcut && <kbd>{item.shortcut}</kbd>}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            ))}
            {openMenu && <div className={styles.clickAway} onClick={() => setOpenMenu(null)} />}
        </nav>
    );
};
