import * as THREE from 'three';
import { bakeChildren } from './quality.js';
import { CHORES, makeProp } from './chores.js';

const WALK = 2.3;
const RUN = 5.05;
const EYE_H = 1.8;
const VIEW_RANGE = 22;
const FOV_COS = Math.cos(THREE.MathUtils.degToRad(62));

const visionFilter = (c) => c.kind !== 'glass';

function buildModel(textures) {
  const root = new THREE.Group();
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...o });
  const skin = std(0xe6b38f);
  const shirt = std(0xdfe7ee);
  const vest = std(0xffffff, { map: textures.vest });
  const pants = std(0x3a3f55);
  const shoes = std(0x2a1d14);
  const hair = std(0x2b2118);
  const dark = std(0x111111);
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
    hip.position.set(0.14 * sx, 0.95, 0);
    add(hip, new THREE.BoxGeometry(0.22, 0.88, 0.24), pants, 0, -0.44, 0);
    add(hip, new THREE.BoxGeometry(0.24, 0.1, 0.36), shoes, 0, -0.9, 0.05);
    body.add(hip);
    legs.push(hip);
  }

  const torso = new THREE.Group();
  torso.position.y = 0.95;
  body.add(torso);
  add(torso, new THREE.BoxGeometry(0.62, 0.26, 0.36), pants, 0, 0.08, 0);
  add(torso, new THREE.BoxGeometry(0.64, 0.62, 0.4), vest, 0, 0.45, 0);
  const belly = add(torso, new THREE.SphereGeometry(0.3, 16, 12), vest, 0, 0.36, 0.08);
  belly.scale.set(1.05, 0.9, 0.85);
  add(torso, new THREE.BoxGeometry(0.66, 0.16, 0.38), shirt, 0, 0.78, 0);
  add(torso, new THREE.BoxGeometry(0.16, 0.08, 0.02), shirt, 0, 0.74, 0.2);

  const arms = [];
  for (const sx of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(0.4 * sx, 0.8, 0);
    add(sh, new THREE.BoxGeometry(0.17, 0.62, 0.19), shirt, 0, -0.3, 0);
    add(sh, new THREE.SphereGeometry(0.075, 10, 8), skin, 0, -0.66, 0);
    torso.add(sh);
    arms.push(sh);
  }

  const head = new THREE.Group();
  head.position.y = 0.88;
  torso.add(head);
  add(head, new THREE.CylinderGeometry(0.09, 0.1, 0.12, 10), skin, 0, 0.02, 0);
  const skull = add(head, new THREE.SphereGeometry(0.2, 18, 16), skin, 0, 0.24, 0);
  skull.scale.set(1.0, 1.12, 1.02);
  add(head, new THREE.SphereGeometry(0.045, 10, 8), skin, 0, 0.21, 0.2);
  // Big bushy mustache.
  const stache = add(head, new THREE.BoxGeometry(0.26, 0.06, 0.07), hair, 0, 0.15, 0.18);
  stache.rotation.x = 0.2;
  for (const sx of [-1, 1]) {
    const tip = add(head, new THREE.BoxGeometry(0.08, 0.05, 0.06), hair, 0.14 * sx, 0.12, 0.16);
    tip.rotation.z = 0.5 * sx;
    // Eyes and heavy brows.
    add(head, new THREE.SphereGeometry(0.022, 8, 6), dark, 0.075 * sx, 0.28, 0.185);
    const brow = add(head, new THREE.BoxGeometry(0.1, 0.03, 0.03), hair, 0.08 * sx, 0.33, 0.185);
    brow.rotation.z = -0.25 * sx;
    // Hair on the sides only; he's bald on top.
    add(head, new THREE.BoxGeometry(0.05, 0.12, 0.22), hair, 0.19 * sx, 0.24, -0.03);
    add(head, new THREE.SphereGeometry(0.04, 8, 6), skin, 0.205 * sx, 0.23, 0.02);
  }
  add(head, new THREE.BoxGeometry(0.3, 0.1, 0.05), hair, 0, 0.22, -0.19);

  // ~40 primitives -> ~8 draw calls: merge the parts of each joint.
  for (const joint of [...legs, ...arms, torso, head]) bakeChildren(joint);

  return { root, body, legs, arms, head, torso };
}

export class Neighbor {
  constructor(scene, textures, physics, nav, sound) {
    this.physics = physics;
    this.nav = nav;
    this.sound = sound;
    this.model = buildModel(textures);
    scene.add(this.model.root);
    this.ch = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      radius: 0.33,
      height: 1.95,
      stepHeight: 0.45,
      onGround: true,
    };
    this.heading = 0;
    this.path = [];
    this.pathIdx = 0;
    this.awareness = 0;
    this.lastSeen = new THREE.Vector3();
    this.investigatePos = new THREE.Vector3();
    this.phase = 0;
    this.stepPhase = 0;
    this.eyeV = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.model.root.rotation.order = 'YXZ';
    this.stations = [];
    this.task = null;
    this.lastChore = null;
    // Stand-in "player" far away, for when there's nobody he could be after.
    this.nobody = {
      pos: new THREE.Vector3(0, 0, 1000),
      ch: { pos: null, height: 1.7 },
      hidden: null,
      crouching: false,
      eye: (out = new THREE.Vector3()) => out.set(0, 1.6, 1000),
    };
    this.nobody.ch.pos = this.nobody.pos;
    this.reset();
  }

  /** Places he can do chores at (see chores.js), found by world.js. */
  setChores(stations) {
    this.stations = stations;
  }

  /** Patrol targets ([nodeId, weight]) and home/guard nodes come from the generated house. */
  setRoutes(patrol, home, guard) {
    this.patrol = patrol;
    this.home = home;
    this.guard = guard;
    this.reset();
  }

  reset() {
    if (this.task) this.endTask(true);
    this.closet = null;
    this.catchT = 0;
    this.grab = null;
    this.focus = null;
    this.sawHideOf = null;
    this.ch.pos.copy(this.nav.pos(this.home || this.nav.nodes.keys().next().value));
    this.ch.vel.set(0, 0, 0);
    this.state = 'patrol';
    this.wait = 1.5;
    this.goal = this.guard;
    this.sawHide = false;
    this.path = [];
    this.pathIdx = 0;
    this.awareness = 0;
    this.lost = 0;
    this.stun = 0;
    this.repath = 0;
    this.directTimer = 0;
    this.direct = false;
    this.lookTimer = 0;
    this.sees = false;
    this.stuckT = 0;
    this.stuckPos = this.ch.pos.clone();
    this.stuckCount = 0;
    this.forcePath = 0;
    this.grabbing = false;
    this.speed = 0;
    this.openedDoors = new Set();
  }

  get pos() {
    return this.ch.pos;
  }

  eye(out = new THREE.Vector3()) {
    return out.set(this.ch.pos.x, this.ch.pos.y + EYE_H, this.ch.pos.z);
  }

  canSee(player) {
    if (player.hidden) return false;
    const e = this.eye(this.eyeV);
    const pe = player.eye(this.tmp);
    const dx = pe.x - e.x;
    const dz = pe.z - e.z;
    const dist = Math.hypot(dx, dz, pe.y - e.y);
    const range = player.crouching ? VIEW_RANGE * 0.6 : VIEW_RANGE;
    if (dist > range) return false;
    if (dist > 1.6) {
      const fx = Math.sin(this.heading);
      const fz = Math.cos(this.heading);
      const hd = Math.hypot(dx, dz) || 1;
      if ((dx * fx + dz * fz) / hd < FOV_COS) return false;
    }
    if (!this.physics.segmentBlocked(e, pe, visionFilter)) return true;
    this.tmp2.set(player.pos.x, player.pos.y + player.ch.height * 0.45, player.pos.z);
    return !this.physics.segmentBlocked(e, this.tmp2, visionFilter);
  }

  setPathTo(target, via = null) {
    const from = this.nav.nearest(this.ch.pos);
    const to = via || this.nav.nearest(target);
    const ids = this.nav.path(from, to) || [from];
    const pts = ids.map((id) => this.nav.pos(id));
    // Skip the first node if we can already head straight for the second.
    if (pts.length > 1 && this.nav.clear(this.ch.pos, pts[1]) && Math.abs(pts[1].y - this.ch.pos.y) < 1) pts.shift();
    const last = pts[pts.length - 1];
    if (!last || (Math.abs(last.y - target.y) < 1 && this.nav.clear(last, target))) pts.push(target.clone());
    this.path = pts;
    this.pathIdx = 0;
  }

  setPathToNode(id) {
    const from = this.nav.nearest(this.ch.pos);
    const ids = this.nav.path(from, id);
    if (!ids) {
      // Unreachable right now (boarded-up door): just stay put for a bit.
      this.path = [];
      this.pathIdx = 0;
      return;
    }
    const pts = ids.map((n) => this.nav.pos(n));
    if (pts.length > 1 && this.nav.clear(this.ch.pos, pts[1]) && Math.abs(pts[1].y - this.ch.pos.y) < 1) pts.shift();
    this.path = pts;
    this.pathIdx = 0;
  }

  moveToward(p, speed, dt) {
    const dx = p.x - this.ch.pos.x;
    const dz = p.z - this.ch.pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    const vx = (dx / len) * speed;
    const vz = (dz / len) * speed;
    const k = Math.min(1, dt * 10);
    this.ch.vel.x += (vx - this.ch.vel.x) * k;
    this.ch.vel.z += (vz - this.ch.vel.z) * k;
    this.turnTo(Math.atan2(dx, dz), dt, 9);
  }

  turnTo(angle, dt, rate = 6) {
    let d = angle - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
  }

  stop(dt) {
    const k = Math.min(1, dt * 10);
    this.ch.vel.x -= this.ch.vel.x * k;
    this.ch.vel.z -= this.ch.vel.z * k;
  }

  /** Returns true once the end of the path is reached. */
  followPath(speed, dt) {
    while (this.pathIdx < this.path.length) {
      const p = this.path[this.pathIdx];
      const dxz = Math.hypot(p.x - this.ch.pos.x, p.z - this.ch.pos.z);
      if (dxz < 0.45 && Math.abs(p.y - this.ch.pos.y) < 1.2) this.pathIdx++;
      else break;
    }
    if (this.pathIdx >= this.path.length) {
      this.stop(dt);
      return true;
    }
    this.moveToward(this.path[this.pathIdx], speed, dt);
    return false;
  }

  pickPatrol() {
    const opts = this.patrol.filter(([id]) => id !== this.goal);
    const total = opts.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [id, w] of opts) {
      r -= w;
      if (r <= 0) return id;
    }
    return opts[0][0];
  }

  startPatrol() {
    if (this.task) this.endTask(true);
    if (this.stations.length && Math.random() < 0.55 && this.startTask()) return;
    this.state = 'patrol';
    this.goal = this.pickPatrol();
    this.setPathToNode(this.goal);
    this.wait = 0;
  }

  // ------------------------------------------------------------ chores
  startTask() {
    const options = this.stations.filter((s) => s.type !== this.lastChore && CHORES[s.type]);
    if (!options.length) return false;
    const station = options[Math.floor(Math.random() * options.length)];
    const chore = CHORES[station.type];
    this.lastChore = station.type;
    this.state = 'task';
    this.task = { station, chore, phase: 'goto', t: 0, soundT: 0, prop: null, dur: chore.dur[0] + Math.random() * (chore.dur[1] - chore.dur[0]) };
    this.setPathTo(station.stand, station.via);
    return true;
  }

  holdProp(task, type, hand = 0) {
    const prop = makeProp(type);
    prop.position.set(0, -0.68, 0.02);
    this.model.arms[hand].add(prop);
    task.prop = prop;
  }

  beginTaskAction(game) {
    const task = this.task;
    const { station, chore } = task;
    task.phase = 'do';
    task.t = 0;
    this.ch.vel.set(0, 0, 0);
    if (!chore.walks) {
      this.ch.pos.x = station.stand.x;
      this.ch.pos.z = station.stand.z;
    }
    this.heading = station.heading;
    if (chore.prop) this.holdProp(task, chore.prop, chore.hand || 0);
    if (chore.start) chore.start(this, game, task);
  }

  /** Stops the current chore (finished, or interrupted when abort is true). */
  endTask(abort = false) {
    const task = this.task;
    if (!task) return;
    this.task = null;
    if (task.prop) task.prop.parent.remove(task.prop);
    if (task.chore.end && this.gameRef) task.chore.end(this, this.gameRef, task);
    if (task.phase === 'do' && task.chore.fixed) this.ch.pos.copy(task.station.stand);
    if (task.chore.fixed) this.ch.vel.set(0, 0, 0);
    void abort;
  }

  updateTask(dt, game) {
    const task = this.task;
    if (task.phase === 'goto') {
      task.t += dt;
      if (task.t > 35) {
        // Couldn't get there (a door he can't open?): forget it.
        this.finishTask();
        return false;
      }
      if (this.followPath(WALK, dt)) {
        // Close enough to the spot (or as close as the route gets)?
        const s = task.station.stand;
        if (Math.hypot(s.x - this.ch.pos.x, s.z - this.ch.pos.z) < 1.2 && Math.abs(s.y - this.ch.pos.y) < 1) this.beginTaskAction(game);
        else this.finishTask();
      }
      return true;
    }
    task.t += dt;
    if (!task.chore.walks) this.stop(dt);
    if (task.chore.sound) {
      task.soundT -= dt;
      if (task.soundT <= 0) {
        task.soundT = task.chore.sound[1] * (0.8 + Math.random() * 0.4);
        this.sound.chore(task.chore.sound[0], this.ch.pos);
      }
    }
    const done = task.chore.update ? task.chore.update(this, dt, game, task) : false;
    if (done || task.t > task.dur) this.finishTask();
    return task.chore.walks;
  }

  finishTask() {
    this.endTask(false);
    this.state = 'patrol';
    this.wait = 1 + Math.random() * 2;
  }

  investigate(pos, lookTime = 3) {
    if (this.task) this.endTask(true);
    this.state = 'investigate';
    this.investigatePos.copy(pos);
    this.setPathTo(pos);
    this.lookTimer = lookTime;
    this.arrived = false;
  }

  startChase(game) {
    if (this.state === 'chase' || this.state === 'openCloset') return;
    if (this.task) this.endTask(true);
    this.state = 'chase';
    this.lost = 0;
    this.repath = 0;
    this.awareness = 1;
    this.sound.alert();
    game.onSpotted(this.focus);
  }

  /** Whether he watched `player` climb into the wardrobe they're now in. */
  noteHidden(player, seen) {
    if (seen) {
      this.sawHide = true;
      this.sawHideOf = player;
    } else if (this.sawHideOf === player || !this.sawHideOf) {
      this.sawHide = false;
      this.sawHideOf = null;
    }
  }

  /** He's got someone: lunge, lift and shake them (3.2 s), then head home. */
  startGrab(player) {
    if (this.task) this.endTask(true);
    this.grab = { player, t: 0 };
  }

  /**
   * Who he's paying attention to when several people are sneaking around:
   * whoever he's chasing (while he can still see them), else the closest one
   * he can see, else whoever he was after, else the closest.
   */
  pickFocus(players) {
    if (!players.length) return null;
    if (players.length === 1) return players[0];
    const cur = players.includes(this.focus) ? this.focus : null;
    if (cur && this.state === 'openCloset') return cur;
    let best = null;
    let bestD = Infinity;
    for (const p of players) {
      const d = p.pos.distanceTo(this.ch.pos);
      if (d < bestD && this.canSee(p)) {
        best = p;
        bestD = d;
      }
    }
    if (cur && this.state === 'chase' && (!best || this.canSee(cur))) return cur;
    if (best) return best;
    if (cur) return cur;
    let near = players[0];
    for (const p of players) if (p.pos.distanceTo(this.ch.pos) < near.pos.distanceTo(this.ch.pos)) near = p;
    return near;
  }

  /** Multiplayer clients: copy what the host's neighbor is doing, then animate. */
  puppet(dt, s) {
    const k = Math.min(1, dt * 12);
    const target = this.tmp.set(s.x, s.y, s.z);
    if (this.ch.pos.distanceTo(target) > 3) this.ch.pos.copy(target);
    else this.ch.pos.lerp(target, k);
    let d = s.heading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * k;
    this.speed = s.speed;
    this.state = s.state;
    this.awareness = s.awareness;
    this.grabbing = s.grabbing;
    this.catchT = s.catchT;
    // Chores: same spot and phase as on the host (for poses and props).
    const cur = this.task;
    if (!s.station) {
      if (cur) this.endPuppetTask();
    } else if (!cur || cur.station !== s.station || (cur.phase === 'do') !== s.doing) {
      if (cur) this.endPuppetTask();
      const chore = CHORES[s.station.type];
      this.task = { station: s.station, chore, phase: s.doing ? 'do' : 'goto', t: s.taskT, prop: null };
      if (s.doing && chore.prop) this.holdProp(this.task, chore.prop, chore.hand || 0);
    }
    if (this.task) this.task.t = s.taskT;
    this.animate(dt);
  }

  endPuppetTask() {
    const task = this.task;
    this.task = null;
    if (task && task.prop) task.prop.parent.remove(task.prop);
  }

  hit(game, player) {
    if (this.state === 'stunned') return;
    if (this.task) this.endTask(true);
    this.state = 'stunned';
    this.stun = 2.2;
    this.sound.grunt(this.ch.pos);
    this.lastSeen.copy(player.pos);
    game.toastTo(player, 'Bonk! That stunned him for a moment.');
  }

  hear(pos, game, radius = Infinity) {
    if (this.state === 'chase' || this.state === 'stunned' || this.state === 'openCloset') return;
    if (!game.onProperty(pos)) return;
    // Asleep, or deafened by his own lawnmower: only loud or close noises get through.
    const t = this.task && this.task.phase === 'do' ? this.task.chore : null;
    const factor = t ? (t.asleep ? 0.35 : t.deaf || 1) : 1;
    if (pos.distanceTo(this.ch.pos) > radius * factor) return;
    this.lastHeard = { pos: pos.clone(), radius, t: game.time };
    this.awareness = Math.max(this.awareness, 0.4);
    this.investigate(pos, 3.5);
  }

  handleDoors(dt) {
    for (const d of this.doorsRef) {
      const dist = Math.hypot(d.center.x - this.ch.pos.x, d.center.z - this.ch.pos.z);
      const sameFloor = Math.abs(d.center.y - this.ch.pos.y) < 1.2;
      if (!d.open && !d.neighborIgnore && !d.boarded && dist < 1.35 && sameFloor && this.speed > 0.2) {
        d.setOpen(true);
        this.sound.door(d.center, true);
        this.openedDoors.add(d);
      }
      // Tidy fellow: closes doors behind him when he isn't in a hurry.
      if (d.open && this.openedDoors.has(d) && dist > 2.6 && this.state !== 'chase') {
        if (this.playersRef && this.playersRef.some((p) => p.pos.distanceTo(d.center) < 1.8)) continue;
        d.setOpen(false);
        this.sound.door(d.center, false);
        this.openedDoors.delete(d);
      }
    }
    void dt;
  }

  checkStuck(dt, trying) {
    this.stuckT += dt;
    if (this.stuckT < 1.2) return;
    const moved = this.stuckPos.distanceTo(this.ch.pos);
    this.stuckPos.copy(this.ch.pos);
    this.stuckT = 0;
    if (!trying || moved > 0.3) {
      this.stuckCount = 0;
      return;
    }
    this.stuckCount++;
    if (this.direct) this.forcePath = 2;
    else if (this.pathIdx < this.path.length - 1) this.pathIdx++;
    if (this.stuckCount >= 4) {
      // Last resort: hop to the nearest waypoint so he never soft-locks.
      this.ch.pos.copy(this.nav.pos(this.nav.nearestAny(this.ch.pos)));
      this.stuckCount = 0;
      this.repath = 0;
    }
  }

  /**
   * `players`: everyone he could notice (one Player, or a list in multiplayer;
   * leave out anyone he should ignore, like the debug free camera).
   */
  update(dt, players, game) {
    if (!Array.isArray(players)) players = [players];
    this.playersRef = players;
    this.gameRef = game;
    this.doorsRef = game.world.doors;

    if (this.grab) {
      const g = this.grab;
      const player = g.player;
      g.t += dt;
      if (this.task) this.endTask(true);
      // Lunge in close, then hold on.
      const dx = player.pos.x - this.ch.pos.x;
      const dz = player.pos.z - this.ch.pos.z;
      const d = Math.hypot(dx, dz);
      // Keep about arm's length: close the gap, or step back if he's on top of you.
      if (d > 0.95 && g.t < 0.35) this.moveToward(player.pos, 4, dt);
      else if (d < 0.85 && d > 0.01) {
        this.ch.vel.x = (-dx / d) * 1.5;
        this.ch.vel.z = (-dz / d) * 1.5;
      } else this.stop(dt);
      this.physics.moveCharacter(this.ch, dt);
      this.turnTo(Math.atan2(dx, dz), dt, 14);
      this.grabbing = true;
      this.catchT = g.t;
      this.speed = 0;
      this.animate(dt);
      // Then he wanders back home as if nothing happened.
      if (g.t > 3.2) this.reset();
      return;
    }
    this.grabbing = false;
    const dbg = game.debug;
    if (!(game.state === 'playing' || game.online) || (dbg && dbg.frozen)) {
      this.animate(dt);
      return;
    }
    const player = this.pickFocus(players) || this.nobody;
    if (player !== this.focus && this.sawHideOf && this.sawHideOf !== player) this.sawHide = false;
    this.focus = player;
    const ghost = false;

    const toP = Math.hypot(player.pos.x - this.ch.pos.x, player.pos.z - this.ch.pos.z);
    const dy = Math.abs(player.pos.y - this.ch.pos.y);
    const onProp = game.onProperty(player.pos);

    // ---- perception
    const asleep = this.task && this.task.phase === 'do' && this.task.chore.asleep;
    this.sees = this.state !== 'stunned' && !asleep && !ghost && this.canSee(player);
    if (this.sees) {
      this.lastSeenAt = game.time;
      this.lastSeen.copy(player.pos);
      if (onProp) {
        // Takes ~0.5s to react up close indoors, a couple of seconds far away in the yard.
        let rate = THREE.MathUtils.clamp(1.5 - toP / 14, 0.3, 1.5);
        if (player.crouching) rate *= 0.55;
        if (player.ch.pos.y > 0.2 || player.ch.pos.y < -0.5) rate *= 1.6; // inside the house
        if (toP < 3) rate *= 2.5;
        this.awareness = Math.min(1, this.awareness + rate * dt);
        if (this.awareness >= 1 && this.state !== 'chase') this.startChase(game);
      } else {
        this.awareness = Math.max(0, this.awareness - dt * 0.2);
      }
    } else if (this.state !== 'chase') {
      this.awareness = Math.max(0, this.awareness - dt * 0.12);
    }

    // Bumping into him is a bad idea.
    const findable = !player.hidden || (this.sawHide && this.sawHideOf === player);
    if (toP < 0.95 && dy < 1.3 && this.state !== 'stunned' && onProp && findable && !player.hidden && !ghost) this.startChase(game);

    let trying = false;
    switch (this.state) {
      case 'patrol': {
        if (this.wait > 0) {
          this.wait -= dt;
          this.stop(dt);
          if (this.sees && !onProp) {
            // Stares at you from across the street.
            this.turnTo(Math.atan2(player.pos.x - this.ch.pos.x, player.pos.z - this.ch.pos.z), dt, 3);
          } else {
            this.heading += Math.sin(performance.now() * 0.0012) * dt * 0.8;
          }
          if (this.wait <= 0) this.startPatrol();
        } else {
          trying = true;
          if (this.followPath(WALK, dt)) this.wait = 2 + Math.random() * 3.5;
        }
        break;
      }
      case 'task': {
        trying = this.updateTask(dt, game) && this.task && this.task.phase === 'goto';
        break;
      }
      case 'openCloset': {
        // He saw you climb in: yank the wardrobe open, then grab you.
        this.stop(dt);
        const c = this.closet;
        this.turnTo(Math.atan2(c.inside.x - this.ch.pos.x, c.inside.z - this.ch.pos.z), dt, 10);
        this.closetT += dt;
        if (this.closetT > 0.55) game.neighborCaught(player);
        break;
      }
      case 'investigate': {
        if (!this.arrived) {
          trying = true;
          if (this.followPath(WALK * 1.35, dt)) {
            this.arrived = true;
            // Whatever made that racket gets switched off.
            for (const app of game.world.appliances) {
              if (app.on && app.pos.distanceTo(this.ch.pos) < 3.2) game.setAppliance(app, false, true);
            }
          }
        } else {
          this.stop(dt);
          this.heading += dt * 1.8;
          this.lookTimer -= dt;
          if (this.lookTimer <= 0) this.startPatrol();
        }
        break;
      }
      case 'chase': {
        if (this.sees) this.lost = 0;
        else this.lost += dt;
        if (!onProp && toP > 7) {
          // Chased you off his property.
          game.toastTo(player, 'He lost interest... for now.');
          this.awareness = 0.3;
          this.startPatrol();
          break;
        }
        if (this.lost > 4.5) {
          this.investigate(this.lastSeen, 4);
          break;
        }
        // If he watched you hide, he heads for the wardrobe doors.
        const inCloset = player.hidden && this.sawHide && this.sawHideOf === player ? player.hidden : null;
        const goal = inCloset ? inCloset.out : player.pos;
        if (inCloset) {
          this.lost = 0;
          if (Math.hypot(goal.x - this.ch.pos.x, goal.z - this.ch.pos.z) < 0.7 && Math.abs(goal.y - this.ch.pos.y) < 1) {
            this.state = 'openCloset';
            this.closet = inCloset;
            this.closetT = 0;
            game.openCloset(inCloset, player);
            break;
          }
        }
        this.directTimer -= dt;
        if (this.directTimer <= 0) {
          this.direct = this.forcePath <= 0 && Math.abs(goal.y - this.ch.pos.y) < 1.6 && this.nav.clear(this.ch.pos, goal);
          this.directTimer = 0.2;
        }
        this.forcePath -= dt;
        trying = true;
        if (this.direct && (this.lost < 0.6 || inCloset)) {
          this.moveToward(goal, RUN, dt);
        } else {
          this.repath -= dt;
          if (this.repath <= 0) {
            this.setPathTo(this.sees || inCloset ? goal : this.lastSeen);
            this.repath = 0.6;
          }
          if (this.followPath(RUN, dt) && !this.sees && !inCloset) this.investigate(this.lastSeen, 4);
        }
        break;
      }
      case 'stunned': {
        this.stop(dt);
        this.stun -= dt;
        if (this.stun <= 0) {
          if (onProp) this.startChase(game);
          else this.investigate(this.lastSeen, 3);
        }
        break;
      }
      default:
        break;
    }

    const planted = this.task && this.task.phase === 'do' && this.task.chore.fixed;
    if (!planted) this.physics.moveCharacter(this.ch, dt);
    this.speed = Math.hypot(this.ch.vel.x, this.ch.vel.z);
    this.handleDoors(dt);
    this.checkStuck(dt, trying);

    if (this.ch.pos.y < -10) this.reset();

    // Catch.
    if (this.state === 'chase' && toP < 1.05 && dy < 1.3 && !player.hidden && !ghost) game.neighborCaught(player);

    this.animate(dt);
  }

  animate(dt) {
    const m = this.model;
    m.root.position.copy(this.ch.pos);
    m.root.rotation.set(0, this.heading, 0);
    m.body.position.y = 0;
    m.head.rotation.set(0, 0, 0);
    m.torso.rotation.set(0, 0, 0);
    for (const a of m.arms) a.rotation.set(0, 0, 0);
    const task = this.task && this.task.phase === 'do' ? this.task : null;
    if (task && task.chore.fixed) {
      // Sitting on a couch / lying in bed: planted on the furniture.
      const st = task.station;
      if (task.chore.fixed === 'lie') {
        m.root.position.copy(st.lie);
        m.root.rotation.set(-Math.PI / 2, st.lieHeading, 0);
        m.legs[0].rotation.x = m.legs[1].rotation.x = 0;
      } else {
        m.root.position.copy(st.sit || st.stand);
      }
      task.chore.pose(m, task.t);
      return;
    }
    const sp = this.speed;
    const run = sp > 3.5;
    const prev = this.phase;
    this.phase += dt * (sp > 0.2 ? 2.2 + sp * 1.3 : 0);
    const swing = Math.min(1, sp / 3) * (run ? 0.9 : 0.55);
    const s = Math.sin(this.phase);
    m.legs[0].rotation.x = s * swing;
    m.legs[1].rotation.x = -s * swing;
    if (this.grabbing) {
      // Reach out, then lift and shake you.
      const t = this.catchT;
      const lift = THREE.MathUtils.smoothstep(t, 0.3, 0.8);
      const shake = t > 0.35 && t < 1.4 ? Math.sin(t * 38) * 0.12 : 0;
      for (const a of m.arms) a.rotation.x = -1.35 - lift * 0.45 + shake;
      m.arms[0].rotation.z = 0.3;
      m.arms[1].rotation.z = -0.3;
      m.torso.rotation.x = 0.15 - lift * 0.2;
      m.head.rotation.x = -0.15 + shake * 0.5;
      m.legs[0].rotation.x = m.legs[1].rotation.x = 0;
      return;
    } else if (this.state === 'stunned') {
      m.arms[0].rotation.x = -0.4 + Math.sin(performance.now() * 0.02) * 0.2;
      m.arms[1].rotation.x = -0.4 - Math.sin(performance.now() * 0.02) * 0.2;
    } else {
      m.arms[0].rotation.x = -s * swing * (run ? 1.3 : 0.9);
      m.arms[1].rotation.x = s * swing * (run ? 1.3 : 0.9);
      m.arms[0].rotation.z = 0;
      m.arms[1].rotation.z = 0;
    }
    m.torso.rotation.x = run ? 0.18 : 0.02;
    m.body.position.y = Math.abs(Math.cos(this.phase)) * (run ? 0.07 : 0.03);
    m.head.rotation.z = this.state === 'stunned' ? Math.sin(performance.now() * 0.01) * 0.3 : 0;
    if (task) task.chore.pose(m, task.t);

    // Footsteps, twice per cycle.
    if (sp > 0.3 && Math.floor(prev / Math.PI) !== Math.floor(this.phase / Math.PI)) {
      this.sound.heavyStep(this.ch.pos);
    }
  }
}
