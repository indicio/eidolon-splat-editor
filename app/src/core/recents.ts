/**
 * Recently opened splats and .splatstudio projects.
 * A FileSystemFileHandle (Chromium) reopens the same file. A project small
 * enough to keep is also stored as bytes, so a package is not read as text.
 */

import { isSplatFilename } from './io';
import { isProjectFilename } from './project';

const DB_NAME = 'splatstudio';
const STORE = 'recents';
const MAX_RECENTS = 8;

export interface RecentItem {
    key: string;
    name: string;
    kind: 'project' | 'splat';
    openedAt: number;
}

const RECENT_PROJECT_BYTES = 64 * 1024 * 1024;

interface RecentRecord extends RecentItem {
    handle: FileSystemFileHandle | null;
    /** older JSON projects */
    projectText: string | null;
    /** packaged or JSON project bytes, when small enough to keep */
    projectBytes?: ArrayBuffer | null;
}

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

const request = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

/** fn must schedule every request before its first await, or the transaction commits. */
const withStore = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    const db = await openDb();
    try {
        const tx = db.transaction(STORE, mode);
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        const result = await fn(tx.objectStore(STORE));
        await done;
        return result;
    } finally {
        db.close();
    }
};

const readHandle = async (handle: FileSystemFileHandle): Promise<File> => {
    if (handle.queryPermission && handle.requestPermission) {
        let perm = await handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
        if (perm !== 'granted') throw new DOMException('Permission was not granted', 'NotAllowedError');
    }
    return handle.getFile();
};

/** Remember a file the user just opened. Splats need a handle; projects do not. */
export const rememberFile = async (file: File, handle?: FileSystemFileHandle | null): Promise<void> => {
    const kind = isProjectFilename(file.name) ? 'project' : isSplatFilename(file.name) ? 'splat' : null;
    if (!kind) return;
    let projectBytes: ArrayBuffer | null = null;
    if (kind === 'project' && file.size <= RECENT_PROJECT_BYTES) {
        try {
            projectBytes = await file.arrayBuffer();
        } catch {
            return;
        }
    }
    if (!handle && !projectBytes) return;

    const record: RecentRecord = {
        key: file.name.toLowerCase(),
        name: file.name,
        kind,
        openedAt: Date.now(),
        handle: handle ?? null,
        projectText: null,
        projectBytes
    };

    try {
        await withStore('readwrite', store => new Promise<void>((resolve, reject) => {
            store.put(record);
            const allReq = store.getAll();
            allReq.onsuccess = () => {
                const all = (allReq.result as RecentRecord[]).sort((a, b) => b.openedAt - a.openedAt);
                for (const extra of all.slice(MAX_RECENTS)) store.delete(extra.key);
                resolve();
            };
            allReq.onerror = () => reject(allReq.error);
        }));
    } catch {
        /* private mode or a handle the browser refused to store */
    }
};

export const listRecents = async (): Promise<RecentItem[]> => {
    try {
        const all = await withStore('readonly', store => request(store.getAll()) as Promise<RecentRecord[]>);
        return all
            .sort((a, b) => b.openedAt - a.openedAt)
            .map(({ key, name, kind, openedAt }) => ({ key, name, kind, openedAt }));
    } catch {
        return [];
    }
};

export const forgetRecent = async (key: string): Promise<void> => {
    try {
        await withStore('readwrite', store => {
            store.delete(key);
            return Promise.resolve();
        });
    } catch { /* already gone */ }
};

const fileFromRecord = (record: RecentRecord): File | null => {
    if (record.projectBytes) return new File([record.projectBytes], record.name);
    if (record.projectText) return new File([record.projectText], record.name, { type: 'application/json' });
    return null;
};

/** Reopen a recent entry. Throws a message suitable for the launch screen. */
export const fileFromRecent = async (key: string): Promise<{ file: File; handle?: FileSystemFileHandle }> => {
    const record = await withStore('readonly', store => request(store.get(key)) as Promise<RecentRecord | undefined>);
    if (!record) throw new Error('That recent file is no longer listed.');

    if (record.handle) {
        try {
            const file = await readHandle(record.handle);
            return { file, handle: record.handle };
        } catch (err) {
            const missing = err instanceof DOMException && err.name === 'NotFoundError';
            if (missing) {
                await forgetRecent(key);
                throw new Error(`Couldn't find ${record.name}. It may have been moved.`);
            }
            const cached = fileFromRecord(record);
            if (cached) return { file: cached };
            throw new Error(`EiDOlON doesn't have permission to open ${record.name}.`);
        }
    }

    const cached = fileFromRecord(record);
    if (cached) return { file: cached };

    await forgetRecent(key);
    throw new Error(`Couldn't reopen ${record.name}. Open it again from disk.`);
};
