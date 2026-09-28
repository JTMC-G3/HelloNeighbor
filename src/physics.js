import * as THREE from 'three';

export const GRAVITY = 20;

const tmp = new THREE.Vector3();

function circleRect(px, pz, r, c) {
  const cx = Math.max(c.min.x, Math.min(px, c.max.x));
  const cz = Math.max(c.min.z, Math.min(pz, c.max.z));
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz < r * r;
}

function segAABB(a, b, c) {
  let t0 = 0;
  let t1 = 1;
  for (const ax of ['x', 'y', 'z']) {
    const d = b[ax] - a[ax];
    if (Math.abs(d) < 1e-9) {
      if (a[ax] < c.min[ax] || a[ax] > c.max[ax]) return false;
    } else {
      let ta = (c.min[ax] - a[ax]) / d;
      let tb = (c.max[ax] - a[ax]) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
  }
  return true;
}

/**
 * Tiny axis-aligned-box physics world.
 *
 * Characters are vertical capsules approximated as a circle in XZ with a
 * height. Anything whose top is within `stepHeight` of the feet is walked
 * onto (stairs, sills, curbs); anything taller is a wall. Items are spheres.
 */
export class Physics {
  constructor() {
    this.colliders = [];
    this.holes = [];
  }

  add(x0, y0, z0, x1, y1, z1, kind = 'wall', ref = null) {
    const c = {
      min: new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      max: new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
      kind,
      ref,
      enabled: true,
    };
    this.colliders.push(c);
    return c;
  }

  /** Rectangles where the implicit y=0 ground plane does not exist. */
  addHole(x0, z0, x1, z1) {
    this.holes.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
  }

  terrainAt(x, z) {
    for (const h of this.holes) {
      if (x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1) return -Infinity;
    }
    return 0;
  }

  resolveHorizontal(ch, stepH) {
    const r = ch.radius;
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      if (c.max.y <= ch.pos.y + stepH) continue;
      if (c.min.y >= ch.pos.y + ch.height) continue;
      const px = ch.pos.x;
      const pz = ch.pos.z;
      if (px < c.min.x - r || px > c.max.x + r || pz < c.min.z - r || pz > c.max.z + r) continue;
      const cx = Math.max(c.min.x, Math.min(px, c.max.x));
      const cz = Math.max(c.min.z, Math.min(pz, c.max.z));
      const dx = px - cx;
      const dz = pz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        const push = (r - d) / d;
        ch.pos.x += dx * push;
        ch.pos.z += dz * push;
      } else {
        const left = px - c.min.x;
        const right = c.max.x - px;
        const back = pz - c.min.z;
        const front = c.max.z - pz;
        const m = Math.min(left, right, back, front);
        if (m === left) ch.pos.x = c.min.x - r;
        else if (m === right) ch.pos.x = c.max.x + r;
        else if (m === back) ch.pos.z = c.min.z - r;
        else ch.pos.z = c.max.z + r;
      }
    }
  }

  /** Is there solid overhead space blocking a character from growing to `height`? */
  blockedAbove(ch, height) {
    const r = ch.radius * 0.9;
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      if (c.min.y > ch.pos.y + ch.stepHeight && c.min.y < ch.pos.y + height && c.max.y > ch.pos.y + ch.stepHeight
        && circleRect(ch.pos.x, ch.pos.z, r, c)) return true;
    }
    return false;
  }

  moveCharacter(ch, dt) {
    const stepH = ch.stepHeight;
    const hs = Math.hypot(ch.vel.x, ch.vel.z) * dt;
    const n = Math.min(8, Math.max(1, Math.ceil(hs / 0.12)));
    for (let i = 0; i < n; i++) {
      ch.pos.x += (ch.vel.x * dt) / n;
      ch.pos.z += (ch.vel.z * dt) / n;
      this.resolveHorizontal(ch, stepH);
      this.resolveHorizontal(ch, stepH);
    }

    const prevY = ch.pos.y;
    ch.vel.y = Math.max(ch.vel.y - GRAVITY * dt, -30);
    ch.pos.y += ch.vel.y * dt;
    const r = ch.radius * 0.85;

    if (ch.vel.y > 0) {
      for (const c of this.colliders) {
        if (!c.enabled) continue;
        if (c.min.y > prevY + ch.height * 0.5 && c.min.y < ch.pos.y + ch.height && circleRect(ch.pos.x, ch.pos.z, r, c)) {
          ch.pos.y = c.min.y - ch.height;
          ch.vel.y = 0;
        }
      }
    }

    const limit = prevY + stepH;
    let ground = -Infinity;
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      if (c.max.y <= limit && c.max.y > ground && circleRect(ch.pos.x, ch.pos.z, r, c)) ground = c.max.y;
    }
    const t = this.terrainAt(ch.pos.x, ch.pos.z);
    if (t <= limit && t > ground) ground = t;

    ch.landingSpeed = 0;
    if (ch.pos.y <= ground) {
      if (!ch.onGround) ch.landingSpeed = -ch.vel.y;
      ch.pos.y = ground;
      ch.vel.y = 0;
      ch.onGround = true;
    } else if (ch.onGround && ch.vel.y <= 0 && prevY - ground <= stepH + 0.05) {
      // Stick to the floor when walking down stairs.
      ch.pos.y = ground;
      ch.vel.y = 0;
      ch.onGround = true;
    } else {
      ch.onGround = false;
    }
  }

  /** Highest walkable surface under (x, z) at or below y. */
  groundBelow(x, y, z) {
    let g = this.terrainAt(x, z);
    if (g > y) g = -Infinity;
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      if (c.max.y <= y && c.max.y > g && x >= c.min.x && x <= c.max.x && z >= c.min.z && z <= c.max.z) g = c.max.y;
    }
    return g;
  }

  segmentBlocked(a, b, filter) {
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      if (filter && !filter(c)) continue;
      if (segAABB(a, b, c)) return true;
    }
    return false;
  }

  /**
   * Integrates a sphere item. `onGlass(collider, speed)` may return true to let
   * the item pass through (the window broke). `onImpact(speed)` is called on
   * solid hits.
   */
  stepItem(it, dt, onGlass, onImpact) {
    it.vel.y = Math.max(it.vel.y - GRAVITY * dt, -30);
    const sp = it.vel.length();
    const n = Math.min(12, Math.max(1, Math.ceil((sp * dt) / (it.radius * 0.7))));
    const h = dt / n;
    const r = it.radius;
    let contact = false;
    let maxImpact = 0;

    for (let s = 0; s < n; s++) {
      it.pos.addScaledVector(it.vel, h);

      for (const c of this.colliders) {
        if (!c.enabled) continue;
        const p = it.pos;
        if (p.x < c.min.x - r || p.x > c.max.x + r || p.y < c.min.y - r || p.y > c.max.y + r
          || p.z < c.min.z - r || p.z > c.max.z + r) continue;
        tmp.set(
          Math.max(c.min.x, Math.min(p.x, c.max.x)),
          Math.max(c.min.y, Math.min(p.y, c.max.y)),
          Math.max(c.min.z, Math.min(p.z, c.max.z)),
        );
        tmp.subVectors(p, tmp);
        const d = tmp.length();
        if (d >= r) continue;
        if (c.kind === 'glass' && onGlass && onGlass(c, it.vel.length())) continue;
        if (d > 1e-6) {
          tmp.divideScalar(d);
          p.addScaledVector(tmp, r - d);
        } else {
          tmp.set(0, 1, 0);
          p.y = c.max.y + r;
        }
        const vn = it.vel.dot(tmp);
        if (vn < 0) {
          maxImpact = Math.max(maxImpact, -vn);
          it.vel.addScaledVector(tmp, -(1 + it.bounce) * vn);
          if (tmp.y > 0.5) {
            contact = true;
            it.vel.x *= 0.82;
            it.vel.z *= 0.82;
          }
        }
      }

      const t = this.terrainAt(it.pos.x, it.pos.z);
      if (it.pos.y - r < t && it.pos.y - r > t - 0.6) {
        it.pos.y = t + r;
        if (it.vel.y < 0) {
          maxImpact = Math.max(maxImpact, -it.vel.y);
          it.vel.y = -it.vel.y * it.bounce;
        }
        it.vel.x *= 0.82;
        it.vel.z *= 0.82;
        contact = true;
      }
    }

    if (maxImpact > 0 && onImpact) onImpact(maxImpact);
    return contact;
  }
}
