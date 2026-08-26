/**
 * PLY sequence source: an ordered set of frame files decoded lazily with a
 * bounded LRU cache and read-ahead prefetch, so long sequences never hold
 * every decoded frame in memory.
 */

import { GSplatData } from 'playcanvas';
import { Quat } from 'playcanvas';

import { loadSplatFromFile } from './io';

const CACHE_LIMIT = 24;
const PREFETCH = 2;

/** Natural sort so frame_0010 follows frame_0009. */
const naturalCompare = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export const sortSequenceFiles = (files: File[]): File[] =>
    [...files].sort((a, b) => naturalCompare(a.name, b.name));

export class SequenceSource {
    readonly files: File[];
    readonly name: string;

    private cache = new Map<number, { data: GSplatData; rotation: Quat }>();
    private inflight = new Map<number, Promise<{ data: GSplatData; rotation: Quat }>>();

    constructor(files: File[]) {
        this.files = sortSequenceFiles(files);
        this.name = this.files[0]?.name.replace(/\d+(?=\.[^.]+$)/, '####') ?? 'sequence';
    }

    get count() {
        return this.files.length;
    }

    async getFrame(index: number): Promise<{ data: GSplatData; rotation: Quat }> {
        const i = Math.max(0, Math.min(this.count - 1, index));

        const cached = this.cache.get(i);
        if (cached) {
            // refresh LRU position
            this.cache.delete(i);
            this.cache.set(i, cached);
            this.prefetch(i);
            return cached;
        }

        const result = await this.load(i);
        this.prefetch(i);
        return result;
    }

    private load(i: number): Promise<{ data: GSplatData; rotation: Quat }> {
        const existing = this.inflight.get(i);
        if (existing) return existing;

        const promise = (async () => {
            const { gsplatData, transform } = await loadSplatFromFile(this.files[i], true);
            const entry = { data: gsplatData, rotation: new Quat().copy(transform.rotation as Quat) };
            this.cache.set(i, entry);
            while (this.cache.size > CACHE_LIMIT) {
                const oldest = this.cache.keys().next().value!;
                this.cache.delete(oldest);
            }
            this.inflight.delete(i);
            return entry;
        })();
        this.inflight.set(i, promise);
        return promise;
    }

    private prefetch(from: number) {
        for (let d = 1; d <= PREFETCH; ++d) {
            const i = (from + d) % this.count;
            if (!this.cache.has(i) && !this.inflight.has(i)) {
                void this.load(i).catch(() => this.inflight.delete(i));
            }
        }
    }
}
