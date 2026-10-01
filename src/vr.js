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
 *
 * Multiplayer (crossplay with desktop players, see mp.js):
 *   Playing the neighbor: Grip (or the right trigger) on nothing grabs the kid
 *     your hand is reaching for. Trigger on a wardrobe searches it.
 *   Waiting in the lobby in the headset: the host pulls a trigger to start.
 *   Your head and hands are sent to everyone, so they see where you look
 *   and what your arms are doing.
 *
 * Debug mode:
 *   Click BOTH sticks at once   debug mode on / off
 *   Hold the LEFT stick in, then on the right controller:
 *     A  neighbor's view (V)       B  free camera (B)
 *     Trigger  teleport to the free camera (T)     Grip  freeze him (K)
 *     Stick up  waypoints (N)   down  keys/crowbar (L)   left/right  wrist panel (H)
 *   Free camera: left stick flies where you look, A/B (or X/Y) up/down,
 *   click the left stick for speed, right stick snap turns.
 */

const SNAP = Math.PI / 4;
const REACH = 2.5;
const $ = (id) => document.getElementById(id);

export class VR {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.session = null;
    this.input = { moveX: 0, moveY: 0, sprint: false, jump: false, crouch: false, fly: 0 };
    this.debugShift = false;
    this.freeTurn = 0;
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

  toast(text, ms = 3200) {
    if (this.toasts.some((t) => t.text === text)) return;
    this.toasts.push({ text, t: Math.max(2, ms / 1000) });
    if (this.toasts.length > 2) this.toasts.shift();
  }

  drawHud(dt) {
    const g = this.game;
    for (const t of this.toasts) t.t -= dt;
    this.toasts = this.toasts.filter((t) => t.t > 0);
    const n = g.neighbor;
    // Playing against a person (or as him), there's no awareness eye.
    const versus = g.online && g.mp.mode === 'versus';
    const chase = !versus && (n.state === 'chase' || n.state === 'openCloset');
    const aw = versus ? 0 : Math.round((chase ? 1 : n.awareness) * 20);
    const target = this.promptHand ? this.promptText(this.promptHand.target) : '';
    const caught = !$('caughtText').classList.contains('hidden');
    const ending = g.state === 'ending';
    const endText = ending && g.endInfo ? (g.endInfo.who === 'kids' ? 'TO BE CONTINUED...' : 'GAME OVER') : 'TO BE CONTINUED...';
    const held = g.player.held ? g.player.held.name : '';
    const banner = g.altView() ? g.debug.bannerText() : '';
    const shift = this.debugShift;
    const status = g.online && g.state !== 'menu' ? g.mpStatusText || '' : '';
    const skip = g.online ? g.skipText || '' : '';
    const lobby = g.state === 'menu' ? this.lobbyText() : null;
    const key = [aw, chase, target, caught, ending, endText, held, g.player.hidden ? 1 : 0, banner, shift, status, skip, lobby && lobby.join('/'), this.toasts.map((t) => t.text).join('|')].join('#');
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
    if (lobby) {
      // Waiting in the multiplayer lobby with the headset on.
      pill(lobby[0], 70, 40, '#fff', 'rgba(108,75,216,0.9)');
      lobby.slice(1).forEach((t, i) => pill(t, 150 + i * 50, 28));
      this.toasts.forEach((t, i) => pill(t.text, 420 + i * 44, 24));
    } else if (caught) {
      ctx.font = 'bold 150px Impact, Arial Black, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#a5391a';
      ctx.lineWidth = 10;
      ctx.strokeText('GOT YOU!', W / 2, H / 2);
      ctx.fillText('GOT YOU!', W / 2, H / 2);
    } else if (ending) {
      ctx.font = 'bold 90px Impact, Arial Black, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(endText, W / 2, H / 2);
      this.toasts.forEach((t, i) => pill(t.text, H / 2 + 100 + i * 44, 24));
    } else if (banner || shift) {
      // Debug camera / debug controls: say what the buttons do.
      if (banner) {
        const parts = banner.split('  ·  ');
        pill(parts[0], 60, 34, '#fff', 'rgba(30,60,140,0.85)');
        parts.slice(1).forEach((t, i) => pill(t, 118 + i * 44, 24));
      }
      if (shift) {
        const lines = ['DEBUG (right hand)', 'A: his view   ·   B: free camera', 'Trigger: teleport here   ·   Grip: freeze him', 'Stick: up waypoints · down keys · sideways panel'];
        lines.forEach((t, i) => pill(t, 300 + i * 50, i ? 26 : 30, i ? '#fff' : '#7fb2ff'));
      }
      this.toasts.forEach((t, i) => pill(t.text, 225 + i * 36, 22));
    } else {
      // Awareness eye bar.
      if (aw > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(W / 2 - 110, 18, 220, 16);
        ctx.fillStyle = chase ? '#ff3b30' : '#ffcc00';
        ctx.fillRect(W / 2 - 108, 20, (216 * aw) / 20, 12);
        if (chase) pill('HE SEES YOU - RUN!', 70, 34, '#fff', 'rgba(180,20,20,0.8)');
      }
      // Multiplayer: the score / your chore, and the "skipping chores" warning.
      if (skip) pill(`SKIPPING CHORES! Get back to ${skip}`, chase ? 120 : 70, 26, '#fff', 'rgba(200,30,30,0.9)');
      else if (status) pill(status.length > 70 ? `${status.slice(0, 68)}…` : status, chase ? 120 : 70, 22, '#fff', 'rgba(20,20,30,0.7)');
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
    const neighbor = g.role === 'neighbor';
    if (t.kid) return `Grip: GRAB ${t.kid.name}!`;
    if (t.item) {
      if (neighbor && t.item.important) return `${t.item.name} (you don't need that)`;
      return `Grip: grab ${t.item.name}   ·   Trigger: pick up`;
    }
    if (t.door) {
      const d = t.door;
      const lock = g.usableLock(d);
      if (lock) return lock.type === 'key' ? `Trigger: use ${g.player.held.name}` : 'Trigger: pry the boards off';
      if (d.locked && !d.open && g.hasKeys(g.player, d)) return `Trigger: unlock ${d.name} (your keys)`;
      if (d.locked && !d.open) return `${d.name} (${d.boarded ? 'boarded up' : 'locked'})`;
      return `Trigger: ${d.open ? 'close' : 'open'} ${d.name}`;
    }
    if (t.container) return `Trigger: ${t.container.open ? 'close' : 'open'} ${t.container.name}`;
    if (t.hide) return neighbor ? 'Trigger: search the wardrobe' : 'Trigger: hide inside';
    if (t.appliance) return `Trigger: turn ${t.appliance.on ? 'off' : 'on'} ${t.appliance.name}`;
    return '';
  }

  /** The HUD while waiting in the multiplayer lobby (null if there's no lobby). */
  lobbyText() {
    const mp = this.game.mp;
    if (!mp.inRoom) return ['Not in a game', 'Take the headset off to host or join one'];
    const names = [...mp.roster.values()].map((p) => p.name).join(', ');
    const mode = mp.mode === 'versus' ? 'Player neighbor' : 'Co-op';
    const lines = [`Room ${mp.net.code}  ·  ${mode}`, `${mp.roster.size} player${mp.roster.size === 1 ? '' : 's'}: ${names.length > 60 ? `${names.slice(0, 58)}…` : names}`];
    if (!mp.isHost) lines.push('Waiting for the host to start...');
    else if (mp.mode === 'versus' && mp.roster.size < 2) lines.push('Playing as the neighbor needs at least 2 players');
    else lines.push('Pull a trigger to START');
    return lines;
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
    g.camera.position.set(0, 0, 0);
    g.camera.rotation.set(0, 0, 0);
    g.camera.add(this.hud, this.fade, this.slats);
    // Flashlight in your left hand.
    const left = this.hand('left').controller;
    left.add(g.flashlight, g.flashlight.target);
    g.flashlight.position.set(0, 0, -0.05);
    if (g.player.held) this.attachHeld(g.player.held, this.hand('right'));
    // Put on in the multiplayer lobby: wait out on the street until the game starts.
    if (g.state === 'menu') g.player.spawn(g.spawnPoint(), 0);
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
    this.rig.position.set(p.ch.pos.x - ox, p.ch.pos.y + p.vrLift + p.camOffset.y * 0.5, p.ch.pos.z - oz);
  }

  /** Where you're looking, in the world: { yaw, pitch } (sent to the other players). */
  look() {
    const d = this.game.camera.getWorldDirection(this.tmp2);
    return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) };
  }

  /**
   * Your hands relative to your body, turned to match your head's yaw (so a
   * desktop player sees your avatar's arms where yours are): [lx, ly, lz, rx, ry, rz].
   */
  handsLocal(yaw) {
    const p = this.game.player.pos;
    const c = Math.cos(-yaw);
    const s = Math.sin(-yaw);
    const out = [];
    for (const side of ['left', 'right']) {
      const h = this.hand(side);
      const v = h.grip.getWorldPosition(this.tmp).sub(p);
      if (!h.source) v.set(side === 'left' ? -0.25 : 0.25, 0.75, 0); // not tracked: arm by your side
      out.push(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
    }
    return out.map((x) => Math.round(x * 100) / 100);
  }

  // ---------------------------------------------------------- update
  update(dt) {
    if (!this.active) return;
    const g = this.game;
    const p = g.player;
    if (g.state === 'menu') {
      this.updateLobby(dt);
      return;
    }
    this.rig.updateMatrixWorld(true);

    const alt = g.altView();
    const view = alt ? g.debug.view : 'player';
    if (!alt) this.dbgView = 'player';
    // Walking around your room moves your body too (and walls stop you).
    if (!alt && !p.hidden && !g.hideAnim && g.state === 'playing') {
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
    // Button presses this frame (tracked every frame so nothing fires late).
    const presses = (h, S) => ({
      trigger: edge(h, 'trigger', !!S.trigger),
      grip: edge(h, 'grip', !!S.grip),
      a: edge(h, 'a', !!S.a),
      b: edge(h, 'b', !!S.b),
    });
    const LP = presses(left, L);
    const RP = presses(right, R);

    // Stick clicks. Both at once: debug mode on/off. The left one held down
    // (with debug on) is the debug "shift" key. A quick left click: sprint.
    const l3 = !!L.stick;
    const r3 = !!R.stick;
    const both = l3 && r3;
    if (both && !this.bothSticks && g.state === 'playing') {
      g.toggleDebug();
      this.pulseBoth(0.5, 80);
    }
    this.bothSticks = both;
    if (l3 && !this.l3) {
      this.l3T = 0;
      this.l3Used = false;
    }
    if (l3) {
      this.l3T += dt;
      if (r3) this.l3Used = true;
    }
    if (!l3 && this.l3 && !this.l3Used && this.l3T < 0.45) this.input.sprint = !this.input.sprint;
    this.l3 = l3;
    const shift = l3 && !!g.debug && g.state === 'playing';
    this.debugShift = shift;

    const dead = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    this.input.moveX = shift ? 0 : dead(L.x || 0);
    this.input.moveY = shift ? 0 : dead(L.y || 0);
    if (!this.input.moveX && !this.input.moveY && !l3) this.input.sprint = false;
    this.input.fly = view === 'free' && !shift ? (R.a || L.a ? 1 : 0) - (R.b || L.b ? 1 : 0) : 0;
    if (!shift && !alt) {
      if (RP.a || LP.a) this.input.jump = true;
      if (RP.b) this.input.crouch = !this.input.crouch;
    }

    const rx = R.x || 0;
    const ry = R.y || 0;
    if (shift) {
      // Debug controls on the right hand.
      const act = (code) => {
        if (g.debug && g.debug.onKey(code)) this.pulse(right, 0.3, 40);
        this.l3Used = true;
      };
      if (RP.a) act('KeyV');
      if (RP.b) act('KeyB');
      if (RP.trigger) act('KeyT');
      if (RP.grip) act('KeyK');
      const m = Math.max(Math.abs(rx), Math.abs(ry));
      if (m > 0.7 && !this.dbgStick) {
        this.dbgStick = true;
        if (Math.abs(ry) > Math.abs(rx)) act(ry < 0 ? 'KeyN' : 'KeyL');
        else act('KeyH');
      } else if (m < 0.3) this.dbgStick = false;
      // Don't snap turn when you let go of the left stick with the right one still pushed.
      if (Math.abs(rx) > 0.3) this.turnHeld = true;
    }

    // Snap turn (in the free camera it turns the camera, not you).
    if (!shift && Math.abs(rx) > 0.7 && !this.turnHeld) {
      this.turnHeld = true;
      if (view === 'free') this.freeTurn -= Math.sign(rx) * SNAP;
      else if (!alt) p.yaw -= Math.sign(rx) * SNAP;
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
    const neighbor = g.role === 'neighbor';
    for (const h of this.hands) {
      if (!h.source || g.state !== 'playing' || alt || shift) {
        h.target = null;
        h.dot.visible = false;
        h.laser.visible = false;
        continue;
      }
      h.laser.visible = true;
      const origin = h.controller.getWorldPosition(new THREE.Vector3());
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(h.controller.getWorldQuaternion(new THREE.Quaternion()));
      let res = p.hidden ? null : g.findTarget(origin, dir);
      // Playing the neighbor: a kid within reach of your hand.
      if (neighbor && !p.held && (!res || !res.item)) {
        const kid = g.kidInReach(origin, dir);
        if (kid) res = { kid, dist: Math.min(REACH, kid.eye(this.tmp).distanceTo(origin)) };
      }
      h.origin = origin;
      h.dir = dir;
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
    for (const [h, P] of [[left, LP], [right, RP]]) {
      if (g.state !== 'playing' || alt) break;
      const S = h === left ? L : R;
      const holding = p.held && this.heldHand === h;
      // Squeezing the grip: whatever's in (or about to land in) this hand stays while you squeeze.
      if (P.grip) {
        h.gripHold = true;
        h.gripAt = g.time;
      }
      // Let go while swinging: throw (even mid debug-shift, so it never sticks to your hand).
      // (Online, the item lands in your hand a moment after you grab it. If you've already
      // let go by then, it goes straight away.)
      if (holding && h.gripHold && !S.grip) {
        this.throwFrom(h);
      } else if (!holding && !S.grip && g.time - (h.gripAt || 0) > 1.5) {
        h.gripHold = false;
      }
      if (shift) continue;
      if (P.trigger) {
        if (h.target && h.target.kid) {
          this.grabKid(h);
        } else if (h === left && !h.target && !p.hidden) {
          g.toggleFlashlight();
        } else if (neighbor && !h.target && !p.held && !p.hidden) {
          this.grabKid(h);
        } else {
          g.target = h.target;
          this.lastHand = h;
          // (Picked up with the trigger: it stays in your hand until you squeeze and let go.)
          if (!S.grip) h.gripHold = false;
          g.interact();
        }
      }
      // Grip: grab (as the neighbor, on nothing: grab whichever kid you're reaching for).
      if (P.grip && h.target && h.target.item) {
        g.target = h.target;
        this.lastHand = h;
        g.interact();
        this.pulse(h, 0.3, 40);
      } else if (P.grip && neighbor && !p.held && !p.hidden && (!h.target || h.target.kid)) {
        this.grabKid(h);
      }
    }

    // Heartbeat in your hands while he's after you.
    const hunter = this.hunterDistance();
    if (hunter < Infinity) {
      this.heartbeat -= dt;
      if (this.heartbeat <= 0) {
        this.pulseBoth(Math.min(1, 0.25 + 3 / Math.max(1, hunter)), 60);
        this.heartbeat = THREE.MathUtils.clamp(hunter / 12, 0.35, 0.9);
      }
    }

    this.slats.visible = !!p.hidden && !alt;
    this.fade.material.opacity = Number($('fade').style.opacity || 0);
    this.drawHud(dt);
  }

  // ------------------------------------------------------ debug cameras
  /** Put the play space so your head ends up at `head`, facing along `yaw`. */
  setRig(head, yaw) {
    const c = this.game.camera.position; // your head inside the play space
    const ox = c.x * Math.cos(yaw) + c.z * Math.sin(yaw);
    const oz = -c.x * Math.sin(yaw) + c.z * Math.cos(yaw);
    this.rig.rotation.set(0, yaw, 0);
    this.rig.position.set(head.x - ox, head.y - c.y, head.z - oz);
  }

  /** Your head's yaw inside the play space (i.e. ignoring snap turns). */
  localYaw() {
    const d = this.tmp2.set(0, 0, -1).applyQuaternion(this.game.camera.quaternion);
    return Math.atan2(-d.x, -d.z);
  }

  /**
   * Debug cameras in the headset (called by debug.js). You can't take the
   * camera away from a headset, so these move the play space instead and
   * leave your head free to look around.
   */
  debugCamera(dbg, dt) {
    const g = this.game;
    if (dbg.view !== this.dbgView) {
      this.dbgView = dbg.view;
      // Start off looking the way he's looking, whichever way you're facing in your room.
      this.povYawOffset = this.localYaw();
      this.freeTurn = 0;
    }
    this.rig.updateMatrixWorld(true);
    if (dbg.view === 'pov') {
      const n = g.neighbor;
      n.model.root.updateMatrixWorld(true);
      const eye = n.model.head.localToWorld(this.tmp.set(0, 0.28, 0.3));
      this.setRig(eye, n.heading + Math.PI - this.povYawOffset);
    } else if (dbg.view === 'free') {
      const head = this.headWorld(this.tmp);
      let yaw = this.rig.rotation.y;
      if (this.freeTurn) {
        yaw += this.freeTurn;
        this.freeTurn = 0;
      }
      // Fly towards where you're looking (including up/down).
      const fwd = g.camera.getWorldDirection(this.tmp2);
      const speed = (this.input.sprint ? 14 : 4) * dt;
      const mx = this.input.moveX;
      const my = -this.input.moveY;
      head.x += (fwd.x * my - fwd.z * mx) * speed;
      head.z += (fwd.z * my + fwd.x * mx) * speed;
      head.y += (fwd.y * my + this.input.fly) * speed;
      this.setRig(head, yaw);
      dbg.free.pos.copy(head);
      dbg.free.yaw = yaw;
      dbg.free.pitch = 0;
    }
    this.rig.updateMatrixWorld(true);
  }

  /**
   * How far away the neighbor is if he's after you (Infinity if he isn't):
   * the AI chasing you, or (playing against a person) him being close.
   */
  hunterDistance() {
    const g = this.game;
    const p = g.player;
    const n = g.neighbor;
    if (g.state !== 'playing' || g.role === 'neighbor') return Infinity;
    const d = n.pos.distanceTo(p.pos);
    if (g.online && g.mp.mode === 'versus') return d < 7 && g.onProperty(p.pos) ? d : Infinity;
    if (n.state !== 'chase') return Infinity;
    // Online, only when it's you he's chasing.
    if (g.online && !(g.mp.isHost ? n.focus === p : g.mp.wasChasingMe)) return Infinity;
    return d;
  }

  /** Playing the neighbor: grab whichever kid `hand` is reaching for. */
  grabKid(hand) {
    if (this.game.grabAt(hand.origin, hand.dir)) this.pulse(hand, 1, 200);
    else this.pulse(hand, 0.2, 30);
  }

  /** Waiting in the multiplayer lobby in the headset: stand on the street; the host can start. */
  updateLobby(dt) {
    const g = this.game;
    const mp = g.mp;
    this.placeRig();
    this.rig.updateMatrixWorld(true);
    for (const h of this.hands) {
      h.target = null;
      h.dot.visible = false;
      h.laser.visible = false;
      const gp = h.source && h.source.gamepad;
      const trig = !!(gp && gp.buttons[0] && gp.buttons[0].pressed);
      const press = trig && !h.pressed.trigger;
      h.pressed.trigger = trig;
      if (press && mp.inRoom && mp.isHost && !mp.started) {
        if (mp.mode === 'versus' && mp.roster.size < 2) this.toast('Playing as the neighbor needs at least 2 players.');
        else mp.hostStart();
      }
    }
    this.slats.visible = false;
    this.fade.material.opacity = 0;
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

  /** Let go: the item flies off with your hand's speed (online, the host takes it from there). */
  throwFrom(hand) {
    const g = this.game;
    const it = g.player.held;
    const pos = hand.grip.getWorldPosition(new THREE.Vector3());
    const vel = hand.vel.clone();
    const speed = vel.length();
    if (speed > 1.5) vel.multiplyScalar(1.35); // a little help: arms are shorter than they feel
    const thrown = speed > 2;
    this.heldHand = null;
    hand.gripHold = false;
    g.releaseAt(it, pos, vel, thrown);
    if (thrown) {
      g.sound.throwWhoosh();
      this.pulse(hand, 0.4, 50);
    }
  }
}
