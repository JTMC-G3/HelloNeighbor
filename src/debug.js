import * as THREE from 'three';
import { CHORES } from './chores.js';

/*
 * Debug mode (enabled from the title screen, or toggled mid-game with `).
 * Shows what the neighbor is thinking and lets you watch him:
 *   - chams (see-through highlight) + ESP box/label, coloured by his mode
 *   - his vision cone, planned path, line of sight to you, and noise rings
 *   - an info panel (top left)
 *   - V: see through his eyes, B: free noclip camera (he ignores you),
 *     N: waypoint graph + chore spots, L: key/crowbar markers,
 *     K: freeze his AI, H: hide the panel, T (free cam): teleport there
 */

export const MODE_COLORS = {
  IDLE: '#4cd964',
  SUSPICIOUS: '#ffcc00',
  ATTACK: '#ff3b30',
  STUNNED: '#b36bff',
  FROZEN: '#7fb2ff',
};

const VIEW_RANGE = 22;
const FOV = THREE.MathUtils.degToRad(62);
const $ = (id) => document.getElementById(id);
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

const overlayMat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });

export class Debug {
  constructor(game) {
    this.game = game;
    this.view = 'player'; // 'player' | 'pov' | 'free'
    this.frozen = false;
    this.showGraph = false;
    this.showLoot = false;
    this.panelOn = true;
    this.panelTimer = 0;
    this.fps = { acc: 0, n: 0, value: 0 };
    this.free = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
    this.v = new THREE.Vector3();
    this.q = new THREE.Quaternion();

    const scene = game.scene;
    const n = game.neighbor;
    this.group = new THREE.Group();
    scene.add(this.group);

    // --- chams: a see-through copy of every neighbor mesh, drawn on top of everything.
    this.chamMat = new THREE.MeshBasicMaterial({ color: 0x4cd964, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false });
    const meshes = [];
    n.model.root.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
    this.chams = meshes.map((o) => {
      const c = new THREE.Mesh(o.geometry, this.chamMat);
      c.renderOrder = 999;
      o.add(c);
      return c;
    });

    // --- vision cone on the floor.
    const segs = 24;
    const pts = [0, 0, 0];
    for (let i = 0; i <= segs; i++) {
      const a = -FOV + (2 * FOV * i) / segs;
      pts.push(Math.sin(a) * VIEW_RANGE, 0, Math.cos(a) * VIEW_RANGE);
    }
    const idx = [];
    for (let i = 1; i <= segs; i++) idx.push(0, i, i + 1);
    const coneGeo = new THREE.BufferGeometry();
    coneGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    coneGeo.setIndex(idx);
    this.coneMat = new THREE.MeshBasicMaterial({ color: 0x4cd964, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
    this.cone = new THREE.Mesh(coneGeo, this.coneMat);
    this.cone.renderOrder = 5;
    this.group.add(this.cone);

    // --- his planned route and his line of sight to you.
    this.pathGeo = new THREE.BufferGeometry();
    this.pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 80), 3));
    this.path = new THREE.Line(this.pathGeo, overlayMat(0x33d6ff));
    this.path.renderOrder = 998;
    this.path.frustumCulled = false;
    this.group.add(this.path);
    this.losGeo = new THREE.BufferGeometry();
    this.losGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.losMat = overlayMat(0xffffff, 0.8);
    this.los = new THREE.Line(this.losGeo, this.losMat);
    this.los.renderOrder = 998;
    this.los.frustumCulled = false;
    this.group.add(this.los);

    // --- noise rings (how far a noise carries).
    const ring = [];
    for (let i = 0; i <= 64; i++) ring.push(Math.cos((i / 64) * Math.PI * 2), 0, Math.sin((i / 64) * Math.PI * 2));
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3));
    this.rings = [];
    for (let i = 0; i < 10; i++) {
      const l = new THREE.Line(ringGeo, overlayMat(0xff9500, 0));
      l.renderOrder = 997;
      l.visible = false;
      this.group.add(l);
      this.rings.push({ l, t: 0 });
    }

    // --- you, as a blue capsule, for when the camera isn't in your head.
    const ghostMat = new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false });
    this.playerMarker = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.2, 12), ghostMat);
    body.position.y = 0.75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), ghostMat);
    head.position.y = 1.55;
    this.playerMarker.add(body, head);
    this.playerMarker.traverse((o) => { o.renderOrder = 996; });
    this.playerMarker.visible = false;
    this.group.add(this.playerMarker);

    this.buildGraph();

    // --- HTML bits: info panel, ESP canvas, view banner.
    this.panel = $('debugPanel');
    this.banner = $('debugBanner');
    this.canvas = $('espCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.panel.classList.remove('hidden');
    this.canvas.classList.remove('hidden');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  buildGraph() {
    const nav = this.game.nav;
    this.graph = new THREE.Group();
    const open = [];
    const blocked = [];
    for (const e of nav.edges) {
      const a = nav.pos(e.a);
      const b = nav.pos(e.b);
      const target = e.door && e.door.locked ? blocked : open;
      target.push(a.x, a.y + 0.08, a.z, b.x, b.y + 0.08, b.z);
    }
    const seg = (arr, color) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(g, overlayMat(color, 0.9));
      l.renderOrder = 995;
      return l;
    };
    this.graph.add(seg(open, 0x7fb2ff), seg(blocked, 0xff6b6b));
    const nodeGeo = new THREE.OctahedronGeometry(0.1);
    const nodeMat = new THREE.MeshBasicMaterial({ color: 0x7fb2ff, depthTest: false });
    const choreMat = new THREE.MeshBasicMaterial({ color: 0xff4fd8, depthTest: false });
    for (const node of nav.nodes.values()) {
      const m = new THREE.Mesh(nodeGeo, nodeMat);
      m.position.copy(node.pos).y += 0.08;
      m.renderOrder = 995;
      this.graph.add(m);
    }
    for (const st of this.game.neighbor.stations) {
      const m = new THREE.Mesh(nodeGeo, choreMat);
      m.position.copy(st.stand).y += 0.3;
      m.scale.setScalar(2);
      m.renderOrder = 995;
      m.userData.label = st.type;
      this.graph.add(m);
    }
    this.graph.visible = false;
    this.group.add(this.graph);
  }

  /** Turn the whole overlay on or off (the ` key mid-game). */
  setEnabled(on) {
    if (!on) {
      this.setView('player');
      if (this.frozen) this.frozen = false;
    }
    this.group.visible = on;
    for (const c of this.chams) c.visible = on;
    this.panel.classList.toggle('hidden', !on || !this.panelOn);
    this.canvas.classList.toggle('hidden', !on);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.panelTimer = 0;
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  /** The neighbor's broad mode, as shown in the panel. */
  mode() {
    const n = this.game.neighbor;
    if (this.frozen) return 'FROZEN';
    if (n.state === 'chase' || n.state === 'openCloset' || this.game.state === 'caught') return 'ATTACK';
    if (n.state === 'stunned') return 'STUNNED';
    if (n.state === 'investigate' || n.awareness > 0.05) return 'SUSPICIOUS';
    return 'IDLE';
  }

  /** Returns true if the key was a debug key (and so shouldn't reach the game). */
  onKey(code) {
    switch (code) {
      case 'KeyV':
        this.setView(this.view === 'pov' ? 'player' : 'pov');
        return true;
      case 'KeyB':
        this.setView(this.view === 'free' ? 'player' : 'free');
        return true;
      case 'KeyT':
        if (this.view !== 'free') return false;
        this.teleportHere();
        return true;
      case 'KeyN':
        this.showGraph = !this.showGraph;
        this.graph.visible = this.showGraph;
        return true;
      case 'KeyL':
        this.showLoot = !this.showLoot;
        return true;
      case 'KeyK':
        this.frozen = !this.frozen;
        this.game.toast(this.frozen ? 'Debug: neighbor frozen' : 'Debug: neighbor unfrozen', 1500);
        return true;
      case 'KeyH':
        this.panelOn = !this.panelOn;
        this.panel.classList.toggle('hidden', !this.panelOn);
        return true;
      default:
        return false;
    }
  }

  setView(view) {
    const g = this.game;
    const p = g.player;
    if (view === this.view) return;
    if (view === 'free') {
      this.free.pos.copy(g.camera.position);
      g.camera.getWorldDirection(this.v);
      this.free.yaw = Math.atan2(-this.v.x, -this.v.z);
      this.free.pitch = Math.asin(THREE.MathUtils.clamp(this.v.y, -1, 1));
    }
    this.view = view;
    p.keys.clear();
    const alt = view !== 'player';
    if (p.held) p.held.mesh.visible = !alt;
    document.body.classList.toggle('debugView', alt);
    for (const c of this.chams) c.visible = view !== 'pov';
    this.banner.classList.toggle('hidden', !alt);
    this.banner.textContent = view === 'pov'
      ? "NEIGHBOR'S VIEW  ·  V to return"
      : 'FREE CAMERA  ·  noclip, he ignores you  ·  WASD/Space/C to fly, Shift fast  ·  T teleport here  ·  B to return';
    if (view !== 'pov' && g.state === 'playing') $('fade').style.opacity = '0';
    if (!alt) p.syncCamera(0);
  }

  /** Mouse look while the camera isn't yours; returns true if handled. */
  look(dx, dy) {
    if (this.view !== 'free') return this.view === 'pov';
    const s = this.game.player.sensitivity;
    this.free.yaw -= dx * s;
    this.free.pitch = THREE.MathUtils.clamp(this.free.pitch - dy * s, -1.55, 1.55);
    return true;
  }

  teleportHere() {
    const g = this.game;
    const p = g.player;
    if (p.hidden) {
      p.hidden.setVisible(true);
      p.hidden.target = 0;
      p.hidden = null;
      $('hideOverlay').classList.add('hidden');
    }
    g.hideAnim = null;
    p.ch.pos.set(this.free.pos.x, this.free.pos.y - 1.6, this.free.pos.z);
    p.ch.vel.set(0, 0, 0);
    p.yaw = this.free.yaw;
    p.pitch = this.free.pitch;
    this.setView('player');
  }

  /** A noise was made; `heard` = within earshot of the neighbor. */
  noise(pos, radius, heard) {
    const r = this.rings.find((x) => !x.l.visible) || this.rings[0];
    r.l.visible = true;
    r.t = 0;
    r.l.position.set(pos.x, pos.y + 0.1, pos.z);
    r.l.scale.setScalar(radius);
    r.l.material.color.set(heard ? 0xff3b30 : 0xff9500);
  }

  roomAt(pos) {
    const w = this.game.world;
    if (pos.y < -0.5) return 'Basement';
    const floor = pos.y > 2.5 ? 1 : 0;
    const r = w.plan.rooms.find((rm) => rm.floor === floor && pos.x > rm.x0 && pos.x < rm.x1 && pos.z > rm.z0 && pos.z < rm.z1);
    if (!r) return 'Outside';
    return `${r.type === 'stairs' ? 'Stairwell' : r.type[0].toUpperCase() + r.type.slice(1)} (${floor ? 'upstairs' : 'ground'})`;
  }

  // ================================================================ update
  update(dt) {
    const g = this.game;
    const n = g.neighbor;
    const p = g.player;
    const mode = this.mode();
    const color = MODE_COLORS[mode];

    this.fps.acc += dt;
    this.fps.n++;
    if (this.fps.acc >= 0.5) {
      this.fps.value = Math.round(this.fps.n / this.fps.acc);
      this.fps.acc = 0;
      this.fps.n = 0;
    }

    this.chamMat.color.set(color);
    this.coneMat.color.set(color);

    // Vision cone (hidden while he's asleep).
    const asleep = n.task && n.task.phase === 'do' && n.task.chore.asleep;
    this.cone.visible = !asleep;
    this.cone.position.set(n.pos.x, n.pos.y + 0.04, n.pos.z);
    this.cone.rotation.y = n.heading;
    this.cone.scale.setScalar(p.crouching ? 0.6 : 1);

    // Route.
    const arr = this.pathGeo.attributes.position.array;
    let k = 0;
    arr[k++] = n.pos.x;
    arr[k++] = n.pos.y + 0.1;
    arr[k++] = n.pos.z;
    const moving = n.state !== 'task' || (n.task && n.task.phase === 'goto');
    if (moving) {
      for (let i = n.pathIdx; i < n.path.length && k < arr.length - 3; i++) {
        arr[k++] = n.path[i].x;
        arr[k++] = n.path[i].y + 0.1;
        arr[k++] = n.path[i].z;
      }
    }
    this.pathGeo.setDrawRange(0, k / 3);
    this.pathGeo.attributes.position.needsUpdate = true;

    // Line of sight to you: green if he can see you, grey if blocked/out of view.
    const la = this.losGeo.attributes.position.array;
    const eye = n.eye(this.v);
    la[0] = eye.x;
    la[1] = eye.y;
    la[2] = eye.z;
    const pe = p.eye(new THREE.Vector3());
    la[3] = pe.x;
    la[4] = pe.y;
    la[5] = pe.z;
    this.losGeo.attributes.position.needsUpdate = true;
    this.losMat.color.set(n.sees ? 0x4cd964 : 0x777777);
    this.losMat.opacity = n.sees ? 0.9 : 0.35;
    this.los.visible = eye.distanceTo(pe) < VIEW_RANGE + 5;

    for (const r of this.rings) {
      if (!r.l.visible) continue;
      r.t += dt;
      r.l.material.opacity = Math.max(0, 1 - r.t / 1.2);
      if (r.t > 1.2) r.l.visible = false;
    }

    this.playerMarker.visible = this.view !== 'player';
    this.playerMarker.position.copy(p.pos);

    this.updateCamera(dt);
    this.drawEsp(mode, color);

    this.panelTimer -= dt;
    if (this.panelTimer <= 0 && this.panelOn) {
      this.panelTimer = 0.2;
      this.updatePanel(mode, color);
    }
  }

  updateCamera(dt) {
    const g = this.game;
    const cam = g.camera;
    if (this.view === 'pov') {
      // Look out of his eyes: follows his head, so it works sitting and lying down too.
      const head = g.neighbor.model.head;
      g.neighbor.model.root.updateMatrixWorld(true);
      head.localToWorld(cam.position.set(0, 0.28, 0.3));
      head.getWorldQuaternion(this.q);
      cam.quaternion.copy(this.q).multiply(FLIP);
      const asleep = g.neighbor.task && g.neighbor.task.phase === 'do' && g.neighbor.task.chore.asleep;
      this.banner.textContent = asleep ? "NEIGHBOR'S VIEW  ·  (asleep, eyes closed)  ·  V to return" : "NEIGHBOR'S VIEW  ·  V to return";
      $('fade').style.opacity = asleep ? '0.85' : '0';
    } else if (this.view === 'free') {
      const f = this.free;
      const keys = g.player.keys;
      const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 16 : 6) * dt;
      const fwd = new THREE.Vector3(-Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch));
      const right = new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
      if (keys.has('KeyW')) f.pos.addScaledVector(fwd, speed);
      if (keys.has('KeyS')) f.pos.addScaledVector(fwd, -speed);
      if (keys.has('KeyD')) f.pos.addScaledVector(right, speed);
      if (keys.has('KeyA')) f.pos.addScaledVector(right, -speed);
      if (keys.has('Space')) f.pos.y += speed;
      if (keys.has('KeyC') || keys.has('ControlLeft')) f.pos.y -= speed;
      cam.position.copy(f.pos);
      cam.rotation.set(f.pitch, f.yaw, 0, 'YXZ');
    }
  }

  project(pos) {
    const v = this.v.copy(pos).project(this.game.camera);
    const behind = v.z > 1;
    return { x: (v.x * 0.5 + 0.5) * this.canvas.width, y: (-v.y * 0.5 + 0.5) * this.canvas.height, behind };
  }

  drawEsp(mode, color) {
    const ctx = this.ctx;
    const { width: W, height: H } = this.canvas;
    ctx.clearRect(0, 0, W, H);
    if (this.game.state === 'menu') return;
    const g = this.game;
    const n = g.neighbor;
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';

    if (this.view !== 'pov') {
      const feet = this.project(n.pos);
      const top = this.project(new THREE.Vector3(n.pos.x, n.pos.y + 2.05, n.pos.z));
      const dist = n.pos.distanceTo(g.camera.position);
      if (!feet.behind && !top.behind) {
        const h = Math.max(8, feet.y - top.y);
        const w = h * 0.45;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(feet.x - w / 2, top.y, w, h);
        const task = n.task ? ` · ${n.task.station.type}` : '';
        const label = `NEIGHBOR  ${dist.toFixed(1)}m  ${mode}${task}`;
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(feet.x - tw / 2, top.y - 20, tw, 16);
        ctx.fillStyle = color;
        ctx.fillText(label, feet.x, top.y - 8);
        // Awareness bar under the box.
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(feet.x - w / 2, feet.y + 4, w, 4);
        ctx.fillStyle = color;
        ctx.fillRect(feet.x - w / 2, feet.y + 4, w * (mode === 'ATTACK' ? 1 : n.awareness), 4);
      } else {
        // Off-screen / behind you: an arrow at the screen edge pointing to him.
        g.camera.getWorldDirection(this.v);
        const camYaw = Math.atan2(-this.v.x, -this.v.z);
        const toYaw = Math.atan2(-(n.pos.x - g.camera.position.x), -(n.pos.z - g.camera.position.z));
        const rel = Math.atan2(Math.sin(toYaw - camYaw), Math.cos(toYaw - camYaw));
        const ax = W / 2 - Math.sin(rel) * (W / 2 - 40);
        const ay = H / 2 + Math.cos(rel) * (H / 2 - 40) * (Math.abs(rel) > Math.PI / 2 ? 1 : -1);
        ctx.fillStyle = color;
        ctx.fillText(`▲ NEIGHBOR ${dist.toFixed(0)}m`, Math.max(60, Math.min(W - 60, ax)), Math.max(20, Math.min(H - 20, ay)));
      }
    }

    // Chore spots when the graph is on.
    if (this.showGraph) {
      ctx.fillStyle = '#ff4fd8';
      for (const m of this.graph.children) {
        if (!m.userData.label) continue;
        const s = this.project(m.position);
        if (!s.behind) ctx.fillText(m.userData.label, s.x, s.y - 10);
      }
    }

    // Keys and the crowbar.
    if (this.showLoot) {
      for (const it of g.world.items) {
        if (!it.important || it.consumed || it.held) continue;
        const s = this.project(it.pos);
        if (s.behind) continue;
        ctx.fillStyle = '#ffd166';
        ctx.fillText(`◆ ${it.name}${it.container ? ` (in ${it.container.name})` : ''} ${it.pos.distanceTo(g.camera.position).toFixed(0)}m`, s.x, s.y);
      }
    }
  }

  updatePanel(mode, color) {
    const g = this.game;
    const n = g.neighbor;
    const p = g.player;
    const r3 = (v) => `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;
    const ago = (t) => (t === undefined ? 'never' : `${(g.time - t).toFixed(1)}s ago`);
    const task = n.task;
    let chore = '—';
    if (task) {
      const label = CHORES[task.station.type].label;
      chore = task.phase === 'goto' ? `heading off to: ${label}` : `${label} (${task.t.toFixed(1)} / ${task.dur.toFixed(1)}s)`;
    }
    const heard = n.lastHeard ? `r=${n.lastHeard.radius.toFixed(1)}m, ${ago(n.lastHeard.t)}` : 'nothing yet';
    const walking = !(n.task && n.task.phase === 'do') && n.pathIdx < n.path.length && !(n.state === 'patrol' && n.wait > 0);
    const goal = walking ? `${n.path.length - n.pathIdx} waypoints left` : '—';
    const noiseLvl = p.hidden ? 'hidden' : p.crouching ? 'silent (crouched)' : p.sprinting ? 'LOUD (sprinting)' : p.moving ? 'quiet (walking)' : 'still';
    const locks = g.world.doors.filter((d) => d.locks.length);
    const lockText = locks.map((d) => d.locks.map((l) => (l.type === 'key' ? l.color : 'boards')).join('+')).join(', ') || 'none';
    const info = g.renderer.info.render;
    const bar = (v) => '█'.repeat(Math.round(v * 10)).padEnd(10, '░');
    const row = (k, v) => `<div><span class="dbg-k">${k}</span>${v}</div>`;
    this.panel.innerHTML = [
      `<div class="dbg-title">DEBUG · House #${g.seed}</div>`,
      `<div class="dbg-sec">NEIGHBOR</div>`,
      row('Mode', `<b style="color:${color}">${mode}</b>`),
      row('State', `${n.state}${this.frozen ? ' (frozen)' : ''}`),
      row('Chore', chore),
      row('Awareness', `${bar(mode === 'ATTACK' ? 1 : n.awareness)} ${Math.round((mode === 'ATTACK' ? 1 : n.awareness) * 100)}%`),
      row('Sees you', n.sees ? '<b style="color:#4cd964">YES</b>' : 'no'),
      row('Last saw you', ago(n.lastSeenAt)),
      row('Last heard', heard),
      row('Route', goal),
      row('Distance', `${n.pos.distanceTo(p.pos).toFixed(1)} m`),
      row('Where', this.roomAt(n.pos)),
      row('Knows hiding spot', p.hidden ? (n.sawHide ? '<b style="color:#ff3b30">YES</b>' : 'no') : '—'),
      `<div class="dbg-sec">YOU</div>`,
      row('Position', r3(p.pos)),
      row('Where', this.roomAt(p.pos)),
      row('Noise', noiseLvl),
      row('On his property', g.onProperty(p.pos) ? 'yes' : 'no'),
      row('Holding', p.held ? p.held.name : '—'),
      `<div class="dbg-sec">HOUSE</div>`,
      row('Locks left', `${locks.length} (${lockText})`),
      row('Chores here', [...new Set(n.stations.map((s) => s.type))].join(', ')),
      `<div class="dbg-sec">RENDER</div>`,
      row('FPS', `${this.fps.value} · ${g.preset.label} · ${Math.round(g.scale * 100)}% res`),
      row('Draw calls', `${info.calls} · ${(info.triangles / 1000).toFixed(0)}k tris`),
      `<div class="dbg-keys">\` debug off · V neighbor's view · B free cam · N waypoints · L keys · K freeze · H hide panel</div>`,
    ].join('');
  }
}
