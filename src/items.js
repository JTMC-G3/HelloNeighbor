import * as THREE from 'three';
import { bakeChildren } from './quality.js';

// Pick-up-able, throwable props. Each is simulated as a sphere.

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });

const KEY_COLORS = { red: 0xd62828, blue: 0x1f6fe0 };

export const ITEM_TYPES = {
  box: { name: 'Cardboard Box', radius: 0.24, bounce: 0.15, flat: true },
  can: { name: 'Soda Can', radius: 0.07, bounce: 0.35 },
  apple: { name: 'Apple', radius: 0.055, bounce: 0.3 },
  ball: { name: 'Basketball', radius: 0.12, bounce: 0.65 },
  mug: { name: 'Mug', radius: 0.07, bounce: 0.2, flat: true },
  book: { name: 'Book', radius: 0.1, bounce: 0.1, flat: true },
  radio: { name: 'Radio', radius: 0.14, bounce: 0.15, flat: true },
  milk: { name: 'Milk Carton', radius: 0.09, bounce: 0.15, flat: true },
  duck: { name: 'Rubber Duck', radius: 0.07, bounce: 0.5 },
  vase: { name: 'Vase', radius: 0.1, bounce: 0.15, flat: true },
  wrench: { name: 'Wrench', radius: 0.1, bounce: 0.2, flat: true },
  keyRed: { name: 'Red Key', radius: 0.07, bounce: 0.3, flat: true, key: 'red' },
  keyBlue: { name: 'Blue Key', radius: 0.07, bounce: 0.3, flat: true, key: 'blue' },
};

export function makeItemMesh(type, textures) {
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };

  switch (type) {
    case 'box': {
      const mat = std(0xffffff, { map: textures.cardboard, roughness: 0.95 });
      add(new THREE.BoxGeometry(0.44, 0.4, 0.44), mat);
      break;
    }
    case 'can': {
      add(new THREE.CylinderGeometry(0.034, 0.034, 0.12, 14), std(0xc0392b, { metalness: 0.4, roughness: 0.35 }));
      add(new THREE.CylinderGeometry(0.03, 0.034, 0.01, 14), std(0xcccccc, { metalness: 0.8, roughness: 0.3 }), 0, 0.065, 0);
      break;
    }
    case 'apple': {
      add(new THREE.SphereGeometry(0.05, 14, 10), std(0xb3261e, { roughness: 0.45 }));
      add(new THREE.CylinderGeometry(0.004, 0.004, 0.03, 5), std(0x4a2f1b), 0, 0.055, 0);
      break;
    }
    case 'ball': {
      add(new THREE.SphereGeometry(0.12, 18, 14), std(0xd9681e, { roughness: 0.8 }));
      const seam = std(0x222222);
      const t = add(new THREE.TorusGeometry(0.121, 0.004, 4, 32), seam);
      t.rotation.x = Math.PI / 2;
      add(new THREE.TorusGeometry(0.121, 0.004, 4, 32), seam);
      break;
    }
    case 'mug': {
      add(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 14), std(0x2e86de, { roughness: 0.3 }));
      const h = add(new THREE.TorusGeometry(0.03, 0.009, 6, 12), std(0x2e86de, { roughness: 0.3 }), 0.05, 0, 0);
      h.rotation.y = Math.PI / 2;
      break;
    }
    case 'book': {
      const colors = [0x8e44ad, 0x16a085, 0xc0392b, 0x2c3e50, 0xd35400];
      add(new THREE.BoxGeometry(0.2, 0.05, 0.15), std(colors[(Math.random() * colors.length) | 0]));
      add(new THREE.BoxGeometry(0.19, 0.042, 0.142), std(0xf5f0e1), 0.006, 0, 0);
      break;
    }
    case 'radio': {
      add(new THREE.BoxGeometry(0.3, 0.18, 0.12), std(0x6d4c41, { roughness: 0.6 }));
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.01, 16), std(0x222222), -0.07, 0, 0.062).rotation.x = Math.PI / 2;
      add(new THREE.BoxGeometry(0.08, 0.04, 0.01), std(0xf1c40f, { emissive: 0x332200 }), 0.08, 0.03, 0.062);
      add(new THREE.CylinderGeometry(0.004, 0.004, 0.25, 5), std(0xaaaaaa, { metalness: 0.9 }), 0.12, 0.2, 0).rotation.z = -0.4;
      break;
    }
    case 'milk': {
      add(new THREE.BoxGeometry(0.09, 0.18, 0.09), std(0xf7f7f7));
      add(new THREE.BoxGeometry(0.092, 0.06, 0.092), std(0x2e86de), 0, -0.02, 0);
      const roof = add(new THREE.CylinderGeometry(0.0, 0.066, 0.05, 4), std(0xf7f7f7), 0, 0.115, 0);
      roof.rotation.y = Math.PI / 4;
      break;
    }
    case 'duck': {
      const y = std(0xf4d03f, { roughness: 0.4 });
      add(new THREE.SphereGeometry(0.06, 12, 10), y, 0, -0.01, 0).scale.set(1, 0.8, 1.2);
      add(new THREE.SphereGeometry(0.04, 12, 10), y, 0, 0.05, 0.04);
      add(new THREE.ConeGeometry(0.018, 0.04, 8), std(0xe67e22), 0, 0.045, 0.085).rotation.x = Math.PI / 2;
      break;
    }
    case 'vase': {
      const pts = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        pts.push(new THREE.Vector2(0.04 + Math.sin(t * Math.PI) * 0.06, t * 0.26 - 0.13));
      }
      add(new THREE.LatheGeometry(pts, 16), std(0x1abc9c, { roughness: 0.25, side: THREE.DoubleSide }));
      break;
    }
    case 'wrench': {
      const m = std(0x95a5a6, { metalness: 0.85, roughness: 0.35 });
      add(new THREE.BoxGeometry(0.24, 0.02, 0.035), m);
      add(new THREE.TorusGeometry(0.03, 0.012, 6, 12, Math.PI * 1.5), m, 0.14, 0, 0).rotation.x = Math.PI / 2;
      break;
    }
    case 'keyRed':
    case 'keyBlue': {
      const color = KEY_COLORS[type === 'keyRed' ? 'red' : 'blue'];
      const m = std(color, { metalness: 0.6, roughness: 0.3, emissive: color, emissiveIntensity: 0.45 });
      const ring = add(new THREE.TorusGeometry(0.035, 0.012, 8, 18), m, -0.06, 0, 0);
      ring.rotation.x = Math.PI / 2;
      add(new THREE.BoxGeometry(0.11, 0.016, 0.018), m, 0.03, 0, 0);
      add(new THREE.BoxGeometry(0.015, 0.016, 0.03), m, 0.07, 0, 0.018);
      add(new THREE.BoxGeometry(0.015, 0.016, 0.022), m, 0.045, 0, 0.014);
      g.userData.glow = m;
      break;
    }
    default:
      add(new THREE.BoxGeometry(0.2, 0.2, 0.2), std(0xff00ff));
  }
  const glow = g.userData.glow;
  bakeChildren(g);
  if (glow) g.userData.glowMesh = g.children.find((c) => c.material === glow);
  return g;
}

let nextId = 1;

export class Item {
  constructor(type, textures, x, y, z, rotY = 0) {
    const def = ITEM_TYPES[type];
    this.id = nextId++;
    this.type = type;
    this.name = def.name;
    this.radius = def.radius;
    this.bounce = def.bounce;
    this.flat = !!def.flat;
    this.key = def.key || null;
    this.mesh = makeItemMesh(type, textures);
    this.mesh.userData.item = this;
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.home = new THREE.Vector3(x, y, z);
    this.homeRotY = rotY;
    this.mesh.rotation.y = rotY;
    this.sleeping = true;
    this.sleepTimer = 0;
    this.held = false;
    this.thrown = false;
    this.consumed = false;
    this.mesh.position.copy(this.pos);
  }

  resetHome() {
    this.pos.copy(this.home);
    this.vel.set(0, 0, 0);
    this.mesh.rotation.set(0, this.homeRotY, 0);
    this.sleeping = true;
    this.thrown = false;
    this.mesh.position.copy(this.pos);
  }
}
