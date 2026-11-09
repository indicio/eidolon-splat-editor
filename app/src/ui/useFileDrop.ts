import { useCallback, useState, type DragEvent } from 'react';

import { dropHandlePromises, matchHandles, pickOpenFile, SPLAT_ACCEPT } from '../core/file-access';
import { isSplatFilename } from '../core/io';
import { isProjectFilename } from '../core/project';

const isOpenable = (name: string) => isSplatFilename(name) || isProjectFilename(name);

/** Drag-and-drop handling for splat and project files. Returns props to spread on the drop target. */
export const useFileDrop = (
    onFile: (file: File, handle?: FileSystemFileHandle) => void,
    onReject?: (name: string) => void,
    onFiles?: (files: File[], handles?: (FileSystemFileHandle | undefined)[]) => void
) => {
    const [dragOver, setDragOver] = useState(false);

    const onDragOver = useCallback((e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
    }, []);

    const onDragLeave = useCallback((e: DragEvent) => {
        e.preventDefault();
        setDragOver(false);
    }, []);

    const onDrop = useCallback((e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        const handlePromises = dropHandlePromises(e.dataTransfer.items);
        const matches = files.filter(f => isOpenable(f.name));
        void Promise.all(handlePromises).then(handles => {
            const matched = matchHandles(matches, handles);
            if (matches.length > 1 && onFiles) {
                onFiles(matches, matched);
            } else if (matches.length > 0) {
                onFile(matches[0], matched[0]);
            } else if (files.length > 0) {
                onReject?.(files[0].name);
            }
        });
    }, [onFile, onReject, onFiles]);

    return { dragOver, dropProps: { onDragOver, onDragLeave, onDrop } };
};

/** Open the native file picker for splat or project files. */
export const pickSplatFile = (
    onFile: (file: File, handle?: FileSystemFileHandle) => void,
    accept = SPLAT_ACCEPT
) => {
    pickOpenFile(onFile, accept);
};
