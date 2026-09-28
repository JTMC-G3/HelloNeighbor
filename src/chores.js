import * as THREE from 'three';
import { bakeChildren } from './quality.js';

/*
 * Things the neighbor does when he isn't chasing anyone. Each chore happens
 * at a "station" registered by world.js (a toilet, a sink, a couch, the
 * lawnmower...). A chore has:
 *   dur      how long it lasts [min, max] seconds
 *   fixed    'sit' / 'lie' to plant him on furniture instead of standing
 *   prop     something held in his hand
 *   sound    [kind, every] a sound played periodically while doing it
 *   pose     arm/torso/head animation
 *   start / update / end   optional extra behaviour
 */

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o });

function makeProp(type) {
  const g = new THREE.Group();
  const add = (geo, m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    g.add(mesh);
  };
  switch (type) {
    case 'plate':
      add(new THREE.CylinderGeometry(0.12, 0.09, 0.02, 16), mat(0xf4f1ea), 0, 0, 0.08, Math.PI / 2);
      break;
    case 'spatula':
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6), mat(0x222222), 0, -0.1, 0.08, 0.6);
      add(new THREE.BoxGeometry(0.08, 0.1, 0.01), mat(0x999999, { metalness: 0.8 }), 0, -0.25, 0.18, 0.6);
      break;
    case 'book':
      add(new THREE.BoxGeometry(0.22, 0.03, 0.3), mat(0x7b2d26), 0.18, -0.02, 0.12, 0.2);
      add(new THREE.BoxGeometry(0.21, 0.035, 0.29), mat(0xf5f0e1), 0.18, -0.005, 0.12, 0.2);
      break;
    case 'hammer':
      add(new THREE.CylinderGeometry(0.015, 0.015, 0.32, 6), mat(0x8b5a2b), 0, -0.05, 0.12, Math.PI / 2);
      add(new THREE.BoxGeometry(0.05, 0.05, 0.14), mat(0x777777, { metalness: 0.8 }), 0, -0.05, 0.28, 0, 0, 0);
      break;
    case 'broom':
      add(new THREE.CylinderGeometry(0.015, 0.015, 1.3, 6), mat(0xb08850), 0, -0.45, 0.1);
      add(new THREE.BoxGeometry(0.28, 0.18, 0.07), mat(0xd9c27a), 0, -1.12, 0.1);
      break;
    case 'can':
      add(new THREE.CylinderGeometry(0.09, 0.1, 0.2, 12), mat(0x3f8f4f, { metalness: 0.4 }), 0, -0.12, 0.12);
      add(new THREE.CylinderGeometry(0.012, 0.02, 0.25, 6), mat(0x3f8f4f, { metalness: 0.4 }), 0, -0.12, 0.3, 1.1);
      break;
    case 'letters':
      add(new THREE.BoxGeometry(0.2, 0.005, 0.12), mat(0xf7f7f2), 0, -0.02, 0.1, 0.4);
      add(new THREE.BoxGeometry(0.2, 0.005, 0.12), mat(0xe8dcc0), 0.02, -0.01, 0.11, 0.35);
      break;
    default:
      break;
  }
  bakeChildren(g);
  return g;
}

// Reusable poses.
const sitPose = (m) => {
  m.legs[0].rotation.x = -1.45;
  m.legs[1].rotation.x = -1.45;
  m.body.position.y = -0.45;
};

export const CHORES = {
  pee: {
    label: 'using the toilet',
    dur: [6, 9],
    sound: ['trickle', 0.65],
    pose(m, t) {
      m.arms[0].rotation.x = m.arms[1].rotation.x = -0.35;
      m.arms[0].rotation.z = 0.25;
      m.arms[1].rotation.z = -0.25;
      m.head.rotation.x = t % 5 < 3 ? 0.3 : -0.25; // look down, then whistle at the ceiling
    },
  },
  dishes: {
    label: 'doing the dishes',
    dur: [10, 16],
    prop: 'plate',
    hand: 1,
    sound: ['splash', 0.9],
    pose(m, t) {
      m.torso.rotation.x = 0.15;
      m.arms[0].rotation.x = -1.0 + Math.sin(t * 9) * 0.15;
      m.arms[1].rotation.x = -1.0 - Math.sin(t * 9) * 0.1;
      m.head.rotation.x = 0.35;
    },
  },
  cook: {
    label: 'cooking',
    dur: [10, 16],
    prop: 'spatula',
    sound: ['sizzle', 1.0],
    pose(m, t) {
      m.arms[0].rotation.x = -1.1 + Math.sin(t * 5) * 0.2;
      m.arms[0].rotation.z = Math.cos(t * 5) * 0.15;
      m.arms[1].rotation.x = -0.5;
      m.head.rotation.x = 0.3;
    },
  },
  tv: {
    label: 'watching TV',
    dur: [14, 22],
    fixed: 'sit',
    pose(m, t) {
      sitPose(m);
      m.arms[0].rotation.x = m.arms[1].rotation.x = -0.9;
      m.head.rotation.y = Math.sin(t * 0.4) * 0.15;
    },
    start(n, game, task) {
      const app = task.station.app;
      if (app && !app.on) {
        game.setAppliance(app, true);
        app.byNeighbor = true;
      }
    },
    end(n, game, task) {
      const app = task.station.app;
      if (app && app.on && app.byNeighbor) game.setAppliance(app, false);
      if (app) app.byNeighbor = false;
    },
  },
  read: {
    label: 'reading',
    dur: [12, 20],
    fixed: 'sit',
    prop: 'book',
    sound: ['paper', 4.5],
    pose(m) {
      sitPose(m);
      m.arms[0].rotation.x = m.arms[1].rotation.x = -1.15;
      m.arms[0].rotation.z = 0.3;
      m.arms[1].rotation.z = -0.3;
      m.head.rotation.x = 0.4;
    },
  },
  nap: {
    label: 'napping',
    dur: [18, 28],
    fixed: 'lie',
    asleep: true,
    sound: ['snore', 2.6],
    pose(m, t) {
      m.head.rotation.z = Math.sin(t * 0.8) * 0.05;
    },
  },
  piano: {
    label: 'playing the piano',
    dur: [10, 15],
    fixed: 'sit',
    sound: ['piano', 0.32],
    pose(m, t) {
      sitPose(m);
      m.arms[0].rotation.x = -1.25 + Math.sin(t * 14) * 0.08;
      m.arms[1].rotation.x = -1.25 + Math.cos(t * 11) * 0.08;
      m.head.rotation.z = Math.sin(t * 2) * 0.1;
    },
  },
  hammer: {
    label: 'fixing something',
    dur: [8, 12],
    prop: 'hammer',
    pose(m, t) {
      m.torso.rotation.x = 0.12;
      m.arms[0].rotation.x = -1.2 - Math.max(0, Math.sin(t * 7)) * 0.9;
      m.arms[1].rotation.x = -0.8;
      m.head.rotation.x = 0.35;
    },
    update(n, dt, game, task) {
      // Clang on each downswing.
      const prev = Math.sin((task.t - dt) * 7);
      if (prev > 0 && Math.sin(task.t * 7) <= 0) n.sound.chore('clang', n.ch.pos);
      return false;
    },
  },
  laundry: {
    label: 'doing laundry',
    dur: [8, 12],
    sound: ['rumble', 1.0],
    pose(m, t) {
      m.torso.rotation.x = 0.45;
      m.arms[0].rotation.x = -1.3 + Math.sin(t * 4) * 0.2;
      m.arms[1].rotation.x = -1.3 - Math.sin(t * 4) * 0.2;
    },
  },
  sweep: {
    label: 'sweeping',
    dur: [10, 15],
    prop: 'broom',
    sound: ['brush', 0.8],
    walks: true,
    pose(m, t) {
      m.torso.rotation.x = 0.12;
      m.arms[0].rotation.x = -0.6 + Math.sin(t * 3) * 0.15;
      m.arms[1].rotation.x = -0.5;
      m.arms[0].rotation.z = m.arms[1].rotation.z = Math.sin(t * 3) * 0.35;
    },
    update(n, dt, game, task) {
      // Slowly sweep in a little loop around the spot.
      const a = task.t * 0.35;
      const s = task.station.stand;
      n.tmp.set(s.x + Math.cos(a) * 0.7, s.y, s.z + Math.sin(a) * 0.7);
      n.moveToward(n.tmp, 0.5, dt);
      return false;
    },
  },
  mow: {
    label: 'mowing the lawn',
    dur: [60, 60],
    walks: true,
    sound: ['engine', 0.45],
    deaf: 0.5,
    pose(m) {
      m.torso.rotation.x = 0.1;
      m.arms[0].rotation.x = m.arms[1].rotation.x = -0.75;
    },
    start(n, game, task) {
      task.route = task.station.route();
      task.leg = 0;
    },
    update(n, dt, game, task) {
      const mower = task.station.mower;
      const target = task.route[task.leg];
      if (!target) return true;
      if (Math.hypot(target.x - n.ch.pos.x, target.z - n.ch.pos.z) < 0.6) task.leg++;
      else n.moveToward(target, 1.5, dt);
      // Push the mower along in front.
      const fx = Math.sin(n.heading);
      const fz = Math.cos(n.heading);
      mower.position.set(n.ch.pos.x + fx * 0.95, n.ch.pos.y, n.ch.pos.z + fz * 0.95);
      mower.rotation.y = n.heading;
      return task.leg >= task.route.length;
    },
    end(n, game, task) {
      // Next time he picks the mower up from wherever he left it.
      const m = task.station.mower;
      task.station.stand.set(m.position.x - Math.sin(m.rotation.y) * 0.95, m.position.y, m.position.z - Math.cos(m.rotation.y) * 0.95);
      task.station.heading = m.rotation.y;
    },
  },
  water: {
    label: 'watering the flowers',
    dur: [8, 12],
    prop: 'can',
    sound: ['trickle', 0.8],
    pose(m, t) {
      m.arms[0].rotation.x = -0.95;
      m.arms[0].rotation.z = Math.sin(t * 0.8) * 0.2;
      m.arms[1].rotation.x = -0.2;
      m.head.rotation.x = 0.35;
    },
  },
  mailbox: {
    label: 'checking the mail',
    dur: [7, 9],
    sound: ['paper', 1.8],
    pose(m, t) {
      if (t < 1.6) {
        m.arms[0].rotation.x = -1.5;
      } else {
        m.arms[0].rotation.x = -1.0;
        m.arms[1].rotation.x = -0.8;
        m.head.rotation.x = 0.4;
      }
    },
    update(n, dt, game, task) {
      if (task.t > 1.6 && !task.prop) n.holdProp(task, 'letters', 0);
      return false;
    },
  },
};

export { makeProp };
