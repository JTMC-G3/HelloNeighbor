import { Rng } from './rng.js';

/*
 * Procedural house layout. Everything here is plain data (no three.js):
 * rooms, walls, doors, windows, the lock-and-key puzzle, and the waypoint
 * graph the neighbor walks on. world.js turns the plan into geometry.
 *
 * The footprint is a grid of 4 m cells (nx wide, nz deep). Cell (i, j) spans
 * x = X0 + 4i .. +4, z = Z0 + 4j .. +4, with j = 0 the back row. The front
 * wall is always at z = -10, facing the street.
 *
 * A 1x2-cell stairwell always sits in the back two rows at a random column.
 * The flight up runs along its west wall; the basement door hides under the
 * top of the flight and the basement stairs run back down beneath it, into a
 * room under the middle of the house.
 */

export const CELL = 4;
export const FLOOR = 0.3;
export const UPPER = 3.5;
export const BASEMENT = -2.9;
export const FRONT_Z = -10;

// Stairwell geometry, in metres from the stairwell's west/north corner.
export const STAIR = {
  width: 1.25, // stair treads run from the west wall to here
  top: 1.3, // z offset where the upper flight arrives (north landing)
  bottom: 6.9, // z offset where the upper flight starts
  baseEnd: 5.95, // z offset where the basement flight reaches the basement
};

const GROUND_BIG = ['dining', 'study', 'library', 'music', 'workshop', 'den'];
const GROUND_SMALL = ['bathroom', 'pantry', 'laundry', 'storage'];
const UPPER_BIG = ['bedroom', 'playroom', 'study', 'library', 'sewing', 'attic'];
const UPPER_SMALL = ['bathroom', 'storage', 'nursery', 'closet'];
const KEY_COLORS = ['blue', 'green', 'yellow', 'purple'];

export function generatePlan(seed) {
  const rng = new Rng(seed);
  const nx = rng.pick([4, 5, 5]);
  const nz = rng.pick([3, 4, 4]);
  const X0 = -(nx * CELL) / 2;
  const X1 = (nx * CELL) / 2;
  const Z1 = FRONT_Z;
  const Z0 = FRONT_Z - nz * CELL;
  const sx = rng.int(0, nx - 1);
  const plan = {
    seed,
    nx,
    nz,
    X0,
    X1,
    Z0,
    Z1,
    sx,
    stairX: X0 + sx * CELL,
    rooms: [],
    grid: [],
    walls: [[], []],
    doors: [],
    windows: [],
    extDoors: [],
    items: [],
    basementLocks: [],
  };
  plan.cellX = (i) => X0 + i * CELL;
  plan.cellZ = (j) => Z0 + j * CELL;
  plan.yard = { x0: X0 - 6, x1: X1 + 6, z0: Z0 - 8, z1: -6 };

  // Basement room: under the middle of the house, south of the stairwell.
  const bw = 8;
  const bx0 = plan.stairX - 4 >= X0 ? plan.stairX - 4 : plan.stairX;
  plan.basement = { x0: bx0, x1: Math.min(X1, bx0 + bw), z0: Z0 + STAIR.baseEnd, z1: Math.min(Z1, Z0 + 11.5) };

  for (const floor of [0, 1]) partition(plan, floor, rng);
  assignTypes(plan, rng);
  for (const floor of [0, 1]) connect(plan, floor, rng);
  exteriorDoors(plan, rng);
  windows(plan, rng);
  puzzle(plan, rng);
  navigation(plan);
  return plan;
}

function partition(plan, floor, rng) {
  const { nx, nz, sx } = plan;
  const grid = Array.from({ length: nx }, () => new Array(nz).fill(-1));
  const add = (i0, j0, w, h, type) => {
    const room = {
      id: plan.rooms.length,
      floor,
      i0,
      j0,
      i1: i0 + w,
      j1: j0 + h,
      x0: plan.cellX(i0),
      x1: plan.cellX(i0 + w),
      z0: plan.cellZ(j0),
      z1: plan.cellZ(j0 + h),
      area: w * h,
      type,
      doors: [],
      windows: [],
    };
    room.cx = (room.x0 + room.x1) / 2;
    room.cz = (room.z0 + room.z1) / 2;
    for (let i = i0; i < i0 + w; i++) for (let j = j0; j < j0 + h; j++) grid[i][j] = room.id;
    plan.rooms.push(room);
    return room;
  };
  add(sx, 0, 1, 2, 'stairs');

  const fits = (i0, j0, w, h) => {
    if (i0 < 0 || j0 < 0 || i0 + w > nx || j0 + h > nz) return false;
    for (let i = i0; i < i0 + w; i++) for (let j = j0; j < j0 + h; j++) if (grid[i][j] !== -1) return false;
    return true;
  };
  const shapes = [[2, 2], [2, 1], [1, 2], [2, 1], [1, 2], [1, 1], [1, 1], [3, 1], [1, 3]];
  const cells = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) cells.push([i, j]);
  for (const [i, j] of rng.shuffle(cells)) {
    if (grid[i][j] !== -1) continue;
    let done = false;
    for (const [w, h] of rng.shuffle(shapes)) {
      const anchors = [];
      for (let ox = 0; ox < w; ox++) for (let oy = 0; oy < h; oy++) anchors.push([i - ox, j - oy]);
      for (const [i0, j0] of rng.shuffle(anchors)) {
        if (fits(i0, j0, w, h)) {
          add(i0, j0, w, h, null);
          done = true;
          break;
        }
      }
      if (done) break;
    }
  }
  plan.grid[floor] = grid;
}

function assignTypes(plan, rng) {
  const bySize = (rooms) => rng.shuffle(rooms).sort((a, b) => b.area - a.area);
  const ground = plan.rooms.filter((r) => r.floor === 0 && r.type !== 'stairs');
  const kitchen = bySize(ground.filter((r) => r.j0 === 0))[0] || bySize(ground)[0];
  kitchen.type = 'kitchen';
  const living = bySize(ground.filter((r) => r.j1 === plan.nz && !r.type))[0] || bySize(ground.filter((r) => !r.type))[0];
  if (living) living.type = 'living';
  let big = rng.shuffle(GROUND_BIG);
  let small = rng.shuffle(GROUND_SMALL);
  for (const r of ground) {
    if (r.type) continue;
    r.type = r.area >= 2 ? big.shift() || rng.pick(GROUND_BIG) : small.shift() || rng.pick(GROUND_SMALL);
  }
  const upper = bySize(plan.rooms.filter((r) => r.floor === 1 && r.type !== 'stairs'));
  upper[0].type = 'master';
  if (upper[1]) upper[1].type = upper[1].area >= 2 ? 'kids' : 'nursery';
  big = rng.shuffle(UPPER_BIG);
  small = rng.shuffle(UPPER_SMALL);
  for (const r of upper) {
    if (r.type) continue;
    r.type = r.area >= 2 ? big.shift() || rng.pick(UPPER_BIG) : small.shift() || rng.pick(UPPER_SMALL);
  }
}

function connect(plan, floor, rng) {
  const { nx, nz } = plan;
  const grid = plan.grid[floor];
  const stairs = plan.rooms.find((r) => r.floor === floor && r.type === 'stairs');
  const pairs = new Map();
  const wallList = plan.walls[floor];
  const addEdge = (e) => {
    wallList.push(e);
    if (e.exterior) return;
    const key = `${Math.min(e.lo, e.hi)}-${Math.max(e.lo, e.hi)}`;
    if (!pairs.has(key)) pairs.set(key, { lo: e.lo, hi: e.hi, edges: [] });
    pairs.get(key).edges.push(e);
  };
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j < nz; j++) {
      const A = i > 0 ? grid[i - 1][j] : -1;
      const B = i < nx ? grid[i][j] : -1;
      if (A === B) continue;
      const e = { floor, axis: 'z', c: plan.cellX(i), a: plan.cellZ(j), b: plan.cellZ(j + 1), lo: A, hi: B, exterior: A < 0 || B < 0, door: null, windows: [] };
      e.side = A < 0 ? 'W' : B < 0 ? 'E' : null;
      addEdge(e);
    }
  }
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i < nx; i++) {
      const A = j > 0 ? grid[i][j - 1] : -1;
      const B = j < nz ? grid[i][j] : -1;
      if (A === B) continue;
      const e = { floor, axis: 'x', c: plan.cellZ(j), a: plan.cellX(i), b: plan.cellX(i + 1), lo: A, hi: B, exterior: A < 0 || B < 0, door: null, windows: [] };
      e.side = A < 0 ? 'N' : B < 0 ? 'S' : null;
      addEdge(e);
    }
  }

  // Where along an edge may a door go? Never through the stairwell's west
  // wall (the stairs are there); on its south wall keep clear of the flight.
  const doorRange = (e) => {
    const involvesStairs = e.lo === stairs.id || e.hi === stairs.id;
    if (involvesStairs && e.axis === 'z' && e.c === stairs.x0) return null;
    if (involvesStairs && e.axis === 'x' && e.a === stairs.x0) return [e.a + 1.9, e.b - 0.6];
    return [e.a + 1.0, e.b - 1.0];
  };

  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  for (const r of plan.rooms) if (r.floor === floor) parent.set(r.id, r.id);

  const makeDoor = (p) => {
    const options = p.edges.filter((e) => doorRange(e));
    if (!options.length) return false;
    const e = rng.pick(options);
    const [lo, hi] = doorRange(e);
    const door = {
      id: plan.doors.length,
      floor,
      axis: e.axis,
      c: e.c,
      center: rng.range(lo, hi),
      width: 1.0,
      lo: e.lo,
      hi: e.hi,
      locks: [],
      swing: rng.chance(0.5) ? 1 : -1,
    };
    e.door = door;
    plan.doors.push(door);
    plan.rooms[e.lo].doors.push(door);
    plan.rooms[e.hi].doors.push(door);
    return true;
  };

  const list = rng.shuffle([...pairs.values()]);
  const linked = new Set();
  for (const p of list) {
    if (find(p.lo) === find(p.hi)) continue;
    if (makeDoor(p)) {
      parent.set(find(p.lo), find(p.hi));
      linked.add(p);
    }
  }
  // A few extra doors make loops, so there's more than one way to run.
  for (const p of list) {
    if (!linked.has(p) && rng.chance(0.3)) makeDoor(p);
  }
}

function exteriorDoors(plan, rng) {
  const ground = plan.rooms.filter((r) => r.floor === 0);
  const pickEdge = (room, side) => plan.walls[0].filter((e) => e.exterior && e.side === side && (e.lo === room.id || e.hi === room.id));
  const make = (kind, room, side) => {
    const e = rng.pick(pickEdge(room, side));
    const door = {
      id: plan.doors.length,
      kind,
      floor: 0,
      axis: 'x',
      c: e.c,
      center: rng.range(e.a + 1.0, e.b - 1.0),
      width: kind === 'front' ? 1.2 : 1.0,
      room: room.id,
      locks: [],
      swing: kind === 'front' ? 1 : -1,
    };
    e.door = door;
    plan.doors.push(door);
    plan.extDoors.push(door);
    room.doors.push(door);
    return door;
  };
  const fronts = ground.filter((r) => r.j1 === plan.nz && r.type !== 'stairs');
  const front = fronts.find((r) => r.type === 'living') || rng.pick(fronts);
  plan.frontDoor = make('front', front, 'S');
  const backs = ground.filter((r) => r.j0 === 0 && r.type !== 'stairs');
  const back = backs.find((r) => r.type === 'kitchen') || rng.pick(backs);
  plan.backDoor = make('back', back, 'N');
}

function windows(plan, rng) {
  for (const floor of [0, 1]) {
    for (const e of plan.walls[floor]) {
      if (!e.exterior || e.door) continue;
      const room = plan.rooms[e.lo >= 0 ? e.lo : e.hi];
      if (room.type === 'stairs' && e.side === 'W') continue;
      if (!rng.chance(floor === 0 ? 0.7 : 0.6)) continue;
      const small = room.type === 'bathroom' || room.type === 'closet' || room.type === 'pantry';
      const w = small ? 0.8 : rng.range(1.2, 1.8);
      const center = rng.range(e.a + w / 2 + 0.6, e.b - w / 2 - 0.6);
      const bottom = floor === 0 ? (small ? 1.6 : 0.9) : small ? 4.9 : 4.3;
      const top = floor === 0 ? 2.6 : 5.7;
      const win = { a: center - w / 2, b: center + w / 2, bottom, top, room: room.id, edge: e };
      e.windows.push(win);
      room.windows.push(win);
      plan.windows.push(win);
    }
  }
}

/*
 * Lock-and-key chain. Some interior doors get a coloured padlock or are
 * boarded up (needs the crowbar). Keys are placed so every lock's item is
 * reachable before that lock, walking in through the back door. The last
 * item is the red key for the basement.
 */
function puzzle(plan, rng) {
  const adj = new Map();
  const link = (a, b, door) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ to: b, door });
    adj.get(b).push({ to: a, door });
  };
  const interior = plan.doors.filter((d) => !d.kind);
  for (const d of interior) link(d.lo, d.hi, d);
  const stairs = plan.rooms.filter((r) => r.type === 'stairs');
  link(stairs[0].id, stairs[1].id, null);
  link('out', plan.backDoor.room, null);

  const reach = (locked) => {
    const seen = new Set(['out']);
    const queue = ['out'];
    while (queue.length) {
      const n = queue.shift();
      for (const { to, door } of adj.get(n) || []) {
        if (seen.has(to) || (door && locked.has(door))) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    return seen;
  };

  const total = plan.rooms.length;
  const K = total >= 16 ? rng.int(2, 4) : rng.int(2, 3);
  const locked = new Set();
  for (const d of rng.shuffle(interior)) {
    if (locked.size >= K) break;
    const before = reach(locked).size;
    locked.add(d);
    const after = reach(locked).size;
    // Must actually shut something off, and leave a few rooms to explore at the start.
    if (after >= before || after - 1 < 3) locked.delete(d);
  }

  const order = [];
  const stages = [reach(locked)];
  const remaining = new Set(locked);
  while (remaining.size) {
    const R = stages[stages.length - 1];
    const frontier = [...remaining].filter((d) => R.has(d.lo) || R.has(d.hi));
    if (!frontier.length) break;
    const d = rng.pick(frontier);
    order.push(d);
    remaining.delete(d);
    stages.push(reach(remaining));
  }

  const colors = rng.shuffle(KEY_COLORS);
  let crowbarPlaced = false;
  const roomFor = (i) => {
    const prev = i > 0 ? stages[i - 1] : new Set();
    const fresh = [...stages[i]].filter((r) => r !== 'out' && !prev.has(r));
    const all = [...stages[i]].filter((r) => r !== 'out');
    const ok = (ids) => ids.filter((id) => plan.rooms[id].type !== 'stairs');
    const pool = ok(fresh).length ? ok(fresh) : ok(all).length ? ok(all) : all;
    return rng.pick(pool);
  };
  const need = (lock, stage) => {
    if (lock.type === 'key') plan.items.push({ type: `key:${lock.color}`, room: roomFor(stage) });
    else if (!crowbarPlaced) {
      plan.items.push({ type: 'crowbar', room: roomFor(stage) });
      crowbarPlaced = true;
    }
  };
  order.forEach((d, i) => {
    const lock = rng.chance(0.3) ? { type: 'boards' } : { type: 'key', color: colors.shift() || 'blue' };
    d.locks.push(lock);
    need(lock, i);
  });
  plan.basementLocks.push({ type: 'key', color: 'red' });
  if (rng.chance(0.45)) plan.basementLocks.push({ type: 'boards' });
  for (const lock of plan.basementLocks) need(lock, stages.length - 1);
  plan.lockOrder = order;
}

function navigation(plan) {
  const nodes = [];
  const edges = [];
  const node = (id, x, y, z) => {
    nodes.push({ id, x, y, z });
    return id;
  };
  const edge = (a, b, door = null) => edges.push({ a, b, door });
  const Y = (f) => (f === 0 ? FLOOR : UPPER);
  const { stairX: a, Z0, Z1 } = plan;
  const roomNode = (r) => `r${r.id}`;

  for (const r of plan.rooms) {
    if (r.type === 'stairs') node(roomNode(r), a + 2.7, Y(r.floor), Z0 + 4);
    else node(roomNode(r), r.cx, Y(r.floor), r.cz);
  }
  const off = 0.85;
  for (const d of plan.doors) {
    if (d.kind) continue;
    const y = Y(d.floor);
    const pa = d.axis === 'x' ? [d.center, y, d.c - off] : [d.c - off, y, d.center];
    const pc = d.axis === 'x' ? [d.center, y, d.c] : [d.c, y, d.center];
    const pb = d.axis === 'x' ? [d.center, y, d.c + off] : [d.c + off, y, d.center];
    node(`d${d.id}a`, ...pa);
    node(`d${d.id}`, ...pc);
    node(`d${d.id}b`, ...pb);
    edge(roomNode(plan.rooms[d.lo]), `d${d.id}a`);
    edge(`d${d.id}a`, `d${d.id}`, d);
    edge(`d${d.id}`, `d${d.id}b`, d);
    edge(`d${d.id}b`, roomNode(plan.rooms[d.hi]));
  }

  // Stairwell.
  const sg = plan.rooms.find((r) => r.floor === 0 && r.type === 'stairs');
  const su = plan.rooms.find((r) => r.floor === 1 && r.type === 'stairs');
  node('stairFoot', a + 2.7, FLOOR, Z0 + 7.45);
  node('stairBot', a + 0.65, FLOOR, Z0 + 7.45);
  node('stairTop', a + 0.65, UPPER, Z0 + 0.7);
  node('upLanding', a + 2.7, UPPER, Z0 + 0.7);
  node('landing', a + 2.7, FLOOR, Z0 + 0.65);
  node('baseGuard', a + 0.65, FLOOR, Z0 + 0.65);
  edge(roomNode(sg), 'stairFoot');
  edge('stairFoot', 'stairBot');
  edge('stairBot', 'stairTop');
  edge('stairTop', 'upLanding');
  edge('upLanding', roomNode(su));
  edge(roomNode(sg), 'landing');
  edge('landing', 'baseGuard');

  // Yard ring.
  const xl = plan.X0 - 3;
  const xr = plan.X1 + 3;
  const zb = Z0 - 3;
  const zm = (Z0 + Z1) / 2;
  node('street', 0, 0, -1);
  node('gate', 0, 0, -6.8);
  node('ySW', xl, 0, -8);
  node('yW', xl, 0, zm);
  node('yNW', xl, 0, zb);
  node('yN', 0, 0, zb);
  node('yNE', xr, 0, zb);
  node('yE', xr, 0, zm);
  node('ySE', xr, 0, -8);
  edge('street', 'gate');
  edge('gate', 'ySW');
  edge('gate', 'ySE');
  edge('ySW', 'yW');
  edge('yW', 'yNW');
  edge('yNW', 'yN');
  edge('yN', 'yNE');
  edge('yNE', 'yE');
  edge('yE', 'ySE');

  const f = plan.frontDoor;
  node('frontIn', f.center, FLOOR, Z1 - off);
  node('frontDoor', f.center, FLOOR, Z1);
  node('frontOut', f.center, 0, Z1 + 1.6);
  edge(roomNode(plan.rooms[f.room]), 'frontIn');
  edge('frontIn', 'frontDoor', f);
  edge('frontDoor', 'frontOut', f);
  edge('frontOut', 'gate');

  const bd = plan.backDoor;
  node('backIn', bd.center, FLOOR, Z0 + off);
  node('backDoor', bd.center, FLOOR, Z0);
  node('backOut', bd.center, 0, Z0 - 1.3);
  edge(roomNode(plan.rooms[bd.room]), 'backIn');
  edge('backIn', 'backDoor', bd);
  edge('backDoor', 'backOut', bd);
  edge('backOut', bd.center < 0 ? 'yNW' : 'yNE');
  edge('backOut', 'yN');

  const patrol = [['baseGuard', 4]];
  for (const r of plan.rooms) patrol.push([roomNode(r), r.type === 'stairs' ? 1 : r.area >= 2 ? 3 : 2]);
  patrol.push(['frontOut', 1], ['yNW', 1], ['ySE', 1], ['backOut', 1]);

  plan.nav = { nodes, edges, patrol, home: roomNode(sg), guard: 'baseGuard' };
}
