/**
 * Non-destructive edit operations over the per-splat state byte.
 *
 * Design adapted from PlayCanvas SuperSplat (MIT):
 * ops store only run-length-encoded index ranges plus a reversible bit
 * operation, never copies of splat data, so undo history stays tiny even
 * for multi-million-splat scenes.
 */

export const State = {
    selected: 1,
    locked: 2,
    deleted: 4,
    hidden: 8,
    /** excluded by the non-destructive modifier stack */
    filtered: 16
} as const;

/** Run-length-encoded set of ascending splat indices. */
export class IndexRanges {
    // flat [lo, hi) pairs
    private ranges: number[] = [];
    private lastLo = -1;
    private lastHi = -1;
    size = 0;

    /** Indices must be added in ascending order. */
    add(i: number) {
        if (i === this.lastHi) {
            this.lastHi++;
        } else {
            if (this.lastLo >= 0) {
                this.ranges.push(this.lastLo, this.lastHi);
            }
            this.lastLo = i;
            this.lastHi = i + 1;
        }
        this.size++;
    }

    forEach(fn: (i: number) => void) {
        const { ranges } = this;
        for (let r = 0; r < ranges.length; r += 2) {
            for (let i = ranges[r]; i < ranges[r + 1]; ++i) fn(i);
        }
        if (this.lastLo >= 0) {
            for (let i = this.lastLo; i < this.lastHi; ++i) fn(i);
        }
    }
}

/** Mutable view over the state byte array. Owner is responsible for GPU flush. */
export interface StateAccess {
    readonly data: Uint8Array;
    setBits(ranges: IndexRanges, mask: number): void;
    clearBits(ranges: IndexRanges, mask: number): void;
}

export interface EditOp {
    name: string;
    /** JSON-safe parameters this op was created from (AI/command traceability). */
    params?: Record<string, unknown>;
    /** True when the op changes deleted bits (sorter mapping must be rebuilt). */
    changesDeleted?: boolean;
    /** True when the op changes layer membership (layer bits must be re-synced). */
    changesLayers?: boolean;
    do(): void;
    undo(): void;
}

/**
 * Generic selection change. Built by diffing the desired selection against
 * current state so undo is exact regardless of mode.
 */
export class SelectionOp implements EditOp {
    name: string;
    params?: Record<string, unknown>;
    private added = new IndexRanges();    // became selected
    private removed = new IndexRanges();  // became deselected

    /**
     * @param wanted - returns true if splat i should be selected after the op
     *                 (only consulted for splats that are not deleted/locked)
     * @param mode - set: wanted defines selection; add: wanted adds; remove: wanted removes
     */
    private state: StateAccess;

    constructor(
        state: StateAccess,
        name: string,
        mode: 'set' | 'add' | 'remove',
        wanted: (i: number) => boolean,
        params?: Record<string, unknown>
    ) {
        this.state = state;
        this.name = name;
        this.params = { ...params, mode };

        const { data } = state;
        for (let i = 0; i < data.length; ++i) {
            const s = data[i];
            if (s & (State.deleted | State.locked | State.hidden | State.filtered)) continue;
            const cur = (s & State.selected) !== 0;
            const hit = wanted(i);
            const next = mode === 'set' ? hit : mode === 'add' ? (cur || hit) : (cur && !hit);
            if (next && !cur) this.added.add(i);
            else if (!next && cur) this.removed.add(i);
        }
    }

    get changed() {
        return this.added.size + this.removed.size;
    }

    do() {
        this.state.setBits(this.added, State.selected);
        this.state.clearBits(this.removed, State.selected);
    }

    undo() {
        this.state.clearBits(this.added, State.selected);
        this.state.setBits(this.removed, State.selected);
    }
}

/** Mark all currently selected splats deleted. Undo restores them, still selected. */
export class DeleteSelectionOp implements EditOp {
    name = 'select.delete';
    changesDeleted = true;
    private ranges = new IndexRanges();
    private state: StateAccess;

    constructor(state: StateAccess) {
        this.state = state;
        const { data } = state;
        // only visible selected splats; hidden or modifier-filtered splats
        // are never deleted invisibly
        const skip = State.deleted | State.hidden | State.filtered;
        for (let i = 0; i < data.length; ++i) {
            if ((data[i] & (State.selected | skip)) === State.selected) {
                this.ranges.add(i);
            }
        }
    }

    get changed() {
        return this.ranges.size;
    }

    do() {
        this.state.setBits(this.ranges, State.deleted);
    }

    undo() {
        this.state.clearBits(this.ranges, State.deleted);
    }
}

/** Mark an arbitrary set of splats deleted (e.g. crop). Undo restores them. */
export class DeleteRangesOp implements EditOp {
    name: string;
    changesDeleted = true;
    private state: StateAccess;
    private ranges: IndexRanges;

    constructor(state: StateAccess, ranges: IndexRanges, name: string) {
        this.state = state;
        this.ranges = ranges;
        this.name = name;
    }

    get changed() {
        return this.ranges.size;
    }

    do() {
        this.state.setBits(this.ranges, State.deleted);
    }

    undo() {
        this.state.clearBits(this.ranges, State.deleted);
    }
}

/**
 * Reassign splats to a layer. Stores the previous layer id of each affected
 * splat (1 byte per affected splat) so undo is exact.
 */
export class AssignLayerOp implements EditOp {
    name: string;
    params?: Record<string, unknown>;
    /** signals that layer visibility/lock bits must be re-synced */
    changesLayers = true;
    private layerIds: Uint8Array;
    private ranges: IndexRanges;
    private newId: number;
    private oldIds: Uint8Array;

    constructor(layerIds: Uint8Array, ranges: IndexRanges, newId: number, name = 'layer.assign') {
        this.layerIds = layerIds;
        this.ranges = ranges;
        this.newId = newId;
        this.name = name;
        this.params = { layerId: newId, count: ranges.size };

        this.oldIds = new Uint8Array(ranges.size);
        let n = 0;
        ranges.forEach((i) => {
            this.oldIds[n++] = layerIds[i];
        });
    }

    get changed() {
        return this.ranges.size;
    }

    do() {
        const { layerIds, newId } = this;
        this.ranges.forEach((i) => {
            layerIds[i] = newId;
        });
    }

    undo() {
        const { layerIds, oldIds } = this;
        let n = 0;
        this.ranges.forEach((i) => {
            layerIds[i] = oldIds[n++];
        });
    }
}

/** Linear undo history. Ops are cheap (index ranges), so no depth cap for now. */
export class EditHistory {
    private ops: EditOp[] = [];
    private cursor = 0;

    onChange?: (op: EditOp, kind: 'do' | 'undo' | 'redo') => void;

    add(op: EditOp) {
        this.ops.length = this.cursor;
        this.ops.push(op);
        this.cursor++;
        op.do();
        this.onChange?.(op, 'do');
    }

    undo() {
        if (!this.canUndo) return;
        const op = this.ops[--this.cursor];
        op.undo();
        this.onChange?.(op, 'undo');
    }

    redo() {
        if (!this.canRedo) return;
        const op = this.ops[this.cursor++];
        op.do();
        this.onChange?.(op, 'redo');
    }

    get canUndo() {
        return this.cursor > 0;
    }

    get canRedo() {
        return this.cursor < this.ops.length;
    }

    clear() {
        this.ops = [];
        this.cursor = 0;
    }
}
