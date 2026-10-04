import * as THREE from 'three';

/*
 * Waypoint graph the neighbor walks along, generated with the house (see
 * housegen.js). Edges are straight lines through the middle of doorways;
 * stairs are just an edge whose ends are on different floors. Edges through
 * a boarded-up door are skipped until the boards come off.
 */

// Doors open, and he just kicks boxes out of the way.
const walkFilter = (c) => c.kind !== 'door' && c.kind !== 'box';
const a = new THREE.Vector3();
const b = new THREE.Vector3();

export class Nav {
  constructor(physics, data) {
    this.physics = physics;
    this.nodes = new Map();
    this.edges = data.edges;
    for (const n of data.nodes) this.nodes.set(n.id, { id: n.id, pos: new THREE.Vector3(n.x, n.y, n.z), links: [] });
    for (const e of data.edges) {
      this.nodes.get(e.a).links.push({ to: e.b, door: e.door });
      this.nodes.get(e.b).links.push({ to: e.a, door: e.door });
    }
  }

  pos(id) {
    return this.nodes.get(id).pos;
  }

  has(id) {
    return this.nodes.has(id);
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

  /** Like clear(), but for a body `r` wide: also checks two parallel lines either side. */
  clearWide(p, q, r = 0.34) {
    if (!this.clear(p, q)) return false;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const ox = (-dz / len) * r;
    const oz = (dx / len) * r;
    for (const s of [-1, 1]) {
      if (!this.clear({ x: p.x + ox * s, y: p.y, z: p.z + oz * s }, { x: q.x + ox * s, y: q.y, z: q.z + oz * s })) return false;
    }
    return true;
  }

  /** Nearest waypoint on the same floor with a body-wide straight approach to p. */
  approachTo(p, maxDist = 9) {
    let best = null;
    let bestD = maxDist * maxDist;
    for (const n of this.nodes.values()) {
      if (Math.abs(n.pos.y - p.y) > 0.8) continue;
      const d = n.pos.distanceToSquared(p);
      if (d < bestD && this.clearWide(n.pos, p)) {
        best = n.id;
        bestD = d;
      }
    }
    return best;
  }

  nearest(p, requireClear = true) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (Math.abs(n.pos.y - p.y) > 1.4) continue;
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

  /** Dijkstra over the graph; returns node ids from `from` to `to`, or null. */
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
      for (const { to: nid, door } of cn.links) {
        if (door && door.boarded) continue;
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

  /**
   * When `target` can't be reached (behind a boarded-up door): the route to the
   * reachable waypoint closest to it, so he at least gets as near as he can.
   */
  pathToward(from, target) {
    const seen = new Set([from]);
    const queue = [from];
    let best = from;
    let bestD = Infinity;
    while (queue.length) {
      const id = queue.shift();
      const p = this.nodes.get(id).pos;
      // Being on the right floor matters more than being close through a ceiling.
      const d = Math.hypot(p.x - target.x, p.z - target.z) + Math.abs(p.y - target.y) * 3;
      if (d < bestD) {
        best = id;
        bestD = d;
      }
      for (const { to, door } of this.nodes.get(id).links) {
        if ((door && door.boarded) || seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    return this.path(from, best);
  }

  /** Lists edges whose straight line is blocked by level geometry (dev check). */
  validate() {
    const bad = [];
    for (const e of this.edges) {
      const P = this.pos(e.a);
      const Q = this.pos(e.b);
      if (Math.abs(P.y - Q.y) > 1) continue; // stairs
      if (!this.clear(P, Q)) bad.push(`${e.a} -> ${e.b}`);
    }
    return bad;
  }
}
