import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createTextures } from './textures.js';
import { Item } from './items.js';

/*
 * Level layout (metres, Y up). The street runs along X at z = 0. The player's
 * house is south of it (+z), the neighbor's house is north of it (-z).
 *
 * Neighbor's house footprint: x -8..8, z -22..-10 (front door faces the street).
 *
 *   Ground floor (floor top y = 0.3)          Upstairs (floor top y = 3.5)
 *   +---------+--------+---------+            +---------+--------+---------+
 *   | Kitchen |  Hall  | Storage |  z=-22     |  Kid's  |  Hall  | Master  |
 *   |  (back  | [base- |         |            |  room   |        | bedroom |
 *   |  door)  |  ment] |         |            |         |        | (blue   |
 *   +--arch---+ stairs +--arch---+  z=-16     |         | stair  |  lock)  |
 *   | Living  |   up   |  Study  |            |         |  hole  |         |
 *   |  room   |        |         |            |         |        |         |
 *   +---------+-front--+---------+  z=-10     +---------+--------+---------+
 *     x=-8    -2      2      8
 *
 * The staircase to the upper floor runs up the west side of the hall. The
 * basement door hides underneath it (red lock), and the basement stairs run
 * back down beneath the upper flight into a small room under the living room.
 */

export const HOUSE = { x0: -8, x1: 8, z0: -22, z1: -10 };
export const FLOOR = 0.3;
export const UPPER = 3.5;
export const BASEMENT = -2.9;
export const SPAWN = new THREE.Vector3(0, 0, 9.5);

const WT = 0.25; // exterior wall thickness
const IT = 0.15; // interior wall thickness

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
class StaticBuilder {
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
function prismX(xa, xb, pts) {
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

function makeMaterials(T) {
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
  };
}

export function buildWorld(scene, physics) {
  const T = createTextures();
  const M = makeMaterials(T);
  const B = new StaticBuilder();
  const doors = [];
  const windows = [];
  const items = [];
  const dynamicMeshes = [];
  const flicker = [];

  const solid = (mat, x0, y0, z0, x1, y1, z1, kind = 'wall') => {
    B.box(mat, x0, y0, z0, x1, y1, z1);
    return physics.add(x0, y0, z0, x1, y1, z1, kind);
  };
  const deco = (mat, x0, y0, z0, x1, y1, z1) => B.box(mat, x0, y0, z0, x1, y1, z1);

  // ---------------------------------------------------------------- windows
  function makeWindow(axis, c, a, b, bottom, top, t) {
    const w = b - a;
    const h = top - bottom;
    const cx = axis === 'x' ? (a + b) / 2 : c;
    const cz = axis === 'x' ? c : (a + b) / 2;
    const group = new THREE.Group();
    group.position.set(cx, (bottom + top) / 2, cz);
    if (axis === 'z') group.rotation.y = Math.PI / 2;
    const pane = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), M.glass);
    pane.renderOrder = 2;
    group.add(pane);
    const bar = M.trim;
    const mv = new THREE.Mesh(new THREE.BoxGeometry(0.04, h, 0.04), bar);
    const mh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, 0.04), bar);
    group.add(mv, mh);
    scene.add(group);

    const collider = axis === 'x'
      ? physics.add(a, bottom, c - 0.03, b, top, c + 0.03, 'glass')
      : physics.add(c - 0.03, bottom, a, c + 0.03, top, b, 'glass');
    const win = {
      group,
      pane,
      collider,
      broken: false,
      center: new THREE.Vector3(cx, (bottom + top) / 2, cz),
      w,
      h,
      axis,
    };
    collider.ref = win;
    pane.userData.window = win;
    windows.push(win);
    dynamicMeshes.push(pane);

    // frame + sill (static)
    const o = t / 2 + 0.03;
    const f = 0.07;
    if (axis === 'x') {
      deco(M.trim, a - f, bottom, c - o, a, top + f, c + o);
      deco(M.trim, b, bottom, c - o, b + f, top + f, c + o);
      deco(M.trim, a - f, top, c - o, b + f, top + f, c + o);
      deco(M.trim, a - f - 0.05, bottom - 0.06, c - o - 0.06, b + f + 0.05, bottom, c + o + 0.06);
    } else {
      deco(M.trim, c - o, bottom, a - f, c + o, top + f, a);
      deco(M.trim, c - o, bottom, b, c + o, top + f, b + f);
      deco(M.trim, c - o, top, a - f, c + o, top + f, b + f);
      deco(M.trim, c - o - 0.06, bottom - 0.06, a - f - 0.05, c + o + 0.06, bottom, b + f + 0.05);
    }
    return win;
  }

  // ------------------------------------------------------------------ doors
  function makePadlock(color) {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.35, emissive: color, emissiveIntensity: 0.15 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.05), m);
    const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.012, 6, 14, Math.PI), new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.3 }));
    shackle.position.y = 0.06;
    g.add(body, shackle);
    return g;
  }

  function makeDoor({ axis, c, a, b, y0, h, id, name, swing = 1, locked = false, key = null, material, neighborIgnore = false }) {
    const w = b - a;
    const pivot = new THREE.Group();
    const base = axis === 'x' ? 0 : -Math.PI / 2;
    if (axis === 'x') pivot.position.set(a, y0, c);
    else pivot.position.set(c, y0, a);
    pivot.rotation.y = base;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w - 0.03, h - 0.02, 0.06), material || M.doorPainted);
    panel.position.set(w / 2, h / 2, 0);
    panel.castShadow = true;
    panel.receiveShadow = true;
    pivot.add(panel);
    const knobGeo = new THREE.SphereGeometry(0.035, 10, 8);
    for (const side of [-1, 1]) {
      const knob = new THREE.Mesh(knobGeo, M.brass);
      knob.position.set(w - 0.12, 1.0, side * 0.06);
      pivot.add(knob);
    }
    const locks = [];
    if (key) {
      const color = key === 'red' ? 0xd62828 : 0x1f6fe0;
      for (const side of [-1, 1]) {
        const lock = makePadlock(color);
        lock.position.set(w - 0.2, 1.25, side * 0.06);
        pivot.add(lock);
        locks.push(lock);
      }
    }
    scene.add(pivot);

    const collider = axis === 'x'
      ? physics.add(a, y0, c - 0.05, b, y0 + h, c + 0.05, 'door')
      : physics.add(c - 0.05, y0, a, c + 0.05, y0 + h, b, 'door');
    const center = axis === 'x' ? new THREE.Vector3((a + b) / 2, y0, c) : new THREE.Vector3(c, y0, (a + b) / 2);

    const door = {
      id,
      name,
      pivot,
      panel,
      collider,
      center,
      locked,
      key,
      locks,
      neighborIgnore,
      open: false,
      t: 0,
      base,
      swing,
      openedByNeighbor: false,
      setOpen(v) { this.open = v; },
      unlock() {
        this.locked = false;
        for (const l of this.locks) l.parent.remove(l);
        this.locks.length = 0;
      },
      update(dt) {
        const target = this.open ? 1 : 0;
        const speed = 2.2 * dt;
        if (this.t < target) this.t = Math.min(target, this.t + speed);
        else if (this.t > target) this.t = Math.max(target, this.t - speed);
        const e = this.t * this.t * (3 - 2 * this.t);
        this.pivot.rotation.y = this.base + this.swing * e * Math.PI * 0.5 * 0.97;
        this.collider.enabled = this.t < 0.15;
      },
    };
    collider.ref = door;
    panel.userData.door = door;
    doors.push(door);
    dynamicMeshes.push(panel);
    return door;
  }

  function doorTrim(axis, c, a, b, bottom, top, t) {
    const o = t / 2 + 0.025;
    const f = 0.08;
    if (axis === 'x') {
      deco(M.trim, a - f, bottom, c - o, a, top + f, c + o);
      deco(M.trim, b, bottom, c - o, b + f, top + f, c + o);
      deco(M.trim, a - f, top, c - o, b + f, top + f, c + o);
    } else {
      deco(M.trim, c - o, bottom, a - f, c + o, top + f, a);
      deco(M.trim, c - o, bottom, b, c + o, top + f, b + f);
      deco(M.trim, c - o, top, a - f, c + o, top + f, b + f);
    }
  }

  // ------------------------------------------------------------------ walls
  function wall({ axis, c, from, to, y0, y1, t, lo, hi, openings = [], splits = [] }) {
    const ops = openings.slice().sort((p, q) => p.a - q.a);
    const pieces = [];
    let cur = from;
    for (const o of ops) {
      if (o.a > cur) pieces.push([cur, o.a, y0, y1]);
      if (o.bottom > y0) pieces.push([o.a, o.b, y0, o.bottom]);
      if (o.top < y1) pieces.push([o.a, o.b, o.top, y1]);
      cur = o.b;
      if (o.window) makeWindow(axis, c, o.a, o.b, o.bottom, o.top, t);
      else doorTrim(axis, c, o.a, o.b, o.bottom, o.top, t);
      if (o.door) makeDoor({ axis, c, a: o.a, b: o.b, y0: o.bottom, h: o.top - o.bottom, ...o.door });
    }
    if (cur < to) pieces.push([cur, to, y0, y1]);
    for (const [a, b, ya, yb] of pieces) {
      if (axis === 'x') physics.add(a, ya, c - t / 2, b, yb, c + t / 2);
      else physics.add(c - t / 2, ya, a, c + t / 2, yb, b);
      const cuts = [a, ...splits.filter((s) => s > a && s < b), b];
      for (let i = 0; i < cuts.length - 1; i++) {
        const p = cuts[i];
        const q = cuts[i + 1];
        const mid = (p + q) / 2;
        const mLo = typeof lo === 'function' ? lo(mid) : lo;
        const mHi = typeof hi === 'function' ? hi(mid) : hi;
        if (axis === 'x') {
          B.box(mLo, p, ya, c - t / 2, q, yb, c);
          B.box(mHi, p, ya, c, q, yb, c + t / 2);
        } else {
          B.box(mLo, c - t / 2, ya, p, c, yb, q);
          B.box(mHi, c, ya, p, c + t / 2, yb, q);
        }
      }
    }
  }

  // Interior finish per room.
  const groundRoom = (x, z) => {
    if (x < -2) return z > -16 ? M.wallpaper : M.plaster;
    if (x > 2) return z > -16 ? M.wallpaper3 : M.basement;
    return M.wallpaper3;
  };
  const upperRoom = (x) => (x < -2 ? M.wallpaper2 : x > 2 ? M.wallpaper : M.plaster);

  // =================================================================
  // Neighbor's house
  // =================================================================
  const { x0: HX0, x1: HX1, z0: HZ0, z1: HZ1 } = HOUSE;
  physics.addHole(HX0, HZ0, HX1, HZ1);

  // ---- ground floor slab (hole for the basement stairs)
  const HOLE_B = { x0: -2, x1: -0.8, z0: -18.95, z1: -14 };
  const slabRects = [
    [HX0, HZ0, HX1, HOLE_B.z0],
    [HX0, HOLE_B.z1, HX1, HZ1],
    [HX0, HOLE_B.z0, HOLE_B.x0, HOLE_B.z1],
    [HOLE_B.x1, HOLE_B.z0, HX1, HOLE_B.z1],
  ];
  for (const [x0, z0, x1, z1] of slabRects) {
    physics.add(x0, 0, z0, x1, FLOOR, z1, 'floor');
    deco(M.basement, x0, 0, z0, x1, FLOOR - 0.02, z1);
  }
  // floor coverings
  deco(M.wood, -8, FLOOR - 0.02, -16, -2, FLOOR, -10); // living
  deco(M.tile, -8, FLOOR - 0.02, -22, -2, FLOOR, -16); // kitchen
  deco(M.carpet, 2, FLOOR - 0.02, -16, 8, FLOOR, -10); // study
  deco(M.basement, 2, FLOOR - 0.02, -22, 8, FLOOR, -16); // storage
  deco(M.wood, -2, FLOOR - 0.02, -22, 2, FLOOR, HOLE_B.z0); // hall
  deco(M.wood, -2, FLOOR - 0.02, HOLE_B.z1, 2, FLOOR, -10);
  deco(M.wood, HOLE_B.x1, FLOOR - 0.02, HOLE_B.z0, 2, FLOOR, HOLE_B.z1);

  // ---- upper floor slab (hole for the staircase)
  const HOLE_U = { x0: -2, x1: -0.8, z0: -19, z1: -13 };
  const uRects = [
    [HX0, HZ0, HX1, HOLE_U.z0],
    [HX0, HOLE_U.z1, HX1, HZ1],
    [HX0, HOLE_U.z0, HOLE_U.x0, HOLE_U.z1],
    [HOLE_U.x1, HOLE_U.z0, HX1, HOLE_U.z1],
  ];
  for (const [x0, z0, x1, z1] of uRects) {
    physics.add(x0, 3.3, z0, x1, UPPER, z1, 'floor');
    deco(M.plaster, x0, 3.3, z0, x1, UPPER - 0.02, z1);
  }
  deco(M.wood, -8, UPPER - 0.02, -22, -2, UPPER, -10);
  deco(M.carpetBlue, 2, UPPER - 0.02, -22, 8, UPPER, -10);
  deco(M.wood, -2, UPPER - 0.02, -22, 2, UPPER, HOLE_U.z0);
  deco(M.wood, -2, UPPER - 0.02, HOLE_U.z1, 2, UPPER, -10);
  deco(M.wood, HOLE_U.x1, UPPER - 0.02, HOLE_U.z0, 2, UPPER, HOLE_U.z1);

  // ---- top ceiling
  solid(M.plaster, HX0, 6.3, HZ0, HX1, 6.5, HZ1, 'floor');

  // ---- exterior walls, ground floor
  const e = WT / 2;
  wall({
    axis: 'x', c: HZ1, from: HX0 - e, to: HX1 + e, y0: 0, y1: UPPER, t: WT,
    lo: (x) => groundRoom(x, -11), hi: M.siding, splits: [-2, 2],
    openings: [
      { a: -0.6, b: 0.6, bottom: FLOOR, top: 2.5, door: { id: 'front', name: 'Front Door', swing: 1, locked: true, material: M.door } },
      { a: -6, b: -4, bottom: 0.9, top: 2.6, window: true },
      { a: 4, b: 6, bottom: 0.9, top: 2.6, window: true },
    ],
  });
  wall({
    axis: 'x', c: HZ0, from: HX0 - e, to: HX1 + e, y0: 0, y1: UPPER, t: WT,
    lo: M.siding, hi: (x) => groundRoom(x, -21), splits: [-2, 2],
    openings: [
      { a: -7, b: -6, bottom: FLOOR, top: 2.5, door: { id: 'back', name: 'Back Door', swing: -1, material: M.door } },
      { a: -4.5, b: -3, bottom: 1.3, top: 2.6, window: true },
      { a: -0.5, b: 0.5, bottom: 0.9, top: 2.6, window: true },
      { a: 4, b: 6, bottom: 0.9, top: 2.6, window: true },
    ],
  });
  wall({
    axis: 'z', c: HX0, from: HZ0 + e, to: HZ1 - e, y0: 0, y1: UPPER, t: WT,
    lo: M.siding, hi: (z) => groundRoom(-5, z), splits: [-16],
    openings: [
      { a: -14, b: -12, bottom: 0.9, top: 2.6, window: true },
      { a: -20, b: -18, bottom: 0.9, top: 2.6, window: true },
    ],
  });
  wall({
    axis: 'z', c: HX1, from: HZ0 + e, to: HZ1 - e, y0: 0, y1: UPPER, t: WT,
    lo: (z) => groundRoom(5, z), hi: M.siding, splits: [-16],
    openings: [{ a: -14, b: -12, bottom: 0.9, top: 2.6, window: true }],
  });

  // ---- interior walls, ground floor
  const ie = IT / 2;
  wall({
    axis: 'z', c: -2, from: HZ0 + e, to: HZ1 - e, y0: FLOOR, y1: 3.3, t: IT,
    lo: (z) => groundRoom(-5, z), hi: M.wallpaper3, splits: [-16],
    openings: [
      { a: -11.8, b: -10.6, bottom: FLOOR, top: 2.5, door: { id: 'living', name: 'Door', swing: -1 } },
      { a: -21.2, b: -20.2, bottom: FLOOR, top: 2.5, door: { id: 'kitchen', name: 'Door', swing: 1 } },
    ],
  });
  wall({
    axis: 'z', c: 2, from: HZ0 + e, to: HZ1 - e, y0: FLOOR, y1: 3.3, t: IT,
    lo: M.wallpaper3, hi: (z) => groundRoom(5, z), splits: [-16],
    openings: [
      { a: -11.8, b: -10.6, bottom: FLOOR, top: 2.5, door: { id: 'study', name: 'Door', swing: 1 } },
      { a: -21.2, b: -20.2, bottom: FLOOR, top: 2.5, door: { id: 'storage', name: 'Door', swing: 1 } },
    ],
  });
  wall({
    axis: 'x', c: -16, from: HX0 + e, to: -2 - ie, y0: FLOOR, y1: 3.3, t: IT,
    lo: M.plaster, hi: M.wallpaper,
    openings: [{ a: -5, b: -4, bottom: FLOOR, top: 2.5 }],
  });
  wall({
    axis: 'x', c: -16, from: 2 + ie, to: HX1 - e, y0: FLOOR, y1: 3.3, t: IT,
    lo: M.basement, hi: M.wallpaper3,
    openings: [{ a: 4.5, b: 5.5, bottom: FLOOR, top: 2.5 }],
  });

  // ---- staircase to upstairs: 16 floating treads up the west side of the hall
  const SX0 = -2 + ie;
  const SX1 = -0.8 - ie;
  for (let i = 1; i <= 16; i++) {
    const zA = -13 - 0.375 * (i - 1);
    const zB = -13 - 0.375 * i;
    const top = FLOOR + 0.2 * i;
    solid(M.darkwood, SX0, top - 0.2, zB, SX1, top, zA, 'floor');
  }
  // Under-stair enclosure wall (also the east wall of the basement stairwell).
  wall({ axis: 'z', c: -0.8, from: -19.05, to: -13, y0: BASEMENT, y1: FLOOR, t: IT, lo: M.basement, hi: M.basement });
  wall({ axis: 'z', c: -0.8, from: -19.05, to: -13, y0: FLOOR, y1: 3.3, t: IT, lo: M.wallpaper3, hi: M.wallpaper3 });
  // West wall of the basement stairwell (below the hall's west wall).
  solid(M.basement, -2 - ie, BASEMENT, -19.05, -2 + ie, FLOOR, -14);
  // Basement door wall, under the top of the stairs.
  solid(M.basement, -2, BASEMENT, -19.05, -0.8, FLOOR, -18.95);
  wall({
    axis: 'x', c: -19, from: SX0, to: SX1, y0: FLOOR, y1: 3.3, t: 0.1,
    lo: M.wallpaper3, hi: M.wallpaper3,
    openings: [{
      a: -1.9, b: -0.9, bottom: FLOOR, top: 2.5,
      door: { id: 'basement', name: 'Basement Door', swing: 1, locked: true, key: 'red', material: M.doorBasement, neighborIgnore: true },
    }],
  });
  // Upstairs railing around the stair hole.
  physics.add(-0.85, 3.3, -19, -0.75, 4.45, -13);
  physics.add(-2, 3.3, -13.05, -0.8, 4.45, -12.95);
  deco(M.darkwood, -0.87, 4.35, -19, -0.73, 4.45, -12.93);
  deco(M.darkwood, -2, 4.35, -13.07, -0.73, 4.45, -12.93);
  for (let z = -19; z <= -13; z += 0.5) deco(M.darkwood, -0.83, UPPER, z - 0.02, -0.77, 4.35, z + 0.02);
  for (let x = -1.9; x < -0.8; x += 0.4) deco(M.darkwood, x - 0.02, UPPER, -13.03, x + 0.02, 4.35, -12.97);

  // ---- basement stairs, running south under the upper flight
  const BZ0 = -18.95;
  const BD = 0.309;
  for (let j = 1; j <= 15; j++) {
    const zA = BZ0 + BD * (j - 1);
    const zB = BZ0 + BD * j;
    solid(M.basement, SX0, BASEMENT, zA, SX1, FLOOR - 0.2 * j, zB, 'floor');
  }

  // ---- basement room
  solid(M.basement, -8, BASEMENT - 0.2, -19.1, 2, BASEMENT, -10, 'floor');
  wall({ axis: 'x', c: -10.1, from: -8, to: 2, y0: BASEMENT, y1: 0, t: 0.2, lo: M.basement, hi: M.basement });
  wall({
    axis: 'x', c: -14, from: -8, to: 2, y0: BASEMENT, y1: 0, t: 0.2, lo: M.basement, hi: M.basement,
    openings: [{ a: -2, b: -0.8, bottom: BASEMENT, top: 0 }],
  });
  wall({ axis: 'z', c: -7.9, from: -14, to: -10.1, y0: BASEMENT, y1: 0, t: 0.2, lo: M.basement, hi: M.basement });
  wall({ axis: 'z', c: 1.9, from: -14, to: -10.1, y0: BASEMENT, y1: 0, t: 0.2, lo: M.basement, hi: M.basement });

  // ---- exterior walls, upstairs
  wall({
    axis: 'x', c: HZ1, from: HX0 - e, to: HX1 + e, y0: UPPER, y1: 6.5, t: WT,
    lo: upperRoom, hi: M.siding, splits: [-2, 2],
    openings: [
      { a: -6, b: -4, bottom: 4.3, top: 5.7, window: true },
      { a: -0.6, b: 0.6, bottom: 4.3, top: 5.7, window: true },
      { a: 4, b: 6, bottom: 4.3, top: 5.7, window: true },
    ],
  });
  wall({
    axis: 'x', c: HZ0, from: HX0 - e, to: HX1 + e, y0: UPPER, y1: 6.5, t: WT,
    lo: M.siding, hi: upperRoom, splits: [-2, 2],
    openings: [
      { a: -5, b: -3, bottom: 4.3, top: 5.7, window: true },
      { a: 4, b: 6, bottom: 4.3, top: 5.7, window: true },
    ],
  });
  wall({
    axis: 'z', c: HX0, from: HZ0 + e, to: HZ1 - e, y0: UPPER, y1: 6.5, t: WT,
    lo: M.siding, hi: M.wallpaper2,
    openings: [{ a: -17, b: -15, bottom: 4.3, top: 5.7, window: true }],
  });
  wall({
    axis: 'z', c: HX1, from: HZ0 + e, to: HZ1 - e, y0: UPPER, y1: 6.5, t: WT,
    lo: M.wallpaper, hi: M.siding,
    openings: [{ a: -17, b: -15, bottom: 4.3, top: 5.7, window: true }],
  });
  // ---- interior walls, upstairs
  wall({
    axis: 'z', c: -2, from: HZ0 + e, to: HZ1 - e, y0: 3.3, y1: 6.3, t: IT,
    lo: M.wallpaper2, hi: M.plaster,
    openings: [{ a: -21.4, b: -20.4, bottom: UPPER, top: 5.7, door: { id: 'kidroom', name: 'Door', swing: -1 } }],
  });
  wall({
    axis: 'z', c: 2, from: HZ0 + e, to: HZ1 - e, y0: 3.3, y1: 6.3, t: IT,
    lo: M.plaster, hi: M.wallpaper,
    openings: [{ a: -21.4, b: -20.4, bottom: UPPER, top: 5.7, door: { id: 'bedroom', name: 'Bedroom Door', swing: 1, locked: true, key: 'blue' } }],
  });

  // ---- roof (gable along X) + chimney
  const eaveY = 6.5;
  const ridgeY = 9.3;
  const ov = 0.6;
  const halfSpan = (HZ1 - HZ0) / 2 + ov;
  const slope = Math.atan2(ridgeY - eaveY, halfSpan);
  const slabLen = Math.hypot(ridgeY - eaveY, halfSpan) + 0.1;
  const midZ = (HZ0 + HZ1) / 2;
  B.mesh(M.roof, new THREE.BoxGeometry(HX1 - HX0 + 1.2, 0.18, slabLen), 0, (eaveY + ridgeY) / 2 + 0.05, midZ + halfSpan / 2, slope, 0, 0);
  B.mesh(M.roof, new THREE.BoxGeometry(HX1 - HX0 + 1.2, 0.18, slabLen), 0, (eaveY + ridgeY) / 2 + 0.05, midZ - halfSpan / 2, -slope, 0, 0);
  for (const x of [HX0 - e, HX1 + e - 0.2]) {
    B.add(M.siding, prismX(x, x + 0.2 * 1, [[HZ1 + e, eaveY], [HZ0 - e, eaveY], [midZ, ridgeY - 0.05]]));
  }
  solid(M.brick, 4.5, 7, -19.5, 5.5, 10.2, -18.5);
  deco(M.black, 4.6, 10.2, -19.4, 5.4, 10.25, -18.6);
  // porch
  solid(M.concrete, -1.6, 0, HZ1 + e, 1.6, 0.15, HZ1 + 1.2);
  deco(M.darkwood, -1.8, 2.7, HZ1 + e, 1.8, 2.85, HZ1 + 1.4);
  deco(M.trim, -1.7, 0.15, HZ1 + 1.25, -1.55, 2.7, HZ1 + 1.4);
  physics.add(-1.7, 0, HZ1 + 1.25, -1.55, 2.7, HZ1 + 1.4);
  deco(M.trim, 1.55, 0.15, HZ1 + 1.25, 1.7, 2.7, HZ1 + 1.4);
  physics.add(1.55, 0, HZ1 + 1.25, 1.7, 2.7, HZ1 + 1.4);
  deco(M.concrete, -0.8, 0, -8.8, 0.8, 0.02, -5.2); // path

  // =================================================================
  // Furniture (neighbor's house)
  // =================================================================
  const F = FLOOR;
  const U = UPPER;
  function table(x0, z0, x1, z1, y, h, mat = M.darkwood) {
    physics.add(x0, y, z0, x1, y + h, z1, 'furniture');
    deco(mat, x0, y + h - 0.05, z0, x1, y + h, z1);
    const l = 0.06;
    for (const [lx, lz] of [[x0, z0], [x1 - l, z0], [x0, z1 - l], [x1 - l, z1 - l]]) deco(mat, lx, y, lz, lx + l, y + h - 0.05, lz + l);
  }
  function chair(x, z, y, rot = 0) {
    const s = 0.22;
    deco(M.darkwood, x - s, y + 0.42, z - s, x + s, y + 0.47, z + s);
    for (const [dx, dz] of [[-s, -s], [s - 0.04, -s], [-s, s - 0.04], [s - 0.04, s - 0.04]]) deco(M.darkwood, x + dx, y, z + dz, x + dx + 0.04, y + 0.42, z + dz + 0.04);
    if (rot === 0) deco(M.darkwood, x - s, y + 0.47, z - s, x + s, y + 0.95, z - s + 0.04);
    else deco(M.darkwood, x - s, y + 0.47, z + s - 0.04, x + s, y + 0.95, z + s);
    physics.add(x - s, y, z - s, x + s, y + 0.47, z + s, 'furniture');
  }
  function bed(x0, z0, x1, z1, y, blanket, headAtZ0 = true) {
    physics.add(x0, y, z0, x1, y + 0.6, z1, 'furniture');
    deco(M.darkwood, x0, y, z0, x1, y + 0.35, z1);
    deco(M.pillow, x0 + 0.05, y + 0.35, z0 + 0.05, x1 - 0.05, y + 0.55, z1 - 0.05);
    const len = z1 - z0;
    if (headAtZ0) {
      deco(blanket, x0 + 0.02, y + 0.4, z0 + len * 0.3, x1 - 0.02, y + 0.6, z1 - 0.02);
      deco(M.pillow, x0 + 0.15, y + 0.55, z0 + 0.1, x1 - 0.15, y + 0.68, z0 + 0.45);
      solid(M.darkwood, x0, y, z0 - 0.06, x1, y + 1.1, z0);
    } else {
      deco(blanket, x0 + 0.02, y + 0.4, z0 + 0.02, x1 - 0.02, y + 0.6, z1 - len * 0.3);
      deco(M.pillow, x0 + 0.15, y + 0.55, z1 - 0.45, x1 - 0.15, y + 0.68, z1 - 0.1);
      solid(M.darkwood, x0, y, z1, x1, y + 1.1, z1 + 0.06);
    }
  }
  function shelf(x0, z0, x1, z1, y, h, levels = 4) {
    physics.add(x0, y, z0, x1, y + h, z1, 'furniture');
    const alongX = x1 - x0 > z1 - z0;
    deco(M.darkwood, x0, y, z0, x1, y + 0.05, z1);
    deco(M.darkwood, x0, y + h - 0.05, z0, x1, y + h, z1);
    if (alongX) {
      deco(M.darkwood, x0, y, z0, x0 + 0.05, y + h, z1);
      deco(M.darkwood, x1 - 0.05, y, z0, x1, y + h, z1);
    } else {
      deco(M.darkwood, x0, y, z0, x1, y + h, z0 + 0.05);
      deco(M.darkwood, x0, y, z1 - 0.05, x1, y + h, z1);
    }
    const bookMats = [M.fabricRed, M.fabricGreen, M.fabricBlue, M.fabricBeige, M.toyYellow];
    for (let l = 1; l < levels; l++) {
      const ly = y + (h / levels) * l;
      deco(M.darkwood, x0, ly - 0.03, z0, x1, ly, z1);
      const len = alongX ? x1 - x0 : z1 - z0;
      let p = 0.08;
      while (p < len - 0.15) {
        const bw = 0.05 + ((p * 97) % 0.06);
        const bh = 0.2 + ((p * 53) % 0.12);
        const m = bookMats[Math.floor(p * 31) % bookMats.length];
        if (alongX) deco(m, x0 + p, ly, z0 + 0.04, x0 + p + bw, ly + bh, z1 - 0.04);
        else deco(m, x0 + 0.04, ly, z0 + p, x1 - 0.04, ly + bh, z0 + p + bw);
        p += bw + 0.01;
        if ((p * 13) % 1 > 0.85) p += 0.15;
      }
    }
  }
  function ceilingLamp(x, y, z, intensity = 9, color = 0xffe2b0, distance = 13) {
    deco(M.lampGlow, x - 0.18, y - 0.12, z - 0.18, x + 0.18, y, z + 0.18);
    const l = new THREE.PointLight(color, intensity, distance, 1.6);
    l.position.set(x, y - 0.3, z);
    scene.add(l);
    return l;
  }
  function picture(axis, c, a, y, w, h, mat, facing) {
    const d = 0.03 * facing;
    if (axis === 'x') {
      deco(M.darkwood, a - w / 2 - 0.04, y - h / 2 - 0.04, c, a + w / 2 + 0.04, y + h / 2 + 0.04, c + d);
      deco(mat, a - w / 2, y - h / 2, c, a + w / 2, y + h / 2, c + d * 1.4);
    } else {
      deco(M.darkwood, c, y - h / 2 - 0.04, a - w / 2 - 0.04, c + d, y + h / 2 + 0.04, a + w / 2 + 0.04);
      deco(mat, c, y - h / 2, a - w / 2, c + d * 1.4, y + h / 2, a + w / 2);
    }
  }

  // Living room
  deco(M.fabricGreen, -7.85, F, -14.5, -6.9, F + 0.45, -11.5);
  deco(M.fabricGreen, -7.85, F, -14.5, -7.55, F + 1.05, -11.5);
  deco(M.fabricGreen, -7.85, F, -14.7, -6.9, F + 0.7, -14.5);
  deco(M.fabricGreen, -7.85, F, -11.5, -6.9, F + 0.7, -11.3);
  physics.add(-7.85, F, -14.7, -6.9, F + 0.75, -11.3, 'furniture');
  deco(M.fabricBeige, -7.5, F + 0.45, -14.3, -7.0, F + 0.6, -12.95);
  deco(M.fabricBeige, -7.5, F + 0.45, -12.9, -7.0, F + 0.6, -11.7);
  table(-6.4, -13.6, -5.4, -12.4, F, 0.45);
  deco(M.fabricRed, -6.9, F, -14.6, -4.6, F + 0.01, -11.4); // rug
  physics.add(-2.6, F, -14.5, -2.07, F + 0.6, -13, 'furniture');
  deco(M.darkwood, -2.6, F, -14.5, -2.07, F + 0.6, -13);
  deco(M.black, -2.45, F + 0.6, -14.3, -2.15, F + 1.15, -13.2);
  deco(M.darkGlass, -2.46, F + 0.65, -14.2, -2.44, F + 1.1, -13.3);
  picture('z', -7.875, -13, 2.1, 1.0, 0.7, M.fabricBlue, 1);
  picture('x', -15.925, -6.5, 2.0, 0.7, 0.5, M.toyYellow, 1);
  ceilingLamp(-5, 3.3, -13);

  // Kitchen
  physics.add(-5.8, F, -21.875, -2.075, F + 0.9, -21.25, 'furniture');
  deco(M.cabinet, -5.8, F, -21.875, -2.075, F + 0.85, -21.3);
  deco(M.counter, -5.85, F + 0.85, -21.875, -2.075, F + 0.9, -21.25);
  deco(M.steel, -4.2, F + 0.86, -21.8, -3.4, F + 0.905, -21.35); // sink
  deco(M.black, -5.6, F + 0.9, -21.8, -4.8, F + 0.92, -21.35); // stove top
  deco(M.cabinet, -5.8, 2.2, -21.875, -4.6, 3.0, -21.5);
  deco(M.cabinet, -2.9, 2.2, -21.875, -2.075, 3.0, -21.5);
  solid(M.white, -7.875, F, -17.1, -7.1, F + 1.9, -16.075, 'furniture'); // fridge
  deco(M.steel, -7.12, F + 0.9, -16.3, -7.08, F + 1.6, -16.25);
  table(-7.4, -19.4, -6.2, -18, F, 0.75);
  chair(-6.8, -17.6, F, 1);
  chair(-6.8, -19.8, F, 0);
  ceilingLamp(-5, 3.3, -19);

  // Hallway
  table(1.4, -13.5, 1.9, -12.5, F, 0.8);
  ceilingLamp(0.6, 3.3, -11.5, 6);
  ceilingLamp(0.6, 3.3, -20.5, 6);
  picture('z', 1.925, -17, 1.9, 0.6, 0.8, M.fabricGreen, -1);
  // coat rack
  deco(M.darkwood, 1.7, F, -10.5, 1.78, F + 1.8, -10.42);

  // Study
  table(6.3, -10.875, 7.8, -10.15, F, 0.75);
  chair(7.0, -11.25, F, 1);
  shelf(2.075, -15.5, 2.5, -13, F, 2.1);
  physics.add(6.5, F, -15.2, 7.5, F + 0.8, -14.2, 'furniture');
  deco(M.fabricRed, 6.5, F, -15.2, 7.5, F + 0.45, -14.2);
  deco(M.fabricRed, 6.5, F, -15.2, 7.5, F + 0.95, -14.95);
  deco(M.carpetBlue, 3.5, F, -15, 6, F + 0.01, -12); // rug
  ceilingLamp(5, 3.3, -13);

  // Storage
  shelf(7.3, -21, 7.875, -17, F, 2.2);
  solid(M.darkwood, 5.5, F, -21.875, 7.2, F + 0.9, -21.1, 'furniture'); // workbench
  deco(M.cardboard, 3.2, F, -21.8, 3.9, F + 0.6, -21.1);
  physics.add(3.2, F, -21.8, 3.9, F + 0.6, -21.1, 'furniture');
  deco(M.rust, 2.3, F, -17, 2.7, F + 0.9, -16.6);
  physics.add(2.3, F, -17, 2.7, F + 0.9, -16.6, 'furniture');
  ceilingLamp(5, 3.3, -19, 6);

  // Upstairs: kid's room (west)
  bed(-7.875, -12.4, -6.3, -10.125, U, M.fabricBlue, false);
  solid(M.darkwood, -7.875, U, -20.5, -7.2, U + 2.0, -19, 'furniture'); // wardrobe
  deco(M.brass, -7.22, U + 1.0, -19.8, -7.18, U + 1.2, -19.75);
  table(-5, -21.875, -3.6, -21.3, U, 0.7);
  deco(M.toy, -6.5, U, -16.5, -6.1, U + 0.4, -16.1);
  deco(M.toyYellow, -6.0, U, -15.2, -5.8, U + 0.2, -15.0);
  deco(M.carpet, -6.5, U, -18, -3.5, U + 0.01, -14);
  picture('z', -7.875, -16, 4.8, 0.8, 0.6, M.drawing1, 1);
  ceilingLamp(-5, 6.3, -16, 8);

  // Upstairs: master bedroom (east, blue lock)
  bed(5.8, -14.5, 7.875, -12, U, M.fabricRed, false);
  table(7.2, -15.3, 7.875, -14.7, U, 0.55);
  deco(M.lampGlow, 7.62, U + 0.55, -14.98, 7.8, U + 0.8, -14.8);
  solid(M.darkwood, 2.075, U, -15, 2.6, U + 1.1, -13, 'furniture'); // dresser
  shelf(7.3, -21.5, 7.875, -18, U, 2.0, 3);
  deco(M.fabricBeige, 3.5, U, -17.5, 6, U + 0.01, -15.5);
  picture('z', 7.875, -13.3, 5.0, 1.1, 0.7, M.fabricGreen, -1);
  ceilingLamp(5, 6.3, -16, 8);

  // Upstairs hall
  ceilingLamp(0.6, 6.3, -16, 6);
  table(1.4, -12, 1.9, -11, U, 0.8);

  // Basement: a child's room hidden under the house.
  bed(-7.8, -13.9, -6.4, -11.8, BASEMENT, M.fabricBlue, false);
  table(-3.5, -10.9, -2.3, -10.2, BASEMENT, 0.6);
  deco(M.black, -3.3, BASEMENT + 0.6, -10.8, -2.5, BASEMENT + 1.2, -10.25);
  const tv = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5), M.tv);
  tv.position.set(-2.9, BASEMENT + 0.9, -10.815);
  tv.rotation.y = Math.PI;
  scene.add(tv);
  chair(-2.9, -12.2, BASEMENT, 1);
  deco(M.toy, -5.5, BASEMENT, -12.8, -5.2, BASEMENT + 0.3, -12.5);
  deco(M.toyYellow, -4.8, BASEMENT, -11.2, -4.6, BASEMENT + 0.2, -11);
  deco(M.fabricRed, -6.2, BASEMENT, -13.5, -3.8, BASEMENT + 0.01, -11.0);
  const dA = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), M.drawing1);
  dA.position.set(-5, BASEMENT + 1.7, -13.89);
  const dB = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), M.drawing2);
  dB.position.set(0.2, BASEMENT + 1.6, -13.89);
  dB.rotation.z = 0.08;
  scene.add(dA, dB);
  deco(M.lampGlow, -3.1, -0.25, -12.1, -2.9, -0.05, -11.9);
  const bulb = new THREE.PointLight(0xffd59a, 10, 12, 1.6);
  bulb.position.set(-3, -0.5, -12);
  scene.add(bulb);
  flicker.push(bulb);
  const stairBulb = new THREE.PointLight(0xffc27a, 3, 6, 1.8);
  stairBulb.position.set(-1.4, -1, -16.5);
  scene.add(stairBulb);

  // =================================================================
  // Neighbor's yard
  // =================================================================
  const FH = 1.2;
  const fence = (x0, z0, x1, z1) => solid(M.fence, x0, 0, z0, x1, FH, z1);
  fence(-14, -6.04, -1.5, -5.96);
  fence(1.5, -6.04, 14, -5.96);
  fence(-14.04, -30, -13.96, -6);
  fence(13.96, -30, 14.04, -6);
  fence(-14, -30.04, 14, -29.96);
  for (const x of [-14, -1.5, 1.5, 14]) deco(M.darkwood, x - 0.08, 0, -6.08, x + 0.08, FH + 0.15, -5.92);

  // =================================================================
  // Street, sidewalks, player's house
  // =================================================================
  // Grass around the neighbor house footprint (no grass under it: the basement is there).
  const G = 70;
  deco(M.grass, -G, -0.1, -G, G, 0, HZ0);
  deco(M.grass, -G, -0.1, HZ1, G, 0, G);
  deco(M.grass, -G, -0.1, HZ0, HX0, 0, HZ1);
  deco(M.grass, HX1, -0.1, HZ0, G, 0, HZ1);
  deco(M.asphalt, -G, 0, -3.5, G, 0.01, 3.5);
  for (let x = -G + 1; x < G; x += 4) deco(M.streetLine, x, 0.01, -0.07, x + 2, 0.015, 0.07);
  solid(M.concrete, -G, 0, -5.2, G, 0.12, -3.5, 'floor');
  solid(M.concrete, -G, 0, 3.5, G, 0.12, 5.2, 'floor');
  deco(M.concrete, -0.8, 0, 5.2, 0.8, 0.02, 12.5);

  // Player's house (just a facade you start in front of).
  solid(M.brick, -7, 0, 13, 7, 3.4, 21);
  B.mesh(M.roofGrey, new THREE.BoxGeometry(15.2, 0.18, Math.hypot(2.3, 4.6) + 0.1), 0, 4.55, 15.2, -Math.atan2(2.3, 4.6), 0, 0);
  B.mesh(M.roofGrey, new THREE.BoxGeometry(15.2, 0.18, Math.hypot(2.3, 4.6) + 0.1), 0, 4.55, 18.8, Math.atan2(2.3, 4.6), 0, 0);
  B.add(M.brick, prismX(-7, -6.9, [[13, 3.4], [21, 3.4], [17, 5.65]]));
  B.add(M.brick, prismX(6.9, 7, [[13, 3.4], [21, 3.4], [17, 5.65]]));
  deco(M.door, -0.55, 0.15, 12.94, 0.55, 2.3, 13);
  deco(M.brass, 0.3, 1.1, 12.9, 0.36, 1.16, 12.94);
  for (const x of [-4.5, 4.5]) {
    deco(M.trim, x - 1.05, 1.05, 12.93, x + 1.05, 2.55, 13);
    deco(M.darkGlass, x - 0.95, 1.15, 12.92, x + 0.95, 2.45, 12.95);
  }
  solid(M.concrete, -1.6, 0, 12, 1.6, 0.15, 13);
  table(2.5, 9.5, 4, 10.5, 0, 0.8, M.white);

  // Car parked on the street.
  solid(M.carRed, -12, 0.3, 1.2, -7.8, 1.1, 3.0, 'furniture');
  deco(M.carRed, -11.2, 1.1, 1.3, -8.6, 1.7, 2.9);
  deco(M.darkGlass, -11.1, 1.15, 1.28, -8.7, 1.62, 2.92);
  for (const x of [-11.2, -8.6]) {
    for (const z of [1.2, 3.0]) {
      B.mesh(M.tire, new THREE.CylinderGeometry(0.35, 0.35, 0.25, 14), x, 0.35, z, Math.PI / 2, 0, 0);
    }
  }

  // Mailbox by the gate.
  deco(M.darkwood, 2.3, 0, -5.45, 2.4, 1.0, -5.35);
  solid(M.mailbox, 2.15, 1.0, -5.65, 2.55, 1.3, -5.15);

  // Lamp posts.
  for (const [x, z] of [[-14, 4.6], [14, 4.6], [-18, -4.6], [18, -4.6]]) {
    B.mesh(M.black, new THREE.CylinderGeometry(0.07, 0.1, 4.2, 8), x, 2.1, z);
    physics.add(x - 0.1, 0, z - 0.1, x + 0.1, 4.2, z + 0.1);
    deco(M.lampGlow, x - 0.2, 4.1, z - 0.2, x + 0.2, 4.35, z + 0.2);
  }

  // Trees.
  function tree(x, z, s = 1) {
    B.mesh(M.bark, new THREE.CylinderGeometry(0.18 * s, 0.26 * s, 3 * s, 8), x, 1.5 * s, z);
    physics.add(x - 0.25 * s, 0, z - 0.25 * s, x + 0.25 * s, 3 * s, z + 0.25 * s);
    B.mesh(M.leaves, new THREE.IcosahedronGeometry(1.6 * s, 1), x, 3.6 * s, z);
    B.mesh(M.leaves, new THREE.IcosahedronGeometry(1.2 * s, 1), x + 0.8 * s, 3.1 * s, z + 0.4 * s);
    B.mesh(M.leaves, new THREE.IcosahedronGeometry(1.1 * s, 1), x - 0.7 * s, 3.3 * s, z - 0.5 * s);
  }
  tree(-4, -27.5, 1.1);
  tree(5.5, -28, 1.2);
  tree(-12.6, -12, 0.9);
  tree(12.6, -20, 1.0);
  tree(-9, 9.5);
  tree(9.5, 8.5, 1.1);
  for (let x = -36; x <= 36; x += 9) {
    tree(x + 2, -34, 1.3);
    tree(x - 1, 27, 1.2);
  }
  for (let z = -27; z <= 22; z += 9) {
    tree(-36, z, 1.2);
    tree(36, z + 3, 1.3);
  }

  // Hedges along the neighbor's side fences and player's yard.
  solid(M.hedge, -7, 0, 11.5, -2, 1.0, 12.3);
  solid(M.hedge, 2, 0, 11.5, 7, 1.0, 12.3);

  // Other houses down the street.
  function house(cx, cz, w, d, wallMat, roofMat, facing) {
    solid(wallMat, cx - w / 2, 0, cz - d / 2, cx + w / 2, 5.5, cz + d / 2);
    const hs = d / 2 + 0.5;
    const rise = 2.4;
    const ang = Math.atan2(rise, hs);
    const len = Math.hypot(rise, hs) + 0.1;
    B.mesh(roofMat, new THREE.BoxGeometry(w + 0.8, 0.18, len), cx, 5.5 + rise / 2, cz + hs / 2, ang, 0, 0);
    B.mesh(roofMat, new THREE.BoxGeometry(w + 0.8, 0.18, len), cx, 5.5 + rise / 2, cz - hs / 2, -ang, 0, 0);
    B.add(wallMat, prismX(cx - w / 2, cx - w / 2 + 0.1, [[cz - d / 2, 5.5], [cz + d / 2, 5.5], [cz, 5.5 + rise * (d / 2) / hs]]));
    B.add(wallMat, prismX(cx + w / 2 - 0.1, cx + w / 2, [[cz - d / 2, 5.5], [cz + d / 2, 5.5], [cz, 5.5 + rise * (d / 2) / hs]]));
    const fz = cz + (d / 2 + 0.02) * facing;
    const zz = (v) => (facing > 0 ? [fz - 0.04, fz + v] : [fz - v, fz + 0.04]);
    const [dz0, dz1] = zz(0.02);
    deco(M.door, cx - 0.55, 0, dz0, cx + 0.55, 2.2, dz1);
    for (const ox of [-w / 4, w / 4]) {
      deco(M.darkGlass, cx + ox - 0.9, 1.2, dz0, cx + ox + 0.9, 2.5, dz1);
      deco(M.darkGlass, cx + ox - 0.9, 3.4, dz0, cx + ox + 0.9, 4.7, dz1);
    }
  }
  house(-27, -17, 12, 10, M.sidingBlue, M.roofGrey, 1);
  house(27, -17, 12, 10, M.sidingWhite, M.roof, 1);
  house(-25, 17, 12, 9, M.sidingWhite, M.roofGrey, -1);
  house(25, 17, 12, 9, M.sidingBlue, M.roof, -1);

  // World boundary.
  physics.add(-40, 0, -40, -38, 10, 32);
  physics.add(38, 0, -40, 40, 10, 32);
  physics.add(-40, 0, -40, 40, 10, -38);
  physics.add(-40, 0, 30, 40, 10, 32);
  deco(M.hedge, -38.5, 0, -38.5, 38.5, 2, -37.5);
  deco(M.hedge, -38.5, 0, 29.5, 38.5, 2, 30.5);
  deco(M.hedge, -38.5, 0, -38.5, -37.5, 2, 30.5);
  deco(M.hedge, 37.5, 0, -38.5, 38.5, 2, 30.5);

  const staticMeshes = B.build(scene);

  // =================================================================
  // Items
  // =================================================================
  const place = (type, x, surfaceY, z, rotY = 0) => {
    const it = new Item(type, T, x, 0, z, rotY);
    it.pos.y = surfaceY + it.radius;
    it.home.copy(it.pos);
    it.mesh.position.copy(it.pos);
    scene.add(it.mesh);
    items.push(it);
    return it;
  };
  // Player's yard: ammunition for breaking windows.
  place('box', 2, 0, 7.6, 0.3);
  place('box', -2.6, 0, 7.4, -0.2);
  place('box', -3.4, 0, 8.6, 0.8);
  place('can', 2.9, 0.8, 10);
  place('apple', 3.3, 0.8, 9.8);
  place('can', 3.65, 0.8, 10.2);
  place('ball', -1.5, 0, 10.2);
  // Neighbor's yard
  place('box', 10, 0, -9, 0.5);
  place('box', -10, 0, -24, 0.1);
  place('wrench', 9.5, 0, -24.5, 1.2);
  place('duck', -6, 0, -8.5);
  // Ground floor
  place('radio', -5.9, F + 0.45, -13, Math.PI / 2);
  place('book', -5.7, F + 0.45, -12.7, 0.3);
  place('mug', -3.0, F + 0.9, -21.55);
  place('milk', -3.9, F + 0.9, -21.55);
  place('apple', -5.2, F + 0.9, -21.5);
  place('apple', -5.0, F + 0.9, -21.6);
  place('keyBlue', -6.75, F + 0.75, -18.75, 0.6);
  place('can', -6.3, F + 0.75, -19.2);
  place('vase', 1.65, F + 0.8, -13);
  place('book', 6.8, F + 0.75, -10.5, -0.4);
  place('mug', 7.4, F + 0.75, -10.45);
  place('box', 4.2, F, -17.6, 0.2);
  place('box', 3.4, F, -18.6, -0.4);
  place('wrench', 6.2, F + 0.9, -21.5, 0.4);
  // Upstairs
  place('keyRed', 7.4, U + 0.55, -15.12, 1.1);
  place('book', 2.35, U + 1.1, -14.3, 0.2);
  place('ball', -5.2, U, -17.2);
  place('duck', -4.3, U + 0.7, -21.6);
  place('box', 1.2, U, -21.2, 0.3);

  // =================================================================
  // Lights
  // =================================================================
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5a6b3a, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
  sun.position.set(22, 38, 14);
  sun.target.position.set(0, 0, -10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -34;
  sc.right = 34;
  sc.top = 34;
  sc.bottom = -34;
  sc.near = 5;
  sc.far = 110;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // =================================================================
  // Runtime
  // =================================================================
  let staticTimer = 0;
  let flickerTimer = 0;
  function update(dt) {
    for (const d of doors) d.update(dt);
    staticTimer -= dt;
    if (staticTimer <= 0) {
      T.updateStatic();
      staticTimer = 0.07;
    }
    flickerTimer -= dt;
    if (flickerTimer <= 0) {
      for (const l of flicker) l.intensity = Math.random() < 0.15 ? 0.6 : 8 + Math.random() * 4;
      flickerTimer = 0.05 + Math.random() * 0.12;
    }
    for (const it of items) {
      if (it.key && it.mesh.userData.glow) {
        it.mesh.userData.glow.emissiveIntensity = 0.35 + 0.3 * Math.sin(performance.now() * 0.004);
      }
    }
  }

  return {
    textures: T,
    materials: M,
    doors,
    windows,
    items,
    staticMeshes,
    dynamicMeshes,
    update,
    doorById: (id) => doors.find((d) => d.id === id),
  };
}
