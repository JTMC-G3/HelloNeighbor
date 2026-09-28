import * as THREE from 'three';
import { createTextures } from './textures.js';
import { Item, KEY_COLORS, keyType } from './items.js';
import { StaticBuilder, prismX, makeMaterials } from './builder.js';
import { generatePlan, FLOOR, UPPER, BASEMENT, STAIR, CELL } from './housegen.js';
import { Rng } from './rng.js';

/*
 * Builds the level from a procedurally generated plan (see housegen.js):
 * the neighbor's house (walls, doors, locks, windows, stairs, basement),
 * furniture with cupboards you can open and wardrobes you can hide in, the
 * items, and the street around it. The same seed always gives the same house.
 */

export { FLOOR, UPPER, BASEMENT };
export const SPAWN = new THREE.Vector3(0, 0, 9.5);

const WT = 0.25; // exterior wall thickness
const IT = 0.15; // interior wall thickness
const DOOR_H = 2.2;

// [floor material, wall material] per room type.
const STYLE = {
  stairs: ['wood', 'wallpaper3'],
  living: ['wood', 'wallpaper'],
  kitchen: ['tile', 'plaster'],
  dining: ['wood', 'wallPeach'],
  study: ['carpet', 'wallpaper3'],
  library: ['wood', 'wallGreen'],
  music: ['lightwood', 'wallpaper2'],
  workshop: ['basement', 'basement'],
  den: ['carpetBlue', 'wallpaperBlue'],
  bathroom: ['tileBlue', 'wallBlue'],
  pantry: ['tile', 'plaster'],
  laundry: ['tile', 'wallBlue'],
  storage: ['basement', 'basement'],
  master: ['carpetBlue', 'wallpaper'],
  kids: ['lightwood', 'wallpaper2'],
  nursery: ['carpet', 'wallPeach'],
  bedroom: ['carpet', 'wallpaperBlue'],
  playroom: ['carpetBlue', 'wallpaper2'],
  sewing: ['wood', 'wallPeach'],
  attic: ['lightwood', 'plaster'],
  closet: ['wood', 'plaster'],
};

// Throwable junk that shows up in each kind of room.
const LOOT = {
  kitchen: ['plate', 'mug', 'apple', 'can', 'bottle', 'milk', 'plate'],
  living: ['book', 'vase', 'radio', 'pillow', 'can'],
  dining: ['plate', 'vase', 'mug', 'bottle'],
  study: ['book', 'mug', 'book'],
  library: ['book', 'book', 'vase'],
  music: ['book', 'mug'],
  workshop: ['wrench', 'can', 'box', 'bottle'],
  den: ['can', 'pillow', 'ball'],
  bathroom: ['duck', 'bottle'],
  pantry: ['can', 'milk', 'apple', 'bottle'],
  laundry: ['shoe', 'bottle', 'box'],
  storage: ['box', 'box', 'wrench'],
  master: ['pillow', 'shoe', 'book'],
  kids: ['duck', 'ball', 'box', 'book'],
  nursery: ['duck', 'pillow'],
  bedroom: ['pillow', 'shoe', 'book'],
  playroom: ['ball', 'duck', 'box'],
  sewing: ['book', 'mug', 'pillow'],
  attic: ['box', 'box', 'book'],
  closet: ['shoe', 'box'],
};

function segHitsRect(s, x0, z0, x1, z1) {
  const [ax, az, bx, bz] = s;
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  for (const [p, d, lo, hi] of [[ax, dx, x0, x1], [az, dz, z0, z1]]) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false;
    } else {
      let ta = (lo - p) / d;
      let tb = (hi - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function rectsMinusHole(x0, z0, x1, z1, h) {
  if (!h || h.x1 <= x0 || h.x0 >= x1 || h.z1 <= z0 || h.z0 >= z1) return [[x0, z0, x1, z1]];
  const hx0 = Math.max(x0, h.x0);
  const hx1 = Math.min(x1, h.x1);
  const hz0 = Math.max(z0, h.z0);
  const hz1 = Math.min(z1, h.z1);
  const out = [];
  if (hz0 > z0) out.push([x0, z0, x1, hz0]);
  if (hz1 < z1) out.push([x0, hz1, x1, z1]);
  if (hx0 > x0) out.push([x0, hz0, hx0, hz1]);
  if (hx1 < x1) out.push([hx1, hz0, x1, hz1]);
  return out;
}

export function buildWorld(scene, physics, seed) {
  const plan = generatePlan(seed);
  const rng = new Rng((seed * 7919) ^ 0x5bd1e995);
  const T = createTextures();
  const M = makeMaterials(T);
  const B = new StaticBuilder();
  const doors = [];
  const windows = [];
  const items = [];
  const dynamicMeshes = [];
  const lamps = [];
  const containers = [];
  const hideSpots = [];
  const appliances = [];
  const doorByPlanId = new Map();

  const solid = (mat, x0, y0, z0, x1, y1, z1, kind = 'wall') => {
    B.box(mat, x0, y0, z0, x1, y1, z1);
    return physics.add(x0, y0, z0, x1, y1, z1, kind);
  };
  const deco = (mat, x0, y0, z0, x1, y1, z1) => B.box(mat, x0, y0, z0, x1, y1, z1);

  const { X0: HX0, X1: HX1, Z0: HZ0, Z1: HZ1, stairX: SA } = plan;
  const siding = rng.pick([M.siding, M.sidingBlue, M.sidingWhite, M.siding]);
  const roofMat = rng.pick([M.roof, M.roofGrey]);
  const roomMat = (id, part) => M[STYLE[plan.rooms[id].type][part]];
  const floorY = (f) => (f === 0 ? FLOOR : UPPER);

  // ---------------------------------------------------------------- windows
  function makeWindow(axis, c, a, b, bottom, top, t) {
    const w = b - a;
    const h = top - bottom;
    const cx = axis === 'x' ? (a + b) / 2 : c;
    const cz = axis === 'x' ? c : (a + b) / 2;
    const collider = axis === 'x'
      ? physics.add(a, bottom, c - 0.03, b, top, c + 0.03, 'glass')
      : physics.add(c - 0.03, bottom, a, c + 0.03, top, b, 'glass');
    const win = { index: windows.length, collider, broken: false, center: new THREE.Vector3(cx, (bottom + top) / 2, cz), w, h, axis };
    collider.ref = win;
    windows.push(win);
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
  const padlockShackle = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.3 });
  function makePadlock(color) {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.35, emissive: color, emissiveIntensity: 0.15 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.05), m);
    const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.012, 6, 14, Math.PI), padlockShackle);
    shackle.position.y = 0.06;
    g.add(body, shackle);
    return g;
  }

  function makeDoor({ axis, c, a, b, y0, h, id, name, swing = 1, locks = [], frontLocked = false, material, neighborIgnore = false, planId }) {
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
    let keyIndex = 0;
    const lockObjs = locks.map((l) => {
      const meshes = [];
      if (l.type === 'key') {
        for (const side of [-1, 1]) {
          const lock = makePadlock(KEY_COLORS[l.color]);
          lock.position.set(w - 0.2, 1.25 + keyIndex * 0.2, side * 0.07);
          pivot.add(lock);
          meshes.push(lock);
        }
        keyIndex++;
      } else {
        for (const side of [-1, 1]) {
          for (let k = 0; k < 3; k++) {
            const plank = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.14, 0.035), M.plank);
            plank.position.set(w / 2, 0.55 + k * 0.6, side * 0.08);
            plank.rotation.z = (k % 2 ? 1 : -1) * 0.13;
            plank.castShadow = true;
            pivot.add(plank);
            meshes.push(plank);
          }
        }
      }
      return { ...l, meshes };
    });
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
      locks: lockObjs,
      frontLocked,
      neighborIgnore,
      open: false,
      t: 0,
      base,
      swing,
      get locked() {
        return this.frontLocked || this.locks.length > 0;
      },
      get boarded() {
        return this.locks.some((l) => l.type === 'boards');
      },
      setOpen(v) {
        this.open = v;
      },
      removeLock(lock) {
        for (const m of lock.meshes) m.parent.remove(m);
        this.locks.splice(this.locks.indexOf(lock), 1);
      },
      update(dt) {
        const target = this.open ? 1 : 0;
        if (this.t === target) return;
        const speed = 2.2 * dt;
        this.t = this.t < target ? Math.min(target, this.t + speed) : Math.max(target, this.t - speed);
        const e = this.t * this.t * (3 - 2 * this.t);
        this.pivot.rotation.y = this.base + this.swing * e * Math.PI * 0.5 * 0.97;
        this.collider.enabled = this.t < 0.15;
      },
    };
    collider.ref = door;
    panel.userData.door = door;
    doors.push(door);
    dynamicMeshes.push(panel);
    if (planId !== undefined) doorByPlanId.set(planId, door);
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

  function wall({ axis, c, from, to, y0, y1, t, lo, hi, openings = [] }) {
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
      if (b - a < 0.005) continue;
      if (axis === 'x') {
        physics.add(a, ya, c - t / 2, b, yb, c + t / 2);
        B.box(lo, a, ya, c - t / 2, b, yb, c);
        B.box(hi, a, ya, c, b, yb, c + t / 2);
      } else {
        physics.add(c - t / 2, ya, a, c + t / 2, yb, b);
        B.box(lo, c - t / 2, ya, a, c, yb, b);
        B.box(hi, c, ya, a, c + t / 2, yb, b);
      }
    }
  }

  // =================================================================
  // House shell
  // =================================================================
  physics.addHole(HX0, HZ0, HX1, HZ1);
  const sxi = SA + (plan.sx === 0 ? WT / 2 : IT / 2); // inner face of the stairwell's west wall
  const SE = SA + STAIR.width; // east edge of the stair treads
  const holeGround = { x0: sxi, x1: SE, z0: HZ0 + STAIR.top, z1: HZ0 + STAIR.baseEnd };
  const holeUpper = { x0: sxi, x1: SE, z0: HZ0 + STAIR.top, z1: HZ0 + STAIR.bottom };

  // Slabs + floor coverings.
  for (const [x0, z0, x1, z1] of rectsMinusHole(HX0, HZ0, HX1, HZ1, holeGround)) {
    physics.add(x0, 0, z0, x1, FLOOR, z1, 'floor');
    deco(M.basement, x0, 0, z0, x1, FLOOR - 0.02, z1);
  }
  for (const [x0, z0, x1, z1] of rectsMinusHole(HX0, HZ0, HX1, HZ1, holeUpper)) {
    physics.add(x0, 3.3, z0, x1, UPPER, z1, 'floor');
    deco(M.plaster, x0, 3.3, z0, x1, UPPER - 0.02, z1);
  }
  solid(M.plaster, HX0, 6.3, HZ0, HX1, 6.5, HZ1, 'floor');
  for (const r of plan.rooms) {
    const y = floorY(r.floor);
    const hole = r.floor === 0 ? holeGround : holeUpper;
    for (const [x0, z0, x1, z1] of rectsMinusHole(r.x0, r.z0, r.x1, r.z1, hole)) deco(roomMat(r.id, 0), x0, y - 0.02, z0, x1, y, z1);
  }

  // Walls. Walls running along X extend across junctions; walls along Z stop at them.
  const key = (f, c, a) => `${f}|${c.toFixed(2)}|${a.toFixed(2)}`;
  const xWalls = new Map();
  const zWalls = new Map();
  for (const f of [0, 1]) {
    for (const e of plan.walls[f]) (e.axis === 'x' ? xWalls : zWalls).set(key(f, e.c, e.a), e);
  }
  const tOf = (e) => (e ? (e.exterior ? WT : IT) : 0);
  const xThickAt = (f, x, z) => Math.max(tOf(xWalls.get(key(f, z, x - CELL))), tOf(xWalls.get(key(f, z, x))));
  const zThickAt = (f, x, z) => Math.max(tOf(zWalls.get(key(f, x, z - CELL))), tOf(zWalls.get(key(f, x, z))));

  for (const f of [0, 1]) {
    for (const e of plan.walls[f]) {
      const ext = e.exterior;
      const y0 = f === 0 ? (ext ? 0 : FLOOR) : ext ? UPPER : 3.3;
      const y1 = f === 0 ? (ext ? UPPER : 3.3) : ext ? 6.5 : 6.3;
      let from = e.a;
      let to = e.b;
      if (e.axis === 'x') {
        from -= zThickAt(f, e.a, e.c) / 2;
        to += zThickAt(f, e.b, e.c) / 2;
      } else {
        from += xThickAt(f, e.c, e.a) / 2;
        to -= xThickAt(f, e.c, e.b) / 2;
      }
      const openings = [];
      if (e.door) {
        const d = e.door;
        const dy = floorY(f);
        let spec;
        if (d.kind === 'front') spec = { id: 'front', name: 'Front Door', swing: 1, frontLocked: true, material: M.door, planId: d.id };
        else if (d.kind === 'back') spec = { id: 'back', name: 'Back Door', swing: -1, material: M.door, planId: d.id };
        else spec = { id: `d${d.id}`, name: 'Door', swing: d.swing, locks: d.locks, planId: d.id };
        openings.push({ a: d.center - d.width / 2, b: d.center + d.width / 2, bottom: dy, top: dy + DOOR_H, door: spec });
      }
      for (const w of e.windows) openings.push({ a: w.a, b: w.b, bottom: w.bottom, top: w.top, window: true });
      const lo = e.lo < 0 ? siding : roomMat(e.lo, 1);
      const hi = e.hi < 0 ? siding : roomMat(e.hi, 1);
      wall({ axis: e.axis, c: e.c, from, to, y0, y1, t: tOf(e), lo, hi, openings });
    }
  }

  // ---- stairwell
  const stairWall = M[STYLE.stairs[1]];
  for (let i = 1; i <= 16; i++) {
    const zA = HZ0 + STAIR.bottom - 0.35 * (i - 1);
    const zB = HZ0 + STAIR.bottom - 0.35 * i;
    const top = FLOOR + 0.2 * i;
    solid(M.darkwood, sxi, top - 0.2, zB, SE, top, zA, 'floor');
  }
  const encX = SE + IT / 2;
  wall({ axis: 'z', c: encX, from: HZ0 + 1.2, to: HZ0 + STAIR.bottom, y0: BASEMENT, y1: FLOOR, t: IT, lo: M.basement, hi: M.basement });
  wall({ axis: 'z', c: encX, from: HZ0 + 1.2, to: HZ0 + STAIR.bottom, y0: FLOOR, y1: 3.3, t: IT, lo: stairWall, hi: stairWall });
  solid(M.basement, sxi - 0.15, BASEMENT, HZ0 + 1.2, sxi, FLOOR, HZ0 + STAIR.baseEnd);
  solid(M.basement, sxi - 0.15, BASEMENT, HZ0 + 1.2, SE + IT, FLOOR, HZ0 + 1.3);
  wall({
    axis: 'x', c: HZ0 + 1.25, from: sxi, to: SE, y0: FLOOR, y1: 3.3, t: 0.1, lo: stairWall, hi: stairWall,
    openings: [{
      a: sxi + 0.04, b: SE - 0.04, bottom: FLOOR, top: FLOOR + DOOR_H,
      door: { id: 'basement', name: 'Basement Door', swing: 1, locks: plan.basementLocks, material: M.doorBasement, neighborIgnore: true },
    }],
  });
  physics.add(SE, 3.3, HZ0 + STAIR.top, SE + 0.12, 4.45, HZ0 + STAIR.bottom);
  physics.add(sxi, 3.3, HZ0 + STAIR.bottom, SE + 0.12, 4.45, HZ0 + STAIR.bottom + 0.1);
  deco(M.darkwood, SE - 0.01, 4.35, HZ0 + STAIR.top, SE + 0.13, 4.45, HZ0 + STAIR.bottom + 0.1);
  deco(M.darkwood, sxi, 4.35, HZ0 + STAIR.bottom - 0.01, SE + 0.13, 4.45, HZ0 + STAIR.bottom + 0.1);
  for (let z = HZ0 + STAIR.top; z <= HZ0 + STAIR.bottom; z += 0.5) deco(M.darkwood, SE + 0.03, UPPER, z - 0.02, SE + 0.09, 4.35, z + 0.02);
  for (let x = sxi + 0.2; x < SE; x += 0.4) deco(M.darkwood, x - 0.02, UPPER, HZ0 + STAIR.bottom + 0.02, x + 0.02, 4.35, HZ0 + STAIR.bottom + 0.08);
  for (let j = 1; j <= 15; j++) {
    const zA = HZ0 + STAIR.top + 0.31 * (j - 1);
    const zB = HZ0 + STAIR.top + 0.31 * j;
    solid(M.basement, sxi, BASEMENT, zA, SE, FLOOR - 0.2 * j, zB, 'floor');
  }

  // ---- basement: a child's room hidden under the house
  const bm = plan.basement;
  solid(M.basement, Math.min(bm.x0, sxi - 0.2), BASEMENT - 0.2, HZ0 + 1.1, Math.max(bm.x1, SE + 0.3), BASEMENT, bm.z1, 'floor');
  wall({ axis: 'x', c: bm.z1, from: bm.x0 - 0.1, to: bm.x1 + 0.1, y0: BASEMENT, y1: 0, t: 0.2, lo: M.basement, hi: M.basement });
  wall({
    axis: 'x', c: bm.z0, from: bm.x0 - 0.1, to: bm.x1 + 0.1, y0: BASEMENT, y1: 0, t: 0.2, lo: M.basement, hi: M.basement,
    openings: [{ a: sxi, b: SE, bottom: BASEMENT, top: 0 }],
  });
  wall({ axis: 'z', c: bm.x0, from: bm.z0, to: bm.z1, y0: BASEMENT, y1: 0, t: 0.2, lo: M.basement, hi: M.basement });
  wall({ axis: 'z', c: bm.x1, from: bm.z0, to: bm.z1, y0: BASEMENT, y1: 0, t: 0.2, lo: M.basement, hi: M.basement });
  {
    const B0 = BASEMENT;
    const west = bm.x0 + 0.1;
    const south = bm.z1 - 0.1;
    // Bed in the south-west corner (away from where the stairs come in).
    physics.add(west, B0, south - 2.1, west + 1.4, B0 + 0.6, south, 'furniture');
    deco(M.darkwood, west, B0, south - 2.1, west + 1.4, B0 + 0.35, south);
    deco(M.pillow, west + 0.05, B0 + 0.35, south - 2.05, west + 1.35, B0 + 0.55, south - 0.05);
    deco(M.fabricBlue, west + 0.02, B0 + 0.4, south - 2.08, west + 1.38, B0 + 0.6, south - 0.6);
    deco(M.pillow, west + 0.15, B0 + 0.55, south - 0.5, west + 1.25, B0 + 0.68, south - 0.12);
    const tx = (bm.x0 + bm.x1) / 2 + 1.2;
    physics.add(tx - 0.6, B0, south - 0.7, tx + 0.6, B0 + 0.6, south, 'furniture');
    deco(M.darkwood, tx - 0.6, B0 + 0.55, south - 0.7, tx + 0.6, B0 + 0.6, south);
    deco(M.black, tx - 0.4, B0 + 0.6, south - 0.6, tx + 0.4, B0 + 1.2, south - 0.05);
    const tv = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5), M.tv);
    tv.position.set(tx, B0 + 0.9, south - 0.615);
    tv.rotation.y = Math.PI;
    scene.add(tv);
    deco(M.fabricRed, west + 1.6, B0, bm.z0 + 1.2, bm.x1 - 0.6, B0 + 0.01, south - 0.8);
    deco(M.toy, west + 2.2, B0, south - 1.8, west + 2.5, B0 + 0.3, south - 1.5);
    deco(M.toyYellow, bm.x1 - 1.5, B0, bm.z0 + 1.6, bm.x1 - 1.3, B0 + 0.2, bm.z0 + 1.8);
    for (const [x, mat, rz] of [[west + 1.2, M.drawing1, 0], [bm.x1 - 1.4, M.drawing2, 0.08]]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), mat);
      d.position.set(x, B0 + 1.7, bm.z0 + 0.11);
      d.rotation.z = rz;
      scene.add(d);
    }
    const bx = (bm.x0 + bm.x1) / 2;
    const bz = (bm.z0 + bm.z1) / 2;
    deco(M.lampGlow, bx - 0.1, -0.25, bz - 0.1, bx + 0.1, -0.05, bz + 0.1);
    lamps.push({ pos: new THREE.Vector3(bx, -0.5, bz), color: 0xffd59a, intensity: 10, distance: 12, decay: 1.6, flicker: true });
    lamps.push({ pos: new THREE.Vector3((sxi + SE) / 2, -1, HZ0 + 3.5), color: 0xffc27a, intensity: 3, distance: 6, decay: 1.8, flicker: false });
  }

  // ---- roof + chimney
  const eaveY = 6.5;
  const halfSpan = (HZ1 - HZ0) / 2 + 0.6;
  const ridgeY = eaveY + halfSpan * 0.42;
  const slope = Math.atan2(ridgeY - eaveY, halfSpan);
  const slabLen = Math.hypot(ridgeY - eaveY, halfSpan) + 0.1;
  const midZ = (HZ0 + HZ1) / 2;
  B.mesh(roofMat, new THREE.BoxGeometry(HX1 - HX0 + 1.2, 0.18, slabLen), 0, (eaveY + ridgeY) / 2 + 0.05, midZ + halfSpan / 2, slope, 0, 0);
  B.mesh(roofMat, new THREE.BoxGeometry(HX1 - HX0 + 1.2, 0.18, slabLen), 0, (eaveY + ridgeY) / 2 + 0.05, midZ - halfSpan / 2, -slope, 0, 0);
  for (const x of [HX0 - WT / 2, HX1 + WT / 2 - 0.2]) {
    B.add(siding, prismX(x, x + 0.2, [[HZ1 + WT / 2, eaveY], [HZ0 - WT / 2, eaveY], [midZ, ridgeY - 0.05]]));
  }
  const chx = rng.range(HX0 + 2, HX1 - 3);
  solid(M.brick, chx, 7, midZ - 3.5, chx + 1, ridgeY + 1, midZ - 2.5);

  // ---- porches
  const fd = plan.frontDoor.center;
  solid(M.concrete, fd - 1.6, 0, HZ1 + WT / 2, fd + 1.6, 0.15, HZ1 + 1.2);
  deco(M.darkwood, fd - 1.8, 2.7, HZ1 + WT / 2, fd + 1.8, 2.85, HZ1 + 1.4);
  const bd = plan.backDoor.center;
  solid(M.concrete, bd - 1, 0, HZ0 - 1.0, bd + 1, 0.15, HZ0 - WT / 2);
  deco(M.concrete, -0.8, 0, -7.6, 0.8, 0.02, -5.2);
  deco(M.concrete, Math.min(0, fd) - 0.8, 0, HZ1 + 1.2, Math.max(0, fd) + 0.8, 0.02, -7.6);

  // =================================================================
  // Furniture
  // =================================================================
  const nodeById = new Map(plan.nav.nodes.map((n) => [n.id, n]));
  const navSegs = [[], []];
  for (const e of plan.nav.edges) {
    const a = nodeById.get(e.a);
    const b = nodeById.get(e.b);
    if (Math.abs(a.y - b.y) > 1) continue;
    navSegs[a.y > 2 ? 1 : 0].push([a.x, a.z, b.x, b.z]);
  }

  /** Converts wall-relative coordinates (u along the wall, v out from it) to world boxes. */
  function frame(r, side) {
    const map = (u, v) => {
      switch (side) {
        case 'N': return [r.x0 + u, r.z0 + v];
        case 'S': return [r.x0 + u, r.z1 - v];
        case 'W': return [r.x0 + v, r.z0 + u];
        default: return [r.x1 - v, r.z0 + u];
      }
    };
    const box = (mat, u0, v0, y0, u1, v1, y1, collide = false) => {
      const [ax, az] = map(u0, v0);
      const [bx, bz] = map(u1, v1);
      const x0 = Math.min(ax, bx);
      const x1 = Math.max(ax, bx);
      const z0 = Math.min(az, bz);
      const z1 = Math.max(az, bz);
      if (collide) solid(mat, x0, y0, z0, x1, y1, z1, 'furniture');
      else deco(mat, x0, y0, z0, x1, y1, z1);
    };
    const w = side === 'N' || side === 'S' ? r.x1 - r.x0 : r.z1 - r.z0;
    const d = side === 'N' || side === 'S' ? r.z1 - r.z0 : r.x1 - r.x0;
    return { box, map, w, d };
  }
  const spotAt = (F, L, u, v, y) => {
    const [x, z] = L.map(u, v);
    F.surface(x, y, z);
  };

  class Furnisher {
    constructor(room) {
      this.room = room;
      this.y = floorY(room.floor);
      const m = 0.14;
      this.bx0 = room.x0 + m;
      this.bx1 = room.x1 - m;
      this.bz0 = room.z0 + m;
      this.bz1 = room.z1 - m;
      this.rects = [];
      this.tall = [];
      this.pics = [];
      this.spots = [];
      this.keepouts = room.doors.map((d) => {
        const hw = d.width / 2 + 0.45;
        return d.axis === 'x'
          ? [d.center - hw, d.c - 1.25, d.center + hw, d.c + 1.25]
          : [d.c - 1.25, d.center - hw, d.c + 1.25, d.center + hw];
      });
      this.windows = room.windows.map((w) => ({ side: w.edge.side, a: w.a, b: w.b }));
    }

    free(x0, z0, x1, z1, tall, side) {
      if (x0 < this.bx0 - 1e-6 || x1 > this.bx1 + 1e-6 || z0 < this.bz0 - 1e-6 || z1 > this.bz1 + 1e-6) return false;
      const pad = 0.08;
      for (const [a0, b0, a1, b1] of [...this.rects, ...this.keepouts]) {
        if (x0 < a1 + pad && x1 > a0 - pad && z0 < b1 + pad && z1 > b0 - pad) return false;
      }
      const m = 0.5;
      for (const s of navSegs[this.room.floor]) if (segHitsRect(s, x0 - m, z0 - m, x1 + m, z1 + m)) return false;
      if (tall) {
        const along = side === 'N' || side === 'S' ? [x0, x1] : [z0, z1];
        for (const w of this.windows) if (w.side === side && along[0] < w.b + 0.15 && along[1] > w.a - 0.15) return false;
      }
      return true;
    }

    /** Finds room for a w x d piece against a wall; returns its footprint rect and side. */
    againstWall(w, d, tall = false, sides = ['N', 'S', 'W', 'E']) {
      for (let tries = 0; tries < 30; tries++) {
        const side = rng.pick(sides);
        const horiz = side === 'N' || side === 'S';
        const lo = horiz ? this.bx0 : this.bz0;
        const hi = (horiz ? this.bx1 : this.bz1) - w;
        if (hi < lo) continue;
        const p = rng.range(lo, hi);
        let r;
        if (side === 'N') r = [p, this.bz0, p + w, this.bz0 + d];
        else if (side === 'S') r = [p, this.bz1 - d, p + w, this.bz1];
        else if (side === 'W') r = [this.bx0, p, this.bx0 + d, p + w];
        else r = [this.bx1 - d, p, this.bx1, p + w];
        if (this.free(...r, tall, side)) {
          this.rects.push(r);
          if (tall) this.tall.push({ side, r });
          return { x0: r[0], z0: r[1], x1: r[2], z1: r[3], side };
        }
      }
      return null;
    }

    inMiddle(w, d) {
      for (let tries = 0; tries < 30; tries++) {
        const x = rng.range(this.bx0 + 0.7, this.bx1 - 0.7 - w);
        const z = rng.range(this.bz0 + 0.7, this.bz1 - 0.7 - d);
        const r = [x, z, x + w, z + d];
        if (this.free(...r, false)) {
          this.rects.push(r);
          return { x0: r[0], z0: r[1], x1: r[2], z1: r[3], side: 'N' };
        }
      }
      return null;
    }

    floorSpot() {
      for (let tries = 0; tries < 20; tries++) {
        const x = rng.range(this.bx0 + 0.3, this.bx1 - 0.3);
        const z = rng.range(this.bz0 + 0.3, this.bz1 - 0.3);
        if (this.rects.every(([a0, b0, a1, b1]) => x < a0 - 0.3 || x > a1 + 0.3 || z < b0 - 0.3 || z > b1 + 0.3)) {
          return { x, y: this.y, z };
        }
      }
      return { x: this.room.cx, y: this.y, z: this.room.cz };
    }

    surface(x, y, z) {
      this.spots.push({ x, y, z, used: false });
    }

    surfaceRow(r, y, n = 2) {
      const horiz = r.side === 'N' || r.side === 'S';
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        this.surface(horiz ? r.x0 + (r.x1 - r.x0) * t : (r.x0 + r.x1) / 2, y, horiz ? (r.z0 + r.z1) / 2 : r.z0 + (r.z1 - r.z0) * t);
      }
    }
  }

  // ---- furniture pieces (r = footprint from againstWall, oriented by r.side)
  function counterRun(F, w) {
    const r = F.againstWall(w, 0.62);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(M.cabinet, 0, 0, F.y, L.w, 0.58, F.y + 0.85, true);
    L.box(M.counter, 0, 0, F.y + 0.85, L.w, 0.62, F.y + 0.9);
    for (let u = 0.3; u < L.w - 0.3; u += 0.6) L.box(M.brass, u, 0.58, F.y + 0.7, u + 0.12, 0.6, F.y + 0.73);
    if (L.w > 1.4) L.box(M.steel, L.w / 2 - 0.35, 0.1, F.y + 0.86, L.w / 2 + 0.35, 0.5, F.y + 0.905);
    F.surfaceRow(r, F.y + 0.9, 3);
  }

  function stove(F) {
    const r = F.againstWall(0.7, 0.62);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(M.white, 0, 0, F.y, L.w, L.d, F.y + 0.9, true);
    L.box(M.black, 0.05, 0.05, F.y + 0.9, L.w - 0.05, L.d - 0.05, F.y + 0.92);
    L.box(M.black, 0.1, L.d, F.y + 0.25, L.w - 0.1, L.d + 0.01, F.y + 0.7);
  }

  /** Hollow cupboard with a hinged door; something may be hidden inside. */
  function cupboard(F, w, d, h, bodyMat, doorMat, opts = {}) {
    const r = F.againstWall(w, d, h > 0.95, opts.sides);
    if (!r) return null;
    const L = frame(r, r.side);
    const y = F.y;
    const th = 0.04;
    L.box(bodyMat, 0, 0, y, L.w, th, y + h);
    L.box(bodyMat, 0, 0, y, th, L.d, y + h);
    L.box(bodyMat, L.w - th, 0, y, L.w, L.d, y + h);
    L.box(bodyMat, 0, 0, y + h - th, L.w, L.d, y + h);
    L.box(bodyMat, 0, 0, y, L.w, L.d, y + 0.06);
    if (h > 1.2) L.box(bodyMat, th, 0, y + h * 0.55, L.w - th, L.d - 0.02, y + h * 0.55 + 0.03);
    const collider = physics.add(r.x0, y, r.z0, r.x1, y + h, r.z1, 'furniture');

    // Hinge at the low end of the front edge; the door swings outward.
    const pivot = new THREE.Group();
    let base = 0;
    let swing = 1;
    if (r.side === 'N') { pivot.position.set(r.x0, y, r.z1 + 0.02); swing = -1; }
    else if (r.side === 'S') { pivot.position.set(r.x0, y, r.z0 - 0.02); swing = 1; }
    else if (r.side === 'W') { pivot.position.set(r.x1 + 0.02, y, r.z0); base = -Math.PI / 2; swing = 1; }
    else { pivot.position.set(r.x0 - 0.02, y, r.z0); base = -Math.PI / 2; swing = -1; }
    pivot.rotation.y = base;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(L.w - 0.02, h - 0.02, 0.03), doorMat);
    panel.position.set(L.w / 2, h / 2, 0);
    panel.castShadow = true;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), M.brass);
    const outward = r.side === 'N' || r.side === 'W' ? 1 : -1;
    knob.position.set(L.w - 0.08, Math.min(h * 0.6, 1.1), 0.03 * outward * (base ? -1 : 1));
    pivot.add(panel, knob);
    scene.add(pivot);
    const [cx, cz] = L.map(L.w / 2, L.d / 2);
    const c = {
      kind: 'cupboard',
      name: opts.name || 'Cupboard',
      pivot,
      panel,
      collider,
      open: false,
      t: 0,
      item: null,
      spot: { x: cx, y: y + 0.06, z: cz },
      update(dt) {
        const target = this.open ? 1 : 0;
        if (this.t === target) return;
        this.t = this.t < target ? Math.min(1, this.t + dt * 3) : Math.max(0, this.t - dt * 3);
        const e = this.t * this.t * (3 - 2 * this.t);
        this.pivot.rotation.y = base + swing * e * Math.PI * 0.55;
      },
    };
    collider.container = c;
    panel.userData.container = c;
    dynamicMeshes.push(panel);
    containers.push(c);
    if (h <= 1.2) F.surface(cx, y + h, cz);
    return c;
  }

  /** Low chest with a lid that lifts up. */
  function chest(F, name = 'Chest', mat = M.darkwood) {
    const r = F.againstWall(0.9, 0.5);
    if (!r) return null;
    const L = frame(r, r.side);
    const y = F.y;
    const h = 0.48;
    const th = 0.04;
    L.box(mat, 0, 0, y, L.w, th, y + h);
    L.box(mat, 0, L.d - th, y, L.w, L.d, y + h);
    L.box(mat, 0, 0, y, th, L.d, y + h);
    L.box(mat, L.w - th, 0, y, L.w, L.d, y + h);
    L.box(mat, 0, 0, y, L.w, L.d, y + 0.05);
    const collider = physics.add(r.x0, y, r.z0, r.x1, y + h, r.z1, 'furniture');
    const pivot = new THREE.Group();
    const [px, pz] = L.map(L.w / 2, 0);
    pivot.position.set(px, y + h, pz);
    const lidGeo = r.side === 'N' || r.side === 'S' ? new THREE.BoxGeometry(L.w, 0.05, L.d) : new THREE.BoxGeometry(L.d, 0.05, L.w);
    const lid = new THREE.Mesh(lidGeo, mat);
    lid.castShadow = true;
    const off = { N: [0, 0.025, L.d / 2], S: [0, 0.025, -L.d / 2], W: [L.d / 2, 0.025, 0], E: [-L.d / 2, 0.025, 0] }[r.side];
    lid.position.set(...off);
    pivot.add(lid);
    scene.add(pivot);
    const [cx, cz] = L.map(L.w / 2, L.d / 2);
    const c = {
      kind: 'chest',
      name,
      pivot,
      panel: lid,
      collider,
      open: false,
      t: 0,
      item: null,
      spot: { x: cx, y: y + 0.05, z: cz },
      update(dt) {
        const target = this.open ? 1 : 0;
        if (this.t === target) return;
        this.t = this.t < target ? Math.min(1, this.t + dt * 3) : Math.max(0, this.t - dt * 3);
        const a = this.t * this.t * (3 - 2 * this.t) * 1.9;
        if (r.side === 'N') pivot.rotation.x = -a;
        else if (r.side === 'S') pivot.rotation.x = a;
        else if (r.side === 'W') pivot.rotation.z = a;
        else pivot.rotation.z = -a;
      },
    };
    collider.container = c;
    lid.userData.container = c;
    dynamicMeshes.push(lid);
    containers.push(c);
    return c;
  }

  /** Tall wardrobe you can hide in. */
  function wardrobe(F) {
    const r = F.againstWall(1.2, 0.62, true);
    if (!r) return;
    const L = frame(r, r.side);
    const h = 2.1;
    L.box(M.darkwood, 0, 0, F.y, L.w, L.d - 0.03, F.y + h, true);
    L.box(M.darkwood, 0, L.d - 0.04, F.y + h - 0.08, L.w, L.d, F.y + h);
    L.box(M.brass, L.w / 2 - 0.07, L.d, F.y + 1.0, L.w / 2 - 0.04, L.d + 0.02, F.y + 1.25);
    L.box(M.brass, L.w / 2 + 0.04, L.d, F.y + 1.0, L.w / 2 + 0.07, L.d + 0.02, F.y + 1.25);
    // The door face is a separate mesh so it can be targeted (and hidden while you're inside).
    const [fx0, fz0] = L.map(0.02, L.d - 0.03);
    const [fx1, fz1] = L.map(L.w - 0.02, L.d);
    const face = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.03, Math.abs(fx1 - fx0)), h - 0.1, Math.max(0.03, Math.abs(fz1 - fz0))),
      M.darkwood,
    );
    face.position.set((fx0 + fx1) / 2, F.y + (h - 0.1) / 2, (fz0 + fz1) / 2);
    face.castShadow = true;
    scene.add(face);
    const [ox, oz] = L.map(L.w / 2, L.d + 0.55);
    const [ix, iz] = L.map(L.w / 2, L.d - 0.2);
    const yaw = { N: Math.PI, S: 0, W: -Math.PI / 2, E: Math.PI / 2 }[r.side];
    const spot = { face, out: new THREE.Vector3(ox, F.y, oz), inside: new THREE.Vector3(ix, F.y, iz), yaw };
    face.userData.hide = spot;
    dynamicMeshes.push(face);
    hideSpots.push(spot);
  }

  function table(F, w, d, h, mat = M.darkwood, chairs = 0, middle = false) {
    const pad = chairs ? 0.55 : 0;
    const r = middle ? F.inMiddle(w + pad * 2, d + pad * 2) : F.againstWall(w + pad * 2, d + pad);
    if (!r) return null;
    const horiz = middle || r.side === 'N' || r.side === 'S';
    const hw = (horiz ? w : d) / 2;
    const hd = (horiz ? d : w) / 2;
    let tx = (r.x0 + r.x1) / 2;
    let tz = (r.z0 + r.z1) / 2;
    if (!middle && chairs) {
      if (r.side === 'N') tz = r.z0 + hd;
      if (r.side === 'S') tz = r.z1 - hd;
      if (r.side === 'W') tx = r.x0 + hw;
      if (r.side === 'E') tx = r.x1 - hw;
    }
    const y = F.y;
    physics.add(tx - hw, y, tz - hd, tx + hw, y + h, tz + hd, 'furniture');
    deco(mat, tx - hw, y + h - 0.05, tz - hd, tx + hw, y + h, tz + hd);
    const l = 0.06;
    for (const [lx, lz] of [[tx - hw, tz - hd], [tx + hw - l, tz - hd], [tx - hw, tz + hd - l], [tx + hw - l, tz + hd - l]]) {
      deco(mat, lx, y, lz, lx + l, y + h - 0.05, lz + l);
    }
    // Chair with its backrest on the side facing away from the table (dir = unit step away).
    const chairAt = (x, z, dx, dz) => {
      const s = 0.21;
      deco(M.darkwood, x - s, y + 0.42, z - s, x + s, y + 0.47, z + s);
      for (const [ox, oz] of [[-s, -s], [s - 0.04, -s], [-s, s - 0.04], [s - 0.04, s - 0.04]]) deco(M.darkwood, x + ox, y, z + oz, x + ox + 0.04, y + 0.42, z + oz + 0.04);
      if (dz) deco(M.darkwood, x - s, y + 0.47, dz > 0 ? z + s - 0.04 : z - s, x + s, y + 0.95, dz > 0 ? z + s : z - s + 0.04);
      else deco(M.darkwood, dx > 0 ? x + s - 0.04 : x - s, y + 0.47, z - s, dx > 0 ? x + s : x - s + 0.04, y + 0.95, z + s);
      physics.add(x - s, y, z - s, x + s, y + 0.47, z + s, 'furniture');
    };
    if (chairs && horiz) {
      const south = middle || r.side === 'N';
      const north = middle || r.side === 'S';
      if (south) {
        chairAt(tx - hw * 0.45, tz + hd + 0.3, 0, 1);
        if (chairs > 1) chairAt(tx + hw * 0.45, tz + hd + 0.3, 0, 1);
      }
      if (north) {
        chairAt(tx - hw * 0.45, tz - hd - 0.3, 0, -1);
        if (chairs > 1) chairAt(tx + hw * 0.45, tz - hd - 0.3, 0, -1);
      }
    } else if (chairs) {
      const dir = r.side === 'W' ? 1 : -1;
      chairAt(tx + dir * (hw + 0.3), tz, dir, 0);
    }
    F.surface(horiz ? tx - hw * 0.4 : tx, y + h, horiz ? tz : tz - hd * 0.4);
    F.surface(horiz ? tx + hw * 0.4 : tx, y + h, horiz ? tz : tz + hd * 0.4);
    return r;
  }

  function couch(F, mat) {
    const r = F.againstWall(2.1, 0.9);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(mat, 0, 0, F.y, L.w, L.d, F.y + 0.45, true);
    L.box(mat, 0, 0, F.y, L.w, 0.28, F.y + 1.0, true);
    L.box(mat, 0, 0, F.y, 0.2, L.d, F.y + 0.7);
    L.box(mat, L.w - 0.2, 0, F.y, L.w, L.d, F.y + 0.7);
    L.box(M.fabricBeige, 0.25, 0.3, F.y + 0.45, L.w / 2 - 0.02, L.d - 0.05, F.y + 0.58);
    L.box(M.fabricBeige, L.w / 2 + 0.02, 0.3, F.y + 0.45, L.w - 0.25, L.d - 0.05, F.y + 0.58);
    spotAt(F, L, L.w * 0.3, 0.6, F.y + 0.58);
  }

  function armchair(F, mat) {
    const r = F.againstWall(0.9, 0.9);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(mat, 0, 0, F.y, L.w, L.d, F.y + 0.45, true);
    L.box(mat, 0, 0, F.y, L.w, 0.22, F.y + 0.95);
    L.box(mat, 0, 0, F.y, 0.15, L.d, F.y + 0.65);
    L.box(mat, L.w - 0.15, 0, F.y, L.w, L.d, F.y + 0.65);
  }

  function bookshelf(F, w = 1.4) {
    const r = F.againstWall(w, 0.4, true);
    if (!r) return;
    const L = frame(r, r.side);
    const h = 2.1;
    L.box(M.darkwood, 0, 0, F.y, L.w, 0.04, F.y + h, true);
    L.box(M.darkwood, 0, 0, F.y, 0.05, L.d, F.y + h);
    L.box(M.darkwood, L.w - 0.05, 0, F.y, L.w, L.d, F.y + h);
    L.box(M.darkwood, 0, 0, F.y + h - 0.05, L.w, L.d, F.y + h);
    physics.add(r.x0, F.y, r.z0, r.x1, F.y + h, r.z1, 'furniture');
    const bookMats = [M.fabricRed, M.fabricGreen, M.fabricBlue, M.fabricBeige, M.toyYellow];
    for (let l = 0; l < 4; l++) {
      const ly = F.y + 0.05 + l * 0.5;
      L.box(M.darkwood, 0, 0, ly - 0.03, L.w, L.d, ly);
      let p = 0.08;
      while (p < L.w - 0.15) {
        const bw = rng.range(0.04, 0.09);
        if (rng.chance(0.12)) {
          p += 0.2;
          continue;
        }
        L.box(rng.pick(bookMats), p, 0.05, ly, p + bw, L.d - 0.03, ly + rng.range(0.2, 0.34));
        p += bw + 0.01;
      }
    }
  }

  function desk(F, withChair = true) {
    return table(F, rng.range(1.1, 1.5), 0.65, 0.76, M.darkwood, withChair ? 1 : 0);
  }

  function bed(F, blanket, width) {
    const r = F.againstWall(width, 2.1);
    if (!r) return null;
    const L = frame(r, r.side);
    const y = F.y;
    L.box(M.darkwood, 0, 0, y, L.w, L.d, y + 0.35, true);
    L.box(M.pillow, 0.05, 0.05, y + 0.35, L.w - 0.05, L.d - 0.05, y + 0.55, true);
    L.box(blanket, 0.02, 0.6, y + 0.4, L.w - 0.02, L.d - 0.02, y + 0.6);
    L.box(M.pillow, 0.15, 0.1, y + 0.55, L.w - 0.15, 0.45, y + 0.68);
    L.box(M.darkwood, 0, 0, y, L.w, 0.06, y + 1.1);
    spotAt(F, L, L.w / 2, 1.3, y + 0.6);
    return r;
  }

  function bathroom(F) {
    const tub = F.againstWall(1.7, 0.75);
    if (tub) {
      const L = frame(tub, tub.side);
      L.box(M.porcelain, 0, 0, F.y, L.w, L.d, F.y + 0.55, true);
      L.box(M.tileBlue, 0.08, 0.08, F.y + 0.54, L.w - 0.08, L.d - 0.08, F.y + 0.56);
    }
    const toilet = F.againstWall(0.45, 0.7);
    if (toilet) {
      const L = frame(toilet, toilet.side);
      L.box(M.porcelain, 0.05, 0.2, F.y, L.w - 0.05, L.d, F.y + 0.42, true);
      L.box(M.porcelain, 0, 0, F.y + 0.4, L.w, 0.2, F.y + 0.85);
    }
    const sink = F.againstWall(0.6, 0.45);
    if (sink) {
      const L = frame(sink, sink.side);
      L.box(M.porcelain, 0, 0, F.y + 0.7, L.w, L.d, F.y + 0.85, true);
      L.box(M.porcelain, 0.2, 0, F.y, L.w - 0.2, 0.2, F.y + 0.7);
      L.box(M.darkGlass, 0.05, 0, F.y + 1.2, L.w - 0.05, 0.02, F.y + 1.8);
      spotAt(F, L, L.w / 2, L.d / 2, F.y + 0.85);
    }
  }

  function washer(F) {
    const r = F.againstWall(0.65, 0.65);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(M.white, 0, 0, F.y, L.w, L.d, F.y + 0.9, true);
    L.box(M.darkGlass, 0.15, L.d, F.y + 0.3, L.w - 0.15, L.d + 0.01, F.y + 0.65);
    spotAt(F, L, L.w / 2, L.d / 2, F.y + 0.9);
  }

  function workbench(F) {
    const r = F.againstWall(rng.range(1.6, 2.2), 0.7);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(M.darkwood, 0, 0, F.y + 0.85, L.w, L.d, F.y + 0.92);
    for (const u of [0.05, L.w - 0.12]) L.box(M.darkwood, u, 0.05, F.y, u + 0.07, L.d - 0.05, F.y + 0.85);
    physics.add(r.x0, F.y, r.z0, r.x1, F.y + 0.92, r.z1, 'furniture');
    L.box(M.plank, 0.1, 0, F.y + 1.2, L.w - 0.1, 0.03, F.y + 1.9);
    for (let u = 0.3; u < L.w - 0.3; u += 0.35) L.box(M.steel, u, 0.03, F.y + 1.4 + rng.range(0, 0.3), u + 0.04, 0.06, F.y + 1.7);
    F.surfaceRow(r, F.y + 0.92, 2);
  }

  function boxes(F) {
    const s = rng.range(0.5, 0.8);
    const r = F.againstWall(s, s);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(M.cardboard, 0, 0, F.y, L.w, L.d, F.y + s, true);
    if (rng.chance(0.5)) L.box(M.cardboard, 0.08, 0.08, F.y + s, L.w - 0.08, L.d - 0.08, F.y + s * 1.8, true);
  }

  function piano(F) {
    const r = F.againstWall(1.5, 0.62, true);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(M.black, 0, 0, F.y, L.w, 0.4, F.y + 1.25, true);
    L.box(M.black, 0, 0.4, F.y + 0.65, L.w, 0.62, F.y + 0.75, true);
    L.box(M.white, 0.05, 0.42, F.y + 0.75, L.w - 0.05, 0.6, F.y + 0.78);
    for (let u = 0.1; u < L.w - 0.1; u += 0.08) L.box(M.black, u, 0.45, F.y + 0.78, u + 0.03, 0.55, F.y + 0.8);
    spotAt(F, L, L.w / 2, 0.2, F.y + 1.25);
  }

  function plant(F) {
    const r = F.againstWall(0.45, 0.45);
    if (!r) return;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    B.mesh(M.pot, new THREE.CylinderGeometry(0.2, 0.15, 0.4, 10), cx, F.y + 0.2, cz);
    B.mesh(M.plant, new THREE.IcosahedronGeometry(0.35, 0), cx, F.y + 0.75, cz);
    physics.add(r.x0, F.y, r.z0, r.x1, F.y + 0.4, r.z1, 'furniture');
  }

  function crib(F) {
    const r = F.againstWall(1.3, 0.75);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(M.lightwood, 0, 0, F.y + 0.3, L.w, L.d, F.y + 0.36);
    L.box(M.pillow, 0.04, 0.04, F.y + 0.36, L.w - 0.04, L.d - 0.04, F.y + 0.45);
    for (let u = 0; u < L.w; u += 0.1) {
      const u0 = Math.min(u, L.w - 0.03);
      L.box(M.lightwood, u0, 0, F.y, u0 + 0.03, 0.03, F.y + 1.0);
      L.box(M.lightwood, u0, L.d - 0.03, F.y, u0 + 0.03, L.d, F.y + 1.0);
    }
    physics.add(r.x0, F.y, r.z0, r.x1, F.y + 1.0, r.z1, 'furniture');
  }

  function tvStand(F) {
    const r = F.againstWall(1.4, 0.5);
    if (!r) return;
    const L = frame(r, r.side);
    L.box(M.darkwood, 0, 0, F.y, L.w, L.d, F.y + 0.55, true);
    L.box(M.black, 0.25, 0.1, F.y + 0.55, L.w - 0.25, 0.4, F.y + 1.1);
    const [sx, sz] = L.map(L.w / 2, 0.405);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.46), M.tvOff);
    screen.position.set(sx, F.y + 0.83, sz);
    screen.rotation.y = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 }[r.side];
    scene.add(screen);
    const app = { kind: 'tv', name: 'TV', mesh: screen, on: false, pos: new THREE.Vector3(sx, F.y + 0.8, sz), timer: 0, offMat: M.tvOff, onMat: M.tv };
    screen.userData.appliance = app;
    dynamicMeshes.push(screen);
    appliances.push(app);
  }

  function radioAppliance(F) {
    const spot = F.spots.find((s) => !s.used);
    if (!spot) return;
    spot.used = true;
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.14), M.darkwood);
    g.position.set(spot.x, spot.y + 0.1, spot.z);
    g.rotation.y = rng.range(-0.5, 0.5);
    g.castShadow = true;
    scene.add(g);
    const app = { kind: 'radio', name: 'Radio', mesh: g, on: false, pos: g.position.clone(), timer: 0 };
    g.userData.appliance = app;
    dynamicMeshes.push(g);
    appliances.push(app);
  }

  function rug(F, mat) {
    const w = (F.bx1 - F.bx0) * rng.range(0.4, 0.6);
    const d = (F.bz1 - F.bz0) * rng.range(0.4, 0.6);
    const cx = (F.bx0 + F.bx1) / 2;
    const cz = (F.bz0 + F.bz1) / 2;
    deco(mat, cx - w / 2, F.y, cz - d / 2, cx + w / 2, F.y + 0.01, cz + d / 2);
  }

  function pictures(F, n) {
    const mats = [M.fabricBlue, M.fabricGreen, M.toyYellow, M.fabricRed, M.drawing1];
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 10; tries++) {
        const side = rng.pick(['N', 'S', 'W', 'E']);
        const horiz = side === 'N' || side === 'S';
        const w = rng.range(0.5, 1.0);
        const lo = (horiz ? F.bx0 : F.bz0) + 0.2;
        const hi = (horiz ? F.bx1 : F.bz1) - 0.2 - w;
        if (hi < lo) continue;
        const p = rng.range(lo, hi);
        const nearWall = ([a0, b0, a1, b1]) => (side === 'N' ? b0 < F.bz0 + 0.5 : side === 'S' ? b1 > F.bz1 - 0.5 : side === 'W' ? a0 < F.bx0 + 0.5 : a1 > F.bx1 - 0.5);
        const overlaps = ([a0, b0, a1, b1]) => (horiz ? p < a1 && p + w > a0 : p < b1 && p + w > b0);
        const clash = F.windows.some((wi) => wi.side === side && p < wi.b + 0.2 && p + w > wi.a - 0.2)
          || F.tall.some((t) => t.side === side && overlaps(t.r))
          || F.keepouts.some((ko) => overlaps(ko) && nearWall(ko))
          || F.pics.some((pc) => pc.side === side && p < pc.b + 0.3 && p + w > pc.a - 0.3);
        if (clash) continue;
        const r = side === 'N' ? { x0: p, z0: F.bz0 - 0.08, x1: p + w, z1: F.bz0 } : side === 'S' ? { x0: p, z0: F.bz1, x1: p + w, z1: F.bz1 + 0.08 }
          : side === 'W' ? { x0: F.bx0 - 0.08, z0: p, x1: F.bx0, z1: p + w } : { x0: F.bx1, z0: p, x1: F.bx1 + 0.08, z1: p + w };
        F.pics.push({ side, a: p, b: p + w });
        const L = frame(r, side);
        const h = w * rng.range(0.6, 0.9);
        const y = F.y + 1.9;
        L.box(M.darkwood, 0, 0.02, y - h / 2 - 0.04, L.w, 0.05, y + h / 2 + 0.04);
        L.box(rng.pick(mats), 0.04, 0.05, y - h / 2, L.w - 0.04, 0.06, y + h / 2);
        break;
      }
    }
  }

  const furnishers = new Map();
  for (const room of plan.rooms) {
    const F = new Furnisher(room);
    furnishers.set(room.id, F);
    // Ceiling lamp.
    const lx = room.type === 'stairs' ? SA + 2.7 : room.cx;
    const lz = room.type === 'stairs' ? HZ0 + 4 : room.cz;
    const ly = room.floor === 0 ? 3.3 : 6.3;
    deco(M.lampGlow, lx - 0.18, ly - 0.12, lz - 0.18, lx + 0.18, ly, lz + 0.18);
    lamps.push({ pos: new THREE.Vector3(lx, ly - 0.3, lz), color: 0xffe2b0, intensity: room.area >= 2 ? 9 : 6, distance: 13, decay: 1.6, flicker: false });
    if (room.type === 'stairs') continue;

    const fab = rng.pick([M.fabricGreen, M.fabricRed, M.fabricBlue, M.fabricBeige]);
    const big = room.area >= 2;
    switch (room.type) {
      case 'living':
        couch(F, fab);
        armchair(F, fab);
        if (big) armchair(F, fab);
        tvStand(F);
        table(F, 1.0, 0.6, 0.45, M.darkwood, 0, true);
        if (rng.chance(0.6)) bookshelf(F);
        if (rng.chance(0.5)) cupboard(F, 1.2, 0.5, 0.9, M.darkwood, M.darkwood, { name: 'Sideboard' });
        plant(F);
        rug(F, M.fabricRed);
        break;
      case 'kitchen':
        counterRun(F, rng.range(2.0, 3.2));
        if (big) counterRun(F, rng.range(1.4, 2.4));
        stove(F);
        cupboard(F, 0.8, 0.72, 1.9, M.white, M.white, { name: 'Fridge' });
        cupboard(F, 1.0, 0.6, 0.9, M.cabinet, M.cabinet, { name: 'Cabinet' });
        table(F, 1.3, 0.9, 0.76, M.darkwood, 2, big);
        if (rng.chance(0.5)) radioAppliance(F);
        break;
      case 'dining':
        table(F, 1.8, 1.0, 0.76, M.darkwood, 2, true);
        cupboard(F, 1.4, 0.5, 0.95, M.darkwood, M.darkwood, { name: 'Sideboard' });
        if (rng.chance(0.5)) cupboard(F, 1.0, 0.5, 1.9, M.darkwood, M.darkwood, { name: 'Cabinet' });
        plant(F);
        break;
      case 'study':
      case 'sewing':
        desk(F);
        bookshelf(F);
        if (big) bookshelf(F);
        armchair(F, fab);
        cupboard(F, 1.0, 0.5, 1.0, M.darkwood, M.darkwood, { name: 'Filing Cabinet' });
        radioAppliance(F);
        break;
      case 'library':
        for (let k = 0; k < 4; k++) bookshelf(F, rng.range(1.2, 1.8));
        armchair(F, fab);
        armchair(F, fab);
        desk(F, false);
        rug(F, M.fabricGreen);
        break;
      case 'music':
        piano(F);
        bookshelf(F);
        armchair(F, fab);
        chest(F, 'Chest');
        radioAppliance(F);
        break;
      case 'workshop':
        workbench(F);
        if (big) workbench(F);
        boxes(F);
        cupboard(F, 1.0, 0.55, 1.9, M.steel, M.steel, { name: 'Tool Locker' });
        chest(F, 'Toolbox', M.rust);
        radioAppliance(F);
        break;
      case 'den':
        couch(F, fab);
        tvStand(F);
        armchair(F, fab);
        chest(F, 'Chest');
        wardrobe(F);
        break;
      case 'bathroom':
        bathroom(F);
        cupboard(F, 0.6, 0.35, 0.9, M.white, M.white, { name: 'Medicine Cabinet' });
        break;
      case 'pantry':
        bookshelf(F, 1.2);
        bookshelf(F, 1.2);
        boxes(F);
        cupboard(F, 0.8, 0.5, 0.9, M.cabinet, M.cabinet, { name: 'Cabinet' });
        break;
      case 'laundry':
        washer(F);
        washer(F);
        cupboard(F, 0.9, 0.5, 0.9, M.white, M.white, { name: 'Cabinet' });
        boxes(F);
        break;
      case 'storage':
      case 'attic':
      case 'closet':
        boxes(F);
        boxes(F);
        if (big) boxes(F);
        chest(F, 'Old Trunk');
        wardrobe(F);
        if (rng.chance(0.5)) bookshelf(F);
        break;
      case 'master':
      case 'bedroom':
        bed(F, room.type === 'master' ? M.fabricRed : fab, room.type === 'master' ? 1.8 : 1.4);
        cupboard(F, 0.5, 0.45, 0.6, M.darkwood, M.darkwood, { name: 'Nightstand' });
        if (room.type === 'master') cupboard(F, 0.5, 0.45, 0.6, M.darkwood, M.darkwood, { name: 'Nightstand' });
        wardrobe(F);
        cupboard(F, 1.2, 0.5, 1.0, M.darkwood, M.darkwood, { name: 'Dresser' });
        if (big) armchair(F, fab);
        break;
      case 'kids':
      case 'playroom':
        if (room.type === 'kids') bed(F, M.fabricBlue, 1.2);
        chest(F, 'Toy Chest', M.toy);
        wardrobe(F);
        desk(F);
        tvStand(F);
        rug(F, M.carpetBlue);
        break;
      case 'nursery':
        crib(F);
        cupboard(F, 1.0, 0.5, 1.0, M.lightwood, M.lightwood, { name: 'Dresser' });
        chest(F, 'Toy Chest', M.toyYellow);
        break;
      default:
        boxes(F);
        chest(F, 'Chest');
    }
    pictures(F, rng.int(1, 3));
  }

  const staticMeshes = B.build(scene);

  // =================================================================
  // Items
  // =================================================================
  const place = (type, x, surfaceY, z, rotY = rng.range(0, Math.PI * 2)) => {
    const it = new Item(type, T, x, 0, z, rotY);
    it.pos.y = surfaceY + it.radius;
    it.home.copy(it.pos);
    it.mesh.position.copy(it.pos);
    scene.add(it.mesh);
    items.push(it);
    return it;
  };
  const freeSpot = (F) => {
    const s = rng.shuffle(F.spots).find((sp) => !sp.used);
    if (s) {
      s.used = true;
      return s;
    }
    return F.floorSpot();
  };
  for (const c of containers) {
    // Tag each container with the room it's in.
    const p = c.spot;
    const room = plan.rooms.find((r) => p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1 && Math.abs(floorY(r.floor) - p.y) < 1);
    c.room = room ? room.id : -1;
  }
  const roomContainers = (room) => containers.filter((c) => !c.item && c.room === room.id);
  const hideIn = (it, c) => {
    c.item = it;
    it.container = c;
    it.homeContainer = c;
  };

  // Keys and the crowbar: often tucked away inside cupboards, chests and fridges.
  for (const need of plan.items) {
    const room = plan.rooms[need.room];
    const F = furnishers.get(room.id);
    const type = need.type === 'crowbar' ? 'crowbar' : keyType(need.type.split(':')[1]);
    const cs = roomContainers(room);
    if (cs.length && rng.chance(0.6)) {
      const c = rng.pick(cs);
      hideIn(place(type, c.spot.x, c.spot.y, c.spot.z), c);
    } else {
      const s = freeSpot(F);
      place(type, s.x, s.y, s.z);
    }
  }
  // Junk to throw (and red herrings in the cupboards).
  for (const room of plan.rooms) {
    if (room.type === 'stairs') continue;
    const F = furnishers.get(room.id);
    const loot = LOOT[room.type] || ['box', 'book'];
    const n = rng.int(1, room.area >= 2 ? 4 : 2);
    for (let k = 0; k < n; k++) {
      const s = freeSpot(F);
      place(rng.pick(loot), s.x, s.y, s.z);
    }
    const small = loot.filter((t) => t !== 'box' && t !== 'pillow').concat(['book']);
    for (const c of roomContainers(room)) {
      if (rng.chance(0.45)) hideIn(place(rng.pick(small), c.spot.x, c.spot.y, c.spot.z), c);
    }
  }
  // Player's yard: ammunition for breaking windows.
  place('box', 2, 0, 7.6, 0.3);
  place('box', -2.6, 0, 7.4, -0.2);
  place('box', -3.4, 0, 8.6, 0.8);
  place('can', 2.9, 0.8, 10);
  place('apple', 3.3, 0.8, 9.8);
  place('can', 3.65, 0.8, 10.2);
  place('ball', -1.5, 0, 10.2);

  // =================================================================
  // Outside: neighbor's yard, street, player's house
  // =================================================================
  const OB = new StaticBuilder();
  const odeco = (mat, x0, y0, z0, x1, y1, z1) => OB.box(mat, x0, y0, z0, x1, y1, z1);
  const osolid = (mat, x0, y0, z0, x1, y1, z1, kind = 'wall') => {
    OB.box(mat, x0, y0, z0, x1, y1, z1);
    return physics.add(x0, y0, z0, x1, y1, z1, kind);
  };
  const Y = plan.yard;
  const FH = 1.2;
  osolid(M.fence, Y.x0, 0, Y.z1 - 0.04, -1.5, FH, Y.z1 + 0.04);
  osolid(M.fence, 1.5, 0, Y.z1 - 0.04, Y.x1, FH, Y.z1 + 0.04);
  osolid(M.fence, Y.x0 - 0.04, 0, Y.z0, Y.x0 + 0.04, FH, Y.z1);
  osolid(M.fence, Y.x1 - 0.04, 0, Y.z0, Y.x1 + 0.04, FH, Y.z1);
  osolid(M.fence, Y.x0, 0, Y.z0 - 0.04, Y.x1, FH, Y.z0 + 0.04);
  for (const x of [Y.x0, -1.5, 1.5, Y.x1]) odeco(M.darkwood, x - 0.08, 0, Y.z1 - 0.08, x + 0.08, FH + 0.15, Y.z1 + 0.08);

  const G = 70;
  odeco(M.grass, -G, -0.1, -G, G, 0, HZ0);
  odeco(M.grass, -G, -0.1, HZ1, G, 0, G);
  odeco(M.grass, -G, -0.1, HZ0, HX0, 0, HZ1);
  odeco(M.grass, HX1, -0.1, HZ0, G, 0, HZ1);
  odeco(M.asphalt, -G, 0, -3.5, G, 0.01, 3.5);
  for (let x = -G + 1; x < G; x += 4) odeco(M.streetLine, x, 0.01, -0.07, x + 2, 0.015, 0.07);
  osolid(M.concrete, -G, 0, -5.2, G, 0.12, -3.5, 'floor');
  osolid(M.concrete, -G, 0, 3.5, G, 0.12, 5.2, 'floor');
  odeco(M.concrete, -0.8, 0, 5.2, 0.8, 0.02, 12.5);

  // Player's house (a facade you start in front of).
  osolid(M.brick, -7, 0, 13, 7, 3.4, 21);
  OB.mesh(M.roofGrey, new THREE.BoxGeometry(15.2, 0.18, Math.hypot(2.3, 4.6) + 0.1), 0, 4.55, 15.2, -Math.atan2(2.3, 4.6), 0, 0);
  OB.mesh(M.roofGrey, new THREE.BoxGeometry(15.2, 0.18, Math.hypot(2.3, 4.6) + 0.1), 0, 4.55, 18.8, Math.atan2(2.3, 4.6), 0, 0);
  OB.add(M.brick, prismX(-7, -6.9, [[13, 3.4], [21, 3.4], [17, 5.65]]));
  OB.add(M.brick, prismX(6.9, 7, [[13, 3.4], [21, 3.4], [17, 5.65]]));
  odeco(M.door, -0.55, 0.15, 12.94, 0.55, 2.3, 13);
  for (const x of [-4.5, 4.5]) {
    odeco(M.trim, x - 1.05, 1.05, 12.93, x + 1.05, 2.55, 13);
    odeco(M.darkGlass, x - 0.95, 1.15, 12.92, x + 0.95, 2.45, 12.95);
  }
  osolid(M.concrete, -1.6, 0, 12, 1.6, 0.15, 13);
  osolid(M.white, 2.5, 0, 9.5, 4, 0.8, 10.5, 'furniture');
  osolid(M.hedge, -7, 0, 11.5, -2, 1.0, 12.3);
  osolid(M.hedge, 2, 0, 11.5, 7, 1.0, 12.3);

  // Car parked on the street.
  osolid(M.carRed, -12, 0.3, 1.2, -7.8, 1.1, 3.0, 'furniture');
  odeco(M.carRed, -11.2, 1.1, 1.3, -8.6, 1.7, 2.9);
  odeco(M.darkGlass, -11.1, 1.15, 1.28, -8.7, 1.62, 2.92);
  for (const x of [-11.2, -8.6]) {
    for (const z of [1.2, 3.0]) OB.mesh(M.tire, new THREE.CylinderGeometry(0.35, 0.35, 0.25, 14), x, 0.35, z, Math.PI / 2, 0, 0);
  }
  odeco(M.darkwood, 2.3, 0, -5.45, 2.4, 1.0, -5.35);
  osolid(M.mailbox, 2.15, 1.0, -5.65, 2.55, 1.3, -5.15);
  for (const [x, z] of [[-14, 4.6], [14, 4.6], [-18, -4.6], [18, -4.6]]) {
    OB.mesh(M.black, new THREE.CylinderGeometry(0.07, 0.1, 4.2, 8), x, 2.1, z);
    physics.add(x - 0.1, 0, z - 0.1, x + 0.1, 4.2, z + 0.1);
    odeco(M.lampGlow, x - 0.2, 4.1, z - 0.2, x + 0.2, 4.35, z + 0.2);
  }

  function tree(x, z, s = 1) {
    OB.mesh(M.bark, new THREE.CylinderGeometry(0.18 * s, 0.26 * s, 3 * s, 8), x, 1.5 * s, z);
    physics.add(x - 0.25 * s, 0, z - 0.25 * s, x + 0.25 * s, 3 * s, z + 0.25 * s);
    OB.mesh(M.leaves, new THREE.IcosahedronGeometry(1.6 * s, 1), x, 3.6 * s, z);
    OB.mesh(M.leaves, new THREE.IcosahedronGeometry(1.2 * s, 1), x + 0.8 * s, 3.1 * s, z + 0.4 * s);
    OB.mesh(M.leaves, new THREE.IcosahedronGeometry(1.1 * s, 1), x - 0.7 * s, 3.3 * s, z - 0.5 * s);
  }
  // Yard trees, kept clear of the house and the neighbor's walking routes.
  let planted = 0;
  for (let tries = 0; tries < 60 && planted < 4; tries++) {
    const x = rng.range(Y.x0 + 1.2, Y.x1 - 1.2);
    const z = rng.range(Y.z0 + 1.2, Y.z1 - 1.5);
    if (x > HX0 - 2 && x < HX1 + 2 && z > HZ0 - 2 && z < HZ1 + 3) continue;
    if (Math.abs(x) < 2.5 && z > -9) continue;
    if (navSegs[0].some((s) => segHitsRect(s, x - 1, z - 1, x + 1, z + 1))) continue;
    tree(x, z, rng.range(0.9, 1.2));
    planted++;
  }
  tree(-9, 9.5);
  tree(9.5, 8.5, 1.1);
  for (let x = -36; x <= 36; x += 9) {
    tree(x + 2, -37, 1.3);
    tree(x - 1, 27, 1.2);
  }
  for (let z = -30; z <= 22; z += 9) {
    tree(-36, z, 1.2);
    tree(36, z + 3, 1.3);
  }

  function house(cx, cz, w, d, wallMat, rMat, facing) {
    osolid(wallMat, cx - w / 2, 0, cz - d / 2, cx + w / 2, 5.5, cz + d / 2);
    const hs = d / 2 + 0.5;
    const rise = 2.4;
    const ang = Math.atan2(rise, hs);
    const len = Math.hypot(rise, hs) + 0.1;
    OB.mesh(rMat, new THREE.BoxGeometry(w + 0.8, 0.18, len), cx, 5.5 + rise / 2, cz + hs / 2, ang, 0, 0);
    OB.mesh(rMat, new THREE.BoxGeometry(w + 0.8, 0.18, len), cx, 5.5 + rise / 2, cz - hs / 2, -ang, 0, 0);
    const peak = 5.5 + (rise * (d / 2)) / hs;
    OB.add(wallMat, prismX(cx - w / 2, cx - w / 2 + 0.1, [[cz - d / 2, 5.5], [cz + d / 2, 5.5], [cz, peak]]));
    OB.add(wallMat, prismX(cx + w / 2 - 0.1, cx + w / 2, [[cz - d / 2, 5.5], [cz + d / 2, 5.5], [cz, peak]]));
    const fz = cz + (d / 2 + 0.02) * facing;
    const [dz0, dz1] = facing > 0 ? [fz - 0.04, fz + 0.02] : [fz - 0.02, fz + 0.04];
    odeco(M.door, cx - 0.55, 0, dz0, cx + 0.55, 2.2, dz1);
    for (const ox of [-w / 4, w / 4]) {
      odeco(M.darkGlass, cx + ox - 0.9, 1.2, dz0, cx + ox + 0.9, 2.5, dz1);
      odeco(M.darkGlass, cx + ox - 0.9, 3.4, dz0, cx + ox + 0.9, 4.7, dz1);
    }
  }
  const sideX = Math.max(27, Y.x1 + 8);
  house(-sideX, -17, 12, 10, M.sidingBlue, M.roofGrey, 1);
  house(sideX, -17, 12, 10, M.sidingWhite, M.roof, 1);
  house(-25, 17, 12, 9, M.sidingWhite, M.roofGrey, -1);
  house(25, 17, 12, 9, M.sidingBlue, M.roof, -1);

  physics.add(-40, 0, -42, -38, 10, 32);
  physics.add(38, 0, -42, 40, 10, 32);
  physics.add(-40, 0, -42, 40, 10, -40);
  physics.add(-40, 0, 30, 40, 10, 32);
  odeco(M.hedge, -38.5, 0, -40.5, 38.5, 2, -39.5);
  odeco(M.hedge, -38.5, 0, 29.5, 38.5, 2, 30.5);
  odeco(M.hedge, -38.5, 0, -40.5, -37.5, 2, 30.5);
  odeco(M.hedge, 37.5, 0, -40.5, 38.5, 2, 30.5);
  staticMeshes.push(...OB.build(scene));

  // =================================================================
  // Lights
  // =================================================================
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x8a8272, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
  sun.position.set(22, 38, 14);
  sun.target.position.set(0, 0, -12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -30;
  sc.right = 30;
  sc.top = 30;
  sc.bottom = -30;
  sc.near = 5;
  sc.far = 110;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // Windows: every pane / glazing bar shares one instanced draw call.
  const unit = new THREE.Matrix4();
  const panes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 0.02), M.glass, windows.length);
  const barsV = new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 1, 0.04), M.trim, windows.length);
  const barsH = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.04, 0.04), M.trim, windows.length);
  panes.renderOrder = 2;
  const q = new THREE.Quaternion();
  const s3 = new THREE.Vector3();
  for (const w of windows) {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), w.axis === 'z' ? Math.PI / 2 : 0);
    panes.setMatrixAt(w.index, unit.compose(w.center, q, s3.set(w.w, w.h, 1)));
    barsV.setMatrixAt(w.index, unit.compose(w.center, q, s3.set(1, w.h, 1)));
    barsH.setMatrixAt(w.index, unit.compose(w.center, q, s3.set(w.w, 1, 1)));
    w.hide = () => {
      unit.makeScale(0, 0, 0);
      for (const im of [panes, barsV, barsH]) {
        im.setMatrixAt(w.index, unit);
        im.instanceMatrix.needsUpdate = true;
      }
    };
  }
  for (const im of [panes, barsV, barsH]) {
    im.frustumCulled = false;
    scene.add(im);
  }

  // Room lights: a small pool of point lights follows the camera and takes
  // on the nearest lamps (each light multiplies the cost of every pixel).
  const slots = [];
  let assignTimer = 0;
  function setLightSlots(n) {
    while (slots.length > n) scene.remove(slots.pop());
    while (slots.length < n) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.6);
      l.userData.lamp = null;
      scene.add(l);
      slots.push(l);
    }
    assignTimer = 0;
  }
  let flickerValue = 10;
  const ranked = lamps.slice();
  function updateLights(dt, cam) {
    assignTimer -= dt;
    if (assignTimer <= 0) {
      assignTimer = 0.2;
      const score = (l) => (l.pos.x - cam.x) ** 2 + (l.pos.z - cam.z) ** 2 + ((l.pos.y - cam.y) * 4) ** 2;
      ranked.sort((a, b) => score(a) - score(b));
      slots.forEach((slot, i) => {
        const lamp = ranked[i];
        slot.userData.lamp = lamp;
        slot.position.copy(lamp.pos);
        slot.color.setHex(lamp.color);
        slot.distance = lamp.distance;
        slot.decay = lamp.decay;
      });
    }
    const inside = cam.y < 0 || (cam.x > HX0 - 0.3 && cam.x < HX1 + 0.3 && cam.z > HZ0 - 0.3 && cam.z < HZ1 + 0.3);
    for (const slot of slots) {
      const lamp = slot.userData.lamp;
      slot.intensity = !inside || !lamp ? 0 : lamp.flicker ? flickerValue : lamp.intensity;
    }
  }

  // Nav graph for the neighbor, with plan doors swapped for the real door objects.
  const navData = {
    ...plan.nav,
    edges: plan.nav.edges.map((e) => ({ ...e, door: e.door ? doorByPlanId.get(e.door.id) : null })),
  };

  let staticTimer = 0;
  let flickerTimer = 0;
  function update(dt, cam) {
    for (const d of doors) d.update(dt);
    for (const c of containers) c.update(dt);
    staticTimer -= dt;
    if (staticTimer <= 0 && cam && (cam.y < 0.6 || appliances.some((a) => a.on && a.kind === 'tv'))) {
      T.updateStatic();
      staticTimer = 0.07;
    }
    flickerTimer -= dt;
    if (flickerTimer <= 0) {
      flickerValue = Math.random() < 0.15 ? 0.6 : 8 + Math.random() * 4;
      flickerTimer = 0.05 + Math.random() * 0.12;
    }
    if (cam) updateLights(dt, cam);
    const glow = 0.35 + 0.3 * Math.sin(performance.now() * 0.004);
    for (const it of items) {
      const gm = it.key && it.mesh.userData.glowMesh;
      if (gm) gm.material.emissiveIntensity = glow;
    }
  }

  return {
    plan,
    textures: T,
    materials: M,
    doors,
    windows,
    items,
    containers,
    hideSpots,
    appliances,
    staticMeshes,
    dynamicMeshes,
    sun,
    navData,
    yard: plan.yard,
    basement: plan.basement,
    house: { x0: HX0, x1: HX1, z0: HZ0, z1: HZ1 },
    textureList: Object.values(T).filter((t) => t && t.isTexture),
    setLightSlots,
    update,
    doorById: (id) => doors.find((d) => d.id === id),
  };
}
