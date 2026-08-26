import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import styles from './Panel.module.scss';

/**
 * Compact labeled number input. Commits on Enter or blur; re-syncs whenever
 * the external value changes (e.g. undo, origin pick). The label scrubs the
 * value on horizontal drag, ↑/↓ step it, and Shift multiplies both ×10.
 */
export const NumberField = ({ label, value, step = 0.01, onCommit }: {
    label: string;
    value: number;
    step?: number;
    onCommit: (v: number) => void;
}) => {
    const ref = useRef<HTMLInputElement>(null);
    const scrub = useRef<{ lastX: number; acc: number; base: number; active: boolean } | null>(null);

    useEffect(() => {
        if (ref.current && document.activeElement !== ref.current) {
            ref.current.value = String(+value.toFixed(4));
        }
    }, [value]);

    const commit = () => {
        const v = parseFloat(ref.current!.value);
        if (Number.isFinite(v) && v !== value) {
            onCommit(v);
        } else if (ref.current) {
            ref.current.value = String(+value.toFixed(4));
        }
    };

    const apply = (v: number) => {
        const snapped = +v.toFixed(4);
        if (ref.current) ref.current.value = String(snapped);
        onCommit(snapped);
    };

    const nudge = (dir: number, mult: number) => {
        const cur = parseFloat(ref.current!.value);
        apply((Number.isFinite(cur) ? cur : value) + dir * step * mult);
    };

    const onScrubDown = (e: ReactPointerEvent) => {
        if (e.button !== 0) return;
        scrub.current = { lastX: e.clientX, acc: 0, base: value, active: false };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
    };

    const onScrubMove = (e: ReactPointerEvent) => {
        const s = scrub.current;
        if (!s) return;
        // shift is sampled per move, so the multiplier applies from the
        // moment it's held rather than rescaling the whole drag
        s.acc += (e.clientX - s.lastX) * step * (e.shiftKey ? 10 : 1);
        s.lastX = e.clientX;
        if (!s.active && Math.abs(s.acc) < step) return;
        s.active = true;
        apply(s.base + s.acc);
    };

    const onScrubUp = () => {
        scrub.current = null;
    };

    return (
        <label className={styles.numField}>
            <span
                className={styles.scrubHandle}
                title="Drag to scrub · ↑/↓ step · ⇧ ×10"
                onPointerDown={onScrubDown}
                onPointerMove={onScrubMove}
                onPointerUp={onScrubUp}
                onClick={e => e.preventDefault()}
            >
                {label}
            </span>
            <input
                ref={ref}
                type="number"
                step={step}
                defaultValue={+value.toFixed(4)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : 1);
                    }
                    e.stopPropagation();
                }}
            />
        </label>
    );
};
