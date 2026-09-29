/*
 * WebSocket connection to the multiplayer relay (server/relay.js), which runs
 * inside the dev / preview server on the same address as the game.
 */
export class Net {
  constructor() {
    this.ws = null;
    this.id = -1;
    this.code = '';
    this.onMessage = () => {};
    this.onClose = () => {};
  }

  get open() {
    return !!this.ws && this.ws.readyState === 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = new URL('mp', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.search = '';
      url.hash = '';
      let ws;
      try {
        ws = new WebSocket(url.href);
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('timeout'));
      }, 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('connect failed'));
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.onClose();
        }
      };
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        this.onMessage(m);
      };
    });
  }

  /** Waits for the first reply of one of the given types (or an error). */
  request(obj, types) {
    return new Promise((resolve, reject) => {
      const prev = this.onMessage;
      this.onMessage = (m) => {
        if (types.includes(m.t)) {
          this.onMessage = prev;
          resolve(m);
        } else if (m.t === 'error') {
          this.onMessage = prev;
          reject(new Error(m.msg));
        } else {
          prev(m);
        }
      };
      this.raw(obj);
    });
  }

  raw(obj) {
    if (this.open) this.ws.send(JSON.stringify(obj));
  }

  /** Client -> host. */
  toHost(d) {
    this.raw({ t: 'send', to: 'host', d });
  }

  /** Host -> everyone (optionally skipping one player). */
  toAll(d, except) {
    this.raw({ t: 'send', to: 'all', d, x: except });
  }

  /** Host -> one player. */
  to(id, d) {
    this.raw({ t: 'send', to: id, d });
  }

  close() {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }
}
