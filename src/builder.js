import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Shared helpers for building static level geometry.

function worldUV(geo, scale) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u;
    let v;
    if (ax >= ay && ax >= az) {
      u = p.getZ(i);
      v = p.getY(i);
    } else if (ay >= ax && ay >= az) {
      u = p.getX(i);
      v = p.getZ(i);
    } else {
      u = p.getX(i);
      v = p.getY(i);
    }
    uv[i * 2] = u / scale;
    uv[i * 2 + 1] = v / scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Collects static geometry and merges it per material to keep draw calls low. */
export class StaticBuilder {
  constructor() {
    this.buckets = new Map();
  }

  add(material, geo) {
    if (geo.index) geo = geo.toNonIndexed();
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (material.userData.worldUV !== false) worldUV(geo, material.userData.scale || 1);
    for (const key of Object.keys(geo.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') geo.deleteAttribute(key);
    }
    if (!this.buckets.has(material)) this.buckets.set(material, []);
    this.buckets.get(material).push(geo);
  }

  box(material, x0, y0, z0, x1, y1, z1) {
    const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.add(material, g);
  }

  mesh(material, geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz),
    );
    geo.applyMatrix4(m);
    this.add(material, geo);
  }

  build(scene) {
    const meshes = [];
    for (const [mat, list] of this.buckets) {
      const geo = mergeGeometries(list, false);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mat.userData.cast !== false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      scene.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }
}

/** Triangular prism along X between xa and xb; pts are [z, y] pairs. */
export function prismX(xa, xb, pts) {
  const [a, b, c] = pts;
  const v = (x, p) => [x, p[1], p[0]];
  const tris = [
    [v(xa, a), v(xa, c), v(xa, b)],
    [v(xb, a), v(xb, b), v(xb, c)],
  ];
  const quad = (p, q) => {
    tris.push([v(xa, p), v(xa, q), v(xb, q)]);
    tris.push([v(xa, p), v(xb, q), v(xb, p)]);
  };
  quad(a, b);
  quad(b, c);
  quad(c, a);
  const arr = [];
  for (const t of tris) for (const p of t) arr.push(...p);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  g.computeVertexNormals();
  // Make sure every face points outward (winding above is not guaranteed).
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const cx = (xa + xb) / 2;
  const cz = (a[0] + b[0] + c[0]) / 3;
  const cy = (a[1] + b[1] + c[1]) / 3;
  for (let i = 0; i < pos.count; i += 3) {
    const mx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3 - cx;
    const my = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 - cy;
    const mz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3 - cz;
    if (mx * nrm.getX(i) + my * nrm.getY(i) + mz * nrm.getZ(i) < 0) {
      // Flip the triangle by swapping two of its vertices.
      const x1 = pos.getX(i + 1);
      const y1 = pos.getY(i + 1);
      const z1 = pos.getZ(i + 1);
      pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
      pos.setXYZ(i + 2, x1, y1, z1);
    }
  }
  g.computeVertexNormals();
  return g;
}

export function makeMaterials(T) {
  const mat = (o) => {
    const m = new THREE.MeshStandardMaterial({
      map: o.map || null,
      color: o.color ?? 0xffffff,
      roughness: o.rough ?? 0.9,
      metalness: o.metal ?? 0,
      emissive: o.emissive ?? 0x000000,
      emissiveIntensity: o.emissiveIntensity ?? 1,
      transparent: !!o.transparent,
      opacity: o.opacity ?? 1,
      side: o.side ?? THREE.FrontSide,
      depthWrite: o.depthWrite ?? true,
    });
    m.userData.scale = o.scale ?? 1;
    m.userData.worldUV = o.worldUV ?? true;
    m.userData.cast = o.cast ?? true;
    return m;
  };
  return {
    grass: mat({ map: T.grass, scale: 4, cast: false }),
    asphalt: mat({ map: T.asphalt, scale: 4, cast: false }),
    concrete: mat({ map: T.concrete, scale: 2 }),
    siding: mat({ map: T.siding, scale: 2 }),
    sidingBlue: mat({ map: T.sidingBlue, scale: 2 }),
    sidingWhite: mat({ map: T.siding, color: 0xf4f4f4, scale: 2 }),
    brick: mat({ map: T.brick, scale: 2 }),
    roof: mat({ map: T.roof, scale: 2 }),
    roofGrey: mat({ map: T.roofGrey, scale: 2 }),
    wood: mat({ map: T.wood, scale: 2.5, rough: 0.7 }),
    darkwood: mat({ map: T.darkwood, scale: 1.2, rough: 0.7 }),
    tile: mat({ map: T.tile, scale: 1.2, rough: 0.4 }),
    wallpaper: mat({ map: T.wallpaper, scale: 1.2 }),
    wallpaper2: mat({ map: T.wallpaper2, scale: 1 }),
    wallpaper3: mat({ map: T.wallpaper3, scale: 1 }),
    plaster: mat({ map: T.plaster, scale: 3 }),
    fence: mat({ map: T.fence, scale: 1.6 }),
    basement: mat({ map: T.basement, scale: 3 }),
    carpet: mat({ map: T.carpet, scale: 2 }),
    carpetBlue: mat({ map: T.carpetBlue, scale: 2 }),
    hedge: mat({ map: T.hedge, scale: 1.5 }),
    cardboard: mat({ map: T.cardboard, scale: 0.7 }),
    bark: mat({ map: T.bark, scale: 1 }),
    leaves: mat({ map: T.leaves, scale: 1.5 }),
    trim: mat({ color: 0xf2efe6, rough: 0.6 }),
    white: mat({ color: 0xf0f0f0, rough: 0.5 }),
    steel: mat({ color: 0xb8bcc2, rough: 0.35, metal: 0.7 }),
    black: mat({ color: 0x1b1b1d, rough: 0.6 }),
    fabricRed: mat({ color: 0x9b3d3d }),
    fabricGreen: mat({ color: 0x4f6b45 }),
    fabricBlue: mat({ color: 0x3c5a8a }),
    fabricBeige: mat({ color: 0xd8c8a8 }),
    pillow: mat({ color: 0xf7f3ea }),
    counter: mat({ color: 0xdedad2, rough: 0.35 }),
    cabinet: mat({ color: 0x7d9b76, rough: 0.6 }),
    darkGlass: mat({ color: 0x1d2a33, rough: 0.1, metal: 0.3 }),
    lampGlow: mat({ color: 0xfff3d0, emissive: 0xffe9b0, emissiveIntensity: 1.5, cast: false }),
    streetLine: mat({ color: 0xf2c94c, rough: 0.8, cast: false }),
    carRed: mat({ color: 0x9e2a2b, rough: 0.35, metal: 0.4 }),
    tire: mat({ color: 0x151515, rough: 0.9 }),
    mailbox: mat({ color: 0x2f5d8a, rough: 0.5, metal: 0.3 }),
    toy: mat({ color: 0xe74c3c, rough: 0.5 }),
    toyYellow: mat({ color: 0xf1c40f, rough: 0.5 }),
    rust: mat({ color: 0x6e3b1f, rough: 0.9, metal: 0.3 }),
    drawing1: mat({ map: T.drawing1, worldUV: false, rough: 1 }),
    drawing2: mat({ map: T.drawing2, worldUV: false, rough: 1 }),
    tv: mat({ map: T.tvStatic, worldUV: false, emissive: 0xffffff, emissiveMap: T.tvStatic, emissiveIntensity: 0.9 }),
    glass: mat({ color: 0xbfe3f5, rough: 0.05, metal: 0.1, transparent: true, opacity: 0.28, depthWrite: false, cast: false, side: THREE.DoubleSide }),
    door: mat({ map: T.darkwood, scale: 1.2, rough: 0.6, color: 0xffffff }),
    doorPainted: mat({ color: 0xe9e2d2, rough: 0.55 }),
    doorBasement: mat({ color: 0x4a4f55, rough: 0.5, metal: 0.4 }),
    brass: mat({ color: 0xd4a93c, rough: 0.3, metal: 0.9 }),
    porcelain: mat({ color: 0xf6f6f2, rough: 0.25 }),
    plank: mat({ map: T.wood, color: 0xd9b48a, scale: 1.5, rough: 0.8 }),
    lightwood: mat({ map: T.wood, color: 0xf0d8b0, scale: 2, rough: 0.7 }),
    plant: mat({ color: 0x3f7d2c, rough: 0.8 }),
    pot: mat({ color: 0xb5653a, rough: 0.8 }),
    tvOff: mat({ color: 0x0e0f12, rough: 0.2, worldUV: false }),
    wallGreen: mat({ map: T.plaster, color: 0xc9dbb7, scale: 3 }),
    wallBlue: mat({ map: T.plaster, color: 0xbfd3e6, scale: 3 }),
    wallPeach: mat({ map: T.plaster, color: 0xf2d2b8, scale: 3 }),
    tileBlue: mat({ map: T.tile, color: 0xcfe3ff, scale: 0.8, rough: 0.35 }),
    wallpaperBlue: mat({ map: T.wallpaper, color: 0xc6d8ff, scale: 1.2 }),
  };
}

