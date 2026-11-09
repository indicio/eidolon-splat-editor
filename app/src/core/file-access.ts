/**
 * File System Access helpers. Chromium can hand back a handle that IndexedDB
 * will reopen later; other browsers fall back to a plain file input.
 */

export const SPLAT_ACCEPT = '.ply,.sog,.splat,.ksplat,.spz,.splatstudio';
export const PROJECT_ACCEPT = '.splatstudio';

declare global {
    interface Window {
        showOpenFilePicker?: (options?: {
            multiple?: boolean;
            excludeAcceptAllOption?: boolean;
            types?: { description?: string; accept: Record<string, string[]> }[];
        }) => Promise<FileSystemFileHandle[]>;
    }

    interface DataTransferItem {
        getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
    }

    interface FileSystemHandle {
        queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
        requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
    }
}

const acceptTypes = (accept: string) => {
    const exts = accept.split(',').map(s => s.trim().toLowerCase()).filter(s => s.startsWith('.'));
    const splats = exts.filter(ext => ext !== '.splatstudio');
    const types: { description?: string; accept: Record<string, string[]> }[] = [];
    if (splats.length) {
        types.push({ description: 'Gaussian splat', accept: { 'application/octet-stream': splats } });
    }
    if (exts.includes('.splatstudio')) {
        types.push({ description: 'EiDOlON project', accept: { 'application/json': ['.splatstudio'] } });
    }
    return types;
};

const pickViaInput = (onFile: (file: File) => void, accept: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
        const file = input.files?.[0];
        if (file) onFile(file);
    };
    input.click();
};

/** Native picker when the browser can remember the file; otherwise an input. */
export const pickOpenFile = (onFile: (file: File, handle?: FileSystemFileHandle) => void, accept: string) => {
    const picker = window.showOpenFilePicker;
    if (!picker) {
        pickViaInput(file => onFile(file), accept);
        return;
    }
    void picker({ multiple: false, excludeAcceptAllOption: false, types: acceptTypes(accept) })
        .then(async handles => {
            const handle = handles[0];
            if (!handle) return;
            onFile(await handle.getFile(), handle);
        })
        .catch(err => {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            pickViaInput(file => onFile(file), accept);
        });
};

/** Start handle lookups during the drop event, before any await. */
export const dropHandlePromises = (items: DataTransferItemList): Promise<FileSystemHandle | null>[] =>
    [...items].map(item => item.getAsFileSystemHandle?.() ?? Promise.resolve(null));

export const matchHandles = (
    files: File[],
    handles: (FileSystemHandle | null)[]
): (FileSystemFileHandle | undefined)[] => {
    const byName = new Map<string, FileSystemFileHandle>();
    for (const handle of handles) {
        if (handle && handle.kind === 'file') byName.set(handle.name, handle as FileSystemFileHandle);
    }
    return files.map(file => byName.get(file.name));
};
