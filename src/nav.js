import * as THREE from 'three';

/*
 * Hand-placed waypoint graph the neighbor walks along. Edges are straight
 * lines that avoid furniture and pass through the middle of doorways; stairs
 * are just an edge whose ends are on different floors.
 */
const NODES = {
  // outside (y = 0)
  street: [0, 0, -1],
  gate: [0, 0, -6.8],
  frontOut: [0, 0, -8.3],
  ySW: [-11, 0, -8],
  yW: [-11, 0, -16],
  yNW: [-11, 0, -25],
  backOut: [-6.5, 0, -23.8],
  yN: [0, 0, -26],
  yNE: [11, 0, -25],
  yE: [11, 0, -16],
  ySE: [11, 0, -8],
  // ground floor (y = 0.3)
  frontDoor: [0, 0.3, -10],
  hFront: [0, 0.3, -11.3],
  hMid: [0.8, 0.3, -16],
  hNorth: [0.6, 0.3, -20.7],
  hBase: [-1.3, 0.3, -20.3],
  stairBot: [-1.4, 0.3, -12.3],
  lDoor: [-2, 0.3, -11.2],
  lIn: [-3.3, 0.3, -11.2],
  lCenter: [-4.2, 0.3, -13.5],
  kArch: [-4.5, 0.3, -16],
  kCenter: [-4, 0.3, -18.3],
  kIn: [-3.3, 0.3, -20.7],
  kDoor: [-2, 0.3, -20.7],
  kBack: [-6.5, 0.3, -21.2],
  backDoor: [-6.5, 0.3, -22],
  sDoor: [2, 0.3, -11.2],
  sIn: [3.3, 0.3, -11.2],
  sCenter: [5, 0.3, -13],
  tArch: [5, 0.3, -16],
  tCenter: [5, 0.3, -19],
  tIn: [3.3, 0.3, -20.7],
  tDoor: [2, 0.3, -20.7],
  // upstairs (y = 3.5)
  stairTop: [-1.4, 3.5, -19.6],
  uHall: [0.6, 3.5, -20.9],
  uSouth: [0.6, 3.5, -11.5],
  uwDoor: [-2, 3.5, -20.9],
  uwIn: [-3.3, 3.5, -20.9],
  uwCenter: [-5, 3.5, -16],
  ubDoor: [2, 3.5, -20.9],
  ubIn: [3.3, 3.5, -20.9],
  ubCenter: [5, 3.5, -16.5],
};

const EDGES = [
  ['street', 'gate'], ['gate', 'frontOut'], ['gate', 'ySW'], ['gate', 'ySE'],
  ['ySW', 'yW'], ['yW', 'yNW'], ['yNW', 'backOut'], ['backOut', 'yN'], ['yN', 'yNE'],
  ['yNE', 'yE'], ['yE', 'ySE'],
  ['frontOut', 'frontDoor'], ['frontDoor', 'hFront'],
  ['hFront', 'hMid'], ['hMid', 'hNorth'], ['hNorth', 'hBase'], ['hFront', 'stairBot'],
  ['hFront', 'lDoor'], ['lDoor', 'lIn'], ['lIn', 'lCenter'], ['lCenter', 'kArch'], ['kArch', 'kCenter'],
  ['kCenter', 'kIn'], ['kIn', 'kDoor'], ['kDoor', 'hNorth'], ['kCenter', 'kBack'], ['kBack', 'backDoor'],
  ['backDoor', 'backOut'],
  ['hFront', 'sDoor'], ['sDoor', 'sIn'], ['sIn', 'sCenter'], ['sCenter', 'tArch'], ['tArch', 'tCenter'],
  ['tCenter', 'tIn'], ['tIn', 'tDoor'], ['tDoor', 'hNorth'],
  ['stairBot', 'stairTop'],
  ['stairTop', 'uHall'], ['stairTop', 'uwDoor'], ['uHall', 'uSouth'], ['uHall', 'uwDoor'], ['uwDoor', 'uwIn'],
  ['uwIn', 'uwCenter'], ['uHall', 'ubDoor'], ['ubDoor', 'ubIn'], ['ubIn', 'ubCenter'],
];

const walkFilter = (c) => c.kind !== 'door';
const a = new THREE.Vector3();
const b = new THREE.Vector3();

export class Nav {
  constructor(physics) {
    this.physics = physics;
    this.nodes = new Map();
    for (const [id, [x, y, z]] of Object.entries(NODES)) {
      this.nodes.set(id, { id, pos: new THREE.Vector3(x, y, z), links: [] });
    }
    for (const [p, q] of EDGES) {
      this.nodes.get(p).links.push(q);
      this.nodes.get(q).links.push(p);
    }
  }

  pos(id) {
    return this.nodes.get(id).pos;
  }

  /** Can a character walk in a straight line from p to q (ignoring doors, which open)? */
  clear(p, q) {
    for (const h of [0.55, 1.4]) {
      a.set(p.x, p.y + h, p.z);
      b.set(q.x, q.y + h, q.z);
      if (this.physics.segmentBlocked(a, b, walkFilter)) return false;
    }
    return true;
  }

  nearest(p, requireClear = true) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      const dy = Math.abs(n.pos.y - p.y);
      if (dy > 1.4) continue;
      const d = n.pos.distanceToSquared(p);
      if (d < bestD && (!requireClear || this.clear(p, n.pos))) {
        best = n;
        bestD = d;
      }
    }
    if (best) return best.id;
    if (requireClear) return this.nearest(p, false) || this.nearestAny(p);
    return null;
  }

  nearestAny(p) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      const d = n.pos.distanceToSquared(p);
      if (d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best.id;
  }

  /** Dijkstra over the (tiny) graph; returns node ids from `from` to `to`. */
  path(from, to) {
    if (from === to) return [from];
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const open = new Set([from]);
    while (open.size) {
      let cur = null;
      let cd = Infinity;
      for (const id of open) {
        if (dist.get(id) < cd) {
          cd = dist.get(id);
          cur = id;
        }
      }
      open.delete(cur);
      if (cur === to) break;
      const cn = this.nodes.get(cur);
      for (const nid of cn.links) {
        const nd = cd + cn.pos.distanceTo(this.nodes.get(nid).pos);
        if (nd < (dist.get(nid) ?? Infinity)) {
          dist.set(nid, nd);
          prev.set(nid, cur);
          open.add(nid);
        }
      }
    }
    if (!dist.has(to)) return null;
    const out = [to];
    let c = to;
    while (prev.has(c)) {
      c = prev.get(c);
      out.unshift(c);
    }
    return out;
  }

  /** Lists edges whose straight line is blocked by level geometry (dev check). */
  validate() {
    const bad = [];
    for (const [p, q] of EDGES) {
      const P = this.pos(p);
      const Q = this.pos(q);
      if (Math.abs(P.y - Q.y) > 1) continue; // stairs
      if (!this.clear(P, Q)) bad.push(`${p} -> ${q}`);
    }
    return bad;
  }
}
