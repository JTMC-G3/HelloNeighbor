import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/*
 * Graphics presets. "low" is tuned for school Chromebooks (Celeron / MediaTek
 * class hardware): cheap Lambert shading, no real-time shadows, only two
 * active room lights, and a render resolution that scales itself down when
 * the frame rate drops.
 */
export const PRESETS = {
  low: {
    label: 'Low',
    standard: false,
    shadows: false,
    shadowSize: 512,
    shadowEvery: 0,
    lights: 2,
    maxScale: 0.85,
    minScale: 0.5,
    aniso: 1,
    fogFar: 90,
  },
  medium: {
    label: 'Medium',
    standard: false,
    shadows: true,
    shadowSize: 1024,
    shadowEvery: 3,
    lights: 3,
    maxScale: 1,
    minScale: 0.6,
    aniso: 4,
    fogFar: 120,
  },
  high: {
    label: 'High',
    standard: true,
    shadows: true,
    shadowSize: 2048,
    shadowEvery: 1,
    lights: 4,
    maxScale: 1.5,
    minScale: 0.7,
    aniso: 8,
    fogFar: 130,
  },
};

/** Best guess at a preset from what the browser tells us about the device. */
export function detectQuality() {
  const ua = navigator.userAgent || '';
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8;
  if (/CrOS|Android|iPhone|iPad/.test(ua) || cores <= 4 || mem <= 4) return 'low';
  if (cores <= 8) return 'medium';
  return 'high';
}

export function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem(`hn-${key}`);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function saveSetting(key, value) {
  try {
    localStorage.setItem(`hn-${key}`, String(value));
  } catch {
    // Storage can be blocked (managed Chromebooks, private windows); settings just won't persist.
  }
}

// ------------------------------------------------------------------ materials
const toLambert = new Map();
const toStandard = new Map();
let standardMode = true;

/** The version of a material to use right now (for materials swapped at runtime). */
export function adapt(m) {
  return !standardMode && m.isMeshStandardMaterial ? lambertOf(m) : m;
}

function lambertOf(m) {
  let l = toLambert.get(m);
  if (!l) {
    l = new THREE.MeshLambertMaterial({
      name: m.name,
      map: m.map,
      color: m.color,
      emissive: m.emissive,
      emissiveIntensity: m.emissiveIntensity,
      emissiveMap: m.emissiveMap,
      vertexColors: m.vertexColors,
      transparent: m.transparent,
      opacity: m.opacity,
      side: m.side,
      depthWrite: m.depthWrite,
      fog: m.fog,
    });
    l.userData = m.userData;
    toLambert.set(m, l);
    toStandard.set(l, m);
  }
  return l;
}

/** Swap every PBR material in the scene for a cheap Lambert twin (or back). */
export function setMaterialQuality(root, standard) {
  standardMode = standard;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (standard) o.material = toStandard.get(o.material) || o.material;
    else if (o.material.isMeshStandardMaterial) o.material = lambertOf(o.material);
  });
}

// ----------------------------------------------------------------------- bake
const vertexColorMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 });

function isPlain(mat) {
  if (mat.map || mat.transparent || mat.side !== THREE.FrontSide) return false;
  const e = mat.emissive;
  return !e || (e.r + e.g + e.b) * mat.emissiveIntensity < 0.05;
}

/**
 * Merges the direct mesh children of `group` into as few meshes as possible:
 * plain-coloured parts become one vertex-coloured mesh, textured or glowing
 * parts are merged per material. Child groups (joints) are left alone.
 * This turns e.g. a 5-part radio into 1-2 draw calls.
 */
export function bakeChildren(group) {
  const meshes = group.children.filter((c) => c.isMesh);
  if (meshes.length < 2) return group;
  const buckets = new Map();
  for (const m of meshes) {
    m.updateMatrix();
    let g = m.geometry.clone().applyMatrix4(m.matrix);
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const plain = isPlain(m.material);
    if (plain) {
      const c = m.material.color;
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    const key = plain ? vertexColorMaterial : m.material;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(g);
    group.remove(m);
  }
  for (const [mat, geos] of buckets) {
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
