/**
 * Capture ingestion: image quality analysis and video frame extraction.
 * All analysis is advisory — frames get warnings, never auto-rejected
 * (except obvious duplicates, which start deselected).
 */

export interface FrameInfo {
    id: number;
    name: string;
    blob: Blob;
    /** object URL of the thumbnail for display */
    thumbUrl: string;
    width: number;
    height: number;
    size: number;
    blurScore: number;
    warnings: string[];
    accepted: boolean;
    /** 32x32 grayscale for duplicate detection */
    gray: Float32Array;
}

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

const THUMB = 192;
const GRAY = 32;

let nextFrameId = 1;

/** Variance of a 3x3 Laplacian over the grayscale thumb — low = blurry. */
const laplacianVariance = (gray: Float32Array, w: number, h: number): number => {
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; ++y) {
        for (let x = 1; x < w - 1; ++x) {
            const i = y * w + x;
            const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
            sum += v;
            sum2 += v * v;
            n++;
        }
    }
    const mean = sum / n;
    return sum2 / n - mean * mean;
};

export const analyzeImage = async (blob: Blob, name: string): Promise<FrameInfo> => {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;

    const scale = THUMB / Math.max(width, height);
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, tw, th);

    const img = ctx.getImageData(0, 0, tw, th).data;
    const grayFull = new Float32Array(tw * th);
    let luma = 0;
    for (let i = 0; i < tw * th; ++i) {
        const v = (0.299 * img[i * 4] + 0.587 * img[i * 4 + 1] + 0.114 * img[i * 4 + 2]) / 255;
        grayFull[i] = v;
        luma += v;
    }
    luma /= tw * th;

    const blurScore = laplacianVariance(grayFull, tw, th) * 1e4;

    // small gray signature for duplicate detection
    const gcanvas = document.createElement('canvas');
    gcanvas.width = GRAY;
    gcanvas.height = GRAY;
    const gctx = gcanvas.getContext('2d', { willReadFrequently: true })!;
    gctx.drawImage(bitmap, 0, 0, GRAY, GRAY);
    const gimg = gctx.getImageData(0, 0, GRAY, GRAY).data;
    const gray = new Float32Array(GRAY * GRAY);
    for (let i = 0; i < gray.length; ++i) {
        gray[i] = (0.299 * gimg[i * 4] + 0.587 * gimg[i * 4 + 1] + 0.114 * gimg[i * 4 + 2]) / 255;
    }
    bitmap.close();

    const warnings: string[] = [];
    if (blurScore < 8) warnings.push('Looks blurry');
    if (luma < 0.12) warnings.push('Very dark');
    if (Math.max(width, height) < 720) warnings.push('Low resolution');

    const thumbUrl = await new Promise<string>((resolve) => {
        canvas.toBlob(b => resolve(URL.createObjectURL(b!)), 'image/jpeg', 0.75);
    });

    return {
        id: nextFrameId++,
        name,
        blob,
        thumbUrl,
        width,
        height,
        size: blob.size,
        blurScore,
        warnings,
        accepted: true,
        gray
    };
};

/** Flag near-identical consecutive frames: warn and start them deselected. */
export const markDuplicates = (frames: FrameInfo[], threshold = 0.015) => {
    for (let i = 1; i < frames.length; ++i) {
        const a = frames[i - 1].gray;
        const b = frames[i].gray;
        let diff = 0;
        for (let j = 0; j < a.length; ++j) diff += Math.abs(a[j] - b[j]);
        if (diff / a.length < threshold && !frames[i].warnings.includes('Likely duplicate')) {
            frames[i].warnings.push('Likely duplicate');
            frames[i].accepted = false;
        }
    }
};

export type SamplingMode =
    | { kind: 'fps'; fps: 1 | 2 | 5 | 10 }
    | { kind: 'nth'; n: 5 | 10 | 15 | 30 };

/** Extract frames from a video file by seeking; assumes ~30fps for nth-frame mode. */
export const extractVideoFrames = async (
    file: File,
    mode: SamplingMode,
    onProgress?: (done: number, total: number) => void
): Promise<FrameInfo[]> => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(file);

    await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('Could not read video'));
    });

    const step = mode.kind === 'fps' ? 1 / mode.fps : mode.n / 30;
    const times: number[] = [];
    for (let t = 0; t < video.duration; t += step) times.push(t);

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d')!;

    const frames: FrameInfo[] = [];
    for (let i = 0; i < times.length; ++i) {
        await new Promise<void>((resolve) => {
            video.onseeked = () => resolve();
            video.currentTime = Math.min(times[i], Math.max(0, video.duration - 0.05));
        });
        ctx.drawImage(video, 0, 0);
        const blob = await new Promise<Blob>((resolve) => {
            canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.9);
        });
        const stamp = times[i].toFixed(2).padStart(7, '0');
        frames.push(await analyzeImage(blob, `${file.name.replace(/\.[^.]+$/, '')}_${stamp}s.jpg`));
        onProgress?.(i + 1, times.length);
    }

    URL.revokeObjectURL(video.src);
    markDuplicates(frames);
    return frames;
};
