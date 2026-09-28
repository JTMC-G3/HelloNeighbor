import * as THREE from 'three';

// Every sound in the game is synthesized with the Web Audio API.

const tmp = new THREE.Vector3();

export class Sound {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.listenerPos = new THREE.Vector3();
    this.listenerRight = new THREE.Vector3(1, 0, 0);
    this.chasing = false;
    this.musicStep = 0;
    this.birdTimer = 3;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    this.music = ctx.createGain();
    this.music.gain.value = 0;
    this.music.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.musicTimer = setInterval(() => this.tickMusic(), 140);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setListener(pos, yaw) {
    this.listenerPos.copy(pos);
    this.listenerRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
  }

  /** Output node with distance attenuation and stereo panning for a world position. */
  out(pos, vol = 1, range = 40) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    let gain = vol;
    let pan = 0;
    if (pos) {
      tmp.subVectors(pos, this.listenerPos);
      const dist = tmp.length();
      gain *= Math.max(0, 1 - dist / range) ** 2;
      if (dist > 0.01) pan = THREE.MathUtils.clamp(tmp.dot(this.listenerRight) / dist, -1, 1) * 0.75;
    }
    g.gain.value = gain;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.master);
    } else {
      g.connect(this.master);
    }
    return { node: g, gain };
  }

  noise(dest, { t = 0, dur = 0.1, type = 'bandpass', freq = 1000, freqEnd, q = 1, gain = 1, attack = 0.003 }) {
    const ctx = this.ctx;
    const now = ctx.currentTime + t;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, now);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, now + dur);
    f.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(f).connect(env).connect(dest);
    src.start(now, Math.random() * 1.5);
    src.stop(now + dur + 0.05);
  }

  tone(dest, { t = 0, type = 'sine', freq = 440, freqEnd, dur = 0.2, gain = 0.5, attack = 0.005 }) {
    const ctx = this.ctx;
    const now = ctx.currentTime + t;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, now);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, now + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(env).connect(dest);
    o.start(now);
    o.stop(now + dur + 0.05);
  }

  ok() {
    return !!this.ctx;
  }

  footstep(surfaceHard = false, loud = false) {
    if (!this.ok()) return;
    const { node } = this.out(null, loud ? 0.5 : 0.3);
    this.noise(node, { dur: 0.09, type: 'lowpass', freq: surfaceHard ? 1800 : 900, gain: 1 });
  }

  heavyStep(pos) {
    if (!this.ok()) return;
    const { node, gain } = this.out(pos, 1.3, 30);
    if (gain < 0.001) return;
    this.noise(node, { dur: 0.14, type: 'lowpass', freq: 420, gain: 1.2 });
    this.tone(node, { freq: 75, freqEnd: 45, dur: 0.14, gain: 0.8 });
  }

  land(strength) {
    if (!this.ok()) return;
    const { node } = this.out(null, Math.min(1, strength / 8));
    this.noise(node, { dur: 0.16, type: 'lowpass', freq: 500, gain: 1 });
  }

  glass(pos) {
    if (!this.ok()) return;
    const { node } = this.out(pos, 1.2, 60);
    this.noise(node, { dur: 0.5, type: 'highpass', freq: 2500, gain: 1 });
    this.noise(node, { dur: 0.25, type: 'bandpass', freq: 5000, q: 2, gain: 0.8 });
    for (let i = 0; i < 12; i++) {
      this.tone(node, { t: Math.random() * 0.6, freq: 2500 + Math.random() * 4500, dur: 0.08 + Math.random() * 0.1, gain: 0.15 });
    }
  }

  thud(pos, strength) {
    if (!this.ok()) return;
    const { node, gain } = this.out(pos, Math.min(1, strength / 9), 35);
    if (gain < 0.001) return;
    this.noise(node, { dur: 0.12, type: 'lowpass', freq: 700, gain: 1 });
    this.tone(node, { freq: 140, freqEnd: 60, dur: 0.12, gain: 0.5 });
  }

  door(pos, opening) {
    if (!this.ok()) return;
    const { node } = this.out(pos, 0.7, 30);
    if (opening) {
      this.tone(node, { type: 'sawtooth', freq: 190 + Math.random() * 40, freqEnd: 260 + Math.random() * 80, dur: 0.45, gain: 0.08, attack: 0.08 });
      this.noise(node, { dur: 0.04, type: 'highpass', freq: 2500, gain: 0.6 });
    } else {
      this.noise(node, { dur: 0.15, type: 'lowpass', freq: 600, gain: 1 });
      this.noise(node, { t: 0.02, dur: 0.04, type: 'highpass', freq: 2500, gain: 0.6 });
    }
  }

  locked(pos) {
    if (!this.ok()) return;
    const { node } = this.out(pos, 0.7);
    for (const t of [0, 0.08, 0.16]) this.noise(node, { t, dur: 0.05, type: 'bandpass', freq: 1800, q: 3, gain: 1 });
  }

  unlock() {
    if (!this.ok()) return;
    const { node } = this.out(null, 0.6);
    this.noise(node, { dur: 0.05, type: 'bandpass', freq: 2200, q: 4, gain: 1 });
    this.tone(node, { t: 0.08, freq: 880, dur: 0.25, gain: 0.25 });
    this.tone(node, { t: 0.18, freq: 1320, dur: 0.4, gain: 0.25 });
  }

  pickup() {
    if (!this.ok()) return;
    const { node } = this.out(null, 0.3);
    this.tone(node, { freq: 520, freqEnd: 820, dur: 0.08, gain: 0.4 });
  }

  keyPickup() {
    if (!this.ok()) return;
    const { node } = this.out(null, 0.4);
    [660, 880, 1320].forEach((f, i) => this.tone(node, { t: i * 0.08, freq: f, dur: 0.3, gain: 0.3 }));
  }

  throwWhoosh() {
    if (!this.ok()) return;
    const { node } = this.out(null, 0.35);
    this.noise(node, { dur: 0.22, type: 'bandpass', freq: 1200, freqEnd: 300, q: 1.5, gain: 1, attack: 0.03 });
  }

  alert() {
    if (!this.ok()) return;
    const { node } = this.out(null, 0.7);
    for (const f of [196, 207.6, 293.7, 415.3]) {
      this.tone(node, { type: 'sawtooth', freq: f, dur: 1.0, gain: 0.12, attack: 0.01 });
    }
    this.noise(node, { dur: 0.4, type: 'lowpass', freq: 300, gain: 1 });
  }

  grunt(pos) {
    if (!this.ok()) return;
    const { node } = this.out(pos, 0.8);
    this.tone(node, { type: 'sawtooth', freq: 140, freqEnd: 90, dur: 0.3, gain: 0.2, attack: 0.02 });
    this.noise(node, { dur: 0.25, type: 'bandpass', freq: 500, q: 2, gain: 0.5 });
  }

  click() {
    if (!this.ok()) return;
    const { node } = this.out(null, 0.4);
    this.noise(node, { dur: 0.03, type: 'bandpass', freq: 2500, q: 3, gain: 1 });
  }

  pry(pos) {
    if (!this.ok()) return;
    const { node } = this.out(pos, 0.9);
    this.noise(node, { dur: 0.35, type: 'bandpass', freq: 700, freqEnd: 300, q: 2, gain: 1 });
    this.tone(node, { t: 0.1, type: 'sawtooth', freq: 320, freqEnd: 180, dur: 0.3, gain: 0.12 });
    this.noise(node, { t: 0.35, dur: 0.2, type: 'lowpass', freq: 500, gain: 1 });
  }

  /** A burst of whatever a TV or radio is playing, heard from its position. */
  appliance(pos, kind) {
    if (!this.ok()) return;
    const { node, gain } = this.out(pos, 0.7, 30);
    if (gain < 0.001) return;
    if (kind === 'tv') {
      this.noise(node, { dur: 1.3, type: 'bandpass', freq: 1800, q: 0.7, gain: 0.35, attack: 0.05 });
      for (let i = 0; i < 4; i++) this.tone(node, { t: i * 0.3, type: 'square', freq: 180 + Math.random() * 220, dur: 0.18, gain: 0.08 });
    } else {
      const scale = [261.6, 293.7, 329.6, 392, 440, 523.3];
      for (let i = 0; i < 6; i++) this.tone(node, { t: i * 0.22, type: 'triangle', freq: scale[(Math.random() * scale.length) | 0], dur: 0.2, gain: 0.18 });
      this.tone(node, { type: 'sine', freq: 130.8, dur: 1.3, gain: 0.12 });
    }
  }

  caught() {
    if (!this.ok()) return;
    const { node } = this.out(null, 1);
    for (const f of [55, 58.3, 82.4, 110, 116.5]) {
      this.tone(node, { type: 'sawtooth', freq: f, dur: 1.6, gain: 0.2, attack: 0.01 });
    }
    this.noise(node, { dur: 0.8, type: 'lowpass', freq: 800, gain: 1.2 });
    this.tone(node, { type: 'square', freq: 880, freqEnd: 220, dur: 0.6, gain: 0.08 });
  }

  drone(seconds = 6) {
    if (!this.ok()) return;
    const { node } = this.out(null, 0.8);
    for (const f of [41.2, 43.6, 61.7, 82.4]) {
      this.tone(node, { type: 'sawtooth', freq: f, dur: seconds, gain: 0.1, attack: 2.5 });
    }
    this.tone(node, { t: 1.5, type: 'sine', freq: 1244, dur: 4, gain: 0.05, attack: 1.5 });
  }

  chirp() {
    if (!this.ok()) return;
    const { node } = this.out(null, 0.05 + Math.random() * 0.05);
    const base = 2600 + Math.random() * 1500;
    const n = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      this.tone(node, { t: i * 0.12, freq: base, freqEnd: base * 1.35, dur: 0.08, gain: 0.5 });
    }
  }

  ambience(dt, outside) {
    if (!this.ok()) return;
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      if (outside) this.chirp();
      this.birdTimer = 2.5 + Math.random() * 6;
    }
  }

  setChase(on) {
    if (!this.ok() || on === this.chasing) return;
    this.chasing = on;
    const now = this.ctx.currentTime;
    this.music.gain.cancelScheduledValues(now);
    this.music.gain.setValueAtTime(this.music.gain.value, now);
    this.music.gain.linearRampToValueAtTime(on ? 0.55 : 0, now + (on ? 0.3 : 2.5));
    if (on) this.musicStep = 0;
  }

  tickMusic() {
    if (!this.ctx || this.music.gain.value < 0.01) return;
    const step = this.musicStep++ % 16;
    const bass = [82.4, 82.4, 87.3, 82.4, 82.4, 82.4, 98, 92.5, 82.4, 82.4, 87.3, 82.4, 110, 103.8, 98, 92.5];
    this.tone(this.music, { type: 'square', freq: bass[step], dur: 0.12, gain: 0.18 });
    if (step % 4 === 0) this.noise(this.music, { dur: 0.1, type: 'lowpass', freq: 200, gain: 1.2 });
    if (step % 4 === 2) this.noise(this.music, { dur: 0.05, type: 'highpass', freq: 5000, gain: 0.4 });
    if (step === 0 || step === 8) {
      this.tone(this.music, { type: 'sawtooth', freq: 659.3, dur: 0.5, gain: 0.05 });
      this.tone(this.music, { type: 'sawtooth', freq: 698.5, dur: 0.5, gain: 0.05 });
    }
  }
}
