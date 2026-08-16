/* pin.glsl.js — camera-facing instanced markers.

   Billboarding happens here rather than via Sprite (which costs one draw
   call per marker) or Points (whose gl_PointSize is driver-capped and
   cannot be expressed in world units). One instanced quad, one draw call,
   arbitrary per-instance state.

   Constant PIXEL size, not constant world size: a marker is a UI element,
   so it should stay legible whether the globe is zoomed to a hemisphere or
   a city. The view-space offset that yields a fixed pixel size at depth z
   is  px * (-z) / uPixelScale,  where uPixelScale = (height/2)/tan(fov/2)
   comes from the CPU. */

export const pinVertex = /* glsl */`
  attribute vec3 aPos;      // unit-sphere position
  attribute float aPhase;   // pulse offset, so they do not blink in unison
  attribute float aState;   // 0 idle .. 1 hovered
  attribute float aDim;     // 1 visible .. 0 filtered out

  uniform float uPixelScale;
  uniform float uTime;
  uniform float uBase;      // idle diameter in px
  uniform float uHover;     // hovered diameter in px
  uniform vec3  uSunDir;

  varying vec2  vUv;
  varying float vFacing;
  varying float vState;
  varying float vDim;
  varying float vPulse;
  varying float vDay;

  void main(){
    vUv = position.xy + 0.5;
    vState = aState;
    vDim = aDim;

    vec3 lifted = aPos * 1.021;
    vec4 world = modelMatrix * vec4(lifted, 1.0);
    vec3 nrm = normalize(mat3(modelMatrix) * aPos);
    vFacing = dot(nrm, normalize(cameraPosition - world.xyz));
    vDay = smoothstep(-0.105, 0.105, dot(normalize(aPos), normalize(uSunDir)));

    /* A slow breath, not a blink — it should read as a live signal at the
       edge of attention, never as something demanding to be looked at. */
    vPulse = 0.86 + 0.14 * sin(uTime * 1.6 + aPhase);

    vec4 mv = viewMatrix * world;
    float px = mix(uBase, uHover, aState) * mix(0.72, 1.0, aDim);
    mv.xy += position.xy * (px * (-mv.z) / uPixelScale);
    gl_Position = projectionMatrix * mv;
  }
`;

export const pinFragment = /* glsl */`
  #include <common>

  uniform vec3 uCore;
  uniform vec3 uRing;
  uniform vec3 uHot;
  uniform vec3 uInk;

  varying vec2  vUv;
  varying float vFacing;
  varying float vState;
  varying float vDim;
  varying float vPulse;
  varying float vDay;

  void main(){
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;

    /* Three concentric zones, and the middle one is the important one.

       A marker drawn as a warm dot disappears into warm ground — at night
       the land field is amber and so was the marker. The fix is the
       cartographic one: a dark separator between the core and the ring, so
       the marker carries its own contrast and stays legible over bright
       land, dark ocean, or the twilight band alike. The core is also held
       at a constant instrument white rather than being tinted by the local
       light, because it needs to contrast MOST exactly where the ground is
       warmest. */
    float core = smoothstep(0.40, 0.20, r);
    float gap  = smoothstep(0.86, 0.66, r) - smoothstep(0.52, 0.34, r);
    float ring = smoothstep(1.00, 0.86, r) - smoothstep(0.80, 0.62, r);

    vec3 col = mix(uCore, uHot, vState);
    col = mix(col, uInk, gap * 0.92);
    col = mix(col, uRing, ring);

    float alpha = max(max(core, ring * 0.9), gap * 0.8) * vPulse;
    alpha *= mix(0.30, 1.0, vDim);
    alpha *= mix(1.0, 1.35, vState);

    /* Fade across the limb. Depth testing alone pops a marker out of
       existence the instant its centre passes behind the sphere; fading
       alone lets far-side markers bleed through. Both, together. */
    alpha *= smoothstep(0.02, 0.20, vFacing);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;
