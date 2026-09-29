import * as THREE from 'three';

/*
 * WebXR (VR headset) support.
 *
 * The camera lives inside a "rig" group that represents your play space. The
 * headset moves the camera around inside the rig; the game moves the rig so
 * your head always stays over your (collision-checked) body. Walking around
 * your room therefore can't take you through walls.
 *
 * Controls (xr-standard gamepads, e.g. Quest Touch):
 *   Left stick   walk (towards where you're looking)   click: sprint
 *   Right stick  snap turn 45°
 *   Trigger      use whatever that hand's laser points at
 *   Grip         grab an item; let go while swinging to THROW it
 *   A / X        jump                B / Y  crouch toggle (or just duck)
 *   Left trigger (pointing at nothing) toggles the flashlight in your left hand
 */

const SNAP = Math.PI / 4;
const REACH = 2.5;
const $ = (id) => document.getElementById(id);

export class VR {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.session = null;
    this.input = { moveX: 0, moveY: 0, sprint: false, jump: false, crouch: false };
    this.rig = new THREE.Group();
    this.rig.name = 'vr-rig';
    game.scene.add(this.rig);
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.heartbeat = 0;

    const r = game.renderer;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local-floor');

    this.hands = [0, 1].map((i) => this.makeHand(i));
    this.makeHud();
  }

  static async supported() {
    try {
      return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')));
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ hands
  makeHand(i) {
    const r = this.game.renderer;
    const controller = r.xr.getController(i); // pointing (target ray) space
    const grip = r.xr.getControllerGrip(i); // holding space
    this.rig.add(controller, grip);

    // A simple chunky controller-in-a-glove model.
    const glove = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.5 });
    const model = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.1), glove);
    palm.position.set(0, -0.01, 0.03);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.1, 10), dark);
    handle.rotation.x = Math.PI / 2 - 0.5;
    handle.position.set(0, -0.03, 0.02);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 20), dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.01, -0.04);
    model.add(palm, handle, ring);
    grip.add(model);

    // Laser pointer.
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const laserMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
    const laser = new THREE.Line(lineGeo, laserMat);
    laser.scale.z = REACH;
    controller.add(laser);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    dot.visible = false;
    controller.add(dot);

    const hand = {
      index: i,
      controller,
      grip,
      model,
      laser,
      laserMat,
      dot,
      source: null,
      handedness: i === 0 ? 'left' : 'right',
      target: null,
      pressed: {},
      history: [],
      vel: new THREE.Vector3(),
    };
    controller.addEventListener('connected', (e) => {
      hand.source = e.data;
      hand.handedness = e.data.handedness || hand.handedness;
    });
    controller.addEventListener('disconnected', () => {
      hand.source = null;
    });
    return hand;
  }

  hand(side) {
    return this.hands.find((h) => h.handedness === side) || this.hands[side === 'left' ? 0 : 1];
  }

  pulse(hand, intensity, ms) {
    const act = hand && hand.source && hand.source.gamepad && hand.source.gamepad.hapticActuators;
    if (act && act[0] && act[0].pulse) act[0].pulse(intensity, ms);
  }

  pulseBoth(intensity, ms) {
    for (const h of this.hands) this.pulse(h, intensity, ms);
  }

  // -------------------------------------------------------------- HUD
  /** A small screen floating just below your view: prompts, toasts, awareness, caught text. */
  makeHud() {
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 1024;
    this.hudCanvas.height = 512;
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.hudTex, transparent: true, depthTest: false, depthWrite: false });
    this.hud = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), mat);
    this.hud.position.set(0, -0.12, -1.0);
    this.hud.renderOrder = 1001;
    this.hudKey = '';
    this.toasts = [];

    // Fade to black (getting caught, the ending).
    this.fade = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false }),
    );
    this.fade.renderOrder = 1000;

    // Wardrobe slats while hiding.
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 256;
    const g = c.getContext('2d');
    for (let y = 0; y < 256; y += 32) {
      g.fillStyle = 'rgba(12,7,3,0.96)';
      g.fillRect(0, y, 64, 21);
    }
    const slatTex = new THREE.CanvasTexture(c);
    slatTex.wrapS = slatTex.wrapT = THREE.RepeatWrapping;
    slatTex.repeat.set(1, 3);
    this.slats = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, 1.2),
      new THREE.MeshBasicMaterial({ map: slatTex, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.slats.position.set(0, 0, -0.22);
    this.slats.renderOrder = 999;
    this.slats.visible = false;
  }

  toast(text) {
    this.toasts.push({ text, t: 3.2 });
    if (this.toasts.length > 2) this.toasts.shift();
  }

  drawHud(dt) {
    const g = this.game;
    for (const t of this.toasts) t.t -= dt;
    this.toasts = this.toasts.filter((t) => t.t > 0);
    const n = g.neighbor;
    const chase = n.state === 'chase' || n.state === 'openCloset';
    const aw = Math.round((chase ? 1 : n.awareness) * 20);
    const target = this.promptHand ? this.promptText(this.promptHand.target) : '';
    const caught = !$('caughtText').classList.contains('hidden');
    const ending = g.state === 'ending';
    const held = g.player.held ? g.player.held.name : '';
    const key = [aw, chase, target, caught, ending, held, g.player.hidden ? 1 : 0, this.toasts.map((t) => t.text).join('|')].join('#');
    if (key === this.hudKey) return;
    this.hudKey = key;

    const ctx = this.hudCanvas.getContext('2d');
    const W = 1024;
    const H = 512;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pill = (text, y, size, color = '#fff', bg = 'rgba(0,0,0,0.6)') => {
      ctx.font = `bold ${size}px Trebuchet MS, sans-serif`;
      const w = ctx.measureText(text).width + size;
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(W / 2 - w / 2, y - size * 0.8, w, size * 1.6, size * 0.8);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, W / 2, y);
    };
    if (caught) {
      ctx.font = 'bold 150px Impact, Arial Black, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#a5391a';
      ctx.lineWidth = 10;
      ctx.strokeText('GOT YOU!', W / 2, H / 2);
      ctx.fillText('GOT YOU!', W / 2, H / 2);
    } else if (ending) {
      ctx.font = 'bold 90px Impact, Arial Black, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('TO BE CONTINUED...', W / 2, H / 2);
    } else {
      // Awareness eye bar.
      if (aw > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(W / 2 - 110, 18, 220, 16);
        ctx.fillStyle = chase ? '#ff3b30' : '#ffcc00';
        ctx.fillRect(W / 2 - 108, 20, (216 * aw) / 20, 12);
        if (chase) pill('HE SEES YOU - RUN!', 70, 34, '#fff', 'rgba(180,20,20,0.8)');
      }
      if (target) pill(target, 190, 42);
      if (held) pill(`Holding: ${held}  ·  let go of grip while swinging to throw`, 260, 26, '#ffd166');
      if (g.player.hidden) pill('Hiding  ·  trigger to climb out', 260, 30);
      this.toasts.forEach((t, i) => pill(t.text, 350 + i * 64, 30));
    }
    this.hudTex.needsUpdate = true;
  }

  promptText(t) {
    const g = this.game;
    if (!t) return '';
    if (t.item) return `Grip: grab ${t.item.name}   ·   Trigger: pick up`;
    if (t.door) {
      const lock = g.usableLock(t.door);
      if (lock) return lock.type === 'key' ? `Trigger: use ${g.player.held.name}` : 'Trigger: pry the boards off';
      if (t.door.locked && !t.door.open) return `${t.door.name} (${t.door.boarded ? 'boarded up' : 'locked'})`;
      return `Trigger: ${t.door.open ? 'close' : 'open'} ${t.door.name}`;
    }
    if (t.container) return `Trigger: ${t.container.open ? 'close' : 'open'} ${t.container.name}`;
    if (t.hide) return 'Trigger: hide inside';
    if (t.appliance) return `Trigger: turn ${t.appliance.on ? 'off' : 'on'} ${t.appliance.name}`;
    return '';
  }

  // --------------------------------------------------------- session
  async enter() {
    const r = this.game.renderer;
    // Standalone headsets have phone-class GPUs: render a little under native.
    const standalone = /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);
    r.xr.setFramebufferScaleFactor(standalone ? 0.8 : 1.0);
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    await r.xr.setSession(session);
    this.session = session;
    session.addEventListener('end', () => this.onEnd());
    this.onStart(standalone);
  }

  onStart(standalone) {
    const g = this.game;
    this.active = true;
    g.player.vr = this;
    const r = g.renderer;
    if (r.xr.setFoveation) r.xr.setFoveation(1);
    // Keep the frame rate up: 72-90 fps in stereo is a lot to ask.
    if (standalone) g.applyQuality('low');
    else if (g.quality === 'high') g.applyQuality('medium');

    this.rig.add(g.camera);
    g.camera.add(this.hud, this.fade, this.slats);
    // Flashlight in your left hand.
    const left = this.hand('left').controller;
    left.add(g.flashlight, g.flashlight.target);
    g.flashlight.position.set(0, 0, -0.05);
    if (g.player.held) this.attachHeld(g.player.held, this.hand('right'));
    this.placeRig();
  }

  onEnd() {
    const g = this.game;
    this.active = false;
    this.session = null;
    g.player.vr = null;
    g.scene.add(g.camera);
    g.camera.remove(this.hud, this.fade, this.slats);
    g.camera.add(g.flashlight, g.flashlight.target);
    g.flashlight.position.set(0.15, -0.1, 0);
    if (g.player.held) g.attachHeldToCamera(g.player.held);
    g.player.syncCamera(0);
    if (g.state === 'playing') g.pause();
  }

  exit() {
    if (this.session) this.session.end();
  }

  // ------------------------------------------------------ helpers
  headWorld(out = new THREE.Vector3()) {
    return this.game.camera.getWorldPosition(out);
  }

  /** Height of your real head above your real floor. */
  headHeight() {
    return this.game.camera.position.y;
  }

  headYaw() {
    const d = this.game.camera.getWorldDirection(this.tmp2);
    return Math.atan2(-d.x, -d.z);
  }

  /** Put the play space so your head is over your body, facing player.yaw. */
  placeRig() {
    const p = this.game.player;
    const cam = this.game.camera;
    const yaw = p.yaw;
    const hx = cam.position.x;
    const hz = cam.position.z;
    const ox = hx * Math.cos(yaw) + hz * Math.sin(yaw);
    const oz = -hx * Math.sin(yaw) + hz * Math.cos(yaw);
    this.rig.rotation.set(0, yaw, 0);
    // Only a gentle version of the "grabbed" lift in VR (no forced spins or rolls).
    this.rig.position.set(p.ch.pos.x - ox, p.ch.pos.y + p.camOffset.y * 0.5, p.ch.pos.z - oz);
  }

  // ---------------------------------------------------------- update
  update(dt) {
    if (!this.active) return;
    const g = this.game;
    const p = g.player;
    this.rig.updateMatrixWorld(true);

    // Walking around your room moves your body too (and walls stop you).
    if (!p.hidden && !g.hideAnim && g.state === 'playing') {
      const head = this.headWorld(this.tmp);
      const dx = head.x - p.ch.pos.x;
      const dz = head.z - p.ch.pos.z;
      if (Math.hypot(dx, dz) < 1.5) this.game.physics.moveBy(p.ch, dx, dz);
    }

    const left = this.hand('left');
    const right = this.hand('right');
    const read = (hand) => {
      const gp = hand.source && hand.source.gamepad;
      if (!gp) return null;
      const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
      // xr-standard: axes[2..3] thumbstick; buttons 0 trigger, 1 grip, 3 stick press, 4 A/X, 5 B/Y.
      return { x: gp.axes[2] || 0, y: gp.axes[3] || 0, trigger: b(0), grip: b(1), stick: b(3), a: b(4), b: b(5) };
    };
    const L = read(left) || {};
    const R = read(right) || {};
    const edge = (hand, name, v) => {
      const was = hand.pressed[name];
      hand.pressed[name] = v;
      return v && !was;
    };
    const released = (hand, name, v) => {
      const was = hand.pressed[`${name}Up`];
      hand.pressed[`${name}Up`] = v;
      return !v && was;
    };

    const dead = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    this.input.moveX = dead(L.x || 0);
    this.input.moveY = dead(L.y || 0);
    if (edge(left, 'stick', !!L.stick)) this.input.sprint = !this.input.sprint;
    if (!this.input.moveX && !this.input.moveY) this.input.sprint = false;
    if (edge(right, 'a', !!R.a) || edge(left, 'a', !!L.a)) this.input.jump = true;
    if (edge(right, 'b', !!R.b)) this.input.crouch = !this.input.crouch;

    // Snap turn.
    const rx = R.x || 0;
    if (Math.abs(rx) > 0.7 && !this.turnHeld) {
      this.turnHeld = true;
      p.yaw -= Math.sign(rx) * SNAP;
    } else if (Math.abs(rx) < 0.3) this.turnHeld = false;

    // Hand velocities (for throwing).
    for (const h of this.hands) {
      const pos = h.grip.getWorldPosition(new THREE.Vector3());
      h.history.push({ pos, t: g.time });
      while (h.history.length > 6) h.history.shift();
      const first = h.history[0];
      const span = g.time - first.t;
      if (span > 0) h.vel.subVectors(pos, first.pos).divideScalar(span);
    }

    // Lasers: what each hand is pointing at.
    this.promptHand = null;
    for (const h of this.hands) {
      if (!h.source || g.state !== 'playing') {
        h.target = null;
        h.laser.visible = false;
        continue;
      }
      h.laser.visible = true;
      const origin = h.controller.getWorldPosition(new THREE.Vector3());
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(h.controller.getWorldQuaternion(new THREE.Quaternion()));
      const res = p.hidden ? null : g.findTarget(origin, dir, true);
      h.target = res;
      h.laserMat.color.set(res ? 0xffd166 : 0xffffff);
      h.laserMat.opacity = res ? 0.9 : 0.35;
      h.dot.visible = !!res;
      const d = res && res.dist !== undefined ? Math.min(REACH, res.dist) : REACH;
      h.laser.scale.z = d;
      h.dot.position.set(0, 0, -d);
      if (res && (!this.promptHand || h === right)) this.promptHand = h;
    }

    // Buttons.
    for (const [h, S] of [[left, L], [right, R]]) {
      if (g.state !== 'playing') break;
      if (edge(h, 'trigger', !!S.trigger)) {
        if (h === left && !h.target && !p.hidden) {
          g.toggleFlashlight();
        } else {
          g.target = h.target;
          this.lastHand = h;
          g.interact();
        }
      }
      // Grip: grab / throw.
      const gripDown = edge(h, 'grip', !!S.grip);
      if (gripDown && h.target && h.target.item) {
        g.target = h.target;
        this.lastHand = h;
        g.interact();
        this.pulse(h, 0.3, 40);
      }
      if (released(h, 'grip', !!S.grip) && p.held && this.heldHand === h) {
        this.throwFrom(h);
      }
    }

    // Heartbeat in your hands while he's chasing you.
    if (g.neighbor.state === 'chase') {
      this.heartbeat -= dt;
      if (this.heartbeat <= 0) {
        const d = g.neighbor.pos.distanceTo(p.pos);
        this.pulseBoth(Math.min(1, 0.25 + 3 / Math.max(1, d)), 60);
        this.heartbeat = THREE.MathUtils.clamp(d / 12, 0.35, 0.9);
      }
    }

    this.slats.visible = !!p.hidden;
    this.fade.material.opacity = Number($('fade').style.opacity || 0);
    this.drawHud(dt);
  }

  /** Put the held item in a hand. */
  attachHeld(it, hand = this.lastHand || this.hand('right')) {
    this.heldHand = hand;
    hand.grip.add(it.mesh);
    const big = it.radius > 0.2;
    it.mesh.position.set(0, big ? -0.05 : 0, big ? -0.18 : -0.06);
    it.mesh.rotation.set(0, 0, 0);
    it.mesh.scale.setScalar(big ? 0.8 : 1);
  }

  /** Let go: the item flies off with your hand's speed. */
  throwFrom(hand) {
    const g = this.game;
    const it = g.player.held;
    const pos = hand.grip.getWorldPosition(new THREE.Vector3());
    const vel = hand.vel.clone();
    const speed = vel.length();
    if (speed > 1.5) vel.multiplyScalar(1.35); // a little help: arms are shorter than they feel
    g.releaseAt(it, pos, vel);
    if (speed > 2) {
      it.thrown = true;
      it.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      g.sound.throwWhoosh();
      this.pulse(hand, 0.4, 50);
    }
    this.heldHand = null;
  }
}
