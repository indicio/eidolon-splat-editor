import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { FX_DEFS } from '../core/fx';
import { runCommand } from '../core/scene-manager';
import { useAppState, type TrackId } from '../core/store';
import { NumberField } from './NumberField';
import styles from './Timeline.module.scss';

const FPS_CHOICES = [12, 15, 24, 25, 30, 50, 60];

/** per-track accent so lanes and keys are identifiable at a glance */
export const TRACK_COLORS: Record<TrackId, string> = {
    camera: '#e0a03c',
    model: '#5f9fd4',
    explode: '#d4634f',
    peel: '#c98ad4',
    dissolve: '#8ac9d4',
    jitter: '#d4c98a',
    wave: '#7fd4a4',
    twist: '#d48a9b',
    fade: '#b8b8c8',
    threshold: '#8aa4d4',
    boxwipe: '#d4a48a'
};

/**
 * Timeline option strip (interpolation / fps / loop / length + selected-key
 * chip). Rendered by the ToolBar below the tracks, next to the tools.
 */
export const TimelineOptions = () => {
    const { interpolation, playbackFps, loopMode, sequence, duration, selectedKey, timelineVisible, playing } = useAppState();
    if (!timelineVisible) return null;

    return (
        <div className={styles.options}>
            <span className={styles.transport}>
                <button title="Previous frame (←)" onClick={() => runCommand('timeline.prev')}>⏮</button>
                <button
                    className={playing ? styles.playing : ''}
                    title="Play / pause (Space)"
                    onClick={() => runCommand(playing ? 'timeline.pause' : 'timeline.play')}
                >
                    {playing ? '⏸' : '▶'}
                </button>
                <button title="Next frame (→)" onClick={() => runCommand('timeline.next')}>⏭</button>
            </span>
            {selectedKey && (
                <span
                    className={styles.selChip}
                    style={{ borderColor: TRACK_COLORS[selectedKey.track], color: TRACK_COLORS[selectedKey.track] }}
                    title="Selected key — drag its diamond to retime, ⌫ to delete, Esc to deselect"
                >
                    ◆ {selectedKey.track} · f{selectedKey.frame + 1}
                </span>
            )}
            <select
                title="Interpolation between keys"
                value={interpolation}
                onChange={e => runCommand('track.setInterpolation', { mode: e.target.value })}
            >
                <option value="linear">Linear</option>
                <option value="ease-in">Ease in</option>
                <option value="ease-out">Ease out</option>
                <option value="ease-in-out">Ease in/out</option>
                <option value="spline">Spline</option>
            </select>
            <select
                title="Playback frames per second"
                value={playbackFps}
                onChange={e => runCommand('timeline.setFps', { fps: Number(e.target.value) })}
            >
                {FPS_CHOICES.map(f => <option key={f} value={f}>{f} fps</option>)}
            </select>
            <select
                title="End-of-timeline behavior"
                value={loopMode}
                onChange={e => runCommand('timeline.setLoop', { mode: e.target.value })}
            >
                <option value="loop">Loop</option>
                <option value="once">Once</option>
                <option value="pingpong">Ping-pong</option>
            </select>
            {!sequence && (
                <span className={styles.durationField} title="Timeline length in frames">
                    <NumberField
                        label="Frames"
                        step={1}
                        value={duration}
                        onCommit={v => runCommand('timeline.setDuration', { frames: v })}
                    />
                </span>
            )}
            {sequence && <span className={styles.seqName} title={sequence.name}>{sequence.name}</span>}
        </div>
    );
};

interface LaneProps {
    track: TrackId;
    label: string;
    keys: number[];
    addCommand: string;
    addParams?: Record<string, unknown>;
}

const Lane = ({ track, label, keys, addCommand, addParams }: LaneProps) => {
    const { totalFrames, selectedKey, frame } = useAppState();
    const stripRef = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<{ from: number; current: number; moved: boolean } | null>(null);

    const frameAt = (clientX: number) => {
        const rect = stripRef.current!.getBoundingClientRect();
        const t = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        return Math.round(t * (totalFrames - 1));
    };

    const pos = (f: number) => `${totalFrames > 1 ? (f / (totalFrames - 1)) * 100 : 0}%`;

    const onKeyPointerDown = (e: ReactPointerEvent, keyFrame: number) => {
        e.stopPropagation();
        runCommand('track.selectKey', { track, frame: keyFrame });
        setDrag({ from: keyFrame, current: keyFrame, moved: false });
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: ReactPointerEvent) => {
        if (!drag) return;
        const f = frameAt(e.clientX);
        if (f !== drag.current) setDrag({ ...drag, current: f, moved: true });
    };

    const onPointerUp = () => {
        if (drag?.moved) {
            runCommand('track.moveKey', { track, from: drag.from, to: drag.current });
        }
        setDrag(null);
    };

    const laneActive = selectedKey?.track === track;

    return (
        <div className={styles.row}>
            <div className={`${styles.left} ${styles.laneLeft}`}>
                <span
                    className={styles.laneLabel}
                    style={laneActive ? { color: TRACK_COLORS[track], fontWeight: 600 } : undefined}
                >
                    <span className={styles.laneDot} style={{ background: TRACK_COLORS[track] }} />
                    {label}
                </span>
                <button
                    className={styles.laneKeyBtn}
                    title={`Key the current ${label.toLowerCase()} state at the playhead`}
                    onClick={() => runCommand(addCommand, addParams)}
                >
                    ◆+
                </button>
            </div>
            <div className={styles.stripCell}>
                <div
                    ref={stripRef}
                    className={styles.laneStrip}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onDoubleClick={(e) => {
                        const f = frameAt(e.clientX);
                        runCommand('timeline.setFrame', { frame: f });
                        runCommand(addCommand, addParams);
                    }}
                    title="Double-click to key the interpolated pose at that frame"
                >
                    <span className={styles.lanePlayhead} style={{ left: pos(frame) }} />
                    {keys.map(f => {
                        const shown = drag && drag.from === f ? drag.current : f;
                        const isSel = selectedKey?.track === track && selectedKey.frame === f;
                        return (
                            <span
                                key={f}
                                className={`${styles.diamond} ${isSel ? styles.diamondSel : ''}`}
                                style={{ left: pos(shown), background: TRACK_COLORS[track] }}
                                title={`${label} key · frame ${shown + 1} — drag to retime, ⌫ to delete`}
                                onPointerDown={e => onKeyPointerDown(e, f)}
                            />
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export const Timeline = () => {
    const {
        frame, totalFrames, cameraKeys, modelKeys, explodeKeys,
        explodeEnabled, timelineExpanded, fx, fxKeys
    } = useAppState();
    const pad = String(totalFrames).length;

    return (
        <div className={styles.wrap}>
            {/* playhead row — the scrubber shares its column with the lane strips */}
            <div className={styles.row}>
                <div className={styles.left}>
                    <button
                        className={styles.chevron}
                        title={timelineExpanded ? 'Collapse track lanes' : 'Expand track lanes'}
                        onClick={() => runCommand('timeline.expand')}
                    >
                        {timelineExpanded ? '▾' : '▸'}
                    </button>
                    <span className={styles.counter}>
                        {String(frame + 1).padStart(pad, '0')}/{totalFrames}
                    </span>
                </div>
                <div className={styles.stripCell}>
                    <input
                        className={styles.scrubber}
                        type="range"
                        min={0}
                        max={Math.max(0, totalFrames - 1)}
                        value={frame}
                        onChange={e => runCommand('timeline.setFrame', { frame: Number(e.target.value) })}
                    />
                    {!timelineExpanded && (
                        <div className={styles.keyMarkers}>
                            {cameraKeys.map(f => (
                                <span
                                    key={f}
                                    className={styles.keyMark}
                                    style={{ left: `${totalFrames > 1 ? (f / (totalFrames - 1)) * 100 : 0}%` }}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {timelineExpanded && (
                <>
                    <Lane track="camera" label="Camera" keys={cameraKeys} addCommand="track.addKey" />
                    <Lane track="model" label="Model" keys={modelKeys} addCommand="track.model.addKey" />
                    {explodeEnabled && (
                        <Lane track="explode" label="Explode" keys={explodeKeys} addCommand="track.explode.addKey" />
                    )}
                    {FX_DEFS.filter(d => fx[d.id].enabled).map(d => (
                        <Lane
                            key={d.id}
                            track={d.id}
                            label={d.label}
                            keys={fxKeys[d.id] ?? []}
                            addCommand="track.fx.addKey"
                            addParams={{ id: d.id }}
                        />
                    ))}
                </>
            )}
        </div>
    );
};
