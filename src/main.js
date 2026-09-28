import * as THREE from 'three';
import { Physics } from './physics.js';
import { buildWorld, SPAWN } from './world.js';
import { Nav } from './nav.js';
import { Player } from './player.js';
import { Neighbor } from './neighbor.js';
import { Sound } from './audio.js';

const REACH = 2.5;
const $ = (id) => document.getElementById(id);

class Game {
  constructor() {
    this.state = 'menu';
    this.time = 0;
    this.playTime = 0;
    this.catches = 0;
    this.noises = [];
    this.flags = { sawBasementLock: false, sawBedroomLock: false };
    this.pointerLockFailed = false;

    // ---- renderer / scene
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.world = buildWorld(scene, this.physics);
    this.nav = new Nav(this.physics);
    this.player = new Player(this.camera, this.physics, this.sound);
    this.neighbor = new Neighbor(scene, this.world.textures, this.physics, this.nav, this.sound);
    this.player.spawn(SPAWN, 0);

    this.raycaster = new THREE.Raycaster();
    this.rayTargets = [...this.world.staticMeshes, ...this.world.dynamicMeshes];
    this.target = null;
    this.shards = [];
    this.shardGeo = new THREE.BufferGeometry();
    this.shardGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.07, 0.02, 0, 0.02, 0.09, 0], 3));
    this.shardGeo.computeVertexNormals();
    this.shardMat = new THREE.MeshStandardMaterial({ color: 0xd8f0ff, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.7, side: THREE.DoubleSide });

    const bad = this.nav.validate();
    if (bad.length) console.warn('[nav] blocked edges:', bad);

    this.bindInput();
    this.updateObjective();
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
    // A few puffy clouds.
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.92 });
    const cg = new THREE.SphereGeometry(1, 12, 8);
    for (let i = 0; i < 14; i++) {
      const cloud = new THREE.Group();
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.3;
      const r = 160 + Math.random() * 60;
      cloud.position.set(Math.cos(a) * r, 55 + Math.random() * 35, Math.sin(a) * r);
      for (let k = 0; k < 5; k++) {
        const puff = new THREE.Mesh(cg, cloudMat);
        puff.position.set((k - 2) * 7 + Math.random() * 4, Math.random() * 4, Math.random() * 6);
        puff.scale.set(9 + Math.random() * 6, 5 + Math.random() * 3, 7 + Math.random() * 4);
        cloud.add(puff);
      }
      cloud.lookAt(0, cloud.position.y, 0);
      this.scene.add(cloud);
    }
  }

  // ================================================================ input
  bindInput() {
    const p = this.player;
    this.drag = null;

    document.addEventListener('keydown', (e) => {
      if (this.state !== 'playing') return;
      p.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'KeyE') this.interact();
      if (e.code === 'KeyQ' || e.code === 'KeyG') this.drop();
      if (e.code === 'KeyF') this.toggleFlashlight();
      if (e.code === 'KeyP') this.pause();
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => p.keys.delete(e.code));
    window.addEventListener('blur', () => p.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (this.state !== 'playing') return;
      if (document.pointerLockElement === this.canvas) {
        // Browsers sometimes report a huge bogus delta right after locking.
        if (performance.now() - this.lockedAt < 120) return;
        if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
        p.look(e.movementX, e.movementY);
      } else if (this.drag) {
        p.look(e.clientX - this.drag.x, e.clientY - this.drag.y);
        this.drag.moved += Math.abs(e.clientX - this.drag.x) + Math.abs(e.clientY - this.drag.y);
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
      }
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing') return;
      if (document.pointerLockElement === this.canvas) {
        if (e.button === 0) this.throwHeld();
        if (e.button === 2) this.drop();
      } else {
        this.drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button };
        if (!this.pointerLockFailed) this.lockPointer();
      }
    });
    window.addEventListener('mouseup', () => {
      if (this.drag && this.drag.moved < 6 && this.pointerLockFailed && this.state === 'playing') {
        if (this.drag.button === 0) this.throwHeld();
        if (this.drag.button === 2) this.drop();
      }
      this.drag = null;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.lockedAt = 0;
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === this.canvas) this.lockedAt = performance.now();
      if (document.pointerLockElement !== this.canvas && this.state === 'playing' && !this.pointerLockFailed) this.pause();
    });
    document.addEventListener('pointerlockerror', () => {
      this.pointerLockFailed = true;
      $('lockNote').classList.remove('hidden');
      this.toast('Mouse capture is blocked here: drag to look, or open the game in its own browser tab.');
    });

    $('playBtn').addEventListener('click', () => this.start());
    $('resumeBtn').addEventListener('click', () => this.resume());
    $('restartBtn').addEventListener('click', () => window.location.reload());
    $('againBtn').addEventListener('click', () => window.location.reload());
    $('sens').addEventListener('input', (e) => {
      p.sensitivity = 0.0022 * Number(e.target.value);
    });
    $('vol').addEventListener('input', (e) => this.sound.setVolume(Number(e.target.value)));
  }

  lockPointer() {
    try {
      const r = this.canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => {});
    } catch {
      this.pointerLockFailed = true;
    }
  }

  start() {
    this.sound.init();
    $('menu').classList.add('hidden');
    $('hud').classList.remove('hidden');
    this.state = 'playing';
    this.player.spawn(SPAWN, 0);
    this.lockPointer();
    this.toast("There's something strange going on across the street...");
    setTimeout(() => this.toast("Get into the neighbor's basement. Don't let him catch you!"), 2500);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.player.keys.clear();
    $('pause').classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  resume() {
    if (this.state !== 'paused') return;
    $('pause').classList.add('hidden');
    this.state = 'playing';
    this.lastTime = performance.now();
    if (!this.pointerLockFailed) this.lockPointer();
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ============================================================== helpers
  onProperty(p) {
    if (p.y < -0.5) return true;
    return p.x > -14.1 && p.x < 14.1 && p.z < -5.9 && p.z > -30.2;
  }

  emitNoise(pos, radius) {
    this.noises.push({ pos: pos.clone(), radius });
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

  updateObjective() {
    const w = this.world;
    const basement = w.doorById('basement');
    const bedroom = w.doorById('bedroom');
    const heldKey = this.player.held && this.player.held.key;
    let text;
    if (!basement.locked) text = 'The basement is open. Go down there.';
    else if (heldKey === 'red') text = 'Use the red key on the basement door (under the stairs).';
    else if (!bedroom.locked) text = 'Search the upstairs bedroom for the red key.';
    else if (heldKey === 'blue') text = 'Find the door with the blue padlock (upstairs).';
    else if (this.flags.sawBedroomLock) text = 'Find a blue key for the upstairs bedroom.';
    else if (this.flags.sawBasementLock) text = 'The basement door has a red padlock. Search the house for a way in.';
    else text = "Get into the neighbor's basement.";
    if (text !== this.objective) {
      this.objective = text;
      $('objectiveText').textContent = text;
    }
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
    const hits = this.raycaster.intersectObjects(this.rayTargets, false);
    const first = hits.find((h) => h.object.visible);
    const wallT = first ? first.distance : Infinity;

    let best = null;
    let bestScore = Infinity;
    const v = new THREE.Vector3();
    for (const it of this.world.items) {
      if (it.held || it.consumed) continue;
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
    if (first && first.distance <= REACH && first.object.userData.door) return { door: first.object.userData.door };
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
      const heldKey = this.player.held && this.player.held.key;
      if (d.locked && d.key && heldKey === d.key) html = `<kbd>E</kbd> Unlock ${d.name}`;
      else if (d.locked && !d.open) html = `<kbd>E</kbd> ${d.name} <span style="color:#ff8a80">(locked)</span>`;
      else html = `<kbd>E</kbd> ${d.open ? 'Close' : 'Open'} ${d.name}`;
    }
    if (el.innerHTML !== html) el.innerHTML = html;
    $('crosshair').classList.toggle('active', !!t);
  }

  interact() {
    const t = this.target;
    if (!t) return;
    const p = this.player;
    if (t.item) {
      const old = p.held;
      if (old) this.release(old, true);
      this.pickUp(t.item);
      return;
    }
    const d = t.door;
    if (d.locked && !d.open) {
      if (d.key && p.held && p.held.key === d.key) {
        const key = p.held;
        this.release(key, false);
        key.consumed = true;
        key.mesh.visible = false;
        d.unlock();
        d.setOpen(true);
        this.sound.unlock();
        this.sound.door(d.center, true);
        this.toast(d.id === 'basement' ? 'The padlock falls away. The basement is open...' : 'Unlocked!');
      } else {
        this.sound.locked(d.center);
        if (d.id === 'basement') {
          this.flags.sawBasementLock = true;
          this.toast('Locked with a red padlock. The key must be somewhere in the house.');
        } else if (d.id === 'bedroom') {
          this.flags.sawBedroomLock = true;
          this.toast('Locked with a blue padlock.');
        } else if (d.id === 'front') {
          this.toast("The front door is locked. There must be another way in.");
        } else {
          this.toast('Locked.');
        }
      }
      this.updateObjective();
      return;
    }
    d.setOpen(!d.open);
    this.sound.door(d.center, d.open);
    // Doors creak: the neighbor may hear it if he's close.
    this.emitNoise(d.center, 3.5);
    this.neighbor.openedDoors.delete(d);
  }

  pickUp(it) {
    const p = this.player;
    p.held = it;
    it.held = true;
    it.sleeping = true;
    it.vel.set(0, 0, 0);
    this.camera.add(it.mesh);
    const big = it.radius > 0.2;
    it.mesh.position.set(big ? 0.28 : 0.3, big ? -0.42 : -0.26, big ? -0.75 : -0.55);
    it.mesh.rotation.set(0.1, big ? 0.4 : -0.6, 0);
    it.mesh.scale.setScalar(big ? 0.75 : 1);
    it.mesh.traverse((o) => { o.castShadow = false; });
    if (it.key) {
      this.sound.keyPickup();
      this.toast(it.key === 'blue' ? 'You found a blue key!' : 'You found a red key! That padlock on the basement door was red...');
    } else {
      this.sound.pickup();
    }
    $('held').innerHTML = `Holding: <b>${it.name}</b> &nbsp;·&nbsp; <kbd>Click</kbd> throw &nbsp;<kbd>Q</kbd> drop`;
    this.updateObjective();
  }

  /** Detach the held item from the camera into the world in front of the player. */
  release(it, gentle) {
    const p = this.player;
    if (p.held !== it) return;
    p.held = null;
    it.held = false;
    this.scene.add(it.mesh);
    it.mesh.scale.setScalar(1);
    it.mesh.traverse((o) => { o.castShadow = true; });
    const eye = this.camera.position.clone();
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    it.pos.copy(eye).addScaledVector(dir, gentle ? 0.45 : 0.35);
    it.pos.y -= gentle ? 0.25 : 0.1;
    it.mesh.position.copy(it.pos);
    it.mesh.rotation.set(0, p.yaw, 0);
    it.vel.set(p.ch.vel.x * 0.5, 0, p.ch.vel.z * 0.5);
    it.sleeping = false;
    it.sleepTimer = 0;
    it.thrown = false;
    $('held').innerHTML = '';
    this.updateObjective();
  }

  drop() {
    const it = this.player.held;
    if (!it) return;
    this.release(it, true);
  }

  throwHeld() {
    const it = this.player.held;
    if (!it) return;
    this.release(it, false);
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const power = it.radius > 0.2 ? 10 : 14;
    it.vel.addScaledVector(dir, power);
    it.vel.y += 1.5;
    it.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
    it.thrown = true;
    this.sound.throwWhoosh();
  }

  breakWindow(win, dir) {
    if (win.broken) return;
    win.broken = true;
    win.group.visible = false;
    win.collider.enabled = false;
    this.sound.glass(win.center);
    this.emitNoise(win.center, 30);
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
            this.breakWindow(c.ref, it.vel);
            it.vel.multiplyScalar(0.6);
            return true;
          }
          return false;
        },
        (speed) => {
          if (speed > 2.2) {
            this.sound.thud(it.pos, speed);
            this.emitNoise(it.pos, Math.min(14, speed * 1.4));
          }
        },
      );

      // Beaning the neighbor stuns him.
      if (it.thrown && it.vel.lengthSq() > 16) {
        const dx = it.pos.x - nb.pos.x;
        const dz = it.pos.z - nb.pos.z;
        if (Math.hypot(dx, dz) < it.radius + 0.4 && it.pos.y > nb.pos.y && it.pos.y < nb.pos.y + 2.05) {
          nb.hit(this, this.player);
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
  onSpotted() {
    this.sound.setChase(true);
    this.toast('He spotted you! RUN!', 2000);
  }

  caught() {
    if (this.state !== 'playing') return;
    this.state = 'caught';
    this.caughtT = 0;
    this.catches++;
    this.player.keys.clear();
    this.sound.caught();
    this.sound.setChase(false);
    const held = this.player.held;
    if (held) {
      this.release(held, true);
      if (held.key) held.resetHome();
    }
  }

  updateCaught(dt) {
    this.caughtT += dt;
    const p = this.player;
    const n = this.neighbor;
    // Turn to face him.
    const head = n.eye(new THREE.Vector3());
    const eye = p.eye(new THREE.Vector3());
    const dx = head.x - eye.x;
    const dz = head.z - eye.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(head.y - eye.y, Math.hypot(dx, dz));
    let dy = yaw - p.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    p.yaw += dy * Math.min(1, dt * 8);
    p.pitch += (pitch - p.pitch) * Math.min(1, dt * 8);
    p.ch.vel.set(0, p.ch.vel.y, 0);
    this.physics.moveCharacter(p.ch, dt);
    p.syncCamera(dt);

    const fade = $('fade');
    if (this.caughtT > 0.9) {
      fade.style.opacity = String(Math.min(1, (this.caughtT - 0.9) * 2));
      $('caughtText').classList.remove('hidden');
    }
    if (this.caughtT > 3.2) {
      $('caughtText').classList.add('hidden');
      p.spawn(SPAWN, 0);
      n.reset();
      for (const d of this.world.doors) {
        if (d.id === 'front') d.setOpen(false);
      }
      this.state = 'playing';
      this.fadeOut = 1;
      if (this.catches === 1) this.toast('You woke up back home. Try again, quieter this time.');
      else if (this.catches === 3) this.toast("Hint: he eats at his kitchen table. Maybe he left something there.", 5000);
      else if (this.catches === 5) this.toast('Hint: crouching (C) makes you silent and harder to spot.', 5000);
      else this.toast('Caught again...');
    }
  }

  checkEnding() {
    const p = this.player.pos;
    if (p.y < -2.3 && p.z > -14.2 && p.x > -8 && p.x < 2) {
      this.state = 'ending';
      this.endT = 0;
      this.player.keys.clear();
      this.sound.setChase(false);
      this.sound.drone(7);
    }
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
      $('stats').innerHTML = `Time: <b>${mm}:${ss}</b><br />Times caught: <b>${this.catches}</b>`;
      $('hud').classList.add('hidden');
      $('end').classList.remove('hidden');
      this.state = 'won';
    }
  }

  updateHUD() {
    const n = this.neighbor;
    const eye = $('eye');
    const chase = n.state === 'chase';
    eye.classList.toggle('alert', n.awareness > 0.05 || chase);
    eye.classList.toggle('chase', chase);
    $('eyeFill').style.width = `${Math.round((chase ? 1 : n.awareness) * 100)}%`;
  }

  // ================================================================ loop
  frame() {
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
      this.world.update(dt);
      this.neighbor.update(dt, p, this);
    } else if (this.state === 'playing') {
      this.playTime += dt;
      p.update(dt, (pos, r) => this.emitNoise(pos, r));
      this.world.update(dt);
      this.updateItems(dt);
      for (const nz of this.noises) {
        if (nz.pos.distanceTo(this.neighbor.pos) < nz.radius) this.neighbor.hear(nz.pos, this);
      }
      this.noises.length = 0;
      this.neighbor.update(dt, p, this);
      if (this.neighbor.state !== 'chase') this.sound.setChase(false);
      this.target = this.findTarget();
      this.updatePrompt();
      this.updateHUD();
      this.checkEnding();
      if (p.pos.y < -20) p.spawn(SPAWN, 0);
      if (this.fadeOut > 0) {
        this.fadeOut = Math.max(0, this.fadeOut - dt * 1.5);
        $('fade').style.opacity = String(this.fadeOut);
      }
    } else if (this.state === 'caught') {
      this.world.update(dt);
      this.neighbor.update(dt, p, this);
      this.updateCaught(dt);
    } else if (this.state === 'ending') {
      this.world.update(dt);
      this.updateEnding(dt);
    } else if (this.state === 'won') {
      this.world.update(dt);
    }

    if (this.state !== 'menu') this.sound.setListener(this.camera.position, p.yaw);
    else this.sound.setListener(this.camera.position, 0);
    if (this.state === 'playing') this.sound.ambience(dt, p.pos.y < 0.2 && p.pos.y > -0.5);
    this.updateShards(dt);
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}

new Game();
