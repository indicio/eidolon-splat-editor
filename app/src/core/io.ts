/**
 * Splat file loading via @playcanvas/splat-transform.
 *
 * Adapted from PlayCanvas SuperSplat (MIT): src/io/read/loader.ts and
 * src/io/read/file-systems.ts. All format parsing (.ply, .compressed.ply,
 * .splat, .sog, .ksplat, .spz) is delegated to splat-transform; the result
 * is converted to an engine GSplatData ready for GSplatResource.
 */

import {
    getInputFormat,
    readFile,
    sortMortonOrder,
    createChunkDataPool,
    materializeToDataTable,
    selectLod,
    BufferedReadStream,
    ZipReadFileSystem,
    type Column,
    type ColumnType,
    type DataTable,
    type Options,
    type ChunkSource,
    type ReadFileSystem,
    type ReadSource,
    type Transform
} from '@playcanvas/splat-transform';
import { ReadStream } from '@playcanvas/splat-transform';
import { GSplatData } from 'playcanvas';

export const SPLAT_EXTENSIONS = ['.ply', '.compressed.ply', '.sog', '.splat', '.ksplat', '.spz'];

export const isSplatFilename = (name: string) => {
    const lower = name.toLowerCase();
    return SPLAT_EXTENSIONS.some(ext => lower.endsWith(ext));
};

export interface LoadResult {
    gsplatData: GSplatData;
    transform: Transform;
}

// pick the most detailed LOD with a loadable splat count when a file
// contains multiple LODs (e.g. LCC)
const LOD_MAX_SPLATS = 20_000_000;

const defaultLodIndex = (lodCounts: readonly number[]) => {
    const candidates = lodCounts.map((count, index) => ({ count, index }));
    const under = candidates.filter(c => c.count < LOD_MAX_SPLATS);
    if (under.length > 0) {
        return under.reduce((a, b) => (b.count > a.count ? b : a)).index;
    }
    return candidates.reduce((a, b) => (b.count < a.count ? b : a)).index;
};

const defaultOptions: Options = {
    iterations: 10,
    lodSelect: [],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

// read blob in 4MB chunks to balance async overhead vs memory usage
const BLOB_CHUNK_SIZE = 4 * 1024 * 1024;

class BlobReadStream extends ReadStream {
    private blob: Blob;
    private offset: number;
    private end: number;

    constructor(blob: Blob, start: number, end: number) {
        super(end - start);
        this.blob = blob;
        this.offset = start;
        this.end = end;
    }

    async pull(target: Uint8Array): Promise<number> {
        const remaining = this.end - this.offset;
        if (remaining <= 0) return 0;

        const bytesToRead = Math.min(target.length, remaining);
        const slice = this.blob.slice(this.offset, this.offset + bytesToRead);
        target.set(new Uint8Array(await slice.arrayBuffer()));
        this.offset += bytesToRead;
        this.bytesRead += bytesToRead;
        return bytesToRead;
    }
}

class BlobReadSource implements ReadSource {
    readonly size: number;
    readonly seekable = true;
    private closed = false;
    private blob: Blob;

    constructor(blob: Blob) {
        this.blob = blob;
        this.size = blob.size;
    }

    read(start = 0, end: number = this.size): ReadStream {
        if (this.closed) throw new Error('Source has been closed');
        const s = Math.max(0, Math.min(start, this.size));
        const e = Math.max(s, Math.min(end, this.size));
        return new BufferedReadStream(new BlobReadStream(this.blob, s, e), BLOB_CHUNK_SIZE);
    }

    close(): void {
        this.closed = true;
    }
}

/** ReadFileSystem over dropped/picked browser File objects. */
export class BlobReadFileSystem implements ReadFileSystem {
    private files = new Map<string, Blob>();

    set(name: string, blob: Blob) {
        this.files.set(name.toLowerCase(), blob);
    }

    createSource(filename: string): Promise<ReadSource> {
        const blob = this.files.get(filename.toLowerCase());
        if (!blob) return Promise.reject(new Error(`File not found: ${filename}`));
        return Promise.resolve(new BlobReadSource(blob));
    }
}

const columnTypeToGSplatType = (colType: ColumnType | null): string => {
    switch (colType) {
        case 'int8': return 'char';
        case 'uint8': return 'uchar';
        case 'int16': return 'short';
        case 'uint16': return 'ushort';
        case 'int32': return 'int';
        case 'uint32': return 'uint';
        case 'float32': return 'float';
        case 'float64': return 'double';
        default: return 'float';
    }
};

const dataTableToGSplatData = (dataTable: DataTable): GSplatData => {
    const properties = dataTable.columns.map((col: Column) => ({
        type: columnTypeToGSplatType(col.dataType),
        name: col.name,
        storage: col.data,
        byteSize: col.data.BYTES_PER_ELEMENT
    }));

    const gsplatData = new GSplatData([{
        name: 'vertex',
        count: dataTable.numRows,
        properties
    }]);

    // support 2D gaussians by synthesizing a near-zero third scale
    if (gsplatData.getProp('scale_0') && gsplatData.getProp('scale_1') && !gsplatData.getProp('scale_2')) {
        const scale2 = new Float32Array(gsplatData.numSplats).fill(Math.log(1e-6));
        gsplatData.addProp('scale_2', scale2);
        const props = gsplatData.getElement('vertex').properties;
        props.splice(props.findIndex((prop: { name: string }) => prop.name === 'scale_1') + 1, 0, props.splice(props.length - 1, 1)[0]);
    }

    return gsplatData;
};

const materializeFirst = async (sources: ChunkSource[]): Promise<DataTable> => {
    const source = sources[0];
    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    try {
        let single = source;
        if (source.meta.numLods > 1) {
            single = selectLod(source, defaultLodIndex(source.meta.lodCounts));
        }
        return await materializeToDataTable(single, pool);
    } finally {
        for (const s of sources) {
            await s.close();
        }
        pool.destroy();
    }
};

export const loadGSplatData = async (filename: string, fileSystem: ReadFileSystem, skipReorder = false): Promise<LoadResult> => {
    const inputFormat = getInputFormat(filename);
    const lowerFilename = filename.toLowerCase();

    // bundled SOG: a zip containing meta.json + webp planes
    if (inputFormat === 'sog' && lowerFilename.endsWith('.sog')) {
        const source = await fileSystem.createSource(filename);
        const zipFs = new ZipReadFileSystem(source);
        try {
            const sources = await readFile({
                filename: 'meta.json',
                inputFormat: 'sog',
                options: defaultOptions,
                params: [],
                fileSystem: zipFs
            });
            const dataTable = await materializeFirst(sources);
            return { gsplatData: dataTableToGSplatData(dataTable), transform: dataTable.transform };
        } finally {
            zipFs.close();
        }
    }

    const sources = await readFile({
        filename,
        inputFormat,
        options: defaultOptions,
        params: [],
        fileSystem
    });

    const dataTable = await materializeFirst(sources);

    // morton-reorder for render performance; sog and compressed ply are
    // already morton ordered; animation frames skip it for load speed
    const isCompressedPly = lowerFilename.endsWith('.compressed.ply');
    if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
        const indices = new Uint32Array(dataTable.numRows);
        for (let i = 0; i < indices.length; i++) indices[i] = i;
        sortMortonOrder(dataTable, indices);
        dataTable.permuteRowsInPlace(indices);
    }

    return { gsplatData: dataTableToGSplatData(dataTable), transform: dataTable.transform };
};

export const validateGSplatData = (gsplatData: GSplatData): void => {
    const required = [
        'x', 'y', 'z',
        'scale_0', 'scale_1', 'scale_2',
        'rot_0', 'rot_1', 'rot_2', 'rot_3',
        'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'
    ];
    const missing = required.filter(x => !gsplatData.getProp(x));
    if (missing.length > 0) {
        throw new Error(`Not gaussian splat data — missing properties: ${missing.join(', ')}`);
    }
};

export const loadSplatFromFile = async (file: File, skipReorder = false): Promise<LoadResult> => {
    const fs = new BlobReadFileSystem();
    fs.set(file.name, file);
    const result = await loadGSplatData(file.name, fs, skipReorder);
    validateGSplatData(result.gsplatData);
    return result;
};
