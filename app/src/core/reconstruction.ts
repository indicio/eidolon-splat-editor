/**
 * Reconstruction provider abstraction (§ ReconstructionProvider).
 *
 * The editor never talks to a specific reconstruction engine — it submits
 * images to a provider and polls staged progress. Swappable backends:
 * - RemoteProvider: generic REST contract for a local or remote trainer
 *   (the Spirula bridge, or anything else speaking the same jobs API).
 * - DemoProvider: fully local simulation that stages realistic progress
 *   and synthesizes a splat from the input photos, so the entire capture →
 *   review → reconstruct → edit flow works without a backend.
 */

export interface ReconstructionInput {
    images: { name: string; blob: Blob }[];
}

export interface JobStage {
    id: string;
    label: string;
}

/** Pipeline monitoring payload (bridge `diag` field) — all best-effort. */
export interface JobDiagnostics {
    totalImages?: number;
    /** SfM pose registration */
    registeredImages?: number;
    points?: number;
    fragments?: number;
    reprojError?: number;
    /** Gaussian training */
    step?: number;
    totalSteps?: number;
    loss?: [number, number][];
    /** per-stage wall time */
    stageTimes?: { stage: number; ms: number }[];
    resultSplats?: number;
    resultBytes?: number;
}

export interface JobProgress {
    stageIndex: number;
    /** 0..1 within the current stage */
    stageProgress: number;
    done: boolean;
    error?: string;
    /** non-fatal pipeline warning (e.g. poor pose registration) */
    warning?: string;
    diag?: JobDiagnostics;
    /**
     * Live trainer preview (Spirula's web viewer) while the job is training.
     * Absent once the run has finished and the PLY is ready for the editor.
     */
    viewerUrl?: string;
    elapsedMs: number;
}

export interface Job {
    id: string;
}

export interface SplatAsset {
    file: File;
}

export interface ReconstructionProvider {
    readonly name: string;
    readonly stages: JobStage[];
    /** true when results are pipeline previews, not trained models */
    readonly isSimulation?: boolean;
    createJob(input: ReconstructionInput): Promise<Job>;
    getProgress(jobId: string): Promise<JobProgress>;
    cancelJob(jobId: string): Promise<void>;
    getResult(jobId: string): Promise<SplatAsset>;
    /** full pipeline log for diagnosis, when the backend exposes one */
    getLog?(jobId: string): Promise<string>;
}

export const RECONSTRUCTION_STAGES: JobStage[] = [
    { id: 'analyze', label: 'Analyzing images' },
    { id: 'features', label: 'Finding features' },
    { id: 'matching', label: 'Matching cameras' },
    { id: 'poses', label: 'Solving camera poses' },
    { id: 'pointcloud', label: 'Generating point cloud' },
    { id: 'training', label: 'Training gaussians' },
    { id: 'optimize', label: 'Optimizing scene' },
    { id: 'package', label: 'Packaging splat' }
];

// -- demo provider -----------------------------------------------------------

const SH_C0 = 0.28209479177387814;

/** Build a gaussian-splat PLY from image pixels arranged as an arc of panels. */
const synthesizeSplatFromImages = async (images: { name: string; blob: Blob }[]): Promise<File> => {
    const COLS = 56, ROWS = 40;
    const panelW = 1.4, panelH = 1.0;
    const radius = Math.max(1.6, images.length * 0.28);

    const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const rows: number[] = [];

    const canvas = document.createElement('canvas');
    canvas.width = COLS;
    canvas.height = ROWS;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const arc = Math.min(Math.PI * 1.5, images.length * 0.35);
    for (let n = 0; n < images.length; ++n) {
        let bitmap: ImageBitmap;
        try {
            bitmap = await createImageBitmap(images[n].blob);
        } catch {
            continue;
        }
        ctx.drawImage(bitmap, 0, 0, COLS, ROWS);
        bitmap.close();
        const data = ctx.getImageData(0, 0, COLS, ROWS).data;

        const theta = images.length > 1 ? (n / (images.length - 1) - 0.5) * arc : 0;
        const cx = Math.sin(theta) * radius;
        const cz = -Math.cos(theta) * radius;
        const rightX = Math.cos(theta), rightZ = Math.sin(theta);

        for (let v = 0; v < ROWS; ++v) {
            for (let u = 0; u < COLS; ++u) {
                const p = (v * COLS + u) * 4;
                const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
                const lx = (u / COLS - 0.5) * panelW;
                const ly = (0.5 - v / ROWS) * panelH + 1.1;
                const sigma = Math.log(0.016);
                rows.push(
                    cx + rightX * lx, ly, cz + rightZ * lx,
                    (r - 0.5) / SH_C0, (g - 0.5) / SH_C0, (b - 0.5) / SH_C0,
                    Math.log(0.85 / 0.15),
                    sigma, sigma, sigma,
                    1, 0, 0, 0
                );
            }
        }
    }

    const count = rows.length / props.length;
    const header = [
        'ply',
        'format binary_little_endian 1.0',
        'comment demo reconstruction by EiDOlON',
        `element vertex ${count}`,
        ...props.map(p => `property float ${p}`),
        'end_header',
        ''
    ].join('\n');

    const blob = new Blob([new TextEncoder().encode(header), new Float32Array(rows).buffer]);
    // named so a simulated result is never mistaken for a trained model
    return new File([blob], 'demo-preview.ply');
};

interface DemoJob {
    input: ReconstructionInput;
    startedAt: number;
    durationMs: number;
    cancelled: boolean;
}

export class DemoProvider implements ReconstructionProvider {
    readonly name = 'Demo (simulation — not real training)';
    readonly stages = RECONSTRUCTION_STAGES;
    readonly isSimulation = true;

    private jobs = new Map<string, DemoJob>();
    private nextId = 1;

    createJob(input: ReconstructionInput): Promise<Job> {
        const id = `demo-${this.nextId++}`;
        this.jobs.set(id, {
            input,
            startedAt: performance.now(),
            // scale duration with image count so progress feels real
            durationMs: 4000 + input.images.length * 350,
            cancelled: false
        });
        return Promise.resolve({ id });
    }

    getProgress(jobId: string): Promise<JobProgress> {
        const job = this.jobs.get(jobId);
        if (!job) return Promise.reject(new Error('Unknown job'));
        const elapsedMs = performance.now() - job.startedAt;
        const t = Math.min(1, elapsedMs / job.durationMs);
        const scaled = t * this.stages.length;
        return Promise.resolve({
            stageIndex: Math.min(this.stages.length - 1, Math.floor(scaled)),
            stageProgress: scaled - Math.floor(scaled),
            done: t >= 1,
            elapsedMs
        });
    }

    cancelJob(jobId: string): Promise<void> {
        const job = this.jobs.get(jobId);
        if (job) job.cancelled = true;
        this.jobs.delete(jobId);
        return Promise.resolve();
    }

    async getResult(jobId: string): Promise<SplatAsset> {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error('Unknown job');
        this.jobs.delete(jobId);
        return { file: await synthesizeSplatFromImages(job.input.images) };
    }
}

// -- remote provider -----------------------------------------------------------

/**
 * Generic REST contract:
 *   POST   {base}/jobs            multipart images[] → { id }
 *   GET    {base}/jobs/:id        → { stageIndex, stageProgress, done, error? }
 *   DELETE {base}/jobs/:id
 *   GET    {base}/jobs/:id/result → binary splat (ply/sog)
 */
export class RemoteProvider implements ReconstructionProvider {
    readonly name: string;
    readonly stages = RECONSTRUCTION_STAGES;
    private base: string;
    private started = new Map<string, number>();

    constructor(baseUrl: string) {
        this.base = baseUrl.replace(/\/$/, '');
        this.name = `Remote (${this.base})`;
    }

    async createJob(input: ReconstructionInput): Promise<Job> {
        const form = new FormData();
        input.images.forEach(img => form.append('images', img.blob, img.name));
        const res = await fetch(`${this.base}/jobs`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`Reconstruction service error: ${res.status}`);
        const { id } = await res.json() as { id: string };
        this.started.set(id, performance.now());
        return { id };
    }

    async getProgress(jobId: string): Promise<JobProgress> {
        const res = await fetch(`${this.base}/jobs/${jobId}`);
        if (!res.ok) throw new Error(`Reconstruction service error: ${res.status}`);
        const p = await res.json() as Omit<JobProgress, 'elapsedMs'>;
        return { ...p, elapsedMs: performance.now() - (this.started.get(jobId) ?? performance.now()) };
    }

    async cancelJob(jobId: string): Promise<void> {
        await fetch(`${this.base}/jobs/${jobId}`, { method: 'DELETE' });
        this.started.delete(jobId);
    }

    async getResult(jobId: string): Promise<SplatAsset> {
        const res = await fetch(`${this.base}/jobs/${jobId}/result`);
        if (!res.ok) throw new Error(`Reconstruction service error: ${res.status}`);
        const blob = await res.blob();
        this.started.delete(jobId);
        return { file: new File([blob], 'reconstruction.ply') };
    }

    async getLog(jobId: string): Promise<string> {
        const res = await fetch(`${this.base}/jobs/${jobId}/log`);
        if (!res.ok) return '';
        return res.text();
    }
}

export const RECONSTRUCTION_URL_KEY = 'splatstudio.reconstructionUrl';

export const getServiceUrl = (): string | null => localStorage.getItem(RECONSTRUCTION_URL_KEY);

export const setServiceUrl = (url: string | null) => {
    if (url?.trim()) localStorage.setItem(RECONSTRUCTION_URL_KEY, url.trim().replace(/\/$/, ''));
    else localStorage.removeItem(RECONSTRUCTION_URL_KEY);
};

/** Health probe: expects GET {base}/health → { ok, engine? }. */
export const pingService = async (url: string): Promise<{ ok: boolean; detail: string }> => {
    try {
        const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        const json = await res.json().catch(() => ({})) as { engine?: Record<string, boolean>; fake?: boolean };
        const engines = json.engine
            ? Object.entries(json.engine).map(([k, v]) => `${k}: ${v ? '✓' : '✗'}`).join(' · ')
            : 'reachable';
        return { ok: true, detail: json.fake ? `${engines} (fake mode)` : engines };
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
};

/** Remote when a service URL is configured (localStorage), demo otherwise. */
export const getProvider = (): ReconstructionProvider => {
    const url = getServiceUrl();
    return url ? new RemoteProvider(url) : new DemoProvider();
};
