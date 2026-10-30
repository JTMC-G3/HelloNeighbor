/*
 * TAS mode: record your run in slow motion, play it back at full speed.
 *
 * The game is stepped in fixed 1/60 s ticks while a TAS is being recorded or played, so a run
 * is just the keys held, where you were looking and the one-off actions (E, throw, drop, torch)
 * on each tick. Recording slows the clock down (scroll wheel, down to 1/100 speed) so you can line up hops and
 * throws; playback runs the same ticks at any speed (1/100x to 4x). The house is rebuilt from the same seed
 * and the game's randomness is seeded, so it comes out the same every time.
 *
 * Y: open / close TAS mode   scroll or [ ]: slower / faster   U: record / stop   I: play back
 * \ : freeze   . : advance one tick while frozen   (Save / Load buttons in the panel)
 */
import * as THREE from 'three';

export const TICK = 1 / 60;
const VIEW_W = 260; // the rear view, top right (CSS pixels)
const VIEW_H = 160;
const MIN_SPEED = 0.01; // 1/100 speed
const MAX_PLAY = 4; // playback can also be sped up
const SNAP = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4];
const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const EVENTS = ['interact', 'drop', 'primary', 'toggleFlashlight'];
const round = (v) => Math.round(v * 1e5) / 1e5;

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TAS {
  constructor(game) {
    this.game = game;
    this.on = false; // panel open
    this.mode = 'idle'; // idle | recording | playing
    this.speed = 0.25; // recording speed
    this.playSpeed = 1; // playback speed
    this.ticks = []; // [keys, yaw, pitch, events]
    this.house = null; // the seed the recording belongs to
    this.pending = [];
    this.acc = 0;
    this.last = 0;
    this.frozen = false;
    this.stepOnce = false;
    this.pos = 0;
    this.realRandom = Math.random;

    // Record the one-off actions by wrapping the Game methods that handle them.
    this.orig = {};
    for (const name of EVENTS) {
      this.orig[name] = game[name].bind(game);
      game[name] = (...a) => {
        if (this.mode === 'recording') {
          // (Where the camera was too: throws and drops start from it, and it's smoothed, so it isn't just yaw and pitch.)
          const c = game.camera.position;
          this.pending.push([name, round(game.player.yaw), round(game.player.pitch), round(c.x), round(c.y), round(c.z)]);
        }
        return this.orig[name](...a);
      };
    }

    // Rear view: a second camera at the player's head looking straight back (his body, not the mouse).
    this.rear = new THREE.PerspectiveCamera(80, VIEW_W / VIEW_H, 0.05, 400);
    this.rear.rotation.order = 'YXZ';
    this.buildPanel();
    document.addEventListener('keydown', (e) => this.onKey(e), true);
    document.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  /** True while the clock is ours (recording or playing back). */
  get driving() {
    return this.mode !== 'idle';
  }

  /** The game ignores your keyboard and mouse while a recording plays back. */
  get blocking() {
    return this.mode === 'playing';
  }

  buildPanel() {
    const el = document.createElement('div');
    el.id = 'tasPanel';
    el.className = 'hidden';
    el.style.cssText = `position:fixed;top:${VIEW_H + 24}px;right:12px;z-index:30;min-width:260px;padding:10px 12px;border-radius:8px;background:rgba(10,10,16,0.82);color:#e8e8f0;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;pointer-events:auto;`;
    el.innerHTML = '<div id="tasInfo"></div><div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button id="tasSave">Save</button><button id="tasLoad">Load</button><input id="tasFile" type="file" accept=".json,application/json" style="display:none" /></div>';
    document.body.appendChild(el);
    // A frame and label drawn over the rear view.
    const frame = document.createElement('div');
    frame.className = 'hidden';
    frame.style.cssText = `position:fixed;top:12px;right:12px;width:${VIEW_W}px;height:${VIEW_H}px;box-sizing:border-box;border:2px solid #8ab4ff;border-radius:4px;z-index:29;pointer-events:none;color:#8ab4ff;font:11px ui-monospace,Menlo,Consolas,monospace;`;
    frame.innerHTML = '<span style="position:absolute;left:5px;top:3px;text-shadow:0 0 3px #000">BEHIND YOU</span>';
    document.body.appendChild(frame);
    this.frame = frame;
    this.panel = el;
    this.info = el.querySelector('#tasInfo');
    for (const b of el.querySelectorAll('button')) b.style.cssText = 'padding:3px 10px;border-radius:5px;border:1px solid #556;background:#223;color:#e8e8f0;cursor:pointer;font:inherit';
    el.querySelector('#tasSave').addEventListener('click', () => this.save());
    el.querySelector('#tasLoad').addEventListener('click', () => el.querySelector('#tasFile').click());
    el.querySelector('#tasFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) f.text().then((t) => this.load(t));
      e.target.value = '';
    });
    this.refresh();
  }

  allowed() {
    const g = this.game;
    return !g.online && !g.vr.active && g.state !== 'menu';
  }

  onKey(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const g = this.game;
    if (e.code === 'KeyY') {
      if (!this.allowed()) {
        if (g.state !== 'menu') g.toast('TAS mode is single player only.', 1800);
        return;
      }
      e.stopPropagation();
      this.setOn(!this.on);
      return;
    }
    if (!this.on) return;
    const key = {
      BracketLeft: () => this.setSpeed(-1),
      BracketRight: () => this.setSpeed(1),
      KeyU: () => (this.mode === 'recording' ? this.stop() : this.record()),
      KeyI: () => this.play(),
      Backslash: () => { this.frozen = !this.frozen; this.refresh(); },
      Period: () => { if (this.frozen) this.stepOnce = true; },
    }[e.code];
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    key();
  }

  setOn(on) {
    this.on = on;
    if (!on) this.stop(true);
    this.panel.classList.toggle('hidden', !on);
    this.frame.classList.toggle('hidden', !on);
    this.game.toast(on ? 'TAS mode ON: U record (slow-mo), I play back, [ ] speed, Y to leave' : 'TAS mode OFF', 2600);
    this.refresh();
  }

  /** [ ] step through the presets; the scroll wheel changes it smoothly (see onWheel). */
  setSpeed(d) {
    const play = this.mode === 'playing';
    const cur = play ? this.playSpeed : this.speed;
    const snaps = play ? SNAP : SNAP.filter((v) => v <= 1);
    let i = snaps.findIndex((v) => v >= cur - 1e-9);
    if (i < 0) i = snaps.length - 1;
    // On a preset: step to the next one. Between two (after scrolling): go to the one above or below.
    const exact = Math.abs(snaps[i] - cur) < 1e-9;
    const next = snaps[Math.max(0, Math.min(snaps.length - 1, exact ? i + d : d < 0 ? i - 1 : i))];
    if (play) this.playSpeed = next;
    else this.speed = next;
    this.refresh();
  }

  onWheel(e) {
    if (!this.on) return;
    e.preventDefault();
    // Scroll up = faster, down = slower, about 12% a notch. While a recording plays back it changes
    // the playback speed (1/100x to 4x); otherwise the speed you record at (1/100x to 1x).
    const f = Math.pow(1.12, -Math.sign(e.deltaY));
    const play = this.mode === 'playing';
    let v = (play ? this.playSpeed : this.speed) * f;
    v = Math.min(play ? MAX_PLAY : 1, Math.max(MIN_SPEED, v));
    if (Math.abs(v - 1) < 0.02) v = 1;
    if (play) this.playSpeed = v;
    else this.speed = v;
    this.refresh();
  }

  // ----------------------------------------------------------- start / stop
  begin(mode) {
    const g = this.game;
    this.stop(true);
    // Same seed, same randomness, same house, fresh world: so a playback starts exactly like the recording did.
    this.seed = g.seed >>> 0;
    Math.random = mulberry(this.seed ^ 0x9e3779b9);
    this.starting = true;
    g.restartWorld();
    this.starting = false;
    Math.random = mulberry(this.seed ^ 0x9e3779b9);
    g.time = 0;
    this.pending = [];
    this.acc = 0;
    this.last = performance.now();
    this.pos = 0;
    this.frozen = false;
    this.mode = mode;
    g.player.keys.clear();
  }

  record() {
    if (!this.allowed()) return;
    this.begin('recording');
    this.ticks = [];
    this.house = this.game.seed;
    this.game.toast(`Recording at ${this.speed.toFixed(3)}x. U to stop.`, 2000);
    this.refresh();
  }

  play() {
    if (!this.ticks.length) {
      this.game.toast('Nothing recorded yet (U), or Load a file.', 2000);
      return;
    }
    if (this.house !== this.game.seed) {
      this.game.toast(`That run is for house #${this.house}. Visit it first (this is #${this.game.seed}).`, 3500);
      return;
    }
    if (!this.allowed()) return;
    this.begin('playing');
    this.game.toast(`Playing back at ${this.playSpeed}x (scroll to change).`, 1800);
    this.refresh();
  }

  /** Stop recording / playback. `quiet`: don't announce. */
  stop(quiet = false) {
    const was = this.mode;
    if (was === 'idle') return;
    this.mode = 'idle';
    Math.random = this.realRandom;
    this.game.player.keys.clear();
    if (!quiet) {
      const secs = (this.ticks.length * TICK).toFixed(3);
      this.game.toast(was === 'recording' ? `Recorded ${this.ticks.length} ticks (${secs} s). I plays it back.` : 'Playback stopped.', 3000);
    }
    this.refresh();
  }

  // ------------------------------------------------------------------ clock
  /** Called by the animation loop instead of Game.frame while recording / playing. */
  drive() {
    const g = this.game;
    const now = performance.now();
    const real = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (g.state !== 'playing') {
      g.frame();
      return;
    }
    const scale = this.mode === 'playing' ? this.playSpeed : this.speed;
    this.acc = Math.min(TICK * 10, this.acc + real * scale);
    let n = 0;
    if (this.frozen) {
      this.acc = 0;
      if (this.stepOnce) {
        this.stepOnce = false;
        n = 1;
      }
    } else {
      while (this.acc >= TICK && n < 10) {
        this.acc -= TICK;
        n++;
      }
    }
    for (let i = 0; i < n && this.mode !== 'idle'; i++) {
      this.beforeTick();
      g.frame(false, TICK, i < n - 1);
      if (this.mode === 'playing' && this.pos >= this.ticks.length) {
        this.stop(true);
        g.toast(`Playback finished: ${(this.ticks.length * TICK).toFixed(3)} s`, 3500);
        break;
      }
      if (this.mode === 'recording' && (g.state === 'ending' || g.state === 'won')) {
        this.stop();
        break;
      }
    }
    if (n === 0 && this.mode !== 'idle') {
      // Between ticks: keep the view smooth (mouse look in slow motion) and draw.
      if (this.mode === 'recording') g.player.syncCamera(0);
      g.renderer.render(g.scene, g.camera);
      this.renderRear();
    }
    if (now - (this.lastInfo || 0) > 100) {
      this.lastInfo = now;
      this.refresh();
    }
  }

  beforeTick() {
    const g = this.game;
    const p = g.player;
    if (this.mode === 'recording') {
      p.yaw = round(p.yaw);
      p.pitch = round(p.pitch);
      const keys = [...p.keys].filter((k) => KEYS.has(k)).sort().join(',');
      this.ticks.push([keys, p.yaw, p.pitch, this.pending]);
      this.pending = [];
      this.pos = this.ticks.length;
    } else if (this.mode === 'playing') {
      const [keys, yaw, pitch, events] = this.ticks[this.pos++];
      for (const [name, y, pt, cx, cy, cz] of events) {
        const camY = p.camY;
        p.yaw = y;
        p.pitch = pt;
        p.syncCamera(0);
        if (cx !== undefined) g.camera.position.set(cx, cy, cz);
        g.camera.updateMatrixWorld(true);
        this.orig[name]();
        p.camY = camY; // (leave the camera smoothing as the recording had it)
      }
      p.keys.clear();
      if (keys) for (const k of keys.split(',')) p.keys.add(k);
      p.yaw = yaw;
      p.pitch = pitch;
    }
  }

  /** Draws the rear view into the top-right corner (after the main picture). */
  renderRear() {
    const g = this.game;
    if (!this.on || g.vr.active || g.state === 'menu') return;
    const r = g.renderer;
    const p = g.player;
    const w = r.domElement.clientWidth;
    const h = r.domElement.clientHeight;
    this.rear.position.copy(g.camera.position);
    this.rear.rotation.set(0, p.yaw + Math.PI, 0);
    this.rear.far = g.camera.far;
    this.rear.updateProjectionMatrix();
    const x = w - VIEW_W - 12;
    const y = h - VIEW_H - 12; // (viewport y counts up from the bottom)
    r.setScissorTest(true);
    r.setViewport(x, y, VIEW_W, VIEW_H);
    r.setScissor(x, y, VIEW_W, VIEW_H);
    r.render(g.scene, this.rear);
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
  }

  // ------------------------------------------------------------ save / load
  save() {
    if (!this.ticks.length) {
      this.game.toast('Nothing to save yet.', 1500);
      return;
    }
    const data = { v: 1, game: 'hello-neighbor-tas', house: this.house, ticks: this.ticks };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tas-house-${this.house}-${(this.ticks.length * TICK).toFixed(2)}s.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  load(text) {
    try {
      const d = JSON.parse(text);
      if (d.game !== 'hello-neighbor-tas' || !Array.isArray(d.ticks)) throw new Error('not a TAS file');
      this.ticks = d.ticks.map((t) => [String(t[0]), Number(t[1]), Number(t[2]), Array.isArray(t[3]) ? t[3] : []]);
      this.house = d.house;
      this.game.toast(`Loaded a ${(this.ticks.length * TICK).toFixed(2)} s run for house #${this.house}.${this.house !== this.game.seed ? ` Go to house #${this.house} to play it.` : ' I plays it.'}`, 4000);
    } catch (err) {
      this.game.toast(`Couldn't load that: ${err.message}`, 3000);
    }
    this.refresh();
  }

  refresh() {
    const t = (n) => (n * TICK).toFixed(3);
    const fmt = (v) => (v >= 0.1 ? v.toFixed(2) : v.toFixed(3));
    const modeText = { idle: 'IDLE', recording: '<b style="color:#ff5a5a">● RECORDING</b>', playing: '<b style="color:#4cd964">▶ PLAYING</b>' }[this.mode];
    this.info.innerHTML = [
      `<b>TAS</b> · ${modeText}${this.frozen ? ' · <b>FROZEN</b>' : ''}`,
      `Record speed: <b>${fmt(this.speed)}x</b>${this.mode === 'playing' ? '' : ' (scroll or [ ])'}`,
      `Playback speed: <b>${fmt(this.playSpeed)}x</b>${this.mode === 'playing' ? ' (scroll or [ ])' : ''}`,
      `Run: ${this.ticks.length} ticks · ${t(this.ticks.length)} s${this.house ? ` · house #${this.house}` : ''}`,
      this.mode === 'playing' ? `At: ${t(this.pos)} s` : this.mode === 'recording' ? `Time: ${t(this.pos)} s` : '',
      '<span style="opacity:.7">scroll speed · U record/stop · I play · \\ freeze · . step · Y leave</span>',
    ].filter(Boolean).join('<br>');
  }
}
