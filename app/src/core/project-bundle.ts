/**
 * A .splatstudio package is a zip: project.json plus the source splat files
 * under sources/. Bytes are stored uncompressed so a large ply is copied,
 * not re-encoded.
 */

import { parseProject, type ProjectFile } from './project';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const UTF8 = 0x0800;

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
}

const crc32 = (data: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; ++i) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

const dosTime = (d: Date) => ({
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
});

interface ZipEntry {
    name: string;
    bytes: Uint8Array;
    crc: number;
}

const sourceEntryName = (fileName: string, used: Set<string>): string => {
    const base = fileName.split(/[/\\]/).pop() || 'source';
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let name = `sources/${base}`;
    let n = 2;
    while (used.has(name)) {
        name = `sources/${stem}-${n}${ext}`;
        n++;
    }
    used.add(name);
    return name;
};

const zipStore = (entries: ZipEntry[]): Blob => {
    const enc = new TextEncoder();
    const names = entries.map(e => enc.encode(e.name));
    const { time, date } = dosTime(new Date());
    const parts: BlobPart[] = [];
    const offsets: number[] = [];
    let offset = 0;

    for (let i = 0; i < entries.length; ++i) {
        const name = names[i];
        const entry = entries[i];
        if (entry.bytes.length > 0xffffffff) {
            throw new Error(`${entry.name} is too large to store in a project`);
        }
        const header = new ArrayBuffer(30);
        const view = new DataView(header);
        view.setUint32(0, LOCAL, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, UTF8, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, time, true);
        view.setUint16(12, date, true);
        view.setUint32(14, entry.crc, true);
        view.setUint32(18, entry.bytes.length, true);
        view.setUint32(22, entry.bytes.length, true);
        view.setUint16(26, name.length, true);
        view.setUint16(28, 0, true);
        offsets.push(offset);
        parts.push(new Uint8Array(header), part(name), part(entry.bytes));
        offset += 30 + name.length + entry.bytes.length;
    }

    const centralStart = offset;
    for (let i = 0; i < entries.length; ++i) {
        const name = names[i];
        const entry = entries[i];
        const header = new ArrayBuffer(46);
        const view = new DataView(header);
        view.setUint32(0, CENTRAL, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, UTF8, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, time, true);
        view.setUint16(14, date, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, entry.bytes.length, true);
        view.setUint32(24, entry.bytes.length, true);
        view.setUint16(28, name.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true);
        view.setUint32(42, offsets[i], true);
        parts.push(new Uint8Array(header), part(name));
        offset += 46 + name.length;
    }

    const eocd = new ArrayBuffer(22);
    const end = new DataView(eocd);
    end.setUint32(0, EOCD, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, offset - centralStart, true);
    end.setUint32(16, centralStart, true);
    end.setUint16(20, 0, true);
    parts.push(new Uint8Array(eocd));
    return new Blob(parts, { type: 'application/octet-stream' });
};

/** arrayBuffer() is a real ArrayBuffer; the DOM typings also allow SharedArrayBuffer. */
const part = (bytes: Uint8Array): BlobPart => bytes as BlobPart;

const readBytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

/** Zip the project document together with the splat files it was opened from. */
export const packProject = async (project: ProjectFile, sources: File[]): Promise<Blob> => {
    const used = new Set<string>();
    const bundled: ProjectFile = {
        ...project,
        bundle: { files: sources.map(file => sourceEntryName(file.name, used)) }
    };
    const json = new TextEncoder().encode(JSON.stringify(bundled));
    const entries: ZipEntry[] = [{ name: 'project.json', bytes: json, crc: crc32(json) }];
    for (let i = 0; i < sources.length; ++i) {
        const bytes = await readBytes(sources[i]);
        entries.push({ name: bundled.bundle!.files[i], bytes, crc: crc32(bytes) });
    }
    return zipStore(entries);
};

export const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    // large packages are still being handed to the browser as the click returns
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

interface CentralEntry {
    name: string;
    method: number;
    size: number;
    offset: number;
}

const findEocd = (tail: Uint8Array): { cdOffset: number; cdSize: number; count: number } | null => {
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    for (let i = tail.length - 22; i >= 0; --i) {
        if (view.getUint32(i, true) !== EOCD) continue;
        return {
            count: view.getUint16(i + 10, true),
            cdSize: view.getUint32(i + 12, true),
            cdOffset: view.getUint32(i + 16, true)
        };
    }
    return null;
};

const readCentral = async (file: Blob): Promise<CentralEntry[]> => {
    const tailSize = Math.min(file.size, 22 + 65535);
    const tailStart = file.size - tailSize;
    const tail = await readBytes(file.slice(tailStart));
    const eocd = findEocd(tail);
    if (!eocd) throw new Error('Not a valid .splatstudio project file');
    const dir = await readBytes(file.slice(eocd.cdOffset, eocd.cdOffset + eocd.cdSize));
    const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const dec = new TextDecoder();
    const entries: CentralEntry[] = [];
    let p = 0;
    for (let n = 0; n < eocd.count; ++n) {
        if (p + 46 > dir.length || view.getUint32(p, true) !== CENTRAL) {
            throw new Error('Not a valid .splatstudio project file');
        }
        const method = view.getUint16(p + 10, true);
        const size = view.getUint32(p + 24, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const offset = view.getUint32(p + 42, true);
        const name = dec.decode(dir.subarray(p + 46, p + 46 + nameLen));
        entries.push({ name, method, size, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
};

const readEntry = async (file: Blob, entry: CentralEntry): Promise<Uint8Array> => {
    if (entry.method !== 0) throw new Error(`Cannot read compressed entry ${entry.name}`);
    const header = await readBytes(file.slice(entry.offset, entry.offset + 30));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== LOCAL) throw new Error('Not a valid .splatstudio project file');
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    const start = entry.offset + 30 + nameLen + extraLen;
    return readBytes(file.slice(start, start + entry.size));
};

const baseName = (path: string) => path.split('/').pop() || path;

/** Pull project.json and its source splats out of a package. */
export const unpackProject = async (file: Blob): Promise<{ project: ProjectFile; sources: File[] }> => {
    const entries = await readCentral(file);
    const byName = new Map(entries.map(entry => [entry.name, entry]));
    const doc = byName.get('project.json');
    if (!doc) throw new Error('Not a valid .splatstudio project file');
    const project = parseProject(new TextDecoder().decode(await readEntry(file, doc)));
    const wanted = project.bundle?.files ?? entries
        .map(entry => entry.name)
        .filter(name => name.startsWith('sources/') && !name.endsWith('/'));
    const sources: File[] = [];
    for (const path of wanted) {
        const entry = byName.get(path);
        if (!entry) throw new Error(`Project is missing ${baseName(path)}`);
        const bytes = await readEntry(file, entry);
        sources.push(new File([part(bytes)], baseName(path)));
    }
    return { project, sources };
};

export const isProjectPackage = async (file: Blob): Promise<boolean> => {
    if (file.size < 4) return false;
    const head = await readBytes(file.slice(0, 4));
    return head[0] === 0x50 && head[1] === 0x4b;
};
