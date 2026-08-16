/* globe.glsl.js — the planet body: photographic earth under the real
   terminator.

   Day side is NASA Blue Marble, night side is NASA Black Marble, blended
   across the same civil-twilight band everything else on this globe uses.
   Until the photographs arrive (they load progressively), the shader falls
   back to the flat cartographic colours, so the planet is never black.

   SAMPLING — geometry UVs, not normal-derived lon/lat.

   The old approach recovered lon/lat from the object normal with atan().
   That has a derivative explosion across the dateline column, which forces
   LinearFilter-without-mips, and an unmipped 4096-wide photograph shimmers
   the moment the globe spins. SphereGeometry's own uv attribute has no such
   seam: the wrap column carries duplicated vertices, interpolation stays
   continuous, and hardware RepeatWrapping (unlike a shader fract()) keeps
   derivatives intact. So the photographs get real mipmaps.

   Alignment: three's SphereGeometry builds x = -cos(φ)·sin(θ), which is
   exactly this app's earth-fixed convention with φ = longitude — so uv.x
   runs from Greenwich, and equirect textures (dateline at the left edge)
   are sampled at uv.x + 0.5, with RepeatWrapping absorbing the overflow.

   The sun arrives in EARTH-FIXED space and is compared against the OBJECT
   normal (see the space note in sun.js). vNormalW/vViewDir exist for the
   view-dependent terms — fresnel and the ocean glint — and vSunW carries
   the same sun into world space for the reflection. */

export const globeVertex = /* glsl */`
  uniform vec3 uSunDir;

  varying vec2 vUv;
  varying vec3 vNormalO;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vSunW;

  void main(){
    vUv = vec2(uv.x + 0.5, uv.y);
    vNormalO = normalize(normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    vSunW = normalize(mat3(modelMatrix) * uSunDir);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const globeFragment = /* glsl */`
  #include <common>

  uniform vec3  uSunDir;        // earth-fixed, same space as the object normal
  uniform sampler2D uLandMask;
  uniform sampler2D uDayMap;
  uniform sampler2D uNightMap;
  uniform float uHasDay;
  uniform float uHasNight;
  uniform sampler2D uCloudMap;
  uniform float uHasClouds;
  uniform float uCloudShift;

  uniform vec3  uOceanDay;
  uniform vec3  uOceanNight;
  uniform vec3  uLandDay;
  uniform vec3  uLandNight;
  uniform vec3  uCityGlow;
  uniform vec3  uTwilight;
  uniform vec3  uAtmo;
  uniform float uCityAmount;

  varying vec2 vUv;
  varying vec3 vNormalO;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vSunW;

  void main(){
    vec3 n = normalize(vNormalO);
    float land = texture2D(uLandMask, vUv).r;
    float ndl = dot(n, normalize(uSunDir));

    /* Civil twilight: the sun within ±6° of the horizon, |ndl| < 0.105. */
    float day = smoothstep(-0.105, 0.105, ndl);
    float band = clamp(1.0 - abs(ndl) / 0.105, 0.0, 1.0);

    /* ---- day: the photograph, shaded by the real sun ---------------- */
    vec3 dayFlat = mix(uOceanDay, uLandDay, land);
    vec3 dayPhoto = texture2D(uDayMap, vUv).rgb * (0.30 + 0.80 * max(ndl, 0.0));
    vec3 daySide = mix(dayFlat, dayPhoto, uHasDay);

    /* ---- night: real city light under real weather ------------------ */
    vec3 nightFlat = mix(uOceanNight, uLandNight, land)
      + uCityGlow * land * uCityAmount;

    /* The vendored night composite is not pure Black Marble: it carries a
       stylised teal terrain painting (the Sahara samples 24/105/148 sRGB —
       brighter in BLUE than many real cities are in red). Taken at face
       value that painting floods the night side mint. It is also cleanly
       separable: the painted base is blue-dominant and the actual lights
       are warm-to-neutral, so red minus a share of blue keeps the LIGHTS
       and discards the painting. */
    vec3 nraw = texture2D(uNightMap, vUv).rgb;

    /* Overcast cities dim. The cloud shell drifts, so the ground samples
       the cover above it RIGHT NOW via the drift shift — orbital night
       photography always shows this: light swallowed under weather. */
    float cover = texture2D(uCloudMap, vec2(vUv.x + uCloudShift, vUv.y)).r * uHasClouds;

    float lightI = max(nraw.r - 0.25 * nraw.b, 0.0) * (1.0 - cover * 0.58);

    /* Dim sprawl burns sodium-orange; dense cores white-gold. */
    vec3 cityCol = mix(vec3(1.00, 0.55, 0.24), vec3(1.02, 0.94, 0.78),
      smoothstep(0.05, 0.32, lightI));

    /* Moonlit terrain: the day photograph's luminance ghosted cold, so
       coastlines and deserts survive the dark the way they do from orbit —
       monochrome, faint, dimmer under cloud. */
    float moon = dot(texture2D(uDayMap, vUv).rgb, vec3(0.32, 0.40, 0.28)) * uHasDay;

    vec3 nightPhoto =
        cityCol * lightI * 3.4
      + moon * vec3(0.028, 0.038, 0.058) * (1.0 - cover * 0.35)
      + vec3(0.003, 0.006, 0.012);

    vec3 nightSide = mix(nightFlat, nightPhoto, uHasNight);

    vec3 col = mix(nightSide, daySide, day);

    /* Twilight accent rides the terminator itself — a blush, not a
       painted stripe; the photograph's own dimming does the real work. */
    col += uTwilight * band * (0.030 + land * 0.025);

    /* No specular glint. A sharp highlight was tried and cut: Blue Marble
       is a photographic mosaic that already contains whatever the ocean
       was doing, so an added lobe sat on top of it as a grey smear in the
       South Atlantic — the one element in the frame that read as CG. */
    vec3 nw = normalize(vNormalW);
    vec3 vd = normalize(vViewDir);

    /* Atmosphere: brighter where the limb is also lit. */
    float fres = pow(1.0 - max(dot(nw, vd), 0.0), 3.0);
    col += uAtmo * fres * (0.22 + day * 0.55);

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/* The weather. A slightly larger shell carrying real cloud cover,
   luminance-as-alpha. It drifts independently of the ground, so its sun
   arrives pre-rotated into the shell's own frame (uSunDir here is
   CLOUD-LOCAL, supplied by globe.js each frame). */
export const cloudsVertex = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormalO;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main(){
    vUv = vec2(uv.x + 0.5, uv.y);
    vNormalO = normalize(normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const cloudsFragment = /* glsl */`
  #include <common>

  uniform sampler2D uCloudMap;
  uniform vec3 uSunDir;          // cloud-local (drift-corrected)
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vNormalO;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main(){
    float cover = texture2D(uCloudMap, vUv).r;
    if (cover < 0.02) discard;

    float ndl = dot(normalize(vNormalO), normalize(uSunDir));
    float day = smoothstep(-0.105, 0.105, ndl);

    /* Lit white by day; at night a moonlit blue-grey — present enough
       that storms read as weather over the city light, not a void. */
    vec3 col = vec3(0.62, 0.66, 0.72) * (0.14 + 0.95 * day * max(ndl, 0.0))
      + vec3(0.050, 0.058, 0.075);

    /* Clouds thicken toward the limb — cheap depth that sells the shell. */
    float fres = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0), 2.0);
    float alpha = cover * uOpacity * (0.17 + 0.83 * day) * (1.0 + fres * 0.5);

    gl_FragColor = vec4(col, min(alpha, 0.92));
    #include <colorspace_fragment>
  }
`;
