import { WebSocketServer } from 'ws';

/*
 * Multiplayer relay. Rooms are made by a host; everyone else joins with the
 * room's 4-letter code. The server doesn't run the game: the host's browser
 * does, and this just passes messages between the host and the others.
 *
 * Client -> server:
 *   { t: 'host' }                      make a room (you become player 0)
 *   { t: 'join', code }                join a room
 *   { t: 'send', to, d }               to: 'host', 'all', or a player id (host only)
 *                                      ('all' may carry x: an id to skip)
 * Server -> client:
 *   { t: 'hosted', code, id }   { t: 'joined', code, id }   { t: 'error', msg }
 *   { t: 'peer', id }  (to host: someone joined)   { t: 'left', id }  (to host)
 *   { t: 'msg', from, d }       { t: 'closed' }  (the host left)
 */

const MAX_PLAYERS = 8;
const MAX_ROOMS = 200;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function attachRelay(httpServer, path = '/mp') {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const rooms = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return;
    }
    // Leave every other upgrade (Vite's hot reload) alone.
    if (!pathname.endsWith(path)) return;
    wss.handleUpgrade(req, socket, head, (ws) => connected(ws));
  });

  const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  function newCode() {
    for (let tries = 0; tries < 100; tries++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
      if (!rooms.has(code)) return code;
    }
    return null;
  }

  function connected(ws) {
    ws.room = null;
    ws.pid = -1;
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (buf) => {
      let m;
      try {
        m = JSON.parse(buf);
      } catch {
        return;
      }
      if (m && typeof m === 'object') handle(ws, m);
    });
    ws.on('close', () => leave(ws));
    ws.on('error', () => {});
  }

  function handle(ws, m) {
    if (m.t === 'host' && !ws.room) {
      const code = rooms.size < MAX_ROOMS ? newCode() : null;
      if (!code) return send(ws, { t: 'error', msg: 'The server is full, try again later.' });
      const room = { code, host: ws, peers: new Map([[0, ws]]), next: 1 };
      rooms.set(code, room);
      ws.room = room;
      ws.pid = 0;
      send(ws, { t: 'hosted', code, id: 0 });
    } else if (m.t === 'join' && !ws.room) {
      const code = String(m.code || '').toUpperCase().slice(0, 8);
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', msg: `No game with the code ${code}.` });
      if (room.peers.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'That game is full.' });
      const id = room.next++;
      room.peers.set(id, ws);
      ws.room = room;
      ws.pid = id;
      send(ws, { t: 'joined', code, id });
      send(room.host, { t: 'peer', id });
    } else if (m.t === 'send' && ws.room) {
      const room = ws.room;
      const out = { t: 'msg', from: ws.pid, d: m.d };
      if (ws !== room.host) {
        // Only the host can talk to everyone; the others talk to the host.
        send(room.host, out);
      } else if (m.to === 'all') {
        const text = JSON.stringify(out);
        for (const [id, peer] of room.peers) {
          if (id !== 0 && id !== m.x && peer.readyState === 1) peer.send(text);
        }
      } else {
        send(room.peers.get(Number(m.to)), out);
      }
    }
  }

  function leave(ws) {
    const room = ws.room;
    if (!room) return;
    ws.room = null;
    if (ws === room.host) {
      rooms.delete(room.code);
      for (const [id, peer] of room.peers) {
        if (id === 0) continue;
        send(peer, { t: 'closed' });
        peer.room = null;
        peer.close();
      }
    } else {
      room.peers.delete(ws.pid);
      send(room.host, { t: 'left', id: ws.pid });
    }
  }

  // Keep connections alive through proxies/tunnels, and drop dead ones.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 25000);
  httpServer.on('close', () => clearInterval(timer));
  return wss;
}
