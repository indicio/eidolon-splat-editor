/**
 * Palette of per-selection transform matrices, stored as 3x4 rows in an
 * RGBA32F texture (512 matrices per row, 3 texels each). Splats reference
 * entries through an R16U index texture; index 0 is identity.
 *
 * Adapted from PlayCanvas SuperSplat (MIT): src/transform-palette.ts.
 */

import {
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_RGBA32F,
    GraphicsDevice,
    Mat4,
    Texture
} from 'playcanvas';

// mapping from Mat4 (column-major) to transposed 3x4 rows
const idx = [
    0, 4, 8, 12,
    1, 5, 9, 13,
    2, 6, 10, 14
];

const WIDTH = 512 * 3;

export class TransformPalette {
    getTransform: (index: number, transform: Mat4) => void;
    setTransform: (index: number, transform: Mat4) => void;
    alloc: (num?: number) => number;
    free: (num?: number) => void;
    texture!: Texture;
    /** index of the next free entry (0 is identity, always allocated) */
    nextIndex = 1;

    constructor(device: GraphicsDevice, initialSize = 4096) {
        let texture: Texture;
        let data: Float32Array;

        const realloc = (width: number, height: number) => {
            const newTexture = new Texture(device, {
                name: 'transformPalette',
                width,
                height,
                format: PIXELFORMAT_RGBA32F,
                mipmaps: false,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });

            const newData = newTexture.lock() as Float32Array;
            newTexture.unlock();

            if (texture!) {
                newData.set(data!);
                texture.destroy();
            }

            texture = newTexture;
            data = newData;
        };

        this.getTransform = (index: number, transform: Mat4) => {
            const dst = transform.data;
            dst[3] = dst[7] = dst[11] = 0;
            dst[15] = 1;
            for (let i = 0; i < 12; ++i) {
                dst[idx[i]] = data[index * 12 + i];
            }
        };

        this.setTransform = (index: number, transform: Mat4) => {
            const src = transform.data;
            for (let i = 0; i < 12; ++i) {
                data[index * 12 + i] = src[idx[i]];
            }
            texture.upload();
        };

        this.alloc = (num = 1) => {
            const result = this.nextIndex;
            while (this.nextIndex + num > data.length / 12) {
                realloc(WIDTH, texture.height * 2);
            }
            this.nextIndex += num;
            return result;
        };

        this.free = (num = 1) => {
            this.nextIndex -= num;
        };

        Object.defineProperty(this, 'texture', {
            get() {
                return texture;
            }
        });

        realloc(WIDTH, Math.max(1, Math.ceil(initialSize / (WIDTH / 3))));
        this.setTransform(0, Mat4.IDENTITY);
    }

    destroy() {
        this.texture.destroy();
    }
}
