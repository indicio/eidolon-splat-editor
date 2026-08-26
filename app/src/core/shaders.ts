/**
 * Splat shader integration, hook-based (works on WebGL2 and WebGPU).
 *
 * Instead of forking the engine's whole gsplat vertex/fragment shaders, we
 * override two small chunks in both shader languages:
 *
 * - `gsplatModifyVS` — the engine's sanctioned hook point. Reads the per-splat
 *   edit state from an R8 texture (bit 1 selected → tint, 2 locked → dim,
 *   4 deleted / 8 hidden / 16 filtered → alpha 0, which the engine's alpha
 *   clip discards), applies the color grade and the diagnostic view modes
 *   (0 beauty, 1 opacity heat, 2 depth heat, 3 selected-only).
 * - `gsplatCenterVS` — adds the per-selection transform palette (R16U index
 *   texture + RGBA32F matrix palette) to the model matrix, so covariance
 *   projection picks the transform up too. Adapted from PlayCanvas
 *   SuperSplat (MIT).
 *
 * Deleted/filtered splats are also excluded from the sorter on the CPU side.
 */

const GLSL_HELPERS = /* glsl */`
uniform sampler2D splatState;
uniform vec4 selectedClr;
uniform vec4 lockedClr;
uniform vec3 clrOffset;
uniform vec4 clrScale;
uniform float saturation;
uniform float viewMode;
uniform vec2 depthRange;
uniform mat4 ssModelView;

uint ssReadState() {
    return uint(texelFetch(splatState, splat.uv, 0).r * 255.0 + 0.5) & 31u;
}

vec3 ssSaturate(vec3 c) {
    vec3 grey = vec3(dot(c, vec3(0.299, 0.587, 0.114)));
    return grey + (c - grey) * saturation;
}

// blue -> cyan -> yellow -> red ramp
vec3 ssHeat(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c = mix(vec3(0.15, 0.25, 0.9), vec3(0.1, 0.85, 0.9), smoothstep(0.0, 0.33, t));
    c = mix(c, vec3(0.95, 0.85, 0.15), smoothstep(0.33, 0.66, t));
    return mix(c, vec3(0.9, 0.15, 0.1), smoothstep(0.66, 1.0, t));
}
`;

export const modifyGlsl = /* glsl */`
${GLSL_HELPERS}
uniform float ssExplodeAmount;
uniform vec3 ssExplodeCenter;
uniform float ssExplodeSeed;
uniform float ssExplodeTurb;
uniform float ssExplodeSwirl;
uniform float ssExplodeGravity;
uniform float ssExplodeSpread;

// integer hash -> [0,1); must match the CPU mirror in splat-entity.ts
float ssHash(uint n) {
    n = (n ^ 61u) ^ (n >> 16u);
    n = n * 9u;
    n = n ^ (n >> 4u);
    n = n * 668265261u;
    n = n ^ (n >> 15u);
    return float(n & 0xffffu) / 65535.0;
}

// -- stylized effects (peel / dissolve / jitter / wave / twist) --------------
uniform float ssFxTime;         // timeline seconds (frame / fps)
uniform vec3 ssFxCenter;        // model bound center (model space)
uniform float ssFxRadius;       // model bound half-diagonal
uniform float ssPeelAmount;
uniform vec3 ssPeelOrigin;
uniform float ssPeelSoft;
uniform float ssPeelLift;
uniform float ssPeelInvert;
uniform float ssDissolveAmount;
uniform float ssDissolveSoft;
uniform float ssDissolveSeed;
uniform float ssJitterAmount;
uniform float ssJitterFreq;
uniform float ssJitterCoherence;
uniform float ssWaveAmount;
uniform vec3 ssWaveOrigin;
uniform float ssWaveLength;
uniform float ssWaveSpeed;
uniform float ssWaveMode;
uniform float ssTwistAmount;
uniform float ssTwistAxis;
uniform float ssTwistFalloff;
uniform vec3 ssFxExtents;       // model bound half-extents
uniform float ssFadeAmount;
uniform float ssFadeExposure;
uniform float ssFadeBrightness;
uniform float ssFadeSaturation;
uniform float ssFadeTransparency;
uniform float ssThreshAmount;
uniform float ssThreshMode;
uniform float ssThreshSoft;
uniform float ssThreshRange;
uniform float ssWipeAmount;
uniform float ssWipeMode;
uniform float ssWipeSoft;

// scatter explode: per-splat random direction, spatial turbulence field,
// vortex swirl about the vertical axis and a gravity arc. Every term must
// stay in sync with applyExplodeToSortCenters in splat-entity.ts. Stylized
// effects below compose as displacements of the original position.
void modifySplatCenter(inout vec3 center) {
    vec3 p = center;
    vec3 delta = vec3(0.0);

    if (ssExplodeAmount >= 0.0001) {
        float amt = ssExplodeAmount;
        vec3 d = p - ssExplodeCenter;
        float dist = length(d);
        uint si = splat.index * 3u + uint(ssExplodeSeed) * 7919u;

        vec3 dir = normalize(vec3(ssHash(si + 1u), ssHash(si + 2u), ssHash(si + 3u)) * 2.0 - 1.0 + vec3(0.0001));
        float speed = max(0.05, 1.0 + (ssHash(si + 5u) - 0.5) * 2.0 * ssExplodeSpread);

        vec3 disp = dir * (0.3 + dist);

        // turbulence: layered sine field over the original position
        float s = ssExplodeSeed;
        vec3 turb = vec3(
            sin(p.y * 3.1 + s + p.z * 1.7),
            sin(p.z * 2.9 + s * 1.3 + p.x * 1.9),
            sin(p.x * 3.3 + s * 0.7 + p.y * 2.1)
        ) + 0.5 * vec3(
            sin(p.z * 7.1 + s * 2.1),
            sin(p.x * 6.7 + s * 1.7),
            sin(p.y * 7.3 + s)
        );
        disp += turb * ssExplodeTurb;

        // swirl: tangential motion around the vertical axis through the center
        vec3 tang = vec3(-d.z, 0.0, d.x) / max(dist, 0.05);
        disp += tang * ssExplodeSwirl * (0.5 + dist * 0.5);

        delta += disp * amt * speed;
        delta.y -= ssExplodeGravity * amt * amt * (0.5 + ssHash(si + 7u));
    }

    // twist: rotate about an axis through the model center, angle ∝ coordinate
    if (abs(ssTwistAmount) > 0.0001) {
        vec3 q = p - ssFxCenter;
        float coord = ssTwistAxis < 0.5 ? q.x : (ssTwistAxis < 1.5 ? q.y : q.z);
        float t = clamp(coord / max(ssFxRadius, 0.001) * 0.5 + 0.5, 0.0, 1.0);
        float shaped = mix(t, t * t * t, ssTwistFalloff);
        float ang = ssTwistAmount * (shaped - 0.5);
        float c = cos(ang);
        float sn = sin(ang);
        vec3 r;
        if (ssTwistAxis < 0.5) {
            r = vec3(q.x, c * q.y - sn * q.z, sn * q.y + c * q.z);
        } else if (ssTwistAxis < 1.5) {
            r = vec3(c * q.x + sn * q.z, q.y, -sn * q.x + c * q.z);
        } else {
            r = vec3(c * q.x - sn * q.y, sn * q.x + c * q.y, q.z);
        }
        delta += r - q;
    }

    // wave / ripple: sinusoidal displacement, radial or along an axis
    if (abs(ssWaveAmount) > 0.0001) {
        vec3 o = ssFxCenter + ssWaveOrigin;
        float ph;
        vec3 dir;
        if (ssWaveMode < 0.5) {
            ph = length(p - o);
            dir = vec3(0.0, 1.0, 0.0);
        } else if (ssWaveMode < 1.5) {
            ph = p.x - o.x;
            dir = vec3(0.0, 1.0, 0.0);
        } else if (ssWaveMode < 2.5) {
            ph = p.y - o.y;
            dir = vec3(1.0, 0.0, 0.0);
        } else {
            ph = p.z - o.z;
            dir = vec3(0.0, 1.0, 0.0);
        }
        delta += dir * (ssWaveAmount * sin(ph * 6.2832 / max(ssWaveLength, 0.01) - ssFxTime * ssWaveSpeed * 6.2832));
    }

    // jitter: per-splat shimmer, blended toward a coherent spatial field
    if (abs(ssJitterAmount) > 0.0001) {
        uint ji = splat.index * 5u + 17u;
        vec3 rnd = vec3(ssHash(ji), ssHash(ji + 1u), ssHash(ji + 2u)) * 2.0 - 1.0;
        float phase = ssFxTime * ssJitterFreq * 6.2832;
        vec3 perSplat = vec3(
            sin(phase + rnd.x * 6.2832),
            sin(phase * 1.13 + rnd.y * 6.2832),
            sin(phase * 0.87 + rnd.z * 6.2832)
        ) * rnd;
        vec3 cohField = vec3(
            sin(p.y * 9.0 + phase),
            sin(p.z * 8.0 + phase * 1.1),
            sin(p.x * 10.0 + phase * 0.9)
        );
        delta += mix(perSplat, cohField, ssJitterCoherence) * ssJitterAmount;
    }

    // peel: lift splats near the wipe front (opacity handled per-fragment)
    if (ssPeelAmount > 0.0001 && ssPeelLift > 0.0001) {
        vec3 q = p - (ssFxCenter + ssPeelOrigin);
        float t = length(q) / max(ssFxRadius, 0.001);
        if (ssPeelInvert > 0.5) {
            t = 1.0 - t;
        }
        float front = mix(-ssPeelSoft, 1.0 + ssPeelSoft, ssPeelAmount);
        float band = exp(-pow((t - front) / max(ssPeelSoft, 0.01), 2.0));
        delta += normalize(q + vec3(0.0001)) * band * ssPeelLift * 0.4;
    }

    center = p + delta;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    // threshold, size modes: collapse splats below/above the sweeping size cut
    if (ssThreshAmount > 0.0001 && ssThreshMode > 0.5) {
        float sz = max(scale.x, max(scale.y, scale.z));
        float t = clamp(sz / max(ssFxRadius * ssThreshRange, 1e-5), 0.0, 1.0);
        if (ssThreshMode > 1.5) {
            t = 1.0 - t;
        }
        float soft = max(ssThreshSoft, 0.001);
        float thr = mix(-soft, 1.0 + soft, ssThreshAmount);
        scale *= smoothstep(thr - soft, thr, t);
    }
}

#define SS_MAX_LIGHTS 8
uniform float ssLightCount;
uniform float ssLightAmbient;
uniform vec4 ssLightPos[SS_MAX_LIGHTS];     // xyz: model-space position
uniform vec4 ssLightColor[SS_MAX_LIGHTS];   // rgb: color, a: intensity

void modifySplatColor(vec3 center, inout vec4 color) {
    uint s = ssReadState();

    // deleted (4), hidden (8), filtered (16): clipped by the engine
    if ((s & 28u) != 0u) {
        color.a = 0.0;
        return;
    }
    // selected-only view mode
    if (viewMode > 2.5 && (s & 1u) == 0u) {
        color.a = 0.0;
        return;
    }

    float origAlpha = clamp(color.a, 0.0, 1.0);

    // peel wipe: erase splats the front has passed (ordered by distance)
    if (ssPeelAmount > 0.0001) {
        float t = length(center - (ssFxCenter + ssPeelOrigin)) / max(ssFxRadius, 0.001);
        if (ssPeelInvert > 0.5) {
            t = 1.0 - t;
        }
        float front = mix(-ssPeelSoft, 1.0 + ssPeelSoft, ssPeelAmount);
        color.a *= smoothstep(front - max(ssPeelSoft, 0.005), front, t);
    }

    // dissolve: per-splat random threshold erodes opacity
    if (ssDissolveAmount > 0.0001) {
        float r = ssHash(splat.index * 11u + uint(ssDissolveSeed) * 419u);
        float thr = mix(-max(ssDissolveSoft, 0.001), 1.0 + ssDissolveSoft, ssDissolveAmount);
        color.a *= smoothstep(thr - max(ssDissolveSoft, 0.001), thr, r);
    }

    // threshold, opacity mode: faintest splats erode first
    if (ssThreshAmount > 0.0001 && ssThreshMode < 0.5) {
        float soft = max(ssThreshSoft, 0.001);
        float thr = mix(-soft, 1.0 + soft, ssThreshAmount);
        color.a *= smoothstep(thr - soft, thr, origAlpha);
    }

    // box wipe: soft-edged crop sweep along ±X/Y/Z
    if (ssWipeAmount > 0.0001) {
        vec3 q = (center - ssFxCenter) / ssFxExtents;
        float axis = floor(ssWipeMode * 0.5 + 0.001);
        float coord = axis < 0.5 ? q.x : (axis < 1.5 ? q.y : q.z);
        float t = clamp(coord * 0.5 + 0.5, 0.0, 1.0);
        // odd modes sweep from the negative side
        if (fract(ssWipeMode * 0.5) > 0.25) {
            t = 1.0 - t;
        }
        float soft = max(ssWipeSoft, 0.005);
        float thr = mix(-soft, 1.0 + soft, ssWipeAmount);
        color.a *= smoothstep(thr - soft, thr, t);
    }

    // color grade
    color = color * clrScale + vec4(clrOffset, 0.0);
    color.xyz = ssSaturate(color.xyz);

    // fade / grade: keyable blend toward a target grade
    if (ssFadeAmount > 0.0001) {
        float fa = ssFadeAmount;
        color.xyz = color.xyz * mix(1.0, ssFadeExposure, fa) + vec3(ssFadeBrightness * fa);
        vec3 fgrey = vec3(dot(color.xyz, vec3(0.299, 0.587, 0.114)));
        color.xyz = fgrey + (color.xyz - fgrey) * mix(1.0, ssFadeSaturation, fa);
        color.a *= mix(1.0, ssFadeTransparency, fa);
    }

    // point lights: baked radiance modulated by ambient + distance falloff.
    // center is the (possibly exploded) model-space position, so debris
    // flying past a light picks it up.
    if (ssLightCount > 0.5) {
        vec3 acc = vec3(ssLightAmbient);
        for (int i = 0; i < SS_MAX_LIGHTS; i++) {
            if (float(i) >= ssLightCount) {
                break;
            }
            vec3 L = ssLightPos[i].xyz - center;
            acc += ssLightColor[i].rgb * (ssLightColor[i].a / (1.0 + dot(L, L)));
        }
        color.xyz *= acc;
    }

    // diagnostic view modes
    if (viewMode > 0.5 && viewMode < 1.5) {
        color = vec4(ssHeat(origAlpha), max(origAlpha, 0.2));
    } else if (viewMode > 1.5 && viewMode < 2.5) {
        float lin = -(ssModelView * vec4(center, 1.0)).z;
        float t = clamp((lin - depthRange.x) / max(depthRange.y - depthRange.x, 0.001), 0.0, 1.0);
        color = vec4(ssHeat(1.0 - t), max(origAlpha, 0.2));
    }

    // locked dim / selection tint
    if ((s & 2u) != 0u) {
        color *= lockedClr;
    } else if ((s & 1u) != 0u) {
        color.xyz = mix(color.xyz, selectedClr.xyz, selectedClr.a);
    }
}
`;

export const modifyWgsl = /* wgsl */`
var splatState: texture_2d<f32>;
uniform selectedClr: vec4f;
uniform lockedClr: vec4f;
uniform clrOffset: vec3f;
uniform clrScale: vec4f;
uniform saturation: f32;
uniform viewMode: f32;
uniform depthRange: vec2f;
uniform ssModelView: mat4x4f;

fn ssReadState() -> u32 {
    return u32(textureLoad(splatState, splat.uv, 0).r * 255.0 + 0.5) & 31u;
}

fn ssSaturate(c: vec3f) -> vec3f {
    let grey = vec3f(dot(c, vec3f(0.299, 0.587, 0.114)));
    return grey + (c - grey) * uniform.saturation;
}

fn ssHeat(tIn: f32) -> vec3f {
    let t = clamp(tIn, 0.0, 1.0);
    var c = mix(vec3f(0.15, 0.25, 0.9), vec3f(0.1, 0.85, 0.9), smoothstep(0.0, 0.33, t));
    c = mix(c, vec3f(0.95, 0.85, 0.15), smoothstep(0.33, 0.66, t));
    return mix(c, vec3f(0.9, 0.15, 0.1), smoothstep(0.66, 1.0, t));
}

uniform ssExplodeAmount: f32;
uniform ssExplodeCenter: vec3f;
uniform ssExplodeSeed: f32;
uniform ssExplodeTurb: f32;
uniform ssExplodeSwirl: f32;
uniform ssExplodeGravity: f32;
uniform ssExplodeSpread: f32;

fn ssHash(nIn: u32) -> f32 {
    var n = (nIn ^ 61u) ^ (nIn >> 16u);
    n = n * 9u;
    n = n ^ (n >> 4u);
    n = n * 668265261u;
    n = n ^ (n >> 15u);
    return f32(n & 0xffffu) / 65535.0;
}

uniform ssFxTime: f32;
uniform ssFxCenter: vec3f;
uniform ssFxRadius: f32;
uniform ssPeelAmount: f32;
uniform ssPeelOrigin: vec3f;
uniform ssPeelSoft: f32;
uniform ssPeelLift: f32;
uniform ssPeelInvert: f32;
uniform ssDissolveAmount: f32;
uniform ssDissolveSoft: f32;
uniform ssDissolveSeed: f32;
uniform ssJitterAmount: f32;
uniform ssJitterFreq: f32;
uniform ssJitterCoherence: f32;
uniform ssWaveAmount: f32;
uniform ssWaveOrigin: vec3f;
uniform ssWaveLength: f32;
uniform ssWaveSpeed: f32;
uniform ssWaveMode: f32;
uniform ssTwistAmount: f32;
uniform ssTwistAxis: f32;
uniform ssTwistFalloff: f32;
uniform ssFxExtents: vec3f;
uniform ssFadeAmount: f32;
uniform ssFadeExposure: f32;
uniform ssFadeBrightness: f32;
uniform ssFadeSaturation: f32;
uniform ssFadeTransparency: f32;
uniform ssThreshAmount: f32;
uniform ssThreshMode: f32;
uniform ssThreshSoft: f32;
uniform ssThreshRange: f32;
uniform ssWipeAmount: f32;
uniform ssWipeMode: f32;
uniform ssWipeSoft: f32;

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let p = *center;
    var delta = vec3f(0.0);

    if (uniform.ssExplodeAmount >= 0.0001) {
        let amt = uniform.ssExplodeAmount;
        let d = p - uniform.ssExplodeCenter;
        let dist = length(d);
        let si = splat.index * 3u + u32(uniform.ssExplodeSeed) * 7919u;

        let dir = normalize(vec3f(ssHash(si + 1u), ssHash(si + 2u), ssHash(si + 3u)) * 2.0 - 1.0 + vec3f(0.0001));
        let speed = max(0.05, 1.0 + (ssHash(si + 5u) - 0.5) * 2.0 * uniform.ssExplodeSpread);

        var disp = dir * (0.3 + dist);

        let s = uniform.ssExplodeSeed;
        let turb = vec3f(
            sin(p.y * 3.1 + s + p.z * 1.7),
            sin(p.z * 2.9 + s * 1.3 + p.x * 1.9),
            sin(p.x * 3.3 + s * 0.7 + p.y * 2.1)
        ) + 0.5 * vec3f(
            sin(p.z * 7.1 + s * 2.1),
            sin(p.x * 6.7 + s * 1.7),
            sin(p.y * 7.3 + s)
        );
        disp = disp + turb * uniform.ssExplodeTurb;

        let tang = vec3f(-d.z, 0.0, d.x) / max(dist, 0.05);
        disp = disp + tang * uniform.ssExplodeSwirl * (0.5 + dist * 0.5);

        delta = delta + disp * amt * speed;
        delta.y = delta.y - uniform.ssExplodeGravity * amt * amt * (0.5 + ssHash(si + 7u));
    }

    if (abs(uniform.ssTwistAmount) > 0.0001) {
        let q = p - uniform.ssFxCenter;
        var coord = q.y;
        if (uniform.ssTwistAxis < 0.5) { coord = q.x; }
        else if (uniform.ssTwistAxis >= 1.5) { coord = q.z; }
        let t = clamp(coord / max(uniform.ssFxRadius, 0.001) * 0.5 + 0.5, 0.0, 1.0);
        let shaped = mix(t, t * t * t, uniform.ssTwistFalloff);
        let ang = uniform.ssTwistAmount * (shaped - 0.5);
        let c = cos(ang);
        let sn = sin(ang);
        var r = vec3f(c * q.x + sn * q.z, q.y, -sn * q.x + c * q.z);
        if (uniform.ssTwistAxis < 0.5) {
            r = vec3f(q.x, c * q.y - sn * q.z, sn * q.y + c * q.z);
        } else if (uniform.ssTwistAxis >= 1.5) {
            r = vec3f(c * q.x - sn * q.y, sn * q.x + c * q.y, q.z);
        }
        delta = delta + (r - q);
    }

    if (abs(uniform.ssWaveAmount) > 0.0001) {
        let o = uniform.ssFxCenter + uniform.ssWaveOrigin;
        var ph = length(p - o);
        var dir = vec3f(0.0, 1.0, 0.0);
        if (uniform.ssWaveMode >= 0.5 && uniform.ssWaveMode < 1.5) {
            ph = p.x - o.x;
        } else if (uniform.ssWaveMode >= 1.5 && uniform.ssWaveMode < 2.5) {
            ph = p.y - o.y;
            dir = vec3f(1.0, 0.0, 0.0);
        } else if (uniform.ssWaveMode >= 2.5) {
            ph = p.z - o.z;
        }
        delta = delta + dir * (uniform.ssWaveAmount * sin(ph * 6.2832 / max(uniform.ssWaveLength, 0.01) - uniform.ssFxTime * uniform.ssWaveSpeed * 6.2832));
    }

    if (abs(uniform.ssJitterAmount) > 0.0001) {
        let ji = splat.index * 5u + 17u;
        let rnd = vec3f(ssHash(ji), ssHash(ji + 1u), ssHash(ji + 2u)) * 2.0 - 1.0;
        let phase = uniform.ssFxTime * uniform.ssJitterFreq * 6.2832;
        let perSplat = vec3f(
            sin(phase + rnd.x * 6.2832),
            sin(phase * 1.13 + rnd.y * 6.2832),
            sin(phase * 0.87 + rnd.z * 6.2832)
        ) * rnd;
        let cohField = vec3f(
            sin(p.y * 9.0 + phase),
            sin(p.z * 8.0 + phase * 1.1),
            sin(p.x * 10.0 + phase * 0.9)
        );
        delta = delta + mix(perSplat, cohField, uniform.ssJitterCoherence) * uniform.ssJitterAmount;
    }

    if (uniform.ssPeelAmount > 0.0001 && uniform.ssPeelLift > 0.0001) {
        let q = p - (uniform.ssFxCenter + uniform.ssPeelOrigin);
        var t = length(q) / max(uniform.ssFxRadius, 0.001);
        if (uniform.ssPeelInvert > 0.5) {
            t = 1.0 - t;
        }
        let front = mix(-uniform.ssPeelSoft, 1.0 + uniform.ssPeelSoft, uniform.ssPeelAmount);
        let x = (t - front) / max(uniform.ssPeelSoft, 0.01);
        let band = exp(-(x * x));
        delta = delta + normalize(q + vec3f(0.0001)) * band * uniform.ssPeelLift * 0.4;
    }

    *center = p + delta;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    if (uniform.ssThreshAmount > 0.0001 && uniform.ssThreshMode > 0.5) {
        let s = *scale;
        let sz = max(s.x, max(s.y, s.z));
        var t = clamp(sz / max(uniform.ssFxRadius * uniform.ssThreshRange, 1e-5), 0.0, 1.0);
        if (uniform.ssThreshMode > 1.5) {
            t = 1.0 - t;
        }
        let soft = max(uniform.ssThreshSoft, 0.001);
        let thr = mix(-soft, 1.0 + soft, uniform.ssThreshAmount);
        *scale = s * smoothstep(thr - soft, thr, t);
    }
}

uniform ssLightCount: f32;
uniform ssLightAmbient: f32;
uniform ssLightPos: array<vec4f, 8>;
uniform ssLightColor: array<vec4f, 8>;

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let s = ssReadState();

    if ((s & 28u) != 0u) {
        (*color).a = 0.0;
        return;
    }
    if (uniform.viewMode > 2.5 && (s & 1u) == 0u) {
        (*color).a = 0.0;
        return;
    }

    let origAlpha = clamp((*color).a, 0.0, 1.0);

    if (uniform.ssPeelAmount > 0.0001) {
        var t = length(center - (uniform.ssFxCenter + uniform.ssPeelOrigin)) / max(uniform.ssFxRadius, 0.001);
        if (uniform.ssPeelInvert > 0.5) {
            t = 1.0 - t;
        }
        let front = mix(-uniform.ssPeelSoft, 1.0 + uniform.ssPeelSoft, uniform.ssPeelAmount);
        (*color).a = (*color).a * smoothstep(front - max(uniform.ssPeelSoft, 0.005), front, t);
    }

    if (uniform.ssDissolveAmount > 0.0001) {
        let r = ssHash(splat.index * 11u + u32(uniform.ssDissolveSeed) * 419u);
        let soft = max(uniform.ssDissolveSoft, 0.001);
        let thr = mix(-soft, 1.0 + uniform.ssDissolveSoft, uniform.ssDissolveAmount);
        (*color).a = (*color).a * smoothstep(thr - soft, thr, r);
    }

    if (uniform.ssThreshAmount > 0.0001 && uniform.ssThreshMode < 0.5) {
        let soft = max(uniform.ssThreshSoft, 0.001);
        let thr = mix(-soft, 1.0 + soft, uniform.ssThreshAmount);
        (*color).a = (*color).a * smoothstep(thr - soft, thr, origAlpha);
    }

    if (uniform.ssWipeAmount > 0.0001) {
        let q = (center - uniform.ssFxCenter) / uniform.ssFxExtents;
        let axis = floor(uniform.ssWipeMode * 0.5 + 0.001);
        var coord = q.y;
        if (axis < 0.5) { coord = q.x; }
        else if (axis >= 1.5) { coord = q.z; }
        var t = clamp(coord * 0.5 + 0.5, 0.0, 1.0);
        if (fract(uniform.ssWipeMode * 0.5) > 0.25) {
            t = 1.0 - t;
        }
        let soft = max(uniform.ssWipeSoft, 0.005);
        let thr = mix(-soft, 1.0 + soft, uniform.ssWipeAmount);
        (*color).a = (*color).a * smoothstep(thr - soft, thr, t);
    }

    *color = (*color) * uniform.clrScale + vec4f(uniform.clrOffset, 0.0);
    let sat = ssSaturate((*color).xyz);
    *color = vec4f(sat, (*color).a);

    if (uniform.ssFadeAmount > 0.0001) {
        let fa = uniform.ssFadeAmount;
        var rgb = (*color).xyz * mix(1.0, uniform.ssFadeExposure, fa) + vec3f(uniform.ssFadeBrightness * fa);
        let fgrey = vec3f(dot(rgb, vec3f(0.299, 0.587, 0.114)));
        rgb = fgrey + (rgb - fgrey) * mix(1.0, uniform.ssFadeSaturation, fa);
        *color = vec4f(rgb, (*color).a * mix(1.0, uniform.ssFadeTransparency, fa));
    }

    if (uniform.ssLightCount > 0.5) {
        var acc = vec3f(uniform.ssLightAmbient);
        for (var i = 0u; i < 8u; i = i + 1u) {
            if (f32(i) >= uniform.ssLightCount) {
                break;
            }
            let L = uniform.ssLightPos[i].xyz - center;
            acc = acc + uniform.ssLightColor[i].rgb * (uniform.ssLightColor[i].a / (1.0 + dot(L, L)));
        }
        *color = vec4f((*color).xyz * acc, (*color).a);
    }

    if (uniform.viewMode > 0.5 && uniform.viewMode < 1.5) {
        *color = vec4f(ssHeat(origAlpha), max(origAlpha, 0.2));
    } else if (uniform.viewMode > 1.5 && uniform.viewMode < 2.5) {
        let lin = -(uniform.ssModelView * vec4f(center, 1.0)).z;
        let t = clamp((lin - uniform.depthRange.x) / max(uniform.depthRange.y - uniform.depthRange.x, 0.001), 0.0, 1.0);
        *color = vec4f(ssHeat(1.0 - t), max(origAlpha, 0.2));
    }

    if ((s & 2u) != 0u) {
        *color = (*color) * uniform.lockedClr;
    } else if ((s & 1u) != 0u) {
        let tinted = mix((*color).xyz, uniform.selectedClr.xyz, uniform.selectedClr.a);
        *color = vec4f(tinted, (*color).a);
    }
}
`;

export const centerGlsl = /* glsl */`
uniform highp usampler2D splatTransform;        // per-splat index into transform palette
uniform sampler2D transformPalette;             // palette of transform matrices

mat4 applyPaletteTransform(mat4 model) {
    uint transformIndex = texelFetch(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return model;
    }

    int u = int(transformIndex % 512u) * 3;
    int v = int(transformIndex / 512u);

    mat4 t;
    t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
    t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
    t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
    t[3] = vec4(0.0, 0.0, 0.0, 1.0);

    return model * transpose(t);
}

uniform mat4 matrix_model;
uniform mat4 matrix_view;
#ifndef GSPLAT_CENTER_NOPROJ
    uniform vec4 camera_params;             // 1 / far, far, near, isOrtho
    uniform mat4 matrix_projection;
#endif

// project the model space gaussian center to view and clip space
bool initCenter(vec3 modelCenter, inout SplatCenter center) {
    mat4 modelView = matrix_view * applyPaletteTransform(matrix_model);
    vec4 centerView = modelView * vec4(modelCenter, 1.0);

    #ifndef GSPLAT_CENTER_NOPROJ

        // early out if splat is behind the camera (perspective only)
        if (camera_params.w != 1.0 && centerView.z > 0.0) {
            return false;
        }

        vec4 centerProj = matrix_projection * centerView;

        // ensure gaussians are not clipped by camera near and far
        #if WEBGPU
            centerProj.z = clamp(centerProj.z, 0, abs(centerProj.w));
        #else
            centerProj.z = clamp(centerProj.z, -abs(centerProj.w), abs(centerProj.w));
        #endif

        center.proj = centerProj;
        center.projMat00 = matrix_projection[0][0];

    #endif

    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
`;

export const centerWgsl = /* wgsl */`
var splatTransform: texture_2d<u32>;
var transformPalette: texture_2d<f32>;

uniform matrix_model: mat4x4f;
uniform matrix_view: mat4x4f;
#ifndef GSPLAT_CENTER_NOPROJ
    uniform camera_params: vec4f;
    uniform matrix_projection: mat4x4f;
#endif

fn applyPaletteTransform(model: mat4x4f) -> mat4x4f {
    let transformIndex: u32 = textureLoad(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return model;
    }

    let u: i32 = i32(transformIndex % 512u) * 3;
    let v: i32 = i32(transformIndex / 512u);

    let r0: vec4f = textureLoad(transformPalette, vec2i(u, v), 0);
    let r1: vec4f = textureLoad(transformPalette, vec2i(u + 1, v), 0);
    let r2: vec4f = textureLoad(transformPalette, vec2i(u + 2, v), 0);
    let t = mat4x4f(r0, r1, r2, vec4f(0.0, 0.0, 0.0, 1.0));

    return model * transpose(t);
}

fn initCenter(modelCenter: vec3f, center: ptr<function, SplatCenter>) -> bool {
    let modelView: mat4x4f = uniform.matrix_view * applyPaletteTransform(uniform.matrix_model);
    let centerView: vec4f = modelView * vec4f(modelCenter, 1.0);

    #ifndef GSPLAT_CENTER_NOPROJ
        if (uniform.camera_params.w != 1.0 && centerView.z > 0.0) {
            return false;
        }

        var centerProj: vec4f = uniform.matrix_projection * centerView;
        centerProj.z = clamp(centerProj.z, 0.0, abs(centerProj.w));

        center.proj = centerProj;
        center.projMat00 = uniform.matrix_projection[0][0];
    #endif

    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
`;
