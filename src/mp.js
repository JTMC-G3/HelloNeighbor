import * as THREE from 'three';
import { Net } from './net.js';
import { Peer, PLAYER_COLORS, F, HeardMarks } from './avatar.js';

/*
 * Multiplayer.
 *
 * One player hosts; their browser runs the real game (the neighbor's AI, item
 * physics, doors, locks...) and sends everyone a snapshot ~15 times a second.
 * Everyone else sends their own position and asks the host to do things for
 * them ("open door 4", "pick up item 12"). The server (server/relay.js) just
 * passes messages along.
 *
 * Modes:
 *   coop   2-8 kids against the AI neighbor.
 *   versus one player IS the neighbor (no AI); the others sneak in.
 *
 * Host -> players (d.k):  welcome, lobby, start, roster, s (snapshot), snd,
 *                         win, toast, caught, stun, end
 * Player -> host (d.k):   hello, me, act
 */

const SEND_EVERY = 1 / 15;
const FULL_EVERY = 2;
const STATES = ['patrol', 'task', 'investigate', 'chase', 'stunned', 'openCloset'];
// World sounds everyone should hear (positional ones mostly).
const SHARED_SOUNDS = new Set(['door', 'pry', 'thud', 'appliance', 'chore', 'grunt', 'alert']);
const CATCHES_PER_KID = 8;
const $ = (id) => document.getElementById(id);
const r2 = (v) => Math.round(v * 100) / 100;
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 16) || 'Player';

export class Multiplayer {
  constructor(game) {
    this.game = game;
    this.net = new Net();
    this.inRoom = false;
    this.started = false;
    this.isHost = false;
    this.myId = -1;
    this.mode = 'coop';
    this.neighborPick = -1; // versus: who plays the neighbor (-1 = random)
    this.roster = new Map(); // id -> { id, name, color, role }
    this.peers = new Map(); // id -> Peer (everyone else, in the world)
    this.sendT = 0;
    this.fullT = 0;
    this.lastSent = {};
    this.itemSent = [];
    this.catches = 0;
    this.catchTarget = 0;
    this.released = new Map(); // item idx -> time we let go (ignore stale snapshots)
    this.npc = null; // latest neighbor state from the host
    this.vsGrab = -1; // versus: how long the neighbor has been grabbing someone
    this.net.onMessage = (m) => this.onRelay(m);
    this.net.onClose = () => this.lost('Lost the connection to the game.');
    this.bindUi();
    this.autoJoin();
  }

  get name() {
    return cleanName($('mpName').value);
  }

  // ============================================================== lobby UI
  bindUi() {
    const nameEl = $('mpName');
    try {
      nameEl.value = localStorage.getItem('hn-name') || '';
    } catch {
      /* private mode */
    }
    nameEl.addEventListener('change', () => {
      try {
        localStorage.setItem('hn-name', this.name);
      } catch {
        /* ignore */
      }
    });
    $('mpBtn').addEventListener('click', () => this.openMenu());
    $('mpBack').addEventListener('click', () => this.leave());
    $('mpHostBtn').addEventListener('click', () => this.host());
    $('mpJoinBtn').addEventListener('click', () => this.join($('mpCode').value));
    $('mpCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.join($('mpCode').value);
    });
    $('mpCopy').addEventListener('click', () => {
      const url = new URL(window.location.href);
      url.search = `?room=${this.net.code}`;
      navigator.clipboard?.writeText(url.href).then(
        () => this.msg('Invite link copied!'),
        () => this.msg(url.href),
      );
    });
    for (const r of document.querySelectorAll('input[name="mpMode"]')) {
      r.addEventListener('change', () => {
        if (!this.isHost) return;
        this.mode = r.value;
        this.broadcastLobby();
      });
    }
    $('mpNeighbor').addEventListener('change', (e) => {
      this.neighborPick = Number(e.target.value);
      this.broadcastLobby();
    });
    $('mpGo').addEventListener('click', () => this.hostStart());
    $('mpGoneBtn').addEventListener('click', () => {
      this.game.allowLeave();
      window.location.href = window.location.pathname;
    });
  }

  openMenu() {
    $('menu').classList.add('hidden');
    $('mpMenu').classList.remove('hidden');
    $('mpStart').classList.remove('hidden');
    $('mpLobby').classList.add('hidden');
    this.msg('');
    const code = new URLSearchParams(window.location.search).get('room');
    if (code) $('mpCode').value = code.toUpperCase();
  }

  msg(text) {
    $('mpMsg').textContent = text;
  }

  busy(on) {
    for (const id of ['mpHostBtn', 'mpJoinBtn']) $(id).disabled = on;
  }

  async connect() {
    if (this.net.open) return true;
    this.msg('Connecting...');
    try {
      await this.net.connect();
      return true;
    } catch {
      this.msg("Couldn't reach the game server. Multiplayer needs the game running from `npm run dev` or `npm run share` (it won't work on GitHub Pages).");
      return false;
    }
  }

  async host() {
    this.busy(true);
    if (!(await this.connect())) return this.busy(false);
    try {
      const m = await this.net.request({ t: 'host' }, ['hosted']);
      this.net.code = m.code;
      this.myId = 0;
      this.isHost = true;
      this.inRoom = true;
      this.roster.set(0, { id: 0, name: this.name, color: PLAYER_COLORS[0], role: 'kid' });
      this.showLobby();
      this.broadcastLobby();
      this.msg('');
    } catch (e) {
      this.msg(e.message);
    }
    this.busy(false);
  }

  async join(code) {
    code = String(code || '').trim().toUpperCase();
    if (code.length !== 4) {
      this.msg('Type the 4-letter room code.');
      return;
    }
    this.busy(true);
    if (!(await this.connect())) return this.busy(false);
    try {
      const m = await this.net.request({ t: 'join', code }, ['joined']);
      this.net.code = m.code;
      this.myId = m.id;
      this.inRoom = true;
      this.net.toHost({ k: 'hello', name: this.name, seed: this.game.seed });
      this.msg('Joining...');
    } catch (e) {
      this.msg(e.message);
      this.net.close();
    }
    this.busy(false);
  }

  /** After reloading into the host's house we rejoin automatically. */
  autoJoin() {
    let pending = null;
    try {
      pending = JSON.parse(sessionStorage.getItem('hn-join') || 'null');
      sessionStorage.removeItem('hn-join');
    } catch {
      /* ignore */
    }
    if (!pending) return;
    $('mpName').value = pending.name;
    this.openMenu();
    $('mpCode').value = pending.code;
    this.join(pending.code);
  }

  leave() {
    if (this.inRoom) {
      // Simplest way to tidy everything up.
      this.net.close();
      this.game.allowLeave();
      window.location.href = window.location.pathname;
      return;
    }
    $('mpMenu').classList.add('hidden');
    $('menu').classList.remove('hidden');
  }

  showLobby() {
    $('mpStart').classList.add('hidden');
    $('mpLobby').classList.remove('hidden');
    $('mpRoom').textContent = this.net.code;
    this.renderLobby();
  }

  renderLobby() {
    const list = $('mpPlayers');
    list.textContent = '';
    for (const p of this.roster.values()) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      li.append(dot, document.createTextNode(`${p.name}${p.id === this.myId ? ' (you)' : ''}${p.id === 0 ? ' · host' : ''}`));
      list.appendChild(li);
    }
    for (const r of document.querySelectorAll('input[name="mpMode"]')) {
      r.checked = r.value === this.mode;
      r.disabled = !this.isHost;
    }
    const sel = $('mpNeighbor');
    sel.disabled = !this.isHost;
    const keep = this.neighborPick;
    sel.textContent = '';
    const opt = (v, t) => {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = t;
      sel.appendChild(o);
    };
    opt(-1, 'Random');
    for (const p of this.roster.values()) opt(p.id, p.name);
    sel.value = this.roster.has(keep) ? String(keep) : '-1';
    $('mpNeighborRow').classList.toggle('hidden', this.mode !== 'versus');
    const enough = this.mode === 'coop' || this.roster.size >= 2;
    $('mpGo').classList.toggle('hidden', !this.isHost);
    $('mpGo').disabled = !enough;
    $('mpWait').textContent = this.isHost
      ? enough ? `House #${this.game.seed}. Everyone in? Press Start.` : 'Playing as the neighbor needs at least 2 players.'
      : 'Waiting for the host to start...';
  }

  broadcastLobby() {
    this.renderLobby();
    this.net.toAll({ k: 'lobby', players: [...this.roster.values()], mode: this.mode, pick: this.neighborPick });
  }

  // ========================================================= relay messages
  onRelay(m) {
    if (m.t === 'peer') return; // wait for their hello
    if (m.t === 'left') return this.playerLeft(m.id);
    if (m.t === 'closed') return this.lost('The host left the game.');
    if (m.t !== 'msg' || !m.d) return;
    if (this.isHost) this.fromPlayer(m.from, m.d);
    else this.fromHost(m.d);
  }

  lost(text) {
    if (!this.inRoom) return;
    this.inRoom = false;
    if (document.pointerLockElement) document.exitPointerLock();
    $('mpGoneText').textContent = text;
    $('mpGone').classList.remove('hidden');
  }

  // --------------------------------------------------------------- host side
  fromPlayer(id, d) {
    const g = this.game;
    if (d.k === 'hello') {
      if (this.roster.has(id)) return;
      if (d.seed !== g.seed) {
        // They'll reload into our house and join again.
        this.net.to(id, { k: 'welcome', seed: g.seed, started: this.started });
        return;
      }
      const used = new Set([...this.roster.values()].map((p) => p.color));
      const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[id % PLAYER_COLORS.length];
      const info = { id, name: cleanName(d.name), color, role: 'kid' };
      this.roster.set(id, info);
      this.net.to(id, { k: 'welcome', seed: g.seed, started: this.started });
      if (this.started) {
        // Joining a game already in progress.
        this.addPeer(info);
        this.catchTarget += CATCHES_PER_KID;
        this.net.to(id, this.startMessage());
        this.net.toAll({ k: 'roster', players: [...this.roster.values()] }, id);
        g.toast(`${info.name} joined.`);
        this.fullT = 0;
      } else {
        this.broadcastLobby();
      }
      return;
    }
    const peer = this.peers.get(id);
    if (!peer || !this.started) return;
    if (d.k === 'me' && Array.isArray(d.s)) {
      const wasHidden = peer.hidden;
      peer.setState(d.s.map(Number));
      if (peer.hidden && !wasHidden) this.game.peerHid(peer);
    } else if (d.k === 'act') {
      g.applyAct(peer, d);
    }
  }

  playerLeft(id) {
    const info = this.roster.get(id);
    if (!info) return;
    this.roster.delete(id);
    const peer = this.peers.get(id);
    if (peer) {
      if (peer.held) this.game.freeItem(peer, peer.held, peer.pos.clone().setY(peer.pos.y + 0.8), new THREE.Vector3(), false, false);
      peer.dispose();
      this.peers.delete(id);
    }
    if (!this.started) {
      this.broadcastLobby();
      return;
    }
    this.game.toast(`${info.name} left.`);
    this.net.toAll({ k: 'roster', players: [...this.roster.values()] });
    if (this.mode === 'versus') {
      if (info.role === 'neighbor') this.finish('kids', null, `${info.name} (the neighbor) left the game.`);
      else if (![...this.roster.values()].some((p) => p.role === 'kid')) this.finish('neighbor', null, 'All the kids left.');
    }
  }

  startMessage() {
    return { k: 'start', mode: this.mode, players: [...this.roster.values()], target: this.catchTarget };
  }

  hostStart() {
    if (!this.isHost || this.started) return;
    if (this.mode === 'versus') {
      if (this.roster.size < 2) return;
      const ids = [...this.roster.keys()];
      const nid = this.roster.has(this.neighborPick) ? this.neighborPick : ids[(Math.random() * ids.length) | 0];
      for (const p of this.roster.values()) p.role = p.id === nid ? 'neighbor' : 'kid';
    } else {
      for (const p of this.roster.values()) p.role = 'kid';
    }
    const kids = [...this.roster.values()].filter((p) => p.role === 'kid').length;
    this.catchTarget = kids * CATCHES_PER_KID;
    const msg = this.startMessage();
    this.net.toAll(msg);
    this.begin(msg);
  }

  // ------------------------------------------------------------- client side
  fromHost(d) {
    const g = this.game;
    switch (d.k) {
      case 'welcome':
        if (d.seed !== g.seed) {
          // Everyone plays the host's house: reload into it and rejoin.
          try {
            sessionStorage.setItem('hn-join', JSON.stringify({ code: this.net.code, name: this.name }));
          } catch {
            /* ignore */
          }
          this.net.onClose = () => {};
          this.net.close();
          this.game.allowLeave();
          window.location.search = `?seed=${d.seed}`;
          return;
        }
        this.showLobby();
        this.msg(d.started ? 'Game in progress, jumping in...' : '');
        break;
      case 'lobby':
        this.roster = new Map(d.players.map((p) => [p.id, p]));
        this.mode = d.mode;
        this.neighborPick = d.pick;
        this.renderLobby();
        break;
      case 'start':
        this.catchTarget = d.target;
        this.begin(d);
        break;
      case 'roster':
        this.syncRoster(d.players);
        break;
      case 's':
        this.applySnapshot(d);
        break;
      case 'snd':
        this.playSound(d.n, d.a);
        break;
      case 'win': {
        const win = g.world.windows[d.i];
        if (win) g.breakWindow(win, new THREE.Vector3(...d.d));
        break;
      }
      case 'toast':
        g.toast(String(d.text), d.ms || 3200);
        break;
      case 'caught':
        g.caught();
        break;
      case 'stun':
        g.stunSelf();
        break;
      case 'heard':
        this.showHeard(d);
        break;
      case 'end':
        g.mpEnd(d.who, d.text);
        break;
      default:
        break;
    }
  }

  syncRoster(players) {
    const ids = new Set(players.map((p) => p.id));
    for (const [id, peer] of this.peers) {
      if (!ids.has(id)) {
        if (this.started) this.game.toast(`${peer.name} left.`);
        peer.dispose();
        this.peers.delete(id);
      }
    }
    for (const p of players) {
      if (!this.roster.has(p.id) && this.started && p.id !== this.myId) this.game.toast(`${p.name} joined.`);
      if (p.id !== this.myId && !this.peers.has(p.id)) this.addPeer(p);
    }
    this.roster = new Map(players.map((p) => [p.id, p]));
  }

  // =============================================================== in game
  get me() {
    return this.roster.get(this.myId);
  }

  get neighborId() {
    for (const p of this.roster.values()) if (p.role === 'neighbor') return p.id;
    return -1;
  }

  addPeer(info) {
    const peer = new Peer(this.game, info);
    this.peers.set(info.id, peer);
    return peer;
  }

  begin(d) {
    this.started = true;
    this.mode = d.mode;
    this.roster = new Map(d.players.map((p) => [p.id, p]));
    for (const p of d.players) if (p.id !== this.myId && !this.peers.has(p.id)) this.addPeer(p);
    $('mpMenu').classList.add('hidden');
    this.game.startOnline(this.me ? this.me.role : 'kid');
    this.startBackgroundTicker();
  }

  /** Host: some sounds are played for everyone. */
  shareSounds(sound) {
    return new Proxy(sound, {
      get: (target, key) => {
        const v = target[key];
        if (typeof v !== 'function') return v;
        if (!SHARED_SOUNDS.has(key)) return v.bind(target);
        return (...args) => {
          v.apply(target, args);
          this.shareSound(key, args);
        };
      },
    });
  }

  shareSound(name, args, except) {
    if (!this.started || !this.isHost) return;
    const a = args.map((x) => (x && x.isVector3 ? { v: [r2(x.x), r2(x.y), r2(x.z)] } : x));
    this.net.toAll({ k: 'snd', n: name, a }, except);
  }

  playSound(name, args) {
    const s = this.game.sound;
    if (!s.ok() || typeof s[name] !== 'function' || !Array.isArray(args)) return;
    s[name](...args.map((x) => (x && x.v ? new THREE.Vector3(...x.v) : x)));
  }

  /** Tell one player something (or show it, if it's us). */
  toastTo(player, text, ms) {
    if (!player || player === this.game.player) this.game.toast(text, ms);
    else if (this.isHost && player.id !== undefined) this.net.to(player.id, { k: 'toast', text, ms });
  }

  soundTo(player, name, ...args) {
    if (player === this.game.player) this.game.sound[name](...args);
    else this.net.to(player.id, { k: 'snd', n: name, a: args });
  }

  sendAct(act) {
    this.net.toHost({ k: 'act', ...act });
  }

  /** Host: the AI (co-op) or the neighbor player (versus) caught someone. */
  catchPlayer(victim, text) {
    this.catches++;
    if (victim === this.game.player) this.game.caught();
    else {
      victim.flags |= F.caught;
      this.net.to(victim.id, { k: 'caught' });
    }
    if (this.mode === 'versus') {
      this.vsGrab = 0;
      const name = victim === this.game.player ? this.me.name : victim.name;
      const nid = this.neighborId;
      this.toastTo(nid === this.myId ? this.game.player : this.peers.get(nid), `Got ${name}! (${this.catches} / ${this.catchTarget})`, 2200);
      if (this.catches >= this.catchTarget) this.finish('neighbor', null, `The neighbor caught the kids ${this.catches} times.`);
    } else if (text) {
      this.game.toast(text, 2200);
    }
  }

  /**
   * Host, versus: the neighbor player hears noises by the same rules as the AI
   * neighbor (loud enough to reach him, and on his property). Kids' own noises
   * (running, landing, doors, cupboards...) show where the kid was.
   */
  neighborHears(nz) {
    const nid = this.neighborId;
    if (nid < 0 || (nz.by && nz.by.role === 'neighbor')) return;
    const g = this.game;
    if (!g.onProperty(nz.pos) || nz.pos.distanceTo(g.neighbor.pos) >= nz.radius) return;
    const kid = nz.by && nz.by.role === 'kid' ? nz.by : null;
    const msg = {
      k: 'heard',
      p: [r2(nz.pos.x), r2(nz.pos.y), r2(nz.pos.z)],
      r: nz.radius,
      id: kid ? kid.id : -1,
      at: kid ? [r2(kid.pos.x), r2(kid.pos.y), r2(kid.pos.z)] : null,
    };
    if (nid === this.myId) this.showHeard(msg);
    else this.net.to(nid, msg);
  }

  showHeard(msg) {
    if (!this.heard) this.heard = new HeardMarks(this.game);
    this.heard.show(msg);
  }

  /** Host: game over for everyone. */
  finish(who, actor, text) {
    if (!this.isHost || this.game.state === 'ending' || this.game.state === 'won') return;
    const name = actor ? (actor === this.game.player ? this.me.name : actor.name) : '';
    const t = text || (who === 'kids' ? `${name} got into the basement!` : 'The neighbor won.');
    this.net.toAll({ k: 'end', who, text: t });
    this.game.mpEnd(who, t);
  }

  // ----------------------------------------------------------- every frame
  update(dt) {
    if (!this.started) return;
    const g = this.game;
    for (const peer of this.peers.values()) peer.update(dt);
    if (this.heard) this.heard.update(dt);
    if (this.mode === 'versus') this.updateVersusNeighbor(dt);
    else if (!this.isHost) this.puppetNeighbor(dt);
    if (!this.isHost) this.smoothItems(dt);

    this.sendT -= dt;
    this.fullT -= dt;
    if (this.sendT > 0) return;
    this.sendT = SEND_EVERY;
    if (this.isHost) {
      const full = this.fullT <= 0;
      if (full) this.fullT = FULL_EVERY;
      this.net.toAll(this.snapshot(full));
    } else if (g.state !== 'won') {
      this.net.toHost({ k: 'me', s: this.myState() });
    }
  }

  myState() {
    const g = this.game;
    const p = g.player;
    let flags = 0;
    if (p.crouching) flags |= F.crouch;
    if (p.moving) flags |= F.moving;
    if (p.sprinting) flags |= F.sprint;
    if (g.flashlightOn) flags |= F.light;
    if (g.state === 'caught') flags |= F.caught;
    if (p.hidden) flags |= F.hidden;
    if (g.hideAnim) flags |= F.hiding;
    if (g.stunned > 0) flags |= F.stunned;
    const spot = p.hidden || (g.hideAnim && g.hideAnim.spot);
    return [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.yaw), r2(p.pitch), flags, spot ? g.world.hideSpots.indexOf(spot) : -1];
  }

  // ------------------------------------------------------ host: snapshots
  snapshot(full) {
    const g = this.game;
    const w = g.world;
    const s = { k: 's' };
    s.p = [[this.myId, ...this.myState()]];
    for (const peer of this.peers.values()) if (peer.state) s.p.push([peer.id, ...peer.state.slice(0, 5), peer.flags, peer.state[6]]);

    const n = g.neighbor;
    const task = n.task;
    const mower = w.stations.find((st) => st.mower);
    const m = mower ? mower.mower : null;
    s.n = [
      r2(n.pos.x), r2(n.pos.y), r2(n.pos.z), r2(n.heading), r2(n.speed),
      STATES.indexOf(n.state), r2(n.awareness),
      task ? n.stations.indexOf(task.station) : -1, task && task.phase === 'do' ? 1 : 0, task ? r2(task.t) : 0,
      n.grabbing ? 1 : 0, r2(n.catchT || 0),
      m ? r2(m.position.x) : 0, m ? r2(m.position.z) : 0, m ? r2(m.rotation.y) : 0,
      n.focus && n.focus.id !== undefined ? n.focus.id : -1,
    ];
    s.g = [this.catches, this.catchTarget];

    const bits = (arr, f) => arr.map((x) => (f(x) ? '1' : '0')).join('');
    const sections = {
      d: bits(w.doors, (d) => d.open),
      L: w.doors.map((d) => d.locks.map((l) => (l.type === 'key' ? l.color : 'boards')).join(',')).join('|'),
      c: bits(w.containers, (c) => c.open),
      a: bits(w.appliances, (a) => a.on),
      w: bits(w.windows, (x) => x.broken),
      h: bits(w.hideSpots, (h) => h.target === 1),
    };
    for (const [k, v] of Object.entries(sections)) {
      if (full || this.lastSent[k] !== v) {
        s[k] = v;
        this.lastSent[k] = v;
      }
    }
    const items = [];
    w.items.forEach((it, i) => {
      const holder = it.consumed ? -2 : it.held ? it.holder : -1;
      const e = [i, r2(it.pos.x), r2(it.pos.y), r2(it.pos.z), r2(it.mesh.rotation.x), r2(it.mesh.rotation.y), r2(it.mesh.rotation.z), holder, it.container ? w.containers.indexOf(it.container) : -1];
      const key = e.join(',');
      if (full || this.itemSent[i] !== key) {
        items.push(e);
        this.itemSent[i] = key;
      }
    });
    if (items.length) s.it = items;
    return s;
  }

  // ------------------------------------------------- client: apply snapshots
  applySnapshot(s) {
    const g = this.game;
    const w = g.world;
    if (s.p) {
      for (const e of s.p) {
        if (e[0] === this.myId) continue;
        const peer = this.peers.get(e[0]);
        if (peer) peer.setState(e.slice(1));
      }
    }
    if (s.n) this.npc = s.n;
    if (s.g) {
      this.catches = s.g[0];
      this.catchTarget = s.g[1];
    }
    if (s.d) {
      w.doors.forEach((d, i) => {
        const open = s.d[i] === '1';
        if (d.open !== open) d.setOpen(open);
      });
    }
    if (s.L !== undefined) {
      const lists = s.L.split('|');
      w.doors.forEach((d, i) => {
        const want = (lists[i] || '').split(',').filter(Boolean);
        for (const lock of [...d.locks]) {
          const name = lock.type === 'key' ? lock.color : 'boards';
          const at = want.indexOf(name);
          if (at >= 0) want.splice(at, 1);
          else d.removeLock(lock);
        }
      });
    }
    if (s.c) w.containers.forEach((c, i) => { c.open = s.c[i] === '1'; });
    if (s.a) {
      w.appliances.forEach((a, i) => {
        const on = s.a[i] === '1';
        if (a.on !== on) g.setApplianceVisual(a, on);
      });
    }
    if (s.w) {
      w.windows.forEach((win, i) => {
        if (s.w[i] === '1' && !win.broken) {
          win.broken = true;
          win.hide();
          win.collider.enabled = false;
        }
      });
    }
    if (s.h) {
      const mine = g.player.hidden || (g.hideAnim && g.hideAnim.spot);
      w.hideSpots.forEach((h, i) => {
        if (h !== mine) h.target = s.h[i] === '1' ? 1 : 0;
      });
    }
    if (s.it) for (const e of s.it) this.applyItem(e);
  }

  applyItem(e) {
    const g = this.game;
    const w = g.world;
    const [i, x, y, z, rx, ry, rz, holder, ci] = e;
    const it = w.items[i];
    if (!it) return;
    const p = g.player;
    const released = this.released.get(i);
    const recent = released !== undefined && g.time - released < 1.2;
    // Who's holding it.
    if (it.holderPeer && it.holderPeer.id !== holder) {
      it.holderPeer.detachItem(it);
      it.holderPeer = null;
    }
    if (holder === -2) {
      if (p.held === it) g.dropVisual(it);
      it.consumed = true;
      it.held = false;
      it.mesh.visible = false;
      return;
    }
    if (holder === this.myId) {
      if (p.held !== it && !recent) g.holdVisual(it);
      it.held = true;
      it.holder = holder;
      return;
    }
    if (p.held === it) g.dropVisual(it);
    if (holder >= 0) {
      const peer = this.peers.get(holder);
      it.held = true;
      it.holder = holder;
      if (peer && it.holderPeer !== peer) {
        peer.attachItem(it);
        it.holderPeer = peer;
      }
      return;
    }
    it.held = false;
    it.holder = -1;
    if (!it.netPos) {
      it.netPos = new THREE.Vector3(x, y, z);
      it.pos.set(x, y, z);
    }
    it.netPos.set(x, y, z);
    it.mesh.rotation.set(rx, ry, rz);
    // Tucked away in a cupboard?
    const c = ci >= 0 ? w.containers[ci] : null;
    if (it.container !== c) {
      if (it.container && it.container.item === it) it.container.item = null;
      it.container = c;
      if (c) c.item = it;
    }
  }

  smoothItems(dt) {
    const k = Math.min(1, dt * 14);
    for (const it of this.game.world.items) {
      if (!it.netPos || it.held || it.consumed) continue;
      if (it.pos.distanceToSquared(it.netPos) > 16) it.pos.copy(it.netPos);
      else it.pos.lerp(it.netPos, k);
      it.mesh.position.copy(it.pos);
    }
  }

  // ------------------------------------------------------------- neighbor
  /** Clients (co-op): move the neighbor model to where the host says he is. */
  puppetNeighbor(dt) {
    const s = this.npc;
    if (!s) return;
    const n = this.game.neighbor;
    n.puppet(dt, {
      x: s[0], y: s[1], z: s[2], heading: s[3], speed: s[4], state: STATES[s[5]] || 'patrol', awareness: s[6],
      station: s[7] >= 0 ? n.stations[s[7]] : null, doing: s[8] === 1, taskT: s[9],
      grabbing: s[10] === 1, catchT: s[11], focus: s[15],
    });
    const mower = this.game.world.stations.find((st) => st.mower);
    if (mower && s[7] >= 0 && n.stations[s[7]] && n.stations[s[7]].type === 'mow') {
      mower.mower.position.set(s[12], mower.mower.position.y, s[13]);
      mower.mower.rotation.y = s[14];
    }
    // "He spotted you!"
    const chasingMe = n.state === 'chase' && s[15] === this.myId;
    if (chasingMe && !this.wasChasingMe) this.game.onSpotted(this.game.player);
    this.wasChasingMe = chasingMe;
    this.game.sound.setChase(n.state === 'chase');
  }

  /** Versus: the neighbor model follows whoever plays him. */
  updateVersusNeighbor(dt) {
    const g = this.game;
    const n = g.neighbor;
    const nid = this.neighborId;
    if (this.vsGrab >= 0) this.vsGrab += dt;
    if (this.vsGrab > 1.8) this.vsGrab = -1;
    if (nid === this.myId) {
      // That's us: the model stays hidden (it would block the camera).
      n.model.root.visible = false;
      n.ch.pos.copy(g.player.pos);
      n.heading = g.player.yaw + Math.PI;
      n.speed = Math.hypot(g.player.ch.vel.x, g.player.ch.vel.z);
      n.state = g.stunned > 0 ? 'stunned' : 'patrol';
      n.grabbing = this.vsGrab >= 0;
      n.catchT = Math.max(0, this.vsGrab);
      return;
    }
    n.model.root.visible = true;
    if (this.isHost) {
      const peer = this.peers.get(nid);
      if (!peer) return;
      n.puppet(dt, {
        x: peer.target.x, y: peer.target.y, z: peer.target.z, heading: peer.targetYaw + Math.PI, speed: peer.speed,
        state: peer.stunned ? 'stunned' : 'patrol', awareness: 0, station: null,
        grabbing: this.vsGrab >= 0, catchT: Math.max(0, this.vsGrab), focus: -1,
      });
    } else {
      this.puppetNeighbor(dt);
    }
  }

  // --------------------------------------------------- hidden-tab host ticker
  /**
   * Browsers stop drawing frames in background tabs, which would freeze the
   * game for everyone if the host switched tabs. A worker timer keeps the
   * simulation ticking (without rendering) while the host's tab is hidden.
   */
  startBackgroundTicker() {
    if (!this.isHost || this.ticker) return;
    try {
      const src = 'setInterval(() => postMessage(0), 50);';
      this.ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.ticker.onmessage = () => {
        if (document.hidden) this.game.frame(true);
      };
    } catch {
      this.ticker = null;
    }
  }
}

