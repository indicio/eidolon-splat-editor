/**
 * Stylized splat effects (beyond the original Explode): shader-driven,
 * with one keyable Amount per effect plus non-keyed character params.
 * Definitions here drive the uniforms, the panel UI, the timeline lanes
 * and project persistence generically.
 */

export type FxId = 'peel' | 'dissolve' | 'jitter' | 'wave' | 'twist' | 'fade' | 'threshold' | 'boxwipe';

export interface FxParamDef {
    key: string;
    label: string;
    /** shader uniform; empty for components folded into a vector uniform */
    uniform: string;
    kind: 'slider' | 'number' | 'select';
    min?: number;
    max?: number;
    step?: number;
    options?: [number, string][];
    default: number;
}

export interface FxDef {
    id: FxId;
    label: string;
    hint: string;
    amountUniform: string;
    amountMax: number;
    params: FxParamDef[];
    /** vector uniforms assembled from scalar params (offsets from the model center) */
    vectors?: { uniform: string; keys: [string, string, string] }[];
}

export const FX_DEFS: FxDef[] = [
    {
        id: 'peel',
        label: 'Peel',
        hint: 'Wipe the model away ordered by distance from a point',
        amountUniform: 'ssPeelAmount',
        amountMax: 1,
        params: [
            { key: 'softness', label: 'Softness', uniform: 'ssPeelSoft', kind: 'slider', min: 0.01, max: 0.5, default: 0.08 },
            { key: 'lift', label: 'Lift', uniform: 'ssPeelLift', kind: 'slider', min: 0, max: 2, default: 0.3 },
            { key: 'invert', label: 'Direction', uniform: 'ssPeelInvert', kind: 'select', options: [[0, 'Outward'], [1, 'Inward']], default: 0 },
            { key: 'originX', label: 'X', uniform: '', kind: 'number', default: 0 },
            { key: 'originY', label: 'Y', uniform: '', kind: 'number', default: 0 },
            { key: 'originZ', label: 'Z', uniform: '', kind: 'number', default: 0 }
        ],
        vectors: [{ uniform: 'ssPeelOrigin', keys: ['originX', 'originY', 'originZ'] }]
    },
    {
        id: 'dissolve',
        label: 'Dissolve',
        hint: 'Erode splat opacity in a noisy pattern',
        amountUniform: 'ssDissolveAmount',
        amountMax: 1,
        params: [
            { key: 'softness', label: 'Softness', uniform: 'ssDissolveSoft', kind: 'slider', min: 0, max: 0.5, default: 0.1 },
            { key: 'seed', label: 'Seed', uniform: 'ssDissolveSeed', kind: 'number', default: 1 }
        ]
    },
    {
        id: 'jitter',
        label: 'Jitter',
        hint: 'Per-splat shimmer / vibration',
        amountUniform: 'ssJitterAmount',
        amountMax: 0.5,
        params: [
            { key: 'frequency', label: 'Frequency', uniform: 'ssJitterFreq', kind: 'slider', min: 0, max: 10, default: 2 },
            { key: 'coherence', label: 'Coherence', uniform: 'ssJitterCoherence', kind: 'slider', min: 0, max: 1, default: 0 }
        ]
    },
    {
        id: 'wave',
        label: 'Wave',
        hint: 'Sinusoidal ripple from a point or along an axis',
        amountUniform: 'ssWaveAmount',
        amountMax: 1,
        params: [
            { key: 'wavelength', label: 'Wavelength', uniform: 'ssWaveLength', kind: 'slider', min: 0.05, max: 5, default: 0.5 },
            { key: 'speed', label: 'Speed', uniform: 'ssWaveSpeed', kind: 'slider', min: 0, max: 5, default: 1 },
            { key: 'mode', label: 'Mode', uniform: 'ssWaveMode', kind: 'select', options: [[0, 'Ripple (radial)'], [1, 'Along X'], [2, 'Along Y'], [3, 'Along Z']], default: 0 },
            { key: 'originX', label: 'X', uniform: '', kind: 'number', default: 0 },
            { key: 'originY', label: 'Y', uniform: '', kind: 'number', default: 0 },
            { key: 'originZ', label: 'Z', uniform: '', kind: 'number', default: 0 }
        ],
        vectors: [{ uniform: 'ssWaveOrigin', keys: ['originX', 'originY', 'originZ'] }]
    },
    {
        id: 'twist',
        label: 'Twist',
        hint: 'Rotate around an axis, angle proportional to position along it',
        amountUniform: 'ssTwistAmount',
        amountMax: 6.28,
        params: [
            { key: 'axis', label: 'Axis', uniform: 'ssTwistAxis', kind: 'select', options: [[0, 'X'], [1, 'Y'], [2, 'Z']], default: 1 },
            { key: 'falloff', label: 'Falloff', uniform: 'ssTwistFalloff', kind: 'slider', min: 0, max: 1, default: 0 }
        ]
    },
    {
        id: 'fade',
        label: 'Fade / Grade',
        hint: 'Blend toward a color grade (default target: transparent)',
        amountUniform: 'ssFadeAmount',
        amountMax: 1,
        params: [
            { key: 'exposure', label: 'Exposure', uniform: 'ssFadeExposure', kind: 'slider', min: 0, max: 3, default: 1 },
            { key: 'brightness', label: 'Brightness', uniform: 'ssFadeBrightness', kind: 'slider', min: -1, max: 1, default: 0 },
            { key: 'saturation', label: 'Saturation', uniform: 'ssFadeSaturation', kind: 'slider', min: 0, max: 2, default: 1 },
            { key: 'transparency', label: 'Transparency', uniform: 'ssFadeTransparency', kind: 'slider', min: 0, max: 1, default: 0 }
        ]
    },
    {
        id: 'threshold',
        label: 'Threshold',
        hint: 'Erode faint or small splats first',
        amountUniform: 'ssThreshAmount',
        amountMax: 1,
        params: [
            { key: 'mode', label: 'Order', uniform: 'ssThreshMode', kind: 'select', options: [[0, 'Faint first'], [1, 'Small first'], [2, 'Large first']], default: 0 },
            { key: 'softness', label: 'Softness', uniform: 'ssThreshSoft', kind: 'slider', min: 0, max: 0.5, default: 0.1 },
            { key: 'range', label: 'Size range', uniform: 'ssThreshRange', kind: 'slider', min: 0.001, max: 0.1, step: 0.001, default: 0.02 }
        ]
    },
    {
        id: 'boxwipe',
        label: 'Box wipe',
        hint: 'Soft-edged crop sweep along an axis',
        amountUniform: 'ssWipeAmount',
        amountMax: 1,
        params: [
            { key: 'mode', label: 'Direction', uniform: 'ssWipeMode', kind: 'select', options: [[0, '+X'], [1, '−X'], [2, '+Y'], [3, '−Y'], [4, '+Z'], [5, '−Z']], default: 2 },
            { key: 'softness', label: 'Softness', uniform: 'ssWipeSoft', kind: 'slider', min: 0, max: 0.5, default: 0.05 }
        ]
    }
];

export const FX_IDS = FX_DEFS.map(d => d.id);

export const fxDef = (id: FxId): FxDef => FX_DEFS.find(d => d.id === id)!;

export interface FxState {
    enabled: boolean;
    /** the keyable value (amplitude / progress / max angle) */
    amount: number;
    params: Record<string, number>;
}

export const defaultFxState = (): Record<FxId, FxState> => {
    const out = {} as Record<FxId, FxState>;
    for (const def of FX_DEFS) {
        const params: Record<string, number> = {};
        for (const p of def.params) params[p.key] = p.default;
        out[def.id] = { enabled: false, amount: 0, params };
    }
    return out;
};

/** Material defaults so the shader never sees an unset uniform. */
export const FX_UNIFORM_DEFAULTS: [string, number | number[]][] = [
    ['ssFxTime', 0],
    ['ssFxCenter', [0, 0, 0]],
    ['ssFxRadius', 1],
    ['ssFxExtents', [1, 1, 1]],
    ...FX_DEFS.flatMap((def): [string, number | number[]][] => [
        [def.amountUniform, 0],
        ...def.params.filter(p => p.uniform).map((p): [string, number | number[]] => [p.uniform, p.default]),
        ...(def.vectors ?? []).map((v): [string, number | number[]] => [v.uniform, [0, 0, 0]])
    ])
];
