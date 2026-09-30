import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Physics } from './physics.js';
import { buildWorld, SPAWN } from './world.js';
import { Nav } from './nav.js';
import { Player } from './player.js';
import { Neighbor } from './neighbor.js';
import { Sound } from './audio.js';
import { PRESETS, detectQuality, loadSetting, saveSetting, setMaterialQuality, adapt } from './quality.js';
import { randomSeed } from './rng.js';
import { Debug } from './debug.js';
import { Multiplayer } from './mp.js';

const REACH = 2.5;
// Things that block reaching for an item: walls, glass, closed cupboards (not doors, handled separately).
const blocksReach = (c) => c.kind !== 'door' && !(c.container && c.container.t > 0.3);
const $ = (id) => document.getElementById(id);
const V3 = (a) => new THREE.Vector3(Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0);

class Game {
  constructor() {
    this.state = 'menu';
    this.time = 0;
    this.playTime = 0;
    this.catches = 0;
    this.noises = [];
    this.pointerLockFailed = false;
    // Multiplayer (see mp.js): online once a game has started; the host is the authority.
    this.online = false;
    this.role = 'kid';
    this.menuOpen = false;
    this.stunned = 0;
    // Every visit is a different house; ?seed=123456 replays a specific one.
    const seedParam = Number(new URLSearchParams(window.location.search).get('seed'));
    this.seed = Number.isFinite(seedParam) && seedParam > 0 ? Math.floor(seedParam) : randomSeed();

    // ---- graphics settings
    this.detected = detectQuality();
    this.qualitySetting = loadSetting('quality', 'auto');
    this.quality = this.qualitySetting === 'auto' ? this.detected : this.qualitySetting;
    if (!PRESETS[this.quality]) this.quality = this.detected;
    this.showFps = loadSetting('fps', '0') === '1';

    // ---- renderer / scene
    // MSAA is expensive on integrated GPUs, so only the High preset asks for it
    // (it can only be chosen when the WebGL context is created).
    const renderer = new THREE.WebGLRenderer({ antialias: this.quality === 'high', powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    $('app').prepend(renderer.domElement);
    this.renderer = renderer;
    this.canvas = renderer.domElement;

    const scene = new THREE.Scene();
    const skyColor = new THREE.Color(0xa9d6f2);
    scene.background = skyColor;
    scene.fog = new THREE.Fog(skyColor, 50, 130);
    this.scene = scene;
    this.addSky();

    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 400);
    scene.add(this.camera);

    this.flashlight = new THREE.SpotLight(0xfff2d8, 0, 26, Math.PI / 7, 0.45, 1.4);
    this.flashlight.position.set(0.15, -0.1, 0);
    this.flashlight.target.position.set(0, 0, -1);
    this.camera.add(this.flashlight, this.flashlight.target);
    this.flashlightOn = false;

    // ---- systems
    this.sound = new Sound();
    this.physics = new Physics();
    this.world = buildWorld(scene, this.physics, this.seed);
    this.nav = new Nav(this.physics, this.world.navData);
    this.player = new Player(this.camera, this.physics, this.sound);
    this.player.id = 0;
    this.player.role = 'kid';
    this.neighbor = new Neighbor(scene, this.world.textures, this.physics, this.nav, this.sound);
    // Sounds of things happening in the world (everyone hears these in multiplayer).
    this.sfx = this.sound;
    this.world.items.forEach((it, i) => {
      it.idx = i;
      it.holder = -1;
    });
    this.world.doors.forEach((d, i) => { d.idx = i; });
    this.world.containers.forEach((c, i) => { c.idx = i; });
    this.world.appliances.forEach((a, i) => { a.idx = i; });
    this.world.hideSpots.forEach((h, i) => { h.idx = i; });
    const nd = this.world.navData;
    this.neighbor.setRoutes(nd.patrol, nd.home, nd.guard);
    // Chores he can actually walk to in this house.
    this.neighbor.setChores(this.world.stations.filter((st) => {
      if (!this.physics.circleFree(st.stand, 0.34)) return false;
      st.via = this.nav.approachTo(st.stand);
      return !!st.via;
    }));
    for (const el of document.querySelectorAll('.seedLabel')) el.textContent = `House #${this.seed}`;
    this.player.spawn(SPAWN, 0);

    this.raycaster = new THREE.Raycaster();
    // Only door panels are raycast as meshes; walls/glass use the (much cheaper) collision boxes.
    this.rayTargets = this.world.dynamicMeshes;
    this.target = null;
    this.shards = [];
    this.shardGeo = new THREE.BufferGeometry();
    this.shardGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.07, 0.02, 0, 0.02, 0.09, 0], 3));
    this.shardGeo.computeVertexNormals();
    this.shardMat = new THREE.MeshLambertMaterial({ color: 0xd8f0ff, transparent: true, opacity: 0.7, side: THREE.DoubleSide });

    const bad = this.nav.validate();
    if (bad.length) console.warn('[nav] blocked edges:', bad);

    this.frameCount = 0;
    this.perf = { acc: 0, frames: 0, calm: 0, cooldown: 0, fpsAcc: 0, fpsFrames: 0 };
    this.applyQuality(this.quality);

    this.bindInput();
    this.bindSettings();
    this.mp = new Multiplayer(this);
    window.addEventListener('resize', () => this.onResize());

    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());

    // Handy for debugging from the console.
    window.game = this;
  }

  addSky() {
    const geo = new THREE.SphereGeometry(300, 32, 16);
    const top = new THREE.Color(0x4f95d6);
    const mid = new THREE.Color(0xa9d6f2);
    const bot = new THREE.Color(0xdde9e6);
    const colors = [];
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const h = p.getY(i) / 300;
      const c = h > 0 ? mid.clone().lerp(top, Math.min(1, h * 1.6)) : mid.clone().lerp(bot, Math.min(1, -h * 4));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.scene.add(sky);
    this.sky = sky;
    // A few puffy clouds, merged into a single mesh (one draw call).
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const puffs = [];
    const cloud = new THREE.Object3D();
    const puff = new THREE.Object3D();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.3;
      const r = 160 + Math.random() * 60;
      cloud.position.set(Math.cos(a) * r, 55 + Math.random() * 35, Math.sin(a) * r);
      cloud.lookAt(0, cloud.position.y, 0);
      cloud.updateMatrix();
      for (let k = 0; k < 5; k++) {
        puff.position.set((k - 2) * 7 + Math.random() * 4, Math.random() * 4, Math.random() * 6);
        puff.scale.set(9 + Math.random() * 6, 5 + Math.random() * 3, 7 + Math.random() * 4);
        puff.updateMatrix();
        const g = new THREE.SphereGeometry(1, 10, 6);
        g.applyMatrix4(puff.matrix).applyMatrix4(cloud.matrix);
        puffs.push(g);
      }
    }
    const clouds = new THREE.Mesh(mergeGeometries(puffs, false), cloudMat);
    clouds.frustumCulled = false;
    sky.add(clouds);
  }

  // ============================================================= graphics
  applyQuality(name) {
    const q = PRESETS[name];
    this.quality = name;
    this.preset = q;
    const r = this.renderer;
    const dpr = window.devicePixelRatio || 1;
    this.maxScale = Math.min(dpr, q.maxScale);
    this.minScale = Math.min(this.maxScale, q.minScale);
    this.scale = this.maxScale;
    r.setPixelRatio(this.scale);
    r.setSize(window.innerWidth, window.innerHeight);

    setMaterialQuality(this.scene, q.standard);
    this.world.setLightSlots(q.lights);

    const sun = this.world.sun;
    const wantShadows = q.shadows;
    if (r.shadowMap.enabled !== wantShadows) {
      r.shadowMap.enabled = wantShadows;
      this.scene.traverse((o) => {
        if (o.material) o.material.needsUpdate = true;
      });
    }
    if (sun.shadow.mapSize.x !== q.shadowSize) {
      sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    }
    r.shadowMap.needsUpdate = true;

    for (const t of this.world.textureList) {
      if (t.anisotropy !== q.aniso) {
        t.anisotropy = q.aniso;
        t.needsUpdate = true;
      }
    }
    this.scene.fog.far = q.fogFar;
    this.scene.fog.near = q.fogFar * 0.4;
    this.camera.far = q.fogFar + 20;
    this.camera.updateProjectionMatrix();
    // The sky dome must stay inside the far plane.
    this.sky.scale.setScalar(Math.min(1, (q.fogFar + 10) / 300));
  }

  bindSettings() {
    const selects = document.querySelectorAll('.qualitySel');
    const checks = document.querySelectorAll('.fpsChk');
    const autoLabel = `Auto (${PRESETS[this.detected].label})`;
    for (const sel of selects) {
      sel.querySelector('option[value="auto"]').textContent = autoLabel;
      sel.value = this.qualitySetting;
      sel.addEventListener('change', () => {
        this.qualitySetting = sel.value;
        saveSetting('quality', sel.value);
        for (const other of selects) other.value = sel.value;
        const next = sel.value === 'auto' ? this.detected : sel.value;
        if ((next === 'high') !== (this.quality === 'high')) {
          this.toast('Anti-aliasing changes apply after a restart.');
        }
        this.applyQuality(next);
      });
    }
    for (const chk of checks) {
      chk.checked = this.showFps;
      chk.addEventListener('change', () => {
        this.showFps = chk.checked;
        saveSetting('fps', chk.checked ? '1' : '0');
        for (const other of checks) other.checked = chk.checked;
        $('fps').classList.toggle('hidden', !this.showFps);
      });
    }
    $('fps').classList.toggle('hidden', !this.showFps);
    const dbg = $('debugChk');
    dbg.checked = loadSetting('debug', '0') === '1';
    dbg.addEventListener('change', () => saveSetting('debug', dbg.checked ? '1' : '0'));
  }

  /**
   * Dynamic resolution: if frames take too long, render fewer pixels (the
   * browser upscales the canvas); creep back up when there is headroom.
   */
  updatePerformance(dt) {
    const p = this.perf;
    p.fpsAcc += dt;
    p.fpsFrames++;
    if (p.fpsAcc >= 0.5) {
      if (this.showFps) $('fps').textContent = `${Math.round(p.fpsFrames / p.fpsAcc)} FPS · ${Math.round(this.scale * 100)}%`;
      p.fpsAcc = 0;
      p.fpsFrames = 0;
    }
    if (this.state !== 'playing' && this.state !== 'menu') return;
    p.acc += dt;
    p.frames++;
    p.cooldown -= dt;
    if (p.acc < 1) return;
    const avg = (p.acc / p.frames) * 1000;
    p.acc = 0;
    p.frames = 0;
    let next = this.scale;
    if (avg > 24 && this.scale > this.minScale) {
      next = Math.max(this.minScale, this.scale - 0.1);
      p.cooldown = 8; // don't bounce straight back up
      p.calm = 0;
    } else if (avg < 18) {
      p.calm++;
      if (p.calm >= 3 && p.cooldown <= 0 && this.scale < this.maxScale) {
        next = Math.min(this.maxScale, this.scale + 0.05);
        p.calm = 0;
      }
    } else {
      p.calm = 0;
    }
    if (next !== this.scale) {
      this.scale = next;
      this.renderer.setPixelRatio(next);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
  }

  // ================================================================ input
  bindInput() {
    const p = this.player;
    this.drag = null;

    document.addEventListener('keydown', (e) => {
      // M: grab the mouse again (browsers sometimes refuse, e.g. right after Esc).
      if (e.code === 'KeyM' && !e.repeat && (this.state === 'playing' || this.state === 'paused')) {
        this.fixMouse();
        return;
      }
      if (this.state !== 'playing' || this.menuOpen) return;
      p.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'Backquote') {
        e.preventDefault();
        this.toggleDebug();
        return;
      }
      if (this.debug && this.debug.onKey(e.code)) {
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyE') this.interact();
      if (e.code === 'KeyQ' || e.code === 'KeyG') this.drop();
      if (e.code === 'KeyF') this.toggleFlashlight();
      if (e.code === 'KeyP') this.pause();
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => p.keys.delete(e.code));
    window.addEventListener('blur', () => p.keys.clear());

    // Mouse look goes to the debug cameras when they're active.
    const look = (dx, dy) => {
      if (this.debug && this.debug.look(dx, dy)) return;
      p.look(dx, dy);
    };
    document.addEventListener('mousemove', (e) => {
      if (this.state !== 'playing' || this.menuOpen) return;
      if (document.pointerLockElement === this.canvas) {
        // Browsers sometimes report a huge bogus delta right after locking.
        if (performance.now() - this.lockedAt < 120) return;
        if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
        look(e.movementX, e.movementY);
      } else if (this.drag) {
        look(e.clientX - this.drag.x, e.clientY - this.drag.y);
        this.drag.moved += Math.abs(e.clientX - this.drag.x) + Math.abs(e.clientY - this.drag.y);
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
      }
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing' || this.menuOpen) return;
      if (document.pointerLockElement === this.canvas) {
        if (e.button === 0) this.primary();
        if (e.button === 2) this.drop();
      } else {
        this.drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button, failed: this.pointerLockFailed };
        // Every click tries again, even if the browser said no before.
        this.lockPointer();
      }
    });
    window.addEventListener('mouseup', () => {
      // (A click that just got the mouse captured doesn't also throw.)
      if (this.drag && this.drag.moved < 6 && this.drag.failed && document.pointerLockElement !== this.canvas && this.state === 'playing') {
        if (this.drag.button === 0) this.primary();
        if (this.drag.button === 2) this.drop();
      }
      this.drag = null;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.lockedAt = 0;
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === this.canvas) {
        this.lockedAt = performance.now();
        if (this.pointerLockFailed) this.toast('Mouse captured.', 1500);
        this.pointerLockFailed = false;
        $('lockNote').classList.add('hidden');
      }
      if (document.pointerLockElement !== this.canvas && this.state === 'playing' && !this.pointerLockFailed) this.pause();
    });
    document.addEventListener('pointerlockerror', () => this.lockFailed());

    $('playBtn').addEventListener('click', () => this.start());
    $('resumeBtn').addEventListener('click', () => this.resume());
    for (const b of document.querySelectorAll('.leaveBtn')) b.addEventListener('click', () => this.mp.leave());
    // Same house again (keeps the seed in the URL) or a brand-new house.
    const replay = () => {
      this.allowLeave();
      window.location.search = `?seed=${this.seed}`;
    };
    const fresh = () => {
      this.allowLeave();
      window.location.href = window.location.pathname;
    };
    this.guardTab();
    $('restartBtn').addEventListener('click', replay);
    $('againBtn').addEventListener('click', replay);
    for (const b of document.querySelectorAll('.newHouseBtn')) b.addEventListener('click', fresh);
    $('sens').addEventListener('input', (e) => {
      p.sensitivity = 0.0022 * Number(e.target.value);
    });
    $('vol').addEventListener('input', (e) => this.sound.setVolume(Number(e.target.value)));
  }

  /**
   * Debug mode on/off (the ` key, or the title-screen checkbox). The tools are
   * built once and kept; `this.debug` is only set while they're switched on.
   */
  toggleDebug(on = !this.debug) {
    if (on && this.online && !(this.mp.isHost && this.mp.mode === 'coop')) {
      this.toast('Debug mode is only for the host of a co-op game.', 2200);
      return;
    }
    if (on && !this.debugTools) this.debugTools = new Debug(this);
    if (!this.debugTools) return;
    this.debugTools.setEnabled(on);
    this.debug = on ? this.debugTools : null;
    if (this.state === 'playing') this.toast(on ? 'Debug mode ON  (` to turn off)' : 'Debug mode OFF', 1500);
  }

  lockPointer() {
    if (document.pointerLockElement === this.canvas) return;
    try {
      const r = this.canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => this.lockFailed());
    } catch {
      this.lockFailed();
    }
  }

  /**
   * Stop Ctrl+W (easy to hit: Ctrl crouches, W walks) from closing the game.
   * Browsers never let a page swallow Ctrl+W outright, so:
   *  - while a game is going, closing the tab asks "Leave site?" first;
   *  - in fullscreen (Chrome/Edge), the Keyboard Lock API hands Ctrl+W to
   *    the game, so it does nothing at all;
   *  - other Ctrl shortcuts that clash with the controls (Ctrl+F find,
   *    Ctrl+D bookmark, Ctrl+S save...) are cancelled while playing.
   */
  guardTab() {
    this.leaving = false;
    window.addEventListener('beforeunload', (e) => {
      const inGame = this.state !== 'menu' && this.state !== 'won';
      if (this.leaving || !(inGame || this.mp.inRoom)) return;
      e.preventDefault();
      e.returnValue = '';
    });
    const clash = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyF', 'KeyQ', 'KeyG', 'KeyC', 'KeyP', 'KeyM', 'Space']);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && clash.has(e.code) && this.state !== 'menu') e.preventDefault();
    }, true);
    const checks = document.querySelectorAll('.fullChk');
    const sync = () => {
      const on = !!document.fullscreenElement;
      for (const c of checks) c.checked = on;
      if (on && navigator.keyboard && navigator.keyboard.lock) {
        navigator.keyboard.lock(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyF', 'KeyC']).catch(() => {});
      }
    };
    for (const c of checks) {
      if (!document.documentElement.requestFullscreen) c.parentElement.classList.add('hidden');
      c.addEventListener('change', () => {
        if (c.checked) document.documentElement.requestFullscreen().catch(() => sync());
        else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      });
    }
    document.addEventListener('fullscreenchange', sync);
  }

  /** Leaving on purpose (restart, new house, leave the game): no "Leave site?" prompt. */
  allowLeave() {
    this.leaving = true;
  }

  /** The browser refused to capture the mouse: drag to look until it works. */
  lockFailed() {
    if (document.pointerLockElement === this.canvas) return;
    if (!this.pointerLockFailed) this.toast('Mouse capture was blocked. Press M (or click) to try again. Until then, drag to look.', 4500);
    this.pointerLockFailed = true;
    $('lockNote').classList.remove('hidden');
  }

  /** M key: try to capture the mouse again (and close the pause menu). */
  fixMouse() {
    if (this.state === 'paused' || this.menuOpen) this.resume();
    else this.lockPointer();
  }

  start() {
    this.sound.init();
    if ($('debugChk').checked) this.toggleDebug(true);
    $('menu').classList.add('hidden');
    $('hud').classList.remove('hidden');
    this.state = 'playing';
    this.player.spawn(SPAWN, 0);
    this.lockPointer();
    this.toast("There's something strange going on across the street...");
  }

  /** Multiplayer game started (see mp.js). `role` is 'kid' or 'neighbor'. */
  startOnline(role) {
    this.sound.init();
    this.online = true;
    this.role = role;
    this.player.role = role;
    this.player.id = this.mp.myId;
    if (this.mp.isHost) {
      this.sfx = this.mp.shareSounds(this.sound);
      this.neighbor.sound = this.sfx;
    }
    $('menu').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('mpStatus').classList.remove('hidden');
    for (const el of document.querySelectorAll('.spOnly')) el.classList.add('hidden');
    for (const el of document.querySelectorAll('.mpOnly')) el.classList.remove('hidden');
    this.state = 'playing';
    const versus = this.mp.mode === 'versus';
    $('eye').classList.toggle('hidden', versus);
    if (role === 'neighbor') {
      // You ARE the neighbor: taller, a bit quicker, and you start at home.
      this.player.setBody({ standH: 1.95, standEye: 1.8, radius: 0.33, walk: 3.4, sprint: 6.0, canCrouch: false });
      this.player.spawn(this.nav.pos(this.world.navData.home), Math.PI);
      this.neighbor.model.root.visible = false;
      this.toast('You are the NEIGHBOR. Keep those kids out of your basement!', 4500);
      this.toast('Click: grab a kid · E on a wardrobe: search it', 6000);
      this.toast("You've got every key. When you hear a kid, you'll see where they were.", 7000);
    } else {
      this.player.spawn(this.spawnPoint(), 0);
      this.toast(versus ? 'One of your friends is the neighbor. Get into his basement!' : "There's something strange going on across the street...", 4000);
    }
    this.lockPointer();
  }

  /** Where you wake up: the street, spread out a little in multiplayer. */
  spawnPoint() {
    const p = SPAWN.clone();
    if (this.online) p.x += ((this.mp.myId % 5) - 2) * 0.8;
    return p;
  }

  pause() {
    if (this.state !== 'playing') return;
    if (this.online) {
      // Can't stop the world for everyone else: just show the menu.
      if (this.menuOpen) return;
      this.menuOpen = true;
      this.player.keys.clear();
      $('pause').classList.remove('hidden');
      if (document.pointerLockElement) document.exitPointerLock();
      return;
    }
    this.state = 'paused';
    this.player.keys.clear();
    $('pause').classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  resume() {
    if (this.menuOpen) {
      this.menuOpen = false;
      $('pause').classList.add('hidden');
      this.lockPointer();
      return;
    }
    if (this.state !== 'paused') return;
    $('pause').classList.add('hidden');
    this.state = 'playing';
    this.lastTime = performance.now();
    this.lockPointer();
  }

  onResize() {
    this.stillFrame = false;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ============================================================== helpers
  onProperty(p) {
    if (p.y < -0.5) return true;
    const y = this.world.yard;
    return p.x > y.x0 - 0.1 && p.x < y.x1 + 0.1 && p.z < y.z1 + 0.1 && p.z > y.z0 - 0.2;
  }

  /**
   * The neighbor never leaves his property (the fence has one gap, the front
   * gate). Pushes `ch` back inside; returns true if it had to.
   */
  keepOnProperty(ch) {
    if (ch.pos.y < -0.5) return false;
    const y = this.world.yard;
    const m = 0.35;
    const x = THREE.MathUtils.clamp(ch.pos.x, y.x0 + m, y.x1 - m);
    const z = THREE.MathUtils.clamp(ch.pos.z, y.z0 + m, y.z1 - m);
    if (x === ch.pos.x && z === ch.pos.z) return false;
    if (x !== ch.pos.x) ch.vel.x = 0;
    if (z !== ch.pos.z) ch.vel.z = 0;
    ch.pos.x = x;
    ch.pos.z = z;
    return true;
  }

  /** The closest point to `p` that the neighbor is allowed to walk to. */
  clampToProperty(p) {
    const out = p.clone();
    if (p.y < -0.5) return out;
    const y = this.world.yard;
    out.x = THREE.MathUtils.clamp(out.x, y.x0 + 0.4, y.x1 - 0.4);
    out.z = THREE.MathUtils.clamp(out.z, y.z0 + 0.4, y.z1 - 0.4);
    return out;
  }

  /** A noise the neighbor might hear. `by`: the player who made it, if any. */
  emitNoise(pos, radius, by = null, owner = by) {
    // `by`: whose body made it (footsteps, a door they opened: it tells where they are).
    // `owner`: who's responsible for it at all (also what they threw, dropped or switched on).
    this.noises.push({ pos: pos.clone(), radius, by, owner });
  }

  /** A message for one player (the local one, or sent to a remote one). */
  toastTo(player, text, ms) {
    if (this.online) this.mp.toastTo(player, text, ms);
    else this.toast(text, ms);
  }

  toast(text, ms = 3200) {
    const box = $('toasts');
    for (const t of box.children) if (t.textContent === text) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 600);
  }

  toggleFlashlight() {
    this.flashlightOn = !this.flashlightOn;
    this.flashlight.intensity = this.flashlightOn ? 40 : 0;
    if (this.sound.ok()) {
      const { node } = this.sound.out(null, 0.3);
      this.sound.noise(node, { dur: 0.03, type: 'highpass', freq: 3000, gain: 1 });
    }
  }

  // ========================================================= interaction
  findTarget() {
    const eye = this.camera.position;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    this.raycaster.set(eye, dir);
    this.raycaster.far = REACH + 1;
    const hit = this.raycaster.intersectObjects(this.rayTargets, false).find((h) => h.object.visible);
    const blockT = this.physics.raycast(eye, dir, REACH + 1, blocksReach);
    const hitT = hit && hit.distance < blockT + 0.05 ? hit.distance : Infinity;
    const wallT = Math.min(blockT, hitT);

    let best = null;
    let bestScore = Infinity;
    const v = new THREE.Vector3();
    for (const it of this.world.items) {
      if (it.held || it.consumed || (it.container && it.container.t < 0.5)) continue;
      v.subVectors(it.pos, eye);
      const t = v.dot(dir);
      if (t < 0.1 || t > REACH || t > wallT + it.radius) continue;
      const perp = v.addScaledVector(dir, -t).length();
      const tol = Math.max(0.2, it.radius + 0.12);
      if (perp > tol) continue;
      const score = t + perp * 4;
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }
    if (best) return { item: best };
    if (hitT <= REACH) {
      const u = hit.object.userData;
      if (u.door) return { door: u.door };
      if (u.container) return { container: u.container };
      if (u.hide) return { hide: u.hide };
      if (u.appliance) return { appliance: u.appliance };
    }
    return null;
  }

  updatePrompt() {
    const t = this.target;
    const el = $('prompt');
    let html = '';
    if (t && t.item) {
      html = `<kbd>E</kbd> ${this.player.held ? 'Swap for' : 'Pick up'} ${t.item.name}`;
    } else if (t && t.door) {
      const d = t.door;
      const lock = this.usableLock(d);
      if (lock) html = lock.type === 'key' ? `<kbd>E</kbd> Use ${this.player.held.name}` : '<kbd>E</kbd> Pry the boards off';
      else if (d.locked && !d.open && this.hasKeys(this.player, d)) html = `<kbd>E</kbd> Unlock ${d.name} <span style="color:#9be7a0">(your keys)</span>`;
      else if (d.locked && !d.open) html = `<kbd>E</kbd> ${d.name} <span style="color:#ff8a80">(${d.boarded ? 'boarded up' : 'locked'})</span>`;
      else html = `<kbd>E</kbd> ${d.open ? 'Close' : 'Open'} ${d.name}`;
    } else if (t && t.container) {
      html = `<kbd>E</kbd> ${t.container.open ? 'Close' : 'Open'} ${t.container.name}`;
    } else if (t && t.hide) {
      html = '<kbd>E</kbd> Hide inside';
    } else if (t && t.appliance) {
      html = `<kbd>E</kbd> Turn ${t.appliance.on ? 'off' : 'on'} ${t.appliance.name}`;
    }
    if (this.promptHtml !== html) {
      this.promptHtml = html;
      el.innerHTML = html;
      $('crosshair').classList.toggle('active', !!t);
    }
  }

  /** Playing as the neighbor: it's your house, you have every key (boards still stop you). */
  hasKeys(actor, d) {
    return actor.role === 'neighbor' && !d.boarded;
  }

  /** The lock on door `d` that the held item can remove, if any. */
  usableLock(d) {
    const held = this.player.held;
    if (!held || d.open) return null;
    return d.locks.find((l) => (l.type === 'key' && held.key === l.color) || (l.type === 'boards' && held.type === 'crowbar')) || null;
  }

  describeLocks(d) {
    if (d.frontLocked) return 'Locked tight. There must be another way in.';
    const keys = d.locks.filter((l) => l.type === 'key').map((l) => l.color);
    const parts = [];
    if (d.boarded) parts.push('boarded up');
    if (keys.length) parts.push(`padlocked (${keys.join(', ')})`);
    const text = parts.join(' and ');
    return `${text[0].toUpperCase()}${text.slice(1)}.`;
  }

  interact() {
    const p = this.player;
    if (this.hideAnim || this.altView() || this.stunned > 0) return;
    if (p.hidden) {
      this.leaveHiding();
      return;
    }
    const t = this.target;
    if (!t) return;
    if (t.item) {
      if (this.role === 'neighbor' && t.item.important) {
        this.toast("You don't need that. Catch those kids!", 1800);
        return;
      }
      this.request({ a: 'pick', i: t.item.idx });
      return;
    }
    if (t.container) {
      this.request({ a: 'cont', i: t.container.idx });
      return;
    }
    if (t.hide) {
      if (this.role === 'neighbor') this.request({ a: 'search', i: t.hide.idx });
      else this.hide(t.hide);
      return;
    }
    if (t.appliance) {
      this.request({ a: 'app', i: t.appliance.idx });
      return;
    }
    const d = t.door;
    if (d.locked && !d.open && !this.hasKeys(this.player, d)) {
      if (this.usableLock(d)) {
        this.request({ a: 'lock', i: d.idx });
      } else {
        this.sound.locked(d.center);
        this.toast(this.describeLocks(d));
      }
      return;
    }
    this.request({ a: 'door', i: d.idx });
  }

  /** Do something to the world: directly (single player / host) or by asking the host. */
  request(act) {
    if (!this.online || this.mp.isHost) this.applyAct(this.player, act);
    else this.mp.sendAct(act);
  }

  /**
   * The one place world changes happen (single player, or the multiplayer
   * host). `actor` is whoever did it: the local Player or a remote Peer.
   */
  applyAct(actor, act) {
    const w = this.world;
    const i = Number(act.i);
    switch (act.a) {
      case 'pick': {
        const it = w.items[i];
        if (!it || it.held || it.consumed || (it.container && it.container.t < 0.3)) return;
        if (actor.role === 'neighbor' && it.important) return;
        if (actor !== this.player && it.pos.distanceTo(actor.pos) > 5) return;
        this.grabItem(actor, it);
        break;
      }
      case 'rel': {
        const it = actor.held;
        if (!it || it.idx !== i) return;
        this.freeItem(actor, it, V3(act.p), V3(act.v), !!act.th, !!act.home);
        break;
      }
      case 'cont': {
        const c = w.containers[i];
        if (!c) return;
        c.open = !c.open;
        this.sfx.door(c.panel.getWorldPosition(new THREE.Vector3()), c.open);
        this.emitNoise(actor.pos, 2.5, actor);
        break;
      }
      case 'app': {
        const sw = w.appliances[i];
        if (sw) sw.switchedBy = actor;
        const app = w.appliances[i];
        if (app) this.setAppliance(app, !app.on);
        break;
      }
      case 'door': {
        const d = w.doors[i];
        if (!d || (d.locked && !d.open && !this.hasKeys(actor, d))) return;
        d.setOpen(!d.open);
        this.sfx.door(d.center, d.open);
        // Doors creak: the neighbor may hear it if he's close.
        this.emitNoise(d.center, 3.5, actor);
        this.neighbor.openedDoors.delete(d);
        break;
      }
      case 'lock':
        this.useLock(actor, w.doors[i]);
        break;
      case 'spot': {
        // Someone climbing in or out of a wardrobe (they animate it themselves).
        const h = w.hideSpots[i];
        const v = act.v ? 1 : 0;
        if (!h || h.target === v) return;
        h.target = v;
        if (actor !== this.player) {
          this.sound.door(h.out, v === 1);
          this.mp.shareSound('door', [h.out, v === 1], actor.id);
        }
        break;
      }
      case 'noise':
        if (Array.isArray(act.p)) this.emitNoise(V3(act.p), Math.min(30, Number(act.r) || 0), actor);
        break;
      case 'search':
        this.searchWardrobe(actor, w.hideSpots[i]);
        break;
      case 'grab':
        this.grabKid(actor, Number(act.id));
        break;
      case 'end':
        if (this.online && actor.role === 'kid') this.mp.finish('kids', actor);
        break;
      default:
        break;
    }
  }

  /** Unlock with the held key / pry off boards with the crowbar. */
  useLock(actor, d) {
    if (!d || !d.locked || d.open) return;
    const held = actor.held;
    const lock = held && d.locks.find((l) => (l.type === 'key' && held.key === l.color) || (l.type === 'boards' && held.type === 'crowbar'));
    if (!lock) return;
    d.removeLock(lock);
    if (lock.type === 'key') {
      this.freeItem(actor, held, held.pos, new THREE.Vector3(), false, false);
      held.consumed = true;
      held.mesh.visible = false;
      if (this.online) this.mp.soundTo(actor, 'unlock');
      else this.sound.unlock();
    } else {
      this.sfx.pry(d.center);
      this.emitNoise(d.center, 8, actor);
    }
    if (!d.locked) {
      d.setOpen(true);
      this.sfx.door(d.center, true);
    } else {
      this.toastTo(actor, `Still ${this.describeLocks(d).toLowerCase()}`);
    }
  }

  /** Versus: the neighbor player yanks a wardrobe open. Anyone inside is caught. */
  searchWardrobe(actor, spot) {
    if (!spot || actor.role !== 'neighbor') return;
    if (this.mp.cantCatch(actor)) return;
    spot.target = 1;
    this.sfx.door(spot.out, true);
    clearTimeout(spot.closeTimer);
    spot.closeTimer = setTimeout(() => {
      if (spot.target === 1 && ![this.player, ...this.mp.peers.values()].some((p) => p.hidden === spot)) {
        spot.target = 0;
        this.sfx.door(spot.out, false);
      }
    }, 1500);
    const inside = [this.player, ...this.mp.peers.values()].filter((p) => p.role === 'kid' && p.hidden === spot);
    if (!inside.length) this.toastTo(actor, 'Nobody in there.', 1500);
    for (const kid of inside) this.mp.catchPlayer(kid);
  }

  /** Versus: the neighbor player grabs a kid in front of them. */
  grabKid(actor, id) {
    if (!this.online || actor.role !== 'neighbor' || this.state === 'ending') return;
    const kid = id === this.mp.myId ? this.player : this.mp.peers.get(id);
    if (!kid || kid.role !== 'kid' || kid.hidden) return;
    if (this.mp.cantCatch(actor)) return;
    if ((kid === this.player && this.state === 'caught') || kid.caughtAnim) return;
    // Off his property (out on the street, or home): safe.
    if (!this.onProperty(kid.pos)) return;
    const dist = Math.hypot(kid.pos.x - actor.pos.x, kid.pos.z - actor.pos.z);
    if (dist > 2.6 || Math.abs(kid.pos.y - actor.pos.y) > 1.6) return;
    this.mp.catchPlayer(kid);
  }

  /** Left click: throw what you're holding (or, as the neighbor, grab a kid). */
  primary() {
    if (this.player.held || this.role !== 'neighbor') {
      this.throwHeld();
      return;
    }
    if (this.stunned > 0 || this.grabCooldown > this.time) return;
    const duty = this.mp.dutyView;
    if (duty && duty.sk && !(duty.h > 0)) {
      this.toast("You can't catch anyone while you're skipping your chores! Get back to them first.", 2500);
      return;
    }
    this.grabCooldown = this.time + 0.8;
    const eye = this.camera.position;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    let best = null;
    let bestD = 2.1;
    for (const peer of this.mp.peers.values()) {
      if (peer.role !== 'kid' || peer.hidden || peer.caughtAnim || !this.onProperty(peer.pos)) continue;
      const to = peer.eye(new THREE.Vector3()).sub(eye);
      to.y *= 0.5;
      const d = to.length();
      if (d < bestD && to.normalize().dot(dir) > 0.55) {
        best = peer;
        bestD = d;
      }
    }
    if (best) this.request({ a: 'grab', id: best.id });
    else this.sound.throwWhoosh();
  }

  // ------------------------------------------------------------- hiding
  /** Climb into a wardrobe: doors open, you step in and turn around, doors close (0.7 s). */
  hide(spot) {
    const p = this.player;
    if (this.hideAnim || p.hidden) return;
    p.keys.clear();
    p.ch.vel.set(0, 0, 0);
    p.crouching = false;
    this.hideAnim = { spot, dir: 'in', t: 0, from: p.ch.pos.clone(), yaw0: p.yaw, pitch0: p.pitch, seen: false };
    this.setSpot(spot, 1, spot.inside);
  }

  /** Your own wardrobe doors swinging (others hear it through the host). */
  setSpot(spot, v, at) {
    spot.target = v;
    this.sound.door(at, v === 1);
    if (this.online) {
      if (this.mp.isHost) this.mp.shareSound('door', [at, v === 1]);
      else this.mp.sendAct({ a: 'spot', i: spot.idx, v });
    }
  }

  /** Climb back out (0.5 s). */
  leaveHiding() {
    const p = this.player;
    const spot = p.hidden;
    if (!spot || this.hideAnim) return;
    p.hidden = null;
    if (!this.online || this.mp.isHost) this.neighbor.noteHidden(p, false);
    spot.setVisible(true);
    $('hideOverlay').classList.add('hidden');
    this.hideAnim = { spot, dir: 'out', t: 0, from: p.ch.pos.clone(), yaw0: p.yaw, pitch0: p.pitch };
    this.setSpot(spot, 1, spot.out);
  }

  updateHideAnim(dt) {
    const a = this.hideAnim;
    const p = this.player;
    const n = this.neighbor;
    const { spot } = a;
    a.t += dt;
    const ease = (x) => THREE.MathUtils.smoothstep(x, 0, 1);
    const turn = (from, to, k) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * k;
    if (a.dir === 'in') {
      // 0-0.25 doors swing open, 0.1-0.5 step in and turn round, 0.45-0.7 pull the doors shut.
      if (n.sees && n.focus === p) a.seen = true;
      const k = ease((a.t - 0.1) / 0.4);
      p.ch.pos.lerpVectors(a.from, spot.inside, k);
      p.yaw = turn(a.yaw0, spot.yaw, k);
      p.pitch = THREE.MathUtils.lerp(a.pitch0, -0.05, k);
      if (a.t > 0.45 && spot.target !== 0) this.setSpot(spot, 0, spot.inside);
      if (a.t >= 0.7) {
        this.hideAnim = null;
        p.hidden = spot;
        spot.setVisible(false);
        $('hideOverlay').classList.remove('hidden');
        // If he watched you climb in, he knows exactly where you are.
        if (!this.online || this.mp.isHost) n.noteHidden(p, a.seen || (n.focus === p && (n.sees || (n.state === 'chase' && n.lost < 0.8))));
      }
    } else {
      const k = ease((a.t - 0.08) / 0.3);
      p.ch.pos.lerpVectors(a.from, spot.out, k);
      if (a.t > 0.35 && spot.target !== 0) this.setSpot(spot, 0, spot.out);
      if (a.t >= 0.5) {
        this.hideAnim = null;
        p.ch.pos.copy(spot.out);
      }
    }
    p.ch.vel.set(0, 0, 0);
    p.syncCamera(dt);
  }

  /** The neighbor yanks open the wardrobe `player` is hiding in. */
  openCloset(spot, player = this.player) {
    spot.target = 1;
    if (player === this.player) {
      spot.setVisible(true);
      $('hideOverlay').classList.add('hidden');
    }
    this.sfx.door(spot.out, true);
    this.sfx.alert();
  }

  /** Host: a remote player finished climbing into a wardrobe. Did he see? */
  peerHid(peer) {
    const n = this.neighbor;
    if (this.mp.mode !== 'coop') return;
    const seen = n.focus === peer && (n.sees || (n.state === 'chase' && n.lost < 0.8) || this.time - (n.lastSeenAt || -9) < 0.8);
    n.noteHidden(peer, seen);
  }

  /** The neighbor (AI) caught someone. */
  neighborCaught(player) {
    this.neighbor.startGrab(player);
    if (this.online) this.mp.catchPlayer(player, player === this.player ? null : `He caught ${player.name}!`);
    else this.caught();
  }

  // --------------------------------------------------------- appliances
  setAppliance(app, on, byNeighbor = false) {
    this.setApplianceVisual(app, on);
    this.sound.click();
    if (byNeighbor && this.player.pos.distanceTo(app.pos) < 12) this.toast(`He switched off the ${app.name.toLowerCase()}.`, 2200);
  }

  setApplianceVisual(app, on) {
    app.on = on;
    app.timer = 0;
    if (app.kind === 'tv') app.mesh.material = adapt(on ? app.onMat : app.offMat);
  }

  updateAppliances(dt) {
    for (const app of this.world.appliances) {
      if (!app.on) continue;
      app.timer -= dt;
      if (app.timer <= 0) {
        app.timer = 1.4;
        this.sfx.appliance(app.pos, app.kind);
        // Loud enough to draw him over from anywhere in the house (unless he's the one watching).
        if (!app.byNeighbor) this.emitNoise(app.pos, 22, null, app.switchedBy || null);
      }
    }
  }

  /** Authority: `actor` now holds `it` (swapping out whatever they had). */
  grabItem(actor, it) {
    const old = actor.held;
    if (old) {
      const at = actor === this.player ? this.releasePose(true).pos : actor.pos.clone().setY(actor.pos.y + 0.9);
      this.freeItem(actor, old, at, new THREE.Vector3(), false, false);
    }
    it.held = true;
    it.holder = actor.id;
    it.lastHolder = actor;
    it.sleeping = true;
    it.thrown = false;
    it.vel.set(0, 0, 0);
    if (it.container) {
      it.container.item = null;
      it.container = null;
    }
    if (actor === this.player) {
      this.holdVisual(it);
    } else {
      actor.attachItem(it);
      it.holderPeer = actor;
    }
  }

  /** Authority: `actor` lets go of `it` at `pos` moving at `vel` (important items can go `home`). */
  freeItem(actor, it, pos, vel, thrown, home) {
    if (actor === this.player) {
      this.dropVisual(it);
    } else {
      actor.detachItem(it);
      it.holderPeer = null;
    }
    if (actor.held === it) actor.held = null;
    it.held = false;
    it.holder = -1;
    if (home && it.important) {
      it.resetHome();
      if (it.container) it.container.item = it;
      return;
    }
    it.pos.copy(pos);
    it.mesh.position.copy(pos);
    it.vel.copy(vel);
    it.sleeping = false;
    it.sleepTimer = 0;
    it.thrown = thrown;
    it.thrownBy = thrown ? actor : null;
    if (thrown) it.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
  }

  /** Show `it` in your hand. */
  holdVisual(it) {
    const p = this.player;
    p.held = it;
    it.held = true;
    it.mesh.visible = true;
    this.camera.add(it.mesh);
    const big = it.radius > 0.2;
    it.mesh.position.set(big ? 0.28 : 0.3, big ? -0.42 : -0.26, big ? -0.75 : -0.55);
    it.mesh.rotation.set(0.1, big ? 0.4 : -0.6, 0);
    it.mesh.scale.setScalar(big ? 0.75 : 1);
    it.mesh.traverse((o) => { o.castShadow = false; });
    if (it.important) {
      this.sound.keyPickup();
      this.toast(`Picked up: ${it.name}`, 2200);
    } else {
      this.sound.pickup();
    }
    $('held').innerHTML = `Holding: <b>${it.name}</b> &nbsp;·&nbsp; <kbd>Click</kbd> throw &nbsp;<kbd>Q</kbd> drop`;
  }

  /** Take `it` out of your hand and put it back in the world. */
  dropVisual(it) {
    const p = this.player;
    if (p.held === it) p.held = null;
    this.scene.add(it.mesh);
    it.mesh.scale.setScalar(1);
    it.mesh.rotation.set(0, p.yaw, 0);
    it.mesh.traverse((o) => { o.castShadow = true; });
    $('held').innerHTML = '';
  }

  /** Where something you let go of starts: just in front of you. */
  releasePose(gentle) {
    const p = this.player;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const pos = this.camera.position.clone().addScaledVector(dir, gentle ? 0.45 : 0.35);
    pos.y -= gentle ? 0.25 : 0.1;
    return { pos, dir, vel: new THREE.Vector3(p.ch.vel.x * 0.5, 0, p.ch.vel.z * 0.5) };
  }

  /** Let go of the held item: drop it, or throw it. */
  release(it, gentle, throwIt = false) {
    const p = this.player;
    if (p.held !== it) return;
    const { pos, dir, vel } = this.releasePose(gentle);
    if (throwIt) {
      vel.addScaledVector(dir, it.radius > 0.2 ? 10 : 14);
      vel.y += 1.5;
      this.sound.throwWhoosh();
    }
    if (!this.online || this.mp.isHost) {
      this.freeItem(p, it, pos, vel, throwIt, false);
      return;
    }
    // Client: the host simulates it from here on.
    this.mp.sendAct({ a: 'rel', i: it.idx, p: pos.toArray(), v: vel.toArray(), th: throwIt });
    this.mp.released.set(it.idx, this.time);
    this.dropVisual(it);
    it.held = false;
    it.pos.copy(pos);
    it.mesh.position.copy(pos);
    if (it.netPos) it.netPos.copy(pos);
  }

  /** True while a debug camera (neighbor's view / free cam) has the camera. */
  altView() {
    return !!(this.debug && this.debug.view !== 'player');
  }

  drop() {
    const it = this.player.held;
    if (!it || this.altView()) return;
    this.release(it, true);
  }

  throwHeld() {
    const it = this.player.held;
    if (!it || this.player.hidden || this.hideAnim || this.altView()) return;
    this.release(it, false, true);
  }

  breakWindow(win, dir, owner = null) {
    if (win.broken) return;
    if (this.online && this.mp.isHost) this.mp.net.toAll({ k: 'win', i: win.index, d: [dir.x, dir.y, dir.z] });
    win.broken = true;
    win.hide();
    win.collider.enabled = false;
    this.sound.glass(win.center);
    // (On other players' screens this is just the effect: the host hears it.)
    if (!this.online || this.mp.isHost) this.emitNoise(win.center, 30, null, owner);
    for (let i = 0; i < 22; i++) {
      const m = new THREE.Mesh(this.shardGeo, this.shardMat);
      const along = (Math.random() - 0.5) * win.w;
      const up = (Math.random() - 0.5) * win.h;
      if (win.axis === 'x') m.position.set(win.center.x + along, win.center.y + up, win.center.z);
      else m.position.set(win.center.x, win.center.y + up, win.center.z + along);
      m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const vel = dir.clone().normalize().multiplyScalar(1 + Math.random() * 3);
      vel.x += (Math.random() - 0.5) * 2;
      vel.z += (Math.random() - 0.5) * 2;
      vel.y += Math.random() * 1.5;
      this.scene.add(m);
      this.shards.push({ m, vel, spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, 0), resting: false });
    }
  }

  updateShards(dt) {
    for (const s of this.shards) {
      if (s.resting) continue;
      s.vel.y -= 20 * dt;
      s.m.position.addScaledVector(s.vel, dt);
      s.m.rotation.x += s.spin.x * dt;
      s.m.rotation.y += s.spin.y * dt;
      const g = this.physics.groundBelow(s.m.position.x, s.m.position.y + 0.3, s.m.position.z);
      if (s.m.position.y <= g + 0.01) {
        s.m.position.y = g + 0.01;
        s.m.rotation.x = -Math.PI / 2;
        s.resting = true;
      }
    }
  }

  updateItems(dt) {
    const nb = this.neighbor;
    for (const it of this.world.items) {
      if (it.held || it.consumed || it.sleeping) continue;
      const contact = this.physics.stepItem(
        it,
        dt,
        (c, speed) => {
          if (speed > 3.5 && c.ref && !c.ref.broken) {
            this.breakWindow(c.ref, it.vel, it.lastHolder || null);
            it.vel.multiplyScalar(0.6);
            return true;
          }
          return false;
        },
        (speed) => {
          if (speed > 2.2) {
            this.sfx.thud(it.pos, speed);
            this.emitNoise(it.pos, Math.min(14, speed * 1.4), null, it.lastHolder || null);
          }
        },
      );

      // Beaning the neighbor stuns him.
      if (it.thrown && it.vel.lengthSq() > 16 && it.thrownBy && it.thrownBy.role !== 'neighbor') {
        const dx = it.pos.x - nb.pos.x;
        const dz = it.pos.z - nb.pos.z;
        if (Math.hypot(dx, dz) < it.radius + 0.4 && it.pos.y > nb.pos.y && it.pos.y < nb.pos.y + 2.05) {
          if (this.online && this.mp.mode === 'versus') this.stunNeighborPlayer(it.thrownBy);
          else nb.hit(this, it.thrownBy || this.player);
          it.vel.x *= -0.3;
          it.vel.z *= -0.3;
          it.thrown = false;
        }
      }

      if (contact) {
        it.spin.multiplyScalar(0.85);
        if (it.vel.lengthSq() < 0.09) {
          it.sleepTimer += dt;
          if (it.sleepTimer > 0.25) {
            it.sleeping = true;
            it.thrown = false;
            it.vel.set(0, 0, 0);
            if (it.flat) it.mesh.rotation.set(0, it.mesh.rotation.y, 0);
          }
        } else {
          it.sleepTimer = 0;
        }
      }
      it.mesh.rotation.x += it.spin.x * dt;
      it.mesh.rotation.y += it.spin.y * dt;
      it.mesh.rotation.z += it.spin.z * dt;
      it.mesh.position.copy(it.pos);
      if (it.pos.y < -20) it.resetHome();
    }
  }

  // ========================================================= game events
  onSpotted(player = this.player) {
    if (player !== this.player) return; // they find out from the host's snapshot
    this.sound.setChase(true);
    this.toast('He spotted you! RUN!', 2000);
  }

  /** Versus: a kid beaned the neighbor player. */
  stunNeighborPlayer(by) {
    const nid = this.mp.neighborId;
    this.sfx.grunt(this.neighbor.pos);
    this.toastTo(by, 'Bonk! The neighbor is stunned for a moment.', 2000);
    if (nid === this.mp.myId) this.stunSelf();
    else this.mp.net.to(nid, { k: 'stun' });
  }

  /** Versus: you (the neighbor) got hit by something. */
  stunSelf() {
    this.stunned = 2.2;
    this.player.keys.clear();
    this.toast('Ouch! Stunned!', 1500);
  }

  caught() {
    if (this.state !== 'playing') return;
    if (this.debug) this.debug.setView('player');
    this.state = 'caught';
    this.caughtT = 0;
    this.catches++;
    this.player.keys.clear();
    this.sound.caught();
    this.sound.setChase(false);
    // Dragged out of a wardrobe (or grabbed mid-climb).
    const p = this.player;
    this.pulledFrom = null;
    if (this.hideAnim) {
      this.hideAnim.spot.setVisible(true);
      this.hideAnim.spot.target = 1;
      this.pulledFrom = this.hideAnim.spot;
      this.hideAnim = null;
    }
    if (p.hidden) {
      this.pulledFrom = p.hidden;
      p.hidden.setVisible(true);
      p.hidden.target = 1;
      p.hidden = null;
      $('hideOverlay').classList.add('hidden');
    }
    this.pullFrom = p.ch.pos.clone();
    this.shakeSeed = Math.random() * 100;
    // Keys and the crowbar go back where they came from.
    const held = this.player.held;
    if (held) {
      const { pos } = this.releasePose(true);
      if (!this.online || this.mp.isHost) {
        this.freeItem(p, held, pos, new THREE.Vector3(), false, true);
      } else {
        this.mp.sendAct({ a: 'rel', i: held.idx, p: pos.toArray(), v: [0, 0, 0], home: true });
        this.mp.released.set(held.idx, this.time);
        this.dropVisual(held);
        held.held = false;
      }
    }
  }

  /**
   * Getting caught: he lunges, grabs you, lifts you up and shakes you, then
   * everything goes black. ~1.8 s before the fade, 3.2 s in total.
   */
  updateCaught(dt) {
    const t0 = this.caughtT;
    this.caughtT += dt;
    const t = this.caughtT;
    const p = this.player;
    const n = this.neighbor;
    if (t0 < 0.3 && t >= 0.3) this.sound.grab();

    // Pulled out of the wardrobe towards him.
    if (this.pulledFrom) {
      // Dragged as far as the wardrobe doorway (he's standing right outside).
      const k = THREE.MathUtils.smoothstep(t, 0, 0.4) * 0.4;
      p.ch.pos.lerpVectors(this.pullFrom, this.pulledFrom.out, k);
    }

    // Snap your view to his face.
    const head = n.eye(new THREE.Vector3());
    const eye = p.eye(new THREE.Vector3());
    const dx = head.x - eye.x;
    const dz = head.z - eye.z;
    const dist = Math.hypot(dx, dz) || 1;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(head.y - eye.y - p.camOffset.y, dist);
    const turnK = Math.min(1, dt * 14);
    p.yaw += Math.atan2(Math.sin(yaw - p.yaw), Math.cos(yaw - p.yaw)) * turnK;
    p.pitch += (pitch - p.pitch) * turnK;

    // Lifted off your feet and shaken, then thrown down.
    const lift = THREE.MathUtils.smoothstep(t, 0.3, 0.75) * (1 - THREE.MathUtils.smoothstep(t, 1.3, 1.6));
    const shakeAmt = t < 0.3 ? 0.02 : t < 1.3 ? 0.06 : 0.02;
    const r = (k) => Math.sin(this.shakeSeed + t * (37 + k * 11)) * shakeAmt;
    p.camOffset.set((dx / dist) * 0.12 * lift + r(1), 0.4 * lift + r(2), (dz / dist) * 0.12 * lift + r(3));
    p.roll = t < 1.3 ? Math.sin(t * 25) * 0.06 * lift : THREE.MathUtils.lerp(0, 0.7, THREE.MathUtils.smoothstep(t, 1.3, 1.7));
    if (t > 1.3) p.pitch -= dt * 1.2;
    p.ch.vel.set(0, 0, 0);
    if (!this.pulledFrom) this.physics.moveCharacter(p.ch, dt);
    p.syncCamera(dt);

    const fade = $('fade');
    if (t > 1.35) fade.style.opacity = String(Math.min(1, (t - 1.35) * 2.2));
    if (t > 1.45) $('caughtText').classList.remove('hidden');
    if (t > 3.2) {
      $('caughtText').classList.add('hidden');
      p.spawn(this.spawnPoint(), 0);
      // (He resets himself: see Neighbor.startGrab.)
      if (!this.online) {
        for (const d of this.world.doors) {
          if (d.id === 'front') d.setOpen(false);
        }
        for (const h of this.world.hideSpots) h.target = 0;
      }
      for (const h of this.world.hideSpots) h.setVisible(true);
      this.pulledFrom = null;
      this.state = 'playing';
      this.fadeOut = 1;
      if (this.online) this.toast(this.mp.mode === 'versus' ? `Caught! The neighbor has ${this.mp.catches} / ${this.mp.catchTarget}.` : 'You woke up back home. Get back in there!');
      else if (this.catches === 1) this.toast('You woke up back home. Try again, quieter this time.');
      else if (this.catches === 3) this.toast('Tip: crouching (C) is silent, and wardrobes are good hiding places.', 5000);
      else this.toast('Caught again...');
    }
  }

  checkEnding() {
    const p = this.player.pos;
    const b = this.world.basement;
    if (this.role === 'kid' && p.y < -2.3 && p.z > b.z0 + 0.3 && p.x > b.x0 && p.x < b.x1) {
      if (this.online) {
        // The host tells everyone.
        if (!this.endSent) this.request({ a: 'end' });
        this.endSent = true;
        return;
      }
      this.state = 'ending';
      this.endT = 0;
      this.player.keys.clear();
      this.sound.setChase(false);
      this.sound.drone(7);
    }
  }

  /** Multiplayer game over (`who` won: 'kids' or 'neighbor'). */
  mpEnd(who, text) {
    if (this.state === 'ending' || this.state === 'won') return;
    if (this.hideAnim || this.player.hidden) {
      const spot = this.player.hidden || this.hideAnim.spot;
      spot.setVisible(true);
      this.player.hidden = null;
      this.hideAnim = null;
      $('hideOverlay').classList.add('hidden');
    }
    $('caughtText').classList.add('hidden');
    this.menuOpen = false;
    $('pause').classList.add('hidden');
    this.state = 'ending';
    this.endT = 0;
    this.endInfo = { who, text };
    this.player.keys.clear();
    this.sound.setChase(false);
    this.sound.drone(7);
    this.toast(text, 5000);
  }

  updateEnding(dt) {
    this.endT += dt;
    const p = this.player;
    // Slowly look around the room.
    p.yaw += dt * 0.25;
    p.pitch += (0 - p.pitch) * dt;
    p.syncCamera(dt);
    $('fade').style.opacity = String(Math.max(0, Math.min(1, (this.endT - 2.5) / 2.5)));
    if (this.endT > 5.2 && $('end').classList.contains('hidden')) {
      if (document.pointerLockElement) document.exitPointerLock();
      const secs = Math.floor(this.playTime);
      const mm = Math.floor(secs / 60);
      const ss = String(secs % 60).padStart(2, '0');
      $('stats').innerHTML = `House <b>#${this.seed}</b><br />Time: <b>${mm}:${ss}</b><br />Times caught: <b>${this.catches}</b>`;
      if (this.endInfo) {
        const lostIt = (this.endInfo.who === 'kids') === (this.role === 'neighbor');
        $('endTitle').innerHTML = this.endInfo.who === 'kids' ? 'TO BE<br />CONTINUED...' : 'GAME<br />OVER';
        $('endBlurb').textContent = `${this.endInfo.text} ${this.mp.mode === 'versus' ? (lostIt ? 'You lose!' : 'You win!') : ''}`;
        $('stats').innerHTML = `House <b>#${this.seed}</b><br />Time: <b>${mm}:${ss}</b><br />Kids caught: <b>${this.mp.catches}</b>`;
      }
      $('hud').classList.add('hidden');
      $('end').classList.remove('hidden');
      this.state = 'won';
    }
  }

  updateHUD() {
    if (this.online) this.updateMpStatus();
    // Only touch the DOM when something visibly changed (avoids per-frame layout work).
    const n = this.neighbor;
    const chase = n.state === 'chase';
    const alert = n.awareness > 0.05 || chase;
    const fill = Math.round((chase ? 1 : n.awareness) * 50) * 2;
    const key = `${alert}|${chase}|${fill}`;
    if (key === this.hudKey) return;
    this.hudKey = key;
    const eye = $('eye');
    eye.classList.toggle('alert', alert);
    eye.classList.toggle('chase', chase);
    $('eyeFill').style.width = `${fill}%`;
  }

  updateMpStatus() {
    const mp = this.mp;
    let text;
    if (mp.mode === 'versus') {
      const d = mp.dutyView;
      if (this.role === 'neighbor') {
        const score = `caught ${mp.catches} / ${mp.catchTarget}`;
        if (!d) text = `You're the NEIGHBOR · ${score}`;
        else if (d.h > 0) text = `HUNTING · ${d.h}s · ${score} · Click: grab · E: search wardrobes`;
        else if (d.sk) text = `Skipping: ${d.l} · ${score}`;
        else if (d.b > 0) text = `Break · ${d.b}s until your next chore · ${score} · Click: grab · E: search wardrobes`;
        else if (d.at) text = `Doing your chore: ${d.l} · ${d.t}s left · ${score}`;
        else text = `Chore: ${d.l} · follow the green marker · ${score}`;
      } else {
        text = `Kids caught: ${mp.catches} / ${mp.catchTarget} · get into the basement!`;
        if (mp.skipping) text = `The neighbor is skipping his chores: you can see him! · ${text}`;
      }
      if (this.stunned > 0) text = 'STUNNED!';
    } else {
      text = `Co-op · ${mp.roster.size} player${mp.roster.size === 1 ? '' : 's'} · room ${mp.net.code}`;
    }
    if (text !== this.mpStatusText) {
      this.mpStatusText = text;
      $('mpStatus').textContent = text;
    }
    // Skipping chores as the neighbor: hard to miss.
    const d = mp.dutyView;
    const skip = mp.mode === 'versus' && this.role === 'neighbor' && d && d.sk && !(d.h > 0) ? d.l : '';
    if (skip !== this.skipText) {
      this.skipText = skip;
      $('skipBanner').textContent = skip ? `⚠ SKIPPING CHORES: the kids can see you through walls and you can't catch anyone! Get back to ${skip}.` : '';
      $('skipBanner').classList.toggle('hidden', !skip);
      $('hud').classList.toggle('skipping', !!skip);
    }
  }

  /** Everyone the AI neighbor could notice right now. */
  aiPlayers() {
    const list = [];
    const ghost = this.debug && this.debug.view === 'free';
    if (this.state === 'playing' && !ghost && this.role === 'kid') list.push(this.player);
    if (this.online) {
      for (const peer of this.mp.peers.values()) if (peer.role === 'kid' && peer.seenState && !peer.caughtAnim) list.push(peer);
    }
    return list;
  }

  /** Whether this machine runs the neighbor's AI. */
  aiActive() {
    if (this.online) return this.mp.isHost && this.mp.mode === 'coop' && this.state !== 'ending' && this.state !== 'won';
    return this.state === 'playing' || this.state === 'caught';
  }

  // ================================================================ loop
  frame(hidden = false) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.time += dt;
    const p = this.player;

    if (this.state === 'menu') {
      // Slow establishing shot of the house while on the title screen.
      const a = Math.sin(this.time * 0.12) * 0.5;
      this.camera.position.set(Math.sin(a) * 9, 2.4, 6 + Math.cos(a) * 2);
      this.camera.lookAt(0, 4, -16);
      this.world.update(dt, this.camera.position);
      this.neighbor.update(dt, p, this);
    } else if (this.state === 'playing' || this.state === 'caught' || this.state === 'ending') {
      const playing = this.state === 'playing';
      if (playing) {
        this.playTime += dt;
        this.stunned = Math.max(0, this.stunned - dt);
        if (this.altView()) {
          // Your body stays put while a debug camera is active.
        } else if (this.hideAnim) {
          this.updateHideAnim(dt);
        } else if (p.hidden) {
          // Peeking out of a wardrobe: look around a little, no moving.
          let d = p.yaw - p.hidden.yaw;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          p.yaw = p.hidden.yaw + THREE.MathUtils.clamp(d, -1.1, 1.1);
          p.pitch = THREE.MathUtils.clamp(p.pitch, -0.6, 0.5);
          p.syncCamera(dt);
        } else if (this.stunned > 0) {
          // Seeing stars.
          p.ch.vel.set(0, p.ch.vel.y, 0);
          this.physics.moveCharacter(p.ch, dt);
          p.roll = Math.sin(this.time * 9) * 0.08 * Math.min(1, this.stunned);
          p.syncCamera(dt);
        } else {
          if (p.roll && !p.hidden) p.roll = 0;
          p.update(dt, (pos, r) => this.emitNoise(pos, r, p));
          // Playing the neighbor: you can't leave your property either.
          if (this.role === 'neighbor' && this.keepOnProperty(p.ch)) {
            p.syncCamera(0);
            if (!(this.fenceToast > this.time)) {
              this.fenceToast = this.time + 4;
              this.toast("You don't leave your property. Let them come to you.", 2200);
            }
          }
        }
      }
      this.world.update(dt, this.camera.position);
      // Online, the world keeps going for everyone else while you're caught.
      if (playing || this.online) {
        const authority = !this.online || this.mp.isHost;
        if (authority) {
          this.updateItems(dt);
          this.updateAppliances(dt);
        }
        // Things stashed in cupboards only show up once the door is open.
        for (const it of this.world.items) {
          if (it.container && !it.held) it.mesh.visible = it.container.t > 0.25;
        }
        for (const nz of this.noises) {
          if (!authority) {
            if (this.role === 'kid') this.mp.sendAct({ a: 'noise', p: nz.pos.toArray().map((v) => Math.round(v * 100) / 100), r: nz.radius });
            continue;
          }
          if (this.online && this.mp.mode === 'versus') {
            this.mp.neighborHears(nz);
            continue;
          }
          const heard = nz.pos.distanceTo(this.neighbor.pos) < nz.radius;
          if (heard && this.aiActive()) this.neighbor.hear(nz.pos, this, nz.radius);
          if (this.debug) this.debug.noise(nz.pos, nz.radius, heard);
        }
        this.noises.length = 0;
      }
      if (this.aiActive()) this.neighbor.update(dt, this.aiPlayers(), this);
      if (this.online) this.mp.update(dt);
      if (playing) {
        if (!this.online && this.neighbor.state !== 'chase') this.sound.setChase(false);
        if (this.online && this.mp.isHost && this.mp.mode === 'coop') this.sound.setChase(this.neighbor.state === 'chase');
        this.target = this.altView() ? null : this.findTarget();
        this.updatePrompt();
        this.updateHUD();
        this.checkEnding();
        if (p.pos.y < -20) p.spawn(this.spawnPoint(), 0);
        if (this.fadeOut > 0) {
          this.fadeOut = Math.max(0, this.fadeOut - dt * 1.5);
          $('fade').style.opacity = String(this.fadeOut);
        }
      } else if (this.state === 'caught') {
        this.updateCaught(dt);
      } else {
        this.updateEnding(dt);
      }
    }

    if (this.debug && this.state !== 'menu') this.debug.update(dt);
    // Hear from wherever the camera is (your head, his head, or the free camera).
    this.camera.getWorldDirection(this.tmpDir || (this.tmpDir = new THREE.Vector3()));
    this.sound.setListener(this.camera.position, Math.atan2(-this.tmpDir.x, -this.tmpDir.z));
    if (this.state === 'playing') this.sound.ambience(dt, p.pos.y < 0.2 && p.pos.y > -0.5);
    this.updateShards(dt);
    this.sky.position.copy(this.camera.position);
    if (hidden) return;
    // Nothing moves while paused or on the end screen: draw one frame, then idle the GPU.
    if (this.state === 'paused' || this.state === 'won') {
      if (this.stillFrame) return;
      this.stillFrame = true;
    } else {
      this.stillFrame = false;
    }
    // The sun never moves, so shadows only need refreshing for moving things
    // (the neighbor, doors, items) and not necessarily every frame.
    this.frameCount++;
    const every = this.preset.shadowEvery;
    if (every > 0 && this.frameCount % every === 0) this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    this.updatePerformance(dt);
  }
}

new Game();
