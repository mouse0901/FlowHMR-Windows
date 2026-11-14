import { LoadingManager, Quaternion, Skeleton, Texture, Vector3 } from "three";
import { MMDLoader } from "../vendor/three/mmd/loaders/MMDLoader.js";
import { TGALoader } from "../vendor/three/mmd/loaders/TGALoader.js";

const DEFAULT_UNIT_SCALE = 0.08;
const LOCAL_TEXTURE_PREFIX = "flowhmr-pmx-local:";
const MAX_TEXTURE_DIMENSION = 16384;
const MAX_TEXTURE_PIXELS = 67108864;

/**
 * Fragment tail for the cel look.
 *
 * Three cheap additions on top of the MMD toon ramp, no extra texture fetch and
 * no extra draw call — roughly eight ALU ops per pixel:
 *   1. rim light  — raking back light on the silhouette, the strongest cue in
 *                   Wind-Wave-style character shading;
 *   2. cool shadows — dark areas drift blue, lit areas stay neutral, which is
 *                   what makes cel shading read as painted rather than grey;
 *   3. a little contrast so the ramp bands separate.
 * Everything stays inside the existing material, so MMD sphere maps, toon
 * gradients and transparency keep working untouched.
 */
const CEL_FRAGMENT_TAIL = `
  {
    // Unlit floor: the material keeps its own colour in shadow instead of going
    // muddy grey. This is the "self-lit" feel Wind-Wave characters have, and it
    // is far cheaper than adding an emissive map or an IBL probe.
    outgoingLight += diffuseColor.rgb * 0.18;

    vec3 celNormal = normalize( normal );
    vec3 celView = normalize( vViewPosition );
    // Narrow, restrained rim: a hair light on the silhouette, not a glow suit.
    float rim = pow( 1.0 - clamp( dot( celNormal, celView ), 0.0, 1.0 ), 3.4 );
    outgoingLight += vec3( 0.42, 0.60, 0.95 ) * rim * 0.30;

    float luma = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec3 coolShadow = outgoingLight * vec3( 0.86, 0.94, 1.14 );
    outgoingLight = mix( coolShadow, outgoingLight, smoothstep( 0.04, 0.70, luma ) );
    outgoingLight = mix( vec3( dot( outgoingLight, vec3( 0.3333 ) ) ), outgoingLight, 1.20 );
    // Soft shoulder so the unlit floor cannot blow bright cloth to white.
    outgoingLight = outgoingLight / ( 1.0 + outgoingLight * 0.10 );
  }
`;

/** Append the cel tail to one material's fragment shader. */
function celVariant(base) {
  for (const anchor of ["#include <opaque_fragment>", "#include <output_fragment>"]) {
    if (base.includes(anchor)) return base.replace(anchor, `${CEL_FRAGMENT_TAIL}${anchor}`);
  }
  return null;
}

/**
 * Toggle the cel tail on a material. The untouched-looking base shader is kept
 * on userData, so switching is a recompile of the same material — no reload, no
 * second material, no extra draw call.
 */
function applyCelShading(material, enabled) {
  if (!material || typeof material.fragmentShader !== "string") return;
  if (material.userData.celBase === undefined) {
    if (!material.fragmentShader.includes("outgoingLight")) return;
    material.userData.celBase = material.fragmentShader;
  }
  const base = material.userData.celBase;
  const target = enabled ? celVariant(base) : base;
  if (!target || material.fragmentShader === target) return;
  material.fragmentShader = target;
  material.needsUpdate = true;
}

/** Public toggle used by the viewport when the user flips 三渲二. */
export function setCelShading(root, enabled) {
  root?.traverse((node) => {
    if (!node.isMesh) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material?.userData?.celBase !== undefined) applyCelShading(material, enabled);
    }
  });
}

class PmxAssetError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "PmxAssetError";
    this.code = code;
  }
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new DOMException("PMX load aborted.", "AbortError");
}

function pathParts(value) {
  if (typeof value !== "string" || !value || /^[\\/]|[:\x00-\x1f\x7f]/.test(value)) return null;
  const parts = value.replace(/\\/g, "/").normalize("NFC").split("/");
  return parts.at(-1) ? parts : null;
}

function fileEntry(file) {
  const parts = pathParts(file?.webkitRelativePath || file?.name);
  if (!parts || parts.some((part) => !part || part === "." || part === "..")) return null;
  return { file, parts, path: parts.join("/"), directoryRoot: parts.length > 1 ? parts[0] : null };
}

export function listPmxCandidates(files) {
  return Array.from(files ?? [], fileEntry)
    .filter((entry) => entry && /\.pmx$/i.test(entry.path))
    .map(({ file, path }) => ({ file, path, name: file.name }))
    .sort((a, b) => a.path.localeCompare(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function textureResolver(files, model) {
  const exact = new Map();
  const folded = new Map();
  const remember = (map, key, file) => {
    if (!map.has(key)) map.set(key, file);
    else if (map.get(key) !== file) map.set(key, null);
  };
  for (const file of files) {
    const entry = fileEntry(file);
    if (!entry || entry.directoryRoot !== model.directoryRoot) continue;
    remember(exact, entry.path, file);
    remember(folded, entry.path.toLowerCase(), file);
  }
  return (path) => {
    const parts = pathParts(path);
    if (!parts) return { blocked: true };
    const resolved = model.parts.slice(0, -1);
    const rootDepth = model.directoryRoot ? 1 : 0;
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (resolved.length <= rootDepth) return { blocked: true };
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }
    const full = resolved.join("/");
    return { file: exact.has(full) ? exact.get(full) : folded.get(full.toLowerCase()) };
  };
}

function rasterMime(bytes) {
  const starts = (...prefix) => prefix.every((value, index) => bytes[index] === value);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (starts(255, 216, 255)) return "image/jpeg";
  if (starts(71, 73, 70, 56)) return "image/gif";
  if (starts(66, 77)) return "image/bmp";
  if (starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
  return null;
}

function validTextureSize(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0 && Math.max(width, height) <= MAX_TEXTURE_DIMENSION
    && width * height <= MAX_TEXTURE_PIXELS;
}

async function decodeRaster(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    } catch {
      // Some WebView builds support more BMP encodings through HTMLImageElement.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeLocalImage(file, signal) {
  const prefix = new Uint8Array(await file.slice(0, 18).arrayBuffer());
  abortIfNeeded(signal);
  const mime = rasterMime(prefix);
  if (mime) {
    // Never give untrusted HTML, SVG or arbitrary MIME types to the browser.
    const image = await decodeRaster(new Blob([file], { type: mime }));
    if (!validTextureSize(image.width, image.height)) {
      image.close?.();
      throw new Error("Unsupported texture dimensions.");
    }
    return image;
  }
  if (!/\.tga$/i.test(file.name) || prefix.length < 18) throw new Error("Unsupported texture format.");
  const width = prefix[12] | (prefix[13] << 8);
  const height = prefix[14] | (prefix[15] << 8);
  if (!validTextureSize(width, height)) throw new Error("Unsupported TGA dimensions.");
  const bytes = await file.arrayBuffer();
  abortIfNeeded(signal);
  const { data } = new TGALoader().parse(bytes);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data.buffer), width, height), 0, 0);
  return canvas;
}

function decodeBuiltinToon(url) {
  const embedded = /^data:image\/png;base64,([a-z0-9+/=]+)$/i.exec(url);
  if (!embedded) throw new Error("Unexpected texture URL in the PMX loader.");
  const bytes = Uint8Array.from(atob(embedded[1]), (char) => char.charCodeAt(0));
  return decodeRaster(new Blob([bytes], { type: "image/png" }));
}

function parseModel(loader, buffer) {
  try {
    const header = new DataView(buffer);
    if (header.byteLength < 17 || header.getUint32(0) !== 0x504d5820 || header.getUint8(8) !== 8) {
      throw new Error("Not a supported PMX 2.0/2.1 header.");
    }
    if (header.getUint8(10) > 4 || [11, 12, 13, 14, 15, 16].some((offset) => ![1, 2, 4].includes(header.getUint8(offset)))) {
      throw new Error("Invalid PMX index sizes.");
    }
    // Three's public load() is URL-based. The pinned r160 parser and builder let us
    // validate and replace every texture reference before any material requests it.
    const data = loader._getParser().parsePmx(buffer, true);
    const { bones, vertices, faces, materials } = data;
    if (!bones.length || bones.length > 65536 || !vertices.length || !faces.length || !materials.length) {
      throw new Error("A skinned PMX model needs vertices, faces, materials and bones.");
    }

    const visited = new Uint8Array(bones.length);
    for (let i = 0; i < bones.length; i++) {
      const { parentIndex, position } = bones[i];
      if (!Number.isInteger(parentIndex) || parentIndex < -1 || parentIndex >= bones.length
        || !position.every(Number.isFinite)) throw new Error("Invalid PMX bone transform or parent.");
      let cursor = i;
      const path = [];
      while (cursor >= 0 && cursor < bones.length && !visited[cursor]) {
        visited[cursor] = 1;
        path.push(cursor);
        cursor = bones[cursor].parentIndex;
      }
      if (cursor >= 0 && visited[cursor] === 1) throw new Error("The PMX skeleton contains a cycle.");
      for (const entry of path) visited[entry] = 2;
    }

    for (const vertex of vertices) {
      if (!vertex.position.every(Number.isFinite)) throw new Error("Invalid PMX vertex.");
      for (let i = 0; i < vertex.skinWeights.length; i++) {
        const weight = vertex.skinWeights[i];
        const index = vertex.skinIndices[i];
        if (!Number.isFinite(weight)) throw new Error("Invalid PMX skin weight.");
        if (index < 0 || index >= bones.length) {
          if (weight !== 0) throw new Error("A PMX skin weight points to a missing bone.");
          vertex.skinIndices[i] = 0;
        }
      }
    }
    return data;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PmxAssetError("parse", detail, cause);
  }
}

async function prepareTextures(data, resolve, rememberImage, signal, readTexture) {
  const references = [];
  const names = data.textures;
  for (const material of data.materials) {
    for (const [field, active, role] of [
      ["textureIndex", true, "color"],
      ["envTextureIndex", material.envFlag === 1 || material.envFlag === 2, "sphere"],
      ["toonIndex", material.toonFlag === 0, "toon"],
    ]) {
      if (active && material[field] !== -1) {
        references.push({ material, field, role, path: names[material[field]] ?? "#" + material[field] });
        material[field] = -1;
      } else if (field === "toonIndex" && (material[field] < -1 || material[field] > 9)) {
        material[field] = -1;
      }
    }
  }
  const paths = new Map();
  for (const { path } of references) {
    if (!paths.has(path)) paths.set(path, resolve(path));
  }
  if (readTexture) {
    const remote = Array.from(paths).filter(([, { file, blocked }]) => !file && !blocked);
    let next = 0;
    await Promise.allSettled(Array.from({ length: Math.min(3, remote.length) }, async () => {
      while (next < remote.length && !signal?.aborted) {
        const [path, record] = remote[next++];
        try { record.file = await readTexture(path); } catch { /* use base material if unavailable */ }
      }
    }));
    abortIfNeeded(signal);
  }
  const textures = Array.from(new Set(Array.from(paths.values(), ({ file }) => file).filter(Boolean)));
  const images = new Map();
  let next = 0;
  await Promise.allSettled(Array.from({ length: Math.min(3, textures.length) }, async () => {
    while (next < textures.length && !signal?.aborted) {
      const file = textures[next++];
      try {
        const image = await decodeLocalImage(file, signal);
        rememberImage(image);
        images.set(file, image);
      } catch {
        // Missing or damaged textures leave the material on its base color.
      }
    }
  }));
  abortIfNeeded(signal);

  const localImages = new Map();
  const byFileAndRole = new Map();
  data.textures = [];
  for (const { material, field, role, path } of references) {
    const { file } = paths.get(path);
    if (!images.has(file)) continue;
    if (!byFileAndRole.has(file)) byFileAndRole.set(file, new Map());
    const roles = byFileAndRole.get(file);
    if (!roles.has(role)) {
      const index = data.textures.length;
      const key = "t" + index + ".asset";
      roles.set(role, index);
      data.textures.push(key);
      localImages.set(LOCAL_TEXTURE_PREFIX + key, images.get(file));
    }
    material[field] = roles.get(role);
  }
  const missingPaths = [];
  const failedPaths = [];
  const blockedPaths = [];
  for (const [path, { file, blocked }] of paths) {
    if (!file) missingPaths.push(path);
    else if (!images.has(file)) failedPaths.push(path);
    if (blocked) blockedPaths.push(path);
  }
  return {
    localImages,
    textureReport: {
      requested: paths.size,
      loaded: paths.size - missingPaths.length - failedPaths.length,
      missing: missingPaths.length,
      failed: failedPaths.length,
      missingPaths,
      failedPaths,
      blockedPaths,
    },
  };
}

function restPose(mesh, data, unitScale) {
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  const position = new Vector3();
  const quaternion = new Quaternion();
  let sdefVertices = 0;
  let qdefVertices = 0;
  for (const vertex of data.vertices) {
    if (vertex.skinC) sdefVertices++;
    if (vertex.type === 4) qdefVertices++;
  }
  return {
    unitScale,
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    skinning: { vertices: data.vertices.length, sdefVertices, qdefVertices, approximate: sdefVertices + qdefVertices > 0 },
    bones: mesh.skeleton.bones.map((bone, index) => {
      const raw = data.bones[index];
      return {
        index,
        name: bone.name,
        nameEn: raw.englishName,
        parent: raw.parentIndex,
        position: bone.position.toArray(),
        quaternion: bone.quaternion.toArray(),
        scale: bone.scale.toArray(),
        worldPosition: bone.getWorldPosition(position).toArray(),
        worldQuaternion: bone.getWorldQuaternion(quaternion).toArray(),
        worldMatrix: bone.matrixWorld.toArray(),
        // The r160 parser converts bone positions, and its mesh builder converts IK limits.
        // Optional PMX axis and tail vectors are still in original PMX coordinates.
        pmx: {
          flags: raw.flag,
          transformationClass: raw.transformationClass,
          connectIndex: raw.connectIndex ?? null,
          offsetPosition: raw.offsetPosition ?? null,
          fixedAxis: raw.fixAxis ?? null,
          localX: raw.localXVector ?? null,
          localZ: raw.localZVector ?? null,
          grant: raw.grant ?? null,
          ik: raw.ik ?? null,
        },
      };
    }),
  };
}

function cloneSkinned(source) {
  const clone = source.clone(true);
  const copies = new Map();
  const pair = (a, b) => {
    copies.set(a, b);
    a.children.forEach((child, i) => pair(child, b.children[i]));
  };
  pair(source, clone);
  const skeleton = new Skeleton(
    source.skeleton.bones.map((bone) => copies.get(bone)),
    source.skeleton.boneInverses.map((matrix) => matrix.clone()),
  );
  clone.bind(skeleton, source.bindMatrix);
  clone.updateMatrixWorld(true);
  return clone;
}

/**
 * Build one local PMX resource. Treat asset.mesh as a read-only rest template;
 * add asset.clone() to the scene and release it with asset.releaseClone().
 * Each clone has its own skeleton and shares asset-owned GPU resources.
 */
export async function loadPmxAsset(files, selectedFile, { signal, readTexture, unitScale = DEFAULT_UNIT_SCALE } = {}) {
  abortIfNeeded(signal);
  const entries = Array.from(files ?? []);
  const model = fileEntry(selectedFile);
  if (!model || !/\.pmx$/i.test(model.path) || !entries.includes(selectedFile)) {
    throw new PmxAssetError("selection", "Select a PMX file from the chosen files.");
  }
  if (!Number.isFinite(unitScale) || unitScale <= 0) throw new PmxAssetError("scale", "PMX unit scale must be positive.");

  const manager = new LoadingManager();
  const loader = new MMDLoader(manager);
  const buffers = new Set();
  const textures = new Set();
  const clones = new Set();
  const pending = [];
  const builtinImages = new Map();
  let mesh;
  let disposed = false;
  const rememberImage = (image) => {
    if (typeof image.close === "function") buffers.add(image);
    return image;
  };
  const releaseClone = (clone) => {
    if (!clones.delete(clone)) return false;
    clone.removeFromParent();
    clone.skeleton.dispose();
    return true;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const clone of clones) releaseClone(clone);
    mesh?.removeFromParent();
    mesh?.skeleton.dispose();
    mesh?.geometry.dispose();
    for (const material of mesh?.material ?? []) material.dispose();
    for (const texture of textures) {
      texture.dispose();
      texture.image = null;
    }
    for (const buffer of buffers) buffer.close();
    textures.clear();
    buffers.clear();
  };

  try {
    const modelBytes = await selectedFile.arrayBuffer();
    abortIfNeeded(signal);
    const data = parseModel(loader, modelBytes);
    const { localImages, textureReport } = await prepareTextures(
      data, textureResolver(entries, model), rememberImage, signal, readTexture,
    );
    manager.addHandler(/.*/, {
      load(url, onLoad) {
        const texture = new Texture();
        textures.add(texture);
        // MMDLoader attaches its ready callbacks before this task resumes.
        pending.push(Promise.resolve().then(async () => {
          if (localImages.has(url)) {
            texture.image = localImages.get(url);
          } else {
            if (!builtinImages.has(url)) builtinImages.set(url, decodeBuiltinToon(url).then(rememberImage));
            texture.image = await builtinImages.get(url);
          }
          onLoad(texture);
          texture.needsUpdate = true;
        }));
        return texture;
      },
    });
    mesh = loader.meshBuilder.build(data, LOCAL_TEXTURE_PREFIX);
    const textureResults = await Promise.allSettled(pending);
    const failure = textureResults.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
    abortIfNeeded(signal);
    for (const material of mesh.material) {
      if (material.map?.transparent) material.transparent = true;
      // Keep the authored toon ramps and sphere textures but let the viewport's
      // key light shape the model. Many PMX materials use bright MMD ambient
      // and additive matcaps that would otherwise blow out white textures.
      // 0.88 leans the diffuse response onto the gradient ramp: this is the
      // cel-shaded look MMD authors draw for, while the remaining 12% of
      // Lambert keeps large curved surfaces from banding.
      material.emissive.multiplyScalar(.42);
      // PMX ambient is authored for MMD's flat lighting; at full strength it
      // lifts the shadows until the toon ramp has nothing left to separate.
      if (material.ambient?.multiplyScalar) material.ambient.multiplyScalar(0.45);
      material.fragmentShader = material.fragmentShader
        .replace("getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color",
          "mix( vec3( max( 0.0, dot( geometryNormal, directLight.direction ) ) ), getGradientIrradiance( geometryNormal, directLight.direction ), 0.94 ) * directLight.color")
        .replace("outgoingLight += matcapColor.rgb;", "outgoingLight += matcapColor.rgb * 0.18;");
      applyCelShading(material);
    }
    mesh.name = data.metadata.modelName || selectedFile.name;
    mesh.scale.setScalar(unitScale);
    mesh.frustumCulled = false;
    mesh.updateMatrixWorld(true);

    const rest = restPose(mesh, data, unitScale);
    return {
      kind: "pmx",
      name: mesh.name,
      path: model.path,
      mesh,
      rest,
      textureReport,
      clone() {
        if (disposed) throw new PmxAssetError("disposed", "The PMX asset is no longer available.");
        const clone = cloneSkinned(mesh);
        clones.add(clone);
        return clone;
      },
      releaseClone,
      dispose,
    };
  } catch (cause) {
    await Promise.allSettled(pending);
    dispose();
    if (cause instanceof PmxAssetError || cause?.name === "AbortError") throw cause;
    throw new PmxAssetError("load", cause instanceof Error ? cause.message : String(cause), cause);
  }
}
