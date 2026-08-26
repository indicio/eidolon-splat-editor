import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { runCommand, scene, type SelectMode } from '../core/scene-manager';
import { getState, useAppState } from '../core/store';
import { PerfHud } from './PerfHud';
import styles from './Viewport.module.scss';
import { useFileDrop } from './useFileDrop';

interface Marquee {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

type DragKind = 'orbit' | 'pan' | 'marquee' | 'brush' | 'lasso' | null;

const ACCENT = 'rgba(224, 160, 60, 0.35)';
const ACCENT_LINE = 'rgba(224, 160, 60, 0.9)';

const modeFromEvent = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): SelectMode =>
    e.shiftKey ? 'add' : (e.metaKey || e.ctrlKey) ? 'remove' : 'set';

export const Viewport = () => {
    const hostRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const ringRef = useRef<HTMLDivElement>(null);
    const { tool, stats, pickingOrigin, brushRadius, perfHudVisible, renderAspect, mode, renderWidth, renderHeight, viewFieldScale, modalHint } = useAppState();
    const toolRef = useRef(tool);
    toolRef.current = tool;
    const pickingRef = useRef(pickingOrigin);
    pickingRef.current = pickingOrigin;

    const dragRef = useRef<{ kind: DragKind; lastX: number; lastY: number; startX: number; startY: number; overGizmo: boolean }>({
        kind: null, lastX: 0, lastY: 0, startX: 0, startY: 0, overGizmo: false
    });
    const lassoRef = useRef<{ x: number; y: number }[]>([]);
    const [marquee, setMarquee] = useState<Marquee | null>(null);

    const { dragOver, dropProps } = useFileDrop(f => scene.openAny(f), undefined, files => scene.openDropped(files));

    useEffect(() => {
        const host = hostRef.current!;
        const canvas = canvasRef.current!;
        scene.onViewportReady(canvas);

        const syncSize = () => {
            scene.resize(host.clientWidth, host.clientHeight);
            const overlay = overlayRef.current!;
            overlay.width = host.clientWidth;
            overlay.height = host.clientHeight;
        };
        syncSize();

        const ro = new ResizeObserver(syncSize);
        ro.observe(host);

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const factor = 1 + Math.max(-100, Math.min(100, e.deltaY)) * 0.002;
            // animation: the wheel zooms the lens (scales the view field);
            // alt-scroll keeps the dolly for stage navigation
            if (getState().mode === 'animation' && !e.altKey) {
                scene.zoomFov(factor);
            } else {
                scene.orbit.dolly(factor);
            }
        };
        host.addEventListener('wheel', onWheel, { passive: false });

        return () => {
            ro.disconnect();
            host.removeEventListener('wheel', onWheel);
        };
    }, []);

    const localPos = (e: ReactPointerEvent) => {
        const rect = hostRef.current!.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const overlayCtx = () => overlayRef.current!.getContext('2d')!;

    const clearOverlay = () => {
        const overlay = overlayRef.current!;
        overlay.getContext('2d')!.clearRect(0, 0, overlay.width, overlay.height);
    };

    const stampBrush = (x0: number, y0: number, x1: number, y1: number) => {
        const ctx = overlayCtx();
        const r = getState().brushRadius;
        ctx.fillStyle = ACCENT;
        const dist = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.ceil(dist / (r * 0.4)));
        for (let s = 0; s <= steps; ++s) {
            const t = s / steps;
            ctx.beginPath();
            ctx.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, 0, Math.PI * 2);
            ctx.fill();
        }
    };

    const drawLasso = (closeAndFill: boolean) => {
        const pts = lassoRef.current;
        if (pts.length < 2) return;
        const ctx = overlayCtx();
        ctx.clearRect(0, 0, overlayRef.current!.width, overlayRef.current!.height);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; ++i) ctx.lineTo(pts[i].x, pts[i].y);
        if (closeAndFill) {
            ctx.closePath();
            ctx.fillStyle = ACCENT;
            ctx.fill();
        } else {
            ctx.strokeStyle = ACCENT_LINE;
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    };

    /** Read the overlay's alpha channel as a binary selection mask and commit. */
    const commitMask = (e: ReactPointerEvent, source: 'brush' | 'lasso') => {
        const overlay = overlayRef.current!;
        const { width, height } = overlay;
        if (width === 0 || height === 0) return;
        const img = overlay.getContext('2d')!.getImageData(0, 0, width, height).data;
        const mask = new Uint8Array(width * height);
        for (let i = 0, n = mask.length; i < n; ++i) {
            if (img[i * 4 + 3] > 0) mask[i] = 1;
        }
        runCommand('select.byMask', {
            mask, canvasW: width, canvasH: height,
            mode: modeFromEvent(e), source
        });
        clearOverlay();
    };

    const moveRing = (x: number, y: number) => {
        const ring = ringRef.current;
        if (!ring) return;
        const r = getState().brushRadius;
        ring.style.transform = `translate(${x - r}px, ${y - r}px)`;
        ring.style.width = ring.style.height = `${r * 2}px`;
    };

    const onPointerDown = (e: ReactPointerEvent) => {
        const { x, y } = localPos(e);
        const drag = dragRef.current;
        drag.lastX = x;
        drag.lastY = y;
        drag.startX = x;
        drag.startY = y;
        // the gizmo's own canvas listener has already run for this pointerdown
        drag.overGizmo = scene.gizmoOwnsPointer;
        const t = toolRef.current;

        if (pickingRef.current && e.button === 0) {
            const host = hostRef.current!;
            runCommand('origin.pickAt', { x, y, canvasW: host.clientWidth, canvasH: host.clientHeight });
            return;
        }

        if (e.button === 1 || (e.button === 0 && e.shiftKey && t === 'orbit')) {
            drag.kind = 'pan';
        } else if (e.button === 2) {
            drag.kind = 'orbit';
        } else if (e.button === 0) {
            if (t === 'move' || t === 'rotate' || t === 'scale') {
                // the transform gizmo owns the left button
                return;
            }
            if (t === 'rect-select' && !e.altKey) {
                drag.kind = 'marquee';
                setMarquee({ x0: x, y0: y, x1: x, y1: y });
            } else if (t === 'brush' && !e.altKey) {
                drag.kind = 'brush';
                clearOverlay();
                stampBrush(x, y, x, y);
            } else if (t === 'lasso' && !e.altKey) {
                drag.kind = 'lasso';
                lassoRef.current = [{ x, y }];
            } else if (t === 'drag' && !e.altKey) {
                drag.kind = 'pan';
            } else {
                drag.kind = 'orbit';
            }
        } else {
            return;
        }
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: ReactPointerEvent) => {
        const { x, y } = localPos(e);
        if (toolRef.current === 'brush') moveRing(x, y);

        const drag = dragRef.current;
        if (!drag.kind) return;
        const dx = x - drag.lastX;
        const dy = y - drag.lastY;

        if (drag.kind === 'orbit') {
            scene.orbit.orbit(dx, dy);
        } else if (drag.kind === 'pan') {
            scene.orbit.pan(dx, dy, hostRef.current!.clientHeight, scene.fov);
        } else if (drag.kind === 'marquee') {
            setMarquee(m => (m ? { ...m, x1: x, y1: y } : m));
        } else if (drag.kind === 'brush') {
            stampBrush(drag.lastX, drag.lastY, x, y);
        } else if (drag.kind === 'lasso') {
            const pts = lassoRef.current;
            const last = pts[pts.length - 1];
            if (Math.hypot(x - last.x, y - last.y) > 3) {
                pts.push({ x, y });
                drawLasso(false);
            }
        }
        drag.lastX = x;
        drag.lastY = y;
    };

    const onPointerUp = (e: ReactPointerEvent) => {
        const drag = dragRef.current;

        // animation mode: a stationary left-click (not a gizmo grab, not a
        // drag) directly selects the stage object under the cursor
        if (
            getState().mode === 'animation' && e.button === 0 && !drag.overGizmo &&
            Math.hypot(drag.lastX - drag.startX, drag.lastY - drag.startY) < 4 &&
            getState().stats
        ) {
            const host = hostRef.current!;
            runCommand('stage.pick', {
                x: drag.startX, y: drag.startY,
                canvasW: host.clientWidth, canvasH: host.clientHeight
            });
        }

        // camera view (Blender): orbit/pan while looking through the lens
        // moves the shot camera itself and keys it at the playhead
        if (
            (drag.kind === 'orbit' || drag.kind === 'pan') &&
            getState().mode === 'animation' && getState().lookThrough && getState().stats &&
            Math.hypot(drag.lastX - drag.startX, drag.lastY - drag.startY) >= 4
        ) {
            scene.lockCameraToView();
        }

        if (drag.kind === 'marquee' && marquee) {
            const host = hostRef.current!;
            runCommand('select.rect', {
                x0: marquee.x0, y0: marquee.y0, x1: marquee.x1, y1: marquee.y1,
                canvasW: host.clientWidth, canvasH: host.clientHeight, mode: modeFromEvent(e)
            });
            setMarquee(null);
        } else if (drag.kind === 'brush') {
            commitMask(e, 'brush');
        } else if (drag.kind === 'lasso') {
            drawLasso(true);
            commitMask(e, 'lasso');
            lassoRef.current = [];
        }
        drag.kind = null;
    };

    const marqueeStyle = marquee ? {
        left: Math.min(marquee.x0, marquee.x1),
        top: Math.min(marquee.y0, marquee.y1),
        width: Math.abs(marquee.x1 - marquee.x0),
        height: Math.abs(marquee.y1 - marquee.y0)
    } : undefined;

    const crosshair = pickingOrigin || tool === 'rect-select' || tool === 'lasso';

    return (
        <div
            ref={hostRef}
            className={[
                styles.viewport,
                crosshair ? styles.crosshair : '',
                !pickingOrigin && tool === 'drag' ? styles.grab : '',
                !pickingOrigin && tool === 'brush' ? styles.noCursor : ''
            ].join(' ')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => runCommand('camera.frameScene')}
            onContextMenu={e => e.preventDefault()}
            {...dropProps}
        >
            <canvas ref={canvasRef} className={styles.canvas} />
            <canvas ref={overlayRef} className={styles.overlay} />

            {marquee && <div className={styles.marquee} style={marqueeStyle} />}

            {tool === 'brush' && !pickingOrigin && (
                <div ref={ringRef} className={styles.brushRing} style={{ width: brushRadius * 2, height: brushRadius * 2 }} />
            )}

            {perfHudVisible && <PerfHud />}

            {(() => {
                // output view field: live preview while the render dialog is
                // open, persistent framing guide in the animation workspace
                const aspect = renderAspect ?? (mode === 'animation' && stats ? renderWidth / renderHeight : null);
                if (!aspect || !hostRef.current) return null;
                const scale = !renderAspect && mode === 'animation' ? viewFieldScale : null;
                const hostAR = hostRef.current.clientWidth / Math.max(1, hostRef.current.clientHeight);
                const size = scale !== null
                    ? { width: renderWidth * scale, height: renderHeight * scale }
                    : hostAR > aspect
                        ? { height: '100%', width: `${(aspect / hostAR) * 100}%` }
                        : { width: '100%', height: `${(hostAR / aspect) * 100}%` };
                return (
                    <div className={styles.aspectPreview}>
                        <div className={styles.aspectBox} style={size}>
                            <span className={styles.aspectLabel}>
                                {renderWidth} × {renderHeight}{scale !== null ? ` · ${Math.round(scale * 100)}%` : ''}
                            </span>
                        </div>
                    </div>
                );
            })()}

            {dragOver && (
                <div className={styles.dropOverlay}>
                    <span>Drop to open</span>
                </div>
            )}

            {pickingOrigin && (
                <div className={styles.pickHint}>
                    Click a splat to set the model origin — Esc to cancel
                </div>
            )}

            {modalHint && <div className={styles.pickHint}>{modalHint}</div>}

            {!stats && !dragOver && (
                <div className={styles.emptyHint}>
                    Open a splat file to begin — File ▸ Open, or drop it here
                </div>
            )}
        </div>
    );
};
