import { useCallback, useState, type DragEvent } from 'react';

import { isSplatFilename } from '../core/io';
import { isProjectFilename } from '../core/project';

const isOpenable = (name: string) => isSplatFilename(name) || isProjectFilename(name);

/** Drag-and-drop handling for splat files. Returns props to spread on the drop target. */
export const useFileDrop = (onFile: (file: File) => void, onReject?: (name: string) => void, onFiles?: (files: File[]) => void) => {
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
        const matches = files.filter(f => isOpenable(f.name));
        if (matches.length > 1 && onFiles) {
            onFiles(matches);
        } else if (matches.length > 0) {
            onFile(matches[0]);
        } else if (files.length > 0) {
            onReject?.(files[0].name);
        }
    }, [onFile, onReject, onFiles]);

    return { dragOver, dropProps: { onDragOver, onDragLeave, onDrop } };
};

/** Open the native file picker for splat/project files. */
export const pickSplatFile = (onFile: (file: File) => void, accept = '.ply,.sog,.splat,.ksplat,.spz,.splatstudio') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
        const file = input.files?.[0];
        if (file) onFile(file);
    };
    input.click();
};
