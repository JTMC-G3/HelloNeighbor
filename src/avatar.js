import * as THREE from 'three';
import { bakeChildren } from './quality.js';

/*
 * Other players in a multiplayer game: a blocky kid with a name tag (or, for
 * whoever plays the neighbor, nothing here; the neighbor model stands in).
 * Positions arrive ~15 times a second and are smoothed in between.
 */

export const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ff6fb5'];

// Flag bits in a player's network state.
// vr: playing in a headset (their state also carries hand positions); leftHand: holding in the left hand.
export const F = { crouch: 1, moving: 2, sprint: 4, light: 8, caught: 16, hidden: 32, hiding: 64, stunned: 128, vr: 256, leftHand: 512 };

function buildKid(color) {
  const root = new THREE.Group();
  const std = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
  const shirt = std(color);
  const cap = std(new THREE.Color(color).multiplyScalar(0.6));
  const skin = std(0xf0c8a0);
  const jeans = std(0x34466e);
  const shoes = std(0xeeeeee);
  const add = (parent, geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const body = new THREE.Group();
  root.add(body);
  const legs = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(0.09 * sx, 0.78, 0);
    add(hip, new THREE.BoxGeometry(0.15, 0.72, 0.17), jeans, 0, -0.36, 0);
    add(hip, new THREE.BoxGeometry(0.16, 0.08, 0.26), shoes, 0, -0.74, 0.04);
    body.add(hip);
    legs.push(hip);
  }
  const torso = new THREE.Group();
  torso.position.y = 0.78;
  body.add(torso);
  add(torso, new THREE.BoxGeometry(0.4, 0.52, 0.24), shirt, 0, 0.26, 0);
  const arms = [];
  for (const sx of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(0.26 * sx, 0.48, 0);
    add(sh, new THREE.BoxGeometry(0.12, 0.3, 0.13), shirt, 0, -0.13, 0);
    add(sh, new THREE.BoxGeometry(0.1, 0.24, 0.11), skin, 0, -0.4, 0);
    torso.add(sh);
    arms.push(sh);
  }
  const head = new THREE.Group();
  head.position.y = 0.56;
  torso.add(head);
  add(head, new THREE.BoxGeometry(0.28, 0.3, 0.28), skin, 0, 0.16, 0);
  add(head, new THREE.BoxGeometry(0.3, 0.1, 0.3), cap, 0, 0.33, 0);
  add(head, new THREE.BoxGeometry(0.26, 0.03, 0.16), cap, 0, 0.29, 0.2);
  for (const sx of [-1, 1]) add(head, new THREE.BoxGeometry(0.04, 0.04, 0.02), std(0x222222), 0.07 * sx, 0.18, 0.14);
  for (const j of [...legs, ...arms, torso, head]) bakeChildren(j);
  // Where a held item sits (`hand`; `hands` has one per arm, for VR players).
  const hands = arms.map((arm) => {
    const h = new THREE.Group();
    h.position.set(0, -0.55, 0.08);
    arm.add(h);
    return h;
  });
  return { root, body, legs, arms, torso, head, hand: hands[1], hands };
}

function drawTag(c, text, color) {
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = 'bold 30px Trebuchet MS, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = Math.min(250, ctx.measureText(text).width + 28);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(128 - w / 2, 10, w, 44, 22);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 33, 240);
}

function nameTag(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  drawTag(c, text, color);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(0.8, 0.2, 1);
  s.userData.setText = (t) => {
    drawTag(c, t, color);
    tex.needsUpdate = true;
  };
  return s;
}

const lerpAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export class Peer {
  constructor(game, info) {
    this.game = game;
    this.id = info.id;
    this.name = info.name;
    this.color = info.color;
    this.role = info.role || 'kid';
    this.ch = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), radius: 0.3, height: 1.7 };
    this.target = new THREE.Vector3();
    this.yaw = 0;
    this.targetYaw = 0;
    this.pitch = 0;
    this.flags = 0;
    this.spot = -1;
    this.hidden = null;
    this.held = null;
    this.state = null; // last network state (host re-broadcasts it)
    this.speed = 0;
    this.phase = 0;
    this.stepAcc = 0;
    this.seenState = false;
    this.lastPos = new THREE.Vector3();
    // VR players: where their hands are (relative to their body), and smoothed.
    this.handsTarget = null;
    this.handsNow = null;
    this.vrTagged = false;
    this.tmp = new THREE.Vector3();
    if (this.role === 'kid') {
      this.model = buildKid(info.color);
      this.tag = nameTag(info.name, info.color);
      this.tag.position.y = 1.95;
      this.model.root.add(this.tag);
      this.model.root.visible = false;
      game.scene.add(this.model.root);
    }
  }

  get pos() {
    return this.ch.pos;
  }

  get crouching() {
    return !!(this.flags & F.crouch);
  }

  get sprinting() {
    return !!(this.flags & F.sprint);
  }

  get caughtAnim() {
    return !!(this.flags & F.caught);
  }

  get stunned() {
    return !!(this.flags & F.stunned);
  }

  get inVR() {
    return !!(this.flags & F.vr);
  }

  eye(out = new THREE.Vector3()) {
    return out.set(this.ch.pos.x, this.ch.pos.y + (this.crouching ? 0.95 : 1.6), this.ch.pos.z);
  }

  /** [x, y, z, yaw, pitch, flags, spot] (+ VR: [lx, ly, lz, rx, ry, rz] hands) */
  setState(s) {
    const [x, y, z, yaw, pitch, flags, spot] = s;
    this.target.set(x, y, z);
    this.targetYaw = yaw;
    this.pitch = pitch;
    this.flags = flags;
    this.spot = spot;
    this.hidden = spot >= 0 && flags & F.hidden ? this.game.world.hideSpots[spot] || null : null;
    this.ch.height = this.crouching ? 1.05 : 1.7;
    this.handsTarget = s.length >= 13 ? s.slice(7, 13).map(Number) : null;
    if (!this.handsTarget) this.handsNow = null;
    else if (!this.handsNow) this.handsNow = [...this.handsTarget];
    if (!this.seenState || this.ch.pos.distanceTo(this.target) > 4) {
      // First update, or teleported (respawned): jump straight there.
      this.ch.pos.copy(this.target);
      this.yaw = yaw;
    }
    this.seenState = true;
    this.state = s;
  }

  update(dt) {
    if (!this.seenState) return;
    const k = Math.min(1, dt * 12);
    this.lastPos.copy(this.ch.pos);
    this.ch.pos.lerp(this.target, k);
    this.yaw = lerpAngle(this.yaw, this.targetYaw, k);
    const moved = Math.hypot(this.ch.pos.x - this.lastPos.x, this.ch.pos.z - this.lastPos.z);
    this.speed += ((dt > 0 ? moved / dt : 0) - this.speed) * Math.min(1, dt * 8);
    this.ch.vel.set((this.ch.pos.x - this.lastPos.x) / (dt || 1), 0, (this.ch.pos.z - this.lastPos.z) / (dt || 1));
    if (!this.model) return;

    const m = this.model;
    m.root.visible = !(this.flags & F.hidden);
    m.root.position.copy(this.ch.pos);
    m.root.rotation.y = this.yaw + Math.PI;
    const sp = this.speed;
    this.phase += dt * (sp > 0.3 ? 3 + sp * 1.6 : 0);
    const swing = Math.min(1, sp / 3) * (this.sprinting ? 0.9 : 0.6);
    const s = Math.sin(this.phase);
    m.legs[0].rotation.x = s * swing;
    m.legs[1].rotation.x = -s * swing;
    m.arms[0].rotation.set(-s * swing, 0, 0);
    m.arms[1].rotation.set(this.held ? -0.9 : s * swing, 0, 0);
    m.head.rotation.x = -this.pitch * 0.6;
    // Crouching: knees bent, body lowered.
    const crouch = this.crouching ? 1 : 0;
    m.body.position.y = -0.32 * crouch;
    m.torso.rotation.x = 0.35 * crouch;
    if (crouch) {
      m.legs[0].rotation.x -= 0.9;
      m.legs[1].rotation.x -= 0.9;
    }
    if (this.caughtAnim) {
      // Wriggling in his grip.
      m.arms[0].rotation.x = -2.6 + Math.sin(performance.now() * 0.03) * 0.4;
      m.arms[1].rotation.x = -2.6 - Math.sin(performance.now() * 0.03) * 0.4;
    }
    this.tag.visible = !this.caughtAnim;
    if (this.inVR !== this.vrTagged) {
      this.vrTagged = this.inVR;
      this.tag.userData.setText(this.inVR ? `${this.name} · VR` : this.name);
    }
    if (this.handsNow && !this.caughtAnim) this.reachArms(dt);

    // Footsteps you can hear (running is loudest; crouch-walking is silent).
    if (sp > 0.8 && !this.crouching && Math.abs(this.ch.pos.y - this.lastPos.y) < 0.2) {
      this.stepAcc += sp * dt;
      if (this.stepAcc > (this.sprinting ? 2.1 : 1.7)) {
        this.stepAcc = 0;
        this.game.sound.stepAt(this.ch.pos, this.sprinting);
      }
    }
  }

  /**
   * VR players: point the arms at where their real hands are. (The model faces
   * +z, so its right arm, arms[0], is on the -x side.)
   */
  reachArms(dt) {
    const m = this.model;
    const k = Math.min(1, dt * 15);
    for (let i = 0; i < 6; i++) this.handsNow[i] += (this.handsTarget[i] - this.handsNow[i]) * k;
    m.root.updateMatrixWorld(true);
    for (const [side, arm] of [[0, m.arms[1]], [1, m.arms[0]]]) {
      const h = this.handsNow;
      const v = this.tmp.set(h[side * 3], h[side * 3 + 1], h[side * 3 + 2]).applyAxisAngle(UP, this.yaw).add(this.ch.pos);
      m.torso.worldToLocal(v).sub(arm.position);
      if (v.lengthSq() < 1e-4) continue;
      arm.quaternion.setFromUnitVectors(DOWN, v.normalize());
    }
    // Whatever they're holding goes in the hand they're holding it with.
    if (this.held) {
      const hand = m.hands[this.flags & F.leftHand ? 1 : 0];
      if (this.held.mesh.parent !== hand) hand.add(this.held.mesh);
    }
  }

  /** Show an item in this player's hand. */
  attachItem(it) {
    this.held = it;
    if (!this.model) {
      it.mesh.visible = false;
      return;
    }
    it.mesh.visible = true;
    this.model.hands[this.inVR && !(this.flags & F.leftHand) ? 0 : 1].add(it.mesh);
    it.mesh.position.set(0, 0, 0.05);
    it.mesh.rotation.set(0, 0, 0);
    it.mesh.scale.setScalar(it.radius > 0.2 ? 0.6 : 1);
  }

  detachItem(it) {
    if (this.held === it) this.held = null;
    this.game.scene.add(it.mesh);
    it.mesh.visible = true;
    it.mesh.scale.setScalar(1);
  }

  dispose() {
    if (this.held) this.detachItem(this.held);
    if (this.model) this.game.scene.remove(this.model.root);
  }
}

/**
 * Versus: what the neighbor player heard. A see-through silhouette where a kid
 * was last heard (drawn over walls; it stays until you hear that kid again or
 * catch them), or a pulsing ring and light beam for other noises (things
 * landing, glass, a TV left on). Anything behind you or off-screen gets an
 * arrow at the edge of the screen.
 */
const RING_LIFE = 8;
const RING_COLOR = '#ffd23f';

export class HeardMarks {
  constructor(game) {
    this.game = game;
    this.kids = new Map(); // player id -> mark
    this.rings = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);
    this.ringGeo = new THREE.RingGeometry(0.7, 1, 40);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.beamGeo = new THREE.CylinderGeometry(0.07, 0.07, 7, 8, 1, true);
    this.beamGeo.translate(0, 3.5, 0);
    this.canvas = document.getElementById('heardCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.canvas.classList.remove('hidden');
    this.v = new THREE.Vector3();
    this.drawn = false;
    this.beacons = new Map(); // key -> mark that stays until moved or hidden
  }

  /**
   * A mark that stays put until moved or hidden (`pos` null): a see-through
   * figure (`figure: true`) or a light beam with a ring, plus a label. Used
   * for the neighbor's chore spot, and for kids seeing a neighbor who's
   * skipping his chores.
   */
  setBeacon(key, pos, { color = '#4cd964', label = '', figure = false } = {}) {
    let b = this.beacons.get(key);
    if (!pos) {
      if (b) b.root.visible = false;
      return;
    }
    if (!b) {
      const root = new THREE.Group();
      const mat = this.overlay(color, 0.7);
      if (figure) {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 1.35, 12), mat);
        body.position.y = 0.9;
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), mat);
        head.position.y = 1.8;
        root.add(body, head);
      } else {
        const ring = new THREE.Mesh(this.ringGeo, mat);
        ring.scale.setScalar(0.8);
        ring.position.y = 0.05;
        root.add(ring);
      }
      root.add(new THREE.Mesh(this.beamGeo, this.overlay(color, 0.35)));
      if (label) {
        const tag = nameTag(label, color);
        tag.material.depthTest = false;
        tag.position.y = figure ? 2.3 : 1.6;
        root.add(tag);
      }
      root.traverse((o) => { o.renderOrder = 991; });
      this.group.add(root);
      b = { root, mat, color, label, t: 0 };
      this.beacons.set(key, b);
    }
    b.root.position.copy(pos);
    b.root.visible = true;
  }

  overlay(color, opacity) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
  }

  kidMark(id) {
    let m = this.kids.get(id);
    if (m) return m;
    const info = this.game.mp.roster.get(id);
    const color = info ? info.color : '#ffcc00';
    const mat = this.overlay(color, 0.75);
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 1.1, 12), mat);
    body.position.y = 0.72;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), mat);
    head.position.y = 1.47;
    const beam = new THREE.Mesh(this.beamGeo, this.overlay(color, 0.3));
    root.add(body, head, beam);
    const name = info ? info.name : 'Someone';
    const tag = nameTag(`${name}?`, color);
    tag.material.depthTest = false;
    tag.position.y = 1.95;
    root.add(tag);
    root.traverse((o) => { o.renderOrder = 990; });
    this.group.add(root);
    m = { id, root, mat, tag, name, color, t: 0, shown: -1 };
    this.kids.set(id, m);
    return m;
  }

  /** { p: noise position, r: how far it carried, id: kid id or -1, at: where the kid was } */
  show(msg) {
    if (msg.id >= 0 && Array.isArray(msg.at)) {
      const m = this.kidMark(msg.id);
      m.root.position.set(msg.at[0], msg.at[1], msg.at[2]);
      m.root.visible = true;
      m.t = 0;
      m.shown = -1;
      return;
    }
    if (!Array.isArray(msg.p)) return;
    const ring = this.rings.find((r) => !r.root.visible) || this.addRing();
    ring.root.position.set(msg.p[0], msg.p[1] + 0.05, msg.p[2]);
    ring.root.visible = true;
    ring.t = 0;
  }

  addRing() {
    const root = new THREE.Group();
    const mat = this.overlay(RING_COLOR, 1);
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    const inner = new THREE.Mesh(this.ringGeo, mat);
    const beamMat = this.overlay(RING_COLOR, 0.45);
    const beam = new THREE.Mesh(this.beamGeo, beamMat);
    root.add(mesh, inner, beam);
    root.traverse((o) => { o.renderOrder = 989; });
    this.group.add(root);
    const ring = { root, mesh, inner, mat, beamMat, t: 0 };
    this.rings.push(ring);
    return ring;
  }

  update(dt) {
    const peers = this.game.mp.peers;
    for (const m of this.kids.values()) {
      if (!m.root.visible) continue;
      // Gone for good once they're caught (they wake up back on the street) or leave.
      const peer = peers.get(m.id);
      if (!peer || peer.caughtAnim) {
        m.root.visible = false;
        continue;
      }
      m.t += dt;
      m.mat.opacity = 0.75 + 0.2 * Math.sin(m.t * 5);
      const secs = Math.floor(m.t);
      if (secs !== m.shown) {
        m.shown = secs;
        m.tag.userData.setText(secs < 1 ? `${m.name}?` : `${m.name}? · ${secs}s`);
      }
    }
    for (const b of this.beacons.values()) {
      if (!b.root.visible) continue;
      b.t += dt;
      b.mat.opacity = 0.6 + 0.25 * Math.sin(b.t * 4);
    }
    for (const r of this.rings) {
      if (!r.root.visible) continue;
      r.t += dt;
      if (r.t > RING_LIFE) {
        r.root.visible = false;
        continue;
      }
      // Two rings rippling outwards, over and over; everything fades in the last second.
      const fade = Math.min(1, RING_LIFE - r.t);
      const a = (r.t % 1.2) / 1.2;
      const b = ((r.t + 0.6) % 1.2) / 1.2;
      r.mesh.scale.setScalar(0.3 + a * 1.9);
      r.inner.scale.setScalar(0.3 + b * 1.9);
      r.mat.opacity = fade * 0.95;
      r.beamMat.opacity = fade * (0.35 + 0.15 * Math.sin(r.t * 6));
    }
    this.drawArrows();
  }

  /** Arrows at the edge of the screen for anything behind you or off to the side. */
  drawArrows() {
    const c = this.canvas;
    if (c.width !== window.innerWidth || c.height !== window.innerHeight) {
      c.width = window.innerWidth;
      c.height = window.innerHeight;
    }
    const ctx = this.ctx;
    const W = c.width;
    const H = c.height;
    if (this.drawn) ctx.clearRect(0, 0, W, H);
    this.drawn = false;
    const cam = this.game.camera;
    const marks = [];
    for (const m of this.kids.values()) if (m.root.visible) marks.push({ pos: m.root.position, y: 1.2, color: m.color, label: m.name });
    for (const r of this.rings) if (r.root.visible) marks.push({ pos: r.root.position, y: 0.5, color: RING_COLOR, label: '' });
    for (const b of this.beacons.values()) if (b.root.visible) marks.push({ pos: b.root.position, y: 1, color: b.color, label: b.label });
    if (!marks.length) return;
    const margin = 36;
    for (const mk of marks) {
      const v = this.v.set(mk.pos.x, mk.pos.y + mk.y, mk.pos.z).project(cam);
      const behind = v.z > 1;
      const onScreen = !behind && Math.abs(v.x) < 0.92 && Math.abs(v.y) < 0.9;
      if (onScreen) continue;
      // Direction on screen (flipped if it's behind you), pushed out to the edge.
      let x = behind ? -v.x : v.x;
      let y = behind ? -v.y : v.y;
      if (behind && Math.abs(x) < 0.01 && Math.abs(y) < 0.01) y = -1;
      const k = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.85, 1e-6);
      x *= k;
      y *= k;
      const sx = THREE.MathUtils.clamp((x * 0.5 + 0.5) * W, margin, W - margin);
      const sy = THREE.MathUtils.clamp((-y * 0.5 + 0.5) * H, margin, H - margin);
      const ang = Math.atan2(sy - H / 2, sx - W / 2);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      ctx.fillStyle = mk.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(16, 0);
      ctx.lineTo(-10, -12);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-10, 12);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.restore();
      if (mk.label) {
        ctx.font = 'bold 13px Trebuchet MS, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = mk.color;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 3;
        const lx = sx - Math.cos(ang) * 30;
        const ly = sy - Math.sin(ang) * 30 + 4;
        ctx.strokeText(mk.label, lx, ly);
        ctx.fillText(mk.label, lx, ly);
      }
      this.drawn = true;
    }
  }
}
