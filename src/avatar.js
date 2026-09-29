import * as THREE from 'three';
import { bakeChildren } from './quality.js';

/*
 * Other players in a multiplayer game: a blocky kid with a name tag (or, for
 * whoever plays the neighbor, nothing here; the neighbor model stands in).
 * Positions arrive ~15 times a second and are smoothed in between.
 */

export const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ff6fb5'];

// Flag bits in a player's network state.
export const F = { crouch: 1, moving: 2, sprint: 4, light: 8, caught: 16, hidden: 32, hiding: 64, stunned: 128 };

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
  // Where a held item sits (right hand).
  const hand = new THREE.Group();
  hand.position.set(0, -0.55, 0.08);
  arms[1].add(hand);
  return { root, body, legs, arms, torso, head, hand };
}

function nameTag(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(0.8, 0.2, 1);
  return s;
}

const lerpAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

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

  eye(out = new THREE.Vector3()) {
    return out.set(this.ch.pos.x, this.ch.pos.y + (this.crouching ? 0.95 : 1.6), this.ch.pos.z);
  }

  /** [x, y, z, yaw, pitch, flags, spot] */
  setState(s) {
    const [x, y, z, yaw, pitch, flags, spot] = s;
    this.target.set(x, y, z);
    this.targetYaw = yaw;
    this.pitch = pitch;
    this.flags = flags;
    this.spot = spot;
    this.hidden = spot >= 0 && flags & F.hidden ? this.game.world.hideSpots[spot] || null : null;
    this.ch.height = this.crouching ? 1.05 : 1.7;
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
    m.arms[0].rotation.x = -s * swing;
    m.arms[1].rotation.x = this.held ? -0.9 : s * swing;
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

    // Footsteps you can hear (running is loudest; crouch-walking is silent).
    if (sp > 0.8 && !this.crouching && Math.abs(this.ch.pos.y - this.lastPos.y) < 0.2) {
      this.stepAcc += sp * dt;
      if (this.stepAcc > (this.sprinting ? 2.1 : 1.7)) {
        this.stepAcc = 0;
        this.game.sound.stepAt(this.ch.pos, this.sprinting);
      }
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
    this.model.hand.add(it.mesh);
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
 * was heard (drawn over walls, fading out), or a ring for other noises
 * (things landing, glass, a TV left on).
 */
export class HeardMarks {
  constructor(game) {
    this.game = game;
    this.kids = new Map(); // player id -> mark
    this.rings = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);
    this.ringGeo = new THREE.RingGeometry(0.85, 1, 40);
    this.ringGeo.rotateX(-Math.PI / 2);
  }

  overlay(color, opacity) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
  }

  kidMark(id) {
    let m = this.kids.get(id);
    if (m) return m;
    const info = this.game.mp.roster.get(id);
    const color = info ? info.color : '#ffcc00';
    const mat = this.overlay(color, 0.6);
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 1.1, 12), mat);
    body.position.y = 0.72;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), mat);
    head.position.y = 1.47;
    root.add(body, head);
    const tag = nameTag(`${info ? info.name : 'Someone'}?`, color);
    tag.material.depthTest = false;
    tag.position.y = 1.95;
    root.add(tag);
    root.traverse((o) => { o.renderOrder = 990; });
    this.group.add(root);
    m = { root, mat, tag, t: 0, life: 4.5 };
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
      return;
    }
    if (!Array.isArray(msg.p)) return;
    const ring = this.rings.find((r) => !r.mesh.visible) || this.addRing();
    ring.mesh.position.set(msg.p[0], msg.p[1] + 0.05, msg.p[2]);
    ring.mesh.visible = true;
    ring.t = 0;
  }

  addRing() {
    const mesh = new THREE.Mesh(this.ringGeo, this.overlay(0xffb347, 0.7));
    mesh.renderOrder = 989;
    this.group.add(mesh);
    const ring = { mesh, t: 0 };
    this.rings.push(ring);
    return ring;
  }

  update(dt) {
    for (const m of this.kids.values()) {
      if (!m.root.visible) continue;
      m.t += dt;
      const k = 1 - m.t / m.life;
      if (k <= 0) {
        m.root.visible = false;
        continue;
      }
      // Pulses a little, then fades.
      m.mat.opacity = 0.6 * k * (0.8 + 0.2 * Math.sin(m.t * 8));
      m.tag.material.opacity = Math.min(1, k * 1.5);
    }
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      r.mesh.scale.setScalar(0.4 + r.t * 1.4);
      r.mesh.material.opacity = 0.7 * Math.max(0, 1 - r.t / 2.5);
      if (r.t > 2.5) r.mesh.visible = false;
    }
  }
}
