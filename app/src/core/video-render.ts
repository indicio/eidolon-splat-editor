/**
 * MP4 video export settings and encoder configuration.
 *
 * Encoding runs on WebCodecs VideoEncoder (H.264) muxed into MP4 by
 * mediabunny — the same stack SuperSplat's render path uses. The H.264
 * codec-string level selection is adapted from SuperSplat's video-config.ts
 * (MIT): declaring too low a level makes isConfigSupported reject frame
 * sizes the hardware could otherwise encode.
 */

export interface VideoSettings {
    width: number;
    height: number;
    fps: number;
    /** target bitrate, bits per second */
    bitrate: number;
}

export interface SizePreset {
    id: string;
    label: string;
    width: number;
    height: number;
}

export const SIZE_PRESETS: SizePreset[] = [
    { id: '2k', label: '2K QHD', width: 2560, height: 1440 },
    { id: '1080p', label: '1080p', width: 1920, height: 1080 },
    { id: '4k', label: '4K UHD', width: 3840, height: 2160 },
    { id: '720p', label: '720p', width: 1280, height: 720 },
    { id: 'square', label: 'Square', width: 1080, height: 1080 },
    { id: 'vertical', label: '9:16', width: 1080, height: 1920 },
    { id: 'viewport', label: 'Viewport', width: 0, height: 0 } // filled at runtime
];

export const FPS_PRESETS = [24, 25, 30, 50, 60];

export const QUALITY_PRESETS = [
    { id: 'low', label: 'Low', bitsPerPixel: 0.1 },
    { id: 'medium', label: 'Medium', bitsPerPixel: 0.2 },
    { id: 'high', label: 'High', bitsPerPixel: 0.4 }
];

/**
 * H.264 requires even dimensions; clamp to sane encoder limits. The floor is
 * 240px: far below that, gaussians project sub-pixel and get alpha-clipped,
 * leaving mostly background.
 */
export const sanitizeSize = (v: number) =>
    Math.max(240, Math.min(7680, Math.round(v / 2) * 2));

export const computeBitrate = (width: number, height: number, fps: number, bitsPerPixel: number) =>
    Math.round(width * height * fps * bitsPerPixel);

export const videoEncodingSupported = () => typeof VideoEncoder !== 'undefined';

// h.264 level table: [level_idc, max frame size in macroblocks, max macroblocks/s]
const H264_LEVELS: [number, number, number][] = [
    [40, 8192, 245760],
    [42, 8704, 522240],
    [50, 22080, 589824],
    [51, 36864, 983040],
    [52, 36864, 2073600],
    [60, 139264, 4177920],
    [61, 139264, 8355840],
    [62, 139264, 16711680]
];

export const h264CodecString = (width: number, height: number, fps: number): string => {
    const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    // constrained baseline for sub-1080 frames, high profile otherwise
    const [profile, minLevel] = height < 1080 ? ['4200', 40] : ['6400', 51];
    const level = H264_LEVELS.find(([idc, maxFs, maxRate]) =>
        idc >= minLevel && macroblocks <= maxFs && macroblocks * fps <= maxRate)?.[0] ?? 62;
    return `avc1.${profile}${level.toString(16).padStart(2, '0')}`;
};

export const buildEncoderConfig = (s: VideoSettings): VideoEncoderConfig => ({
    codec: h264CodecString(s.width, s.height, s.fps),
    width: s.width,
    height: s.height,
    bitrate: s.bitrate,
    framerate: s.fps
});
