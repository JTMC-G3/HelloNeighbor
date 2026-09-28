import * as THREE from 'three';

// All textures are drawn procedurally on canvases, so the game ships with no
// image assets at all.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function canvas(size, draw, seed) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size, rng(seed));
  return c;
}

function tex(size, draw, seed = 7) {
  const t = new THREE.CanvasTexture(canvas(size, draw, seed));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function fill(g, s, color) {
  g.fillStyle = color;
  g.fillRect(0, 0, s, s);
}

function speckle(g, s, r, n, colors, min, max, alpha = 1) {
  g.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(r() * colors.length) | 0];
    const w = min + r() * (max - min);
    g.fillRect(r() * s, r() * s, w, w);
  }
  g.globalAlpha = 1;
}

function grain(g, s, r, n, color, alpha) {
  g.strokeStyle = color;
  g.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    const x = r() * s;
    g.lineWidth = 0.5 + r() * 1.2;
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + (r() - 0.5) * 8, s * 0.33, x + (r() - 0.5) * 8, s * 0.66, x, s);
    g.stroke();
  }
  g.globalAlpha = 1;
}

export function createTextures() {
  const T = {};

  T.grass = tex(256, (g, s, r) => {
    fill(g, s, '#4f7e31');
    speckle(g, s, r, 9000, ['#5b9139', '#44722a', '#6aa045', '#3d6824', '#78a852'], 1, 3);
  }, 11);

  T.asphalt = tex(256, (g, s, r) => {
    fill(g, s, '#3a3b3e');
    speckle(g, s, r, 8000, ['#46474a', '#2f3033', '#55565a', '#28292b'], 1, 2);
  }, 12);

  T.concrete = tex(256, (g, s, r) => {
    fill(g, s, '#b7b3a8');
    speckle(g, s, r, 5000, ['#c2beb3', '#aaa69b', '#9f9b90'], 1, 3, 0.6);
    g.strokeStyle = '#8d897f';
    g.lineWidth = 3;
    g.strokeRect(0, 0, s, s);
  }, 13);

  T.siding = tex(256, (g, s, r) => {
    const n = 8;
    const h = s / n;
    for (let i = 0; i < n; i++) {
      const grd = g.createLinearGradient(0, i * h, 0, (i + 1) * h);
      grd.addColorStop(0, '#f1e2b0');
      grd.addColorStop(1, '#d9c38b');
      g.fillStyle = grd;
      g.fillRect(0, i * h, s, h);
      g.fillStyle = '#a99159';
      g.fillRect(0, (i + 1) * h - 2, s, 2);
    }
    speckle(g, s, r, 1500, ['#e6d6a2', '#cdb77e'], 1, 2, 0.5);
  }, 14);

  T.sidingBlue = tex(256, (g, s, r) => {
    const n = 8;
    const h = s / n;
    for (let i = 0; i < n; i++) {
      const grd = g.createLinearGradient(0, i * h, 0, (i + 1) * h);
      grd.addColorStop(0, '#a9c3d6');
      grd.addColorStop(1, '#8aa6bc');
      g.fillStyle = grd;
      g.fillRect(0, i * h, s, h);
      g.fillStyle = '#6c879c';
      g.fillRect(0, (i + 1) * h - 2, s, 2);
    }
    speckle(g, s, r, 1200, ['#9bb5c9', '#7f9ab0'], 1, 2, 0.5);
  }, 15);

  T.brick = tex(256, (g, s, r) => {
    fill(g, s, '#cbc3b5');
    const rows = 8;
    const bh = s / rows;
    const bw = s / 4;
    const cols = ['#9a4631', '#a8513a', '#8b3d2b', '#b05a40', '#94432f'];
    for (let y = 0; y < rows; y++) {
      const off = (y % 2) * bw * 0.5;
      for (let x = -1; x < 5; x++) {
        g.fillStyle = cols[(r() * cols.length) | 0];
        g.fillRect(x * bw + off + 2, y * bh + 2, bw - 4, bh - 4);
      }
    }
    speckle(g, s, r, 2500, ['#7b3526', '#c06a4f', '#8e8578'], 1, 2, 0.4);
  }, 16);

  T.roof = tex(256, (g, s, r) => {
    fill(g, s, '#6e241d');
    const rows = 8;
    const h = s / rows;
    const w = s / 8;
    const cols = ['#8a2f26', '#732620', '#94372c', '#7f2a22'];
    for (let y = 0; y < rows; y++) {
      const off = (y % 2) * w * 0.5;
      for (let x = -1; x < 9; x++) {
        g.fillStyle = cols[(r() * cols.length) | 0];
        g.fillRect(x * w + off + 1, y * h + 1, w - 2, h - 3);
      }
    }
    speckle(g, s, r, 2000, ['#5e1f19', '#a4453a'], 1, 2, 0.5);
  }, 17);

  T.roofGrey = tex(256, (g, s, r) => {
    fill(g, s, '#3c3f45');
    const rows = 8;
    const h = s / rows;
    const w = s / 8;
    const cols = ['#4a4e55', '#43474d', '#52565e', '#3f4349'];
    for (let y = 0; y < rows; y++) {
      const off = (y % 2) * w * 0.5;
      for (let x = -1; x < 9; x++) {
        g.fillStyle = cols[(r() * cols.length) | 0];
        g.fillRect(x * w + off + 1, y * h + 1, w - 2, h - 3);
      }
    }
  }, 18);

  T.wood = tex(256, (g, s, r) => {
    const cols = ['#a0703f', '#94653a', '#aa7a48', '#8a5c33', '#9c6d40'];
    const n = 4;
    const w = s / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = cols[(r() * cols.length) | 0];
      g.fillRect(i * w, 0, w, s);
      const cut = r() * s;
      g.fillStyle = '#6b4526';
      g.fillRect(i * w, cut, w, 2);
    }
    grain(g, s, r, 70, '#5e3c20', 0.25);
    g.fillStyle = '#5a3a1f';
    for (let i = 0; i < n; i++) g.fillRect(i * w, 0, 2, s);
  }, 19);

  T.darkwood = tex(256, (g, s, r) => {
    fill(g, s, '#5b3a22');
    grain(g, s, r, 90, '#3f2715', 0.35);
    speckle(g, s, r, 800, ['#6a4529'], 1, 2, 0.4);
  }, 20);

  T.tile = tex(128, (g, s) => {
    const n = 4;
    const w = s / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        g.fillStyle = (x + y) % 2 ? '#3f4c5c' : '#ece8dc';
        g.fillRect(x * w, y * w, w, w);
      }
    }
    g.strokeStyle = '#9c978b';
    g.lineWidth = 1.5;
    for (let i = 0; i <= n; i++) {
      g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.stroke();
      g.beginPath(); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke();
    }
  }, 21);

  T.wallpaper = tex(128, (g, s, r) => {
    fill(g, s, '#cdd8b4');
    for (let x = 0; x < s; x += 32) {
      g.fillStyle = '#b9c89a';
      g.fillRect(x, 0, 14, s);
      g.fillStyle = '#a8b98a';
      g.fillRect(x + 20, 0, 2, s);
    }
    speckle(g, s, r, 400, ['#c4cfaa'], 1, 2, 0.5);
  }, 22);

  T.wallpaper2 = tex(128, (g, s) => {
    fill(g, s, '#e6d6d9');
    g.fillStyle = '#c99aa6';
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const cx = x * 32 + (y % 2) * 16 + 8;
        const cy = y * 32 + 16;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          g.beginPath();
          g.arc(cx + Math.cos(a) * 4, cy + Math.sin(a) * 4, 2.5, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }, 23);

  T.wallpaper3 = tex(128, (g, s) => {
    fill(g, s, '#d9c9a3');
    g.strokeStyle = '#c1ad80';
    g.lineWidth = 2;
    for (let i = -s; i < s * 2; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.stroke();
      g.beginPath(); g.moveTo(i, s); g.lineTo(i + s, 0); g.stroke();
    }
  }, 24);

  T.plaster = tex(256, (g, s, r) => {
    fill(g, s, '#e9e3d4');
    speckle(g, s, r, 3000, ['#e1dbcb', '#f1ebdd', '#ddd6c5'], 1, 3, 0.5);
  }, 25);

  T.fence = tex(256, (g, s, r) => {
    const n = 8;
    const w = s / n;
    const cols = ['#c9a46c', '#c29c63', '#d0ac75', '#bb955c'];
    for (let i = 0; i < n; i++) {
      g.fillStyle = cols[(r() * cols.length) | 0];
      g.fillRect(i * w, 0, w, s);
      g.fillStyle = '#6e5638';
      g.fillRect(i * w, 0, 3, s);
    }
    grain(g, s, r, 40, '#8b6a40', 0.25);
  }, 26);

  T.basement = tex(256, (g, s, r) => {
    fill(g, s, '#6b675f');
    speckle(g, s, r, 6000, ['#75716a', '#5f5b54', '#827d74'], 1, 3, 0.6);
    g.globalAlpha = 0.12;
    for (let i = 0; i < 12; i++) {
      g.fillStyle = r() > 0.5 ? '#3e3a33' : '#4a4b3a';
      g.beginPath();
      g.arc(r() * s, r() * s, 10 + r() * 30, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }, 27);

  T.carpet = tex(256, (g, s, r) => {
    fill(g, s, '#7b3232');
    speckle(g, s, r, 12000, ['#853838', '#6e2b2b', '#8f4040'], 1, 2);
  }, 28);

  T.carpetBlue = tex(256, (g, s, r) => {
    fill(g, s, '#3e4f73');
    speckle(g, s, r, 12000, ['#46587e', '#364566', '#4f6189'], 1, 2);
  }, 29);

  T.cardboard = tex(128, (g, s, r) => {
    fill(g, s, '#b88a55');
    speckle(g, s, r, 800, ['#a97c4a', '#c79a63'], 1, 2, 0.6);
    g.fillStyle = '#d8c49a';
    g.fillRect(0, s * 0.44, s, s * 0.12);
  }, 30);

  T.hedge = tex(128, (g, s, r) => {
    fill(g, s, '#2f5a22');
    speckle(g, s, r, 3500, ['#3a6d2a', '#274b1c', '#4a7f35', '#20401a'], 2, 5);
  }, 31);

  T.bark = tex(128, (g, s, r) => {
    fill(g, s, '#5a4330');
    grain(g, s, r, 50, '#3b2b1d', 0.6);
  }, 32);

  T.leaves = tex(128, (g, s, r) => {
    fill(g, s, '#3f6f2a');
    speckle(g, s, r, 3000, ['#4d8233', '#335c22', '#5c963e', '#2a4c1c'], 2, 5);
  }, 33);

  // Argyle knit for the neighbor's sweater vest.
  T.vest = tex(128, (g, s) => {
    fill(g, s, '#8c6a43');
    g.fillStyle = '#a98357';
    const d = s / 2;
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const cx = x * d + d / 2;
        const cy = y * d + d / 2;
        g.beginPath();
        g.moveTo(cx, cy - d / 2);
        g.lineTo(cx + d / 2, cy);
        g.lineTo(cx, cy + d / 2);
        g.lineTo(cx - d / 2, cy);
        g.closePath();
        g.fill();
      }
    }
    g.strokeStyle = '#e5d7b5';
    g.lineWidth = 1.5;
    for (let i = -s; i < s * 2; i += d) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.stroke();
      g.beginPath(); g.moveTo(i, s); g.lineTo(i + s, 0); g.stroke();
    }
  }, 34);

  // A child's crayon drawing, pinned up in the basement.
  const drawing = (seed, variant) => {
    const t = new THREE.CanvasTexture(canvas(256, (g, s, r) => {
      fill(g, s, '#f4f1e6');
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const wob = (x) => x + (r() - 0.5) * 4;
      const line = (pts, color, w) => {
        g.strokeStyle = color;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(wob(pts[0][0]), wob(pts[0][1]));
        for (let i = 1; i < pts.length; i++) g.lineTo(wob(pts[i][0]), wob(pts[i][1]));
        g.stroke();
      };
      if (variant === 0) {
        // A house with a big dark door underneath it.
        line([[60, 150], [60, 90], [128, 40], [196, 90], [196, 150], [60, 150]], '#c0392b', 5);
        line([[110, 150], [110, 115], [146, 115], [146, 150]], '#2c3e50', 5);
        line([[70, 150], [70, 220], [186, 220], [186, 150]], '#222', 4);
        g.fillStyle = '#111';
        g.fillRect(110, 175, 36, 40);
        line([[20, 230], [236, 230]], '#27ae60', 6);
        line([[200, 30], [215, 45], [230, 30]], '#f1c40f', 4);
      } else {
        // A stick figure behind bars.
        line([[128, 70], [128, 150]], '#222', 5);
        line([[128, 95], [100, 125]], '#222', 5);
        line([[128, 95], [156, 125]], '#222', 5);
        line([[128, 150], [108, 200]], '#222', 5);
        line([[128, 150], [148, 200]], '#222', 5);
        g.strokeStyle = '#222';
        g.lineWidth = 5;
        g.beginPath(); g.arc(128, 55, 16, 0, Math.PI * 2); g.stroke();
        for (let x = 70; x <= 190; x += 24) line([[x, 30], [x, 220]], '#7f8c8d', 4);
        line([[40, 240], [90, 240]], '#c0392b', 3);
        g.fillStyle = '#c0392b';
        g.font = 'bold 28px Comic Sans MS, cursive';
        g.fillText('HELP', 150, 245);
      }
    }, seed));
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  T.drawing1 = drawing(40, 0);
  T.drawing2 = drawing(41, 1);

  // Animated TV static: redrawn a few times per second by the world update.
  const staticCanvas = document.createElement('canvas');
  staticCanvas.width = 64;
  staticCanvas.height = 48;
  T.tvStatic = new THREE.CanvasTexture(staticCanvas);
  T.tvStatic.colorSpace = THREE.SRGBColorSpace;
  T.tvStatic.magFilter = THREE.NearestFilter;
  T.updateStatic = () => {
    const g = staticCanvas.getContext('2d');
    const img = g.createImageData(64, 48);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    T.tvStatic.needsUpdate = true;
  };
  T.updateStatic();

  return T;
}
