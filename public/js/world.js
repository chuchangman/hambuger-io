/* 3D 식당 — 씬 구성, 스테이션, 조리 시각화, 원격 플레이어 */
import * as THREE from '/vendor/three.module.js';
import { S, now } from './net.js';

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 120);
export const interactables = [];   // 조준 가능한 메시
export const solids = [];          // 충돌용 AABB {minX,maxX,minZ,maxZ}

let renderer;
const dynamic = {
  grill: [], toaster: [], boards: [], plate: null, plateLayers: [],
  hand: null, customer: null, bubble: null, remotes: new Map(), brooms: []
};

/* ──────────────── 재료별 색 ──────────────── */
const C = {
  bun: 0xdca85c, bunToast: 0xc98a3a, bunRaw: 0xe8c98d,
  patty: 0x6b4020, pattyRaw: 0xb2705c, burnt: 0x241610,
  cheese: 0xf5c542, bacon: 0xa8402f, egg: 0xf7f3e8, yolk: 0xf2b705,
  lettuce: 0x6fbf50, tomato: 0xd94a3c, onion: 0xf0e6dc, pickle: 0x8fae3d,
  ketchup: 0xcf3b2f, mustard: 0xe0b21c, mayo: 0xf5f0dc, special: 0xd98750
};

const SAUCE_COLOR = { ketchup: C.ketchup, mustard: C.mustard, mayo: C.mayo, special: C.special };

/* ──────────────── 헬퍼 ──────────────── */
const mat = (color, opts) => new THREE.MeshLambertMaterial(Object.assign({ color }, opts || {}));

function box(w, h, d, color, x, y, z, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  (parent || scene).add(m);
  return m;
}

function cyl(r, h, color, x, y, z, parent, seg) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg || 16), mat(color));
  m.position.set(x, y, z);
  (parent || scene).add(m);
  return m;
}

function addSolid(x, z, w, d) {
  solids.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
}

function station(mesh, data) {
  mesh.userData.station = data;
  interactables.push(mesh);
  return mesh;
}

/**
 * 조준 판정용 투명 박스.
 * 그릴 팬처럼 납작한 물체는 정확히 겨냥하기 어려우므로,
 * 조리대 위 공간을 넉넉히 덮는 보이지 않는 상자를 대신 조준 대상으로 삼는다.
 */
function hitProxy(x, y, z, w, h, d, data) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
  );
  m.position.set(x, y, z);
  m.renderOrder = -1;
  scene.add(m);
  return station(m, data);
}

/* 캔버스 텍스처 라벨/게이지 */
class Panel {
  constructor(w, h, scale) {
    this.cv = document.createElement('canvas');
    this.cv.width = w; this.cv.height = h;
    this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false }));
    this.sprite.scale.set(scale, scale * h / w, 1);
    this.sprite.renderOrder = 10;
  }
  clear() { this.ctx.clearRect(0, 0, this.cv.width, this.cv.height); }
  text(str, opts) {
    const o = opts || {};
    const ctx = this.ctx;
    const W = this.cv.width, H = this.cv.height;
    this.clear();
    if (o.bg !== false) {
      ctx.fillStyle = o.bg || 'rgba(20,16,13,.82)';
      ctx.beginPath();
      const r = 14;
      ctx.roundRect(2, 2, W - 4, H - 4, r);
      ctx.fill();
    }
    ctx.fillStyle = o.color || '#fff';
    ctx.font = (o.font || '600 ' + Math.round(H * 0.44) + 'px system-ui, sans-serif');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(str, W / 2, H / 2 + (o.dy || 0));
    this.tex.needsUpdate = true;
  }
  gauge(title, pct, color, sub) {
    const ctx = this.ctx, W = this.cv.width, H = this.cv.height;
    this.clear();
    ctx.fillStyle = 'rgba(20,16,13,.85)';
    ctx.beginPath(); ctx.roundRect(2, 2, W - 4, H - 4, 12); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 30px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(title, W / 2, H * 0.32);
    // 바
    const bx = 18, bw = W - 36, by = H * 0.56, bh = 18;
    ctx.fillStyle = '#3a2f24';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 9); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(bx, by, Math.max(6, bw * pct), bh, 9); ctx.fill();
    if (sub) {
      ctx.fillStyle = '#c9b79c';
      ctx.font = '600 22px system-ui, sans-serif';
      ctx.fillText(sub, W / 2, H * 0.86);
    }
    this.tex.needsUpdate = true;
  }
}

function labelSprite(text, scale, y, parent, color) {
  const p = new Panel(256, 64, scale || 0.9);
  p.text(text, { color: color || '#fff' });
  p.sprite.position.y = y;
  (parent || scene).add(p.sprite);
  return p;
}

/* ──────────────── 재료 메시 ──────────────── */
export function makeItemMesh(item) {
  const g = new THREE.Group();
  if (!item) return g;
  const t = item.type;
  const burnt = item.quality === 0 && item.cookLabel === '탐';

  if (t === 'patty' || t === 'bacon' || t === 'egg') {
    if (t === 'patty') {
      const col = burnt ? C.burnt : (item.raw ? C.pattyRaw : C.patty);
      cyl(0.26, 0.09, col, 0, 0, 0, g, 20);
    } else if (t === 'bacon') {
      const col = burnt ? C.burnt : C.bacon;
      const b = box(0.5, 0.035, 0.14, col, 0, 0, 0, g);
      b.rotation.y = 0.2;
    } else {
      cyl(0.24, 0.035, burnt ? C.burnt : C.egg, 0, 0, 0, g, 18);
      const y = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), mat(C.yolk));
      y.position.set(0.03, 0.03, 0); y.scale.y = 0.6; g.add(y);
    }
  } else if (t === 'bun_bottom' || t === 'bun_top') {
    const col = burnt ? C.burnt : (item.toasted ? C.bunToast : C.bunRaw);
    if (t === 'bun_bottom') cyl(0.3, 0.11, col, 0, 0, 0, g, 20);
    else {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(col));
      dome.scale.y = 0.62; g.add(dome);
      cyl(0.3, 0.05, col, 0, 0.01, 0, g, 20);
    }
  } else if (t === 'cheese') {
    const c = box(0.46, 0.018, 0.46, C.cheese, 0, 0, 0, g);
    c.rotation.y = Math.PI / 4;
  } else if (t === 'lettuce') {
    const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 0), mat(C.lettuce, { flatShading: true }));
    l.scale.y = 0.22; g.add(l);
  } else if (t === 'tomato') {
    cyl(0.24, 0.03, C.tomato, 0, 0, 0, g, 14);
  } else if (t === 'onion') {
    const o = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.045, 6, 16), mat(C.onion));
    o.rotation.x = Math.PI / 2; g.add(o);
  } else if (t === 'pickle') {
    for (let i = 0; i < 3; i++) cyl(0.09, 0.025, C.pickle, (i - 1) * 0.14, 0, 0.03 * i, g, 12);
  } else if (t === 'sauce') {
    cyl(0.24, 0.022, SAUCE_COLOR[item.sauceType] || C.ketchup, 0, 0, 0, g, 16);
  } else if (t === 'broom') {
    const stick = cyl(0.035, 1.25, 0xb98b46, 0, 0.25, 0, g, 10);
    const head = box(0.34, 0.30, 0.14, 0xd9b45a, 0, -0.48, 0, g);
    head.rotation.z = 0.05;
    for (let i = 0; i < 5; i++) {
      box(0.045, 0.20, 0.1, 0xc79a3f, -0.12 + i * 0.06, -0.70, 0, g);
    }
    stick.userData.noTint = true;
  } else {
    box(0.2, 0.2, 0.2, 0xcccccc, 0, 0, 0, g);
  }
  return g;
}

const LAYER_H = { patty: 0.1, bun_bottom: 0.12, bun_top: 0.2, cheese: 0.03, bacon: 0.05,
  egg: 0.06, lettuce: 0.08, tomato: 0.04, onion: 0.06, pickle: 0.04, sauce: 0.03 };

/* ──────────────── 식당 짓기 ──────────────── */
function buildRoom() {
  scene.background = new THREE.Color(0x9fd4e8);
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(6, 12, 4);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xfff0d8, 0.7);
  dir2.position.set(-8, 8, -6);
  scene.add(dir2);

  // 바닥 (체커 타일)
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#e9e6df'; cx.fillRect(0, 0, 64, 64);
  cx.fillStyle = '#d5d1c7'; cx.fillRect(0, 0, 32, 32); cx.fillRect(32, 32, 32, 32);
  cx.strokeStyle = '#c2beb2'; cx.lineWidth = 2; cx.strokeRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 20);
  tex.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(18, 20), new THREE.MeshLambertMaterial({ map: tex }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // 천장
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(18, 20), mat(0xf3f1ec));
  ceil.rotation.x = Math.PI / 2; ceil.position.y = 3.4;
  scene.add(ceil);

  // 벽
  const wallMat = mat(0xbfe3d4);
  const mk = (w, h, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.set(x, y, z); m.rotation.y = ry; scene.add(m); return m;
  };
  mk(18, 3.4, 0, 1.7, -10, 0);            // 앞(손님 쪽)
  mk(18, 3.4, 0, 1.7, 10, Math.PI);       // 뒤
  mk(20, 3.4, -9, 1.7, 0, Math.PI / 2);   // 좌
  mk(20, 3.4, 9, 1.7, 0, -Math.PI / 2);   // 우

  // 방 경계
  addSolid(0, -10.4, 20, 0.8);
  addSolid(0, 10.4, 20, 0.8);
  addSolid(-9.4, 0, 0.8, 22);
  addSolid(9.4, 0, 0.8, 22);

  // 메뉴판 (뒷벽)
  const menu = box(4.2, 1.6, 0.08, 0x2f2b26, 0, 2.35, 9.9);
  box(3.9, 1.35, 0.02, 0x3d3830, 0, 0, -0.06, menu);
  labelSprite('오늘의 버거', 2.2, 0.45, menu, '#f5b942');
  labelSprite('주문서를 보고 만드세요', 2.6, 0.05, menu, '#e8e0d2');
}

/* ──────────────── 바닥 구역 표시 ────────────────
   어디로 가야 하는지 한눈에 보이도록 바닥을 색으로 칠한다.
   rect 형식: [x1, z1, x2, z2]
   ──────────────────────────────────────────────── */
export const ZONES = [
  {
    id: 'counter', name: '🔴 카운터', help: '손님 응대 · 주문패드 · 서빙 창구',
    color: 0xe05252, rects: [[-5.5, -6.7, 5.5, -4.4]]
  },
  {
    id: 'kitchen', name: '🟢 주방', help: '재료를 집어 굽고 썰어주세요',
    color: 0x58c07a, rects: [[-6.2, -5.4, -4.0, 6.0], [4.0, -5.8, 6.2, 5.6]]
  },
  {
    id: 'assemble', name: '🔵 조립대', help: '아래에서 위로 재료를 쌓으세요',
    color: 0x63a8e8, rects: [[-2.8, 3.85, 2.8, 5.7]]
  }
];

const LOBBY_ZONE = { id: 'floor', name: '🚶 매장 통로', help: '카운터 또는 주방으로 이동하세요' };

function buildZones() {
  for (const zone of ZONES) {
    for (const [x1, z1, x2, z2] of zone.rects) {
      const w = Math.abs(x2 - x1), d = Math.abs(z2 - z1);
      const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;

      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshBasicMaterial({ color: zone.color, transparent: true, opacity: 0.16, depthWrite: false })
      );
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(cx, 0.012, cz);
      scene.add(fill);

      // 테두리 선
      const pts = [
        new THREE.Vector3(x1, 0.02, z1), new THREE.Vector3(x2, 0.02, z1),
        new THREE.Vector3(x2, 0.02, z2), new THREE.Vector3(x1, 0.02, z2),
        new THREE.Vector3(x1, 0.02, z1)
      ];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: zone.color, transparent: true, opacity: 0.7 })
      );
      scene.add(line);
    }
  }
}

/** 현재 서 있는 구역 (없으면 통로) */
export function currentZone(x, z) {
  for (const zone of ZONES) {
    for (const [x1, z1, x2, z2] of zone.rects) {
      if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) &&
          z >= Math.min(z1, z2) && z <= Math.max(z1, z2)) return zone;
    }
  }
  return LOBBY_ZONE;
}

/* 카운터 상판 만들기 */
function counterTop(x, z, w, d, color) {
  const body = box(w, 1.0, d, color || 0xe08a3c, x, 0.5, z);
  box(w + 0.08, 0.09, d + 0.08, 0xf1ece1, x, 1.03, z);
  addSolid(x, z, w, d);
  return body;
}

/* ──────────────── 스테이션 ──────────────── */
const BIN_LAYOUT = [
  ['patty', -4.2], ['bacon', -3.2], ['egg', -2.2], ['cheese', -1.2],
  ['bun_bottom', -0.2], ['bun_top', 0.8],
  ['lettuce', 1.8], ['tomato', 2.8], ['onion', 3.8], ['pickle', 4.8]
];

function buildIngredientLine() {
  const X = -6.6;
  counterTop(X, 0.3, 1.0, 10.4, 0xd8d3c6);

  for (const [item, z] of BIN_LAYOUT) {
    const ing = S.cfg.ingredients[item];
    box(0.72, 0.26, 0.72, 0xf4f0e6, X + 0.12, 1.2, z);
    hitProxy(X + 0.1, 1.45, z, 1.0, 0.8, 0.94, { kind: 'bin', item, label: ing.name + ' 집기' });

    // 통 안에 샘플 재료
    const sample = makeItemMesh({ type: item, raw: true, toasted: false });
    sample.position.set(X + 0.12, 1.36, z);
    sample.scale.setScalar(0.8);
    scene.add(sample);

    const p = labelSprite(ing.emoji + ' ' + ing.name, 1.05, 0, scene, '#fff');
    p.sprite.position.set(X + 0.12, 1.78, z);
  }

  const t = labelSprite('🧊 재료 냉장고', 2.2, 0, scene, '#9fe8ff');
  t.sprite.position.set(X + 0.2, 2.5, 0.3);
}

function buildGrill() {
  const X = 6.6;
  counterTop(X, -3.0, 1.0, 4.6, 0x4a4640);
  const surface = box(0.86, 0.06, 4.2, 0x2e2b27, X - 0.05, 1.07, -3.0);
  surface.userData.noHit = true;

  for (let i = 0; i < S.cfg.slots.grill; i++) {
    const z = -4.9 + i * 0.64;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.03, 18), mat(0x3d3a35));
    pad.position.set(X - 0.05, 1.11, z);
    scene.add(pad);
    hitProxy(X - 0.1, 1.45, z, 1.0, 0.78, 0.64, { kind: 'grill', slot: i, label: '그릴 ' + (i + 1) });

    const g = new Panel(256, 96, 0.62);
    g.sprite.position.set(X - 0.05, 1.62, z);
    g.sprite.visible = false;
    scene.add(g.sprite);
    dynamic.grill.push({ pad, panel: g, mesh: null });
  }
  const t = labelSprite('🔥 그릴', 1.7, 0, scene, '#ffb36b');
  t.sprite.position.set(X - 0.1, 2.4, -3.0);
}

function buildToaster() {
  const X = 6.6;
  counterTop(X, 0.6, 1.0, 2.2, 0x6b6660);
  for (let i = 0; i < S.cfg.slots.toaster; i++) {
    const z = -0.15 + i * 0.75;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.6), mat(0x8f8a82));
    pad.position.set(X - 0.05, 1.11, z);
    scene.add(pad);
    hitProxy(X - 0.1, 1.45, z, 1.0, 0.78, 0.75, { kind: 'toast', slot: i, label: '토스터 ' + (i + 1) });

    const g = new Panel(256, 96, 0.62);
    g.sprite.position.set(X - 0.05, 1.6, z);
    g.sprite.visible = false;
    scene.add(g.sprite);
    dynamic.toaster.push({ pad, panel: g, mesh: null });
  }
  const t = labelSprite('🍞 토스터', 1.7, 0, scene, '#ffd9a0');
  t.sprite.position.set(X - 0.1, 2.4, 0.6);
}

function buildSauces() {
  const X = 6.6;
  counterTop(X, 3.9, 1.0, 2.6, 0xd8d3c6);
  const types = S.cfg.sauces.filter((s) => s !== 'none');
  types.forEach((s, i) => {
    const z = 2.9 + i * 0.66;
    const body = cyl(0.16, 0.42, SAUCE_COLOR[s] || 0xcccccc, X - 0.05, 1.26, z, scene, 14);
    cyl(0.06, 0.16, 0xf0ece2, 0, 0.28, 0, body, 10);
    hitProxy(X - 0.1, 1.45, z, 1.0, 0.8, 0.66, { kind: 'sauce', sauceType: s, label: S.cfg.sauceLabel[s] });
    const p = labelSprite(S.cfg.sauceLabel[s], 1.05, 0, scene, '#fff');
    p.sprite.position.set(X - 0.05, 1.72, z);
  });
  const t = labelSprite('🥫 소스', 1.5, 0, scene, '#ffc9a0');
  t.sprite.position.set(X - 0.1, 2.4, 3.9);
}

function buildIsland() {
  counterTop(0, 1.2, 2.6, 5.2, 0xe0b07a);

  // 도마 2개
  for (let i = 0; i < S.cfg.slots.boards; i++) {
    const x = i === 0 ? -0.7 : 0.7;
    const z = -0.5;
    const bd = box(1.0, 0.07, 0.8, 0xc99a5e, x, 1.11, z);
    hitProxy(x, 1.48, z, 1.15, 0.82, 1.4, { kind: 'board', board: i, label: '도마 ' + (i + 1) });
    const g = new Panel(256, 96, 0.62);
    g.sprite.position.set(x, 1.62, z);
    g.sprite.visible = false;
    scene.add(g.sprite);
    dynamic.boards.push({ mesh: bd, panel: g, item: null });
  }
  const lb = labelSprite('🔪 도마 (E 연타)', 1.6, 0, scene, '#fff');
  lb.sprite.position.set(0, 1.95, -0.5);

  // 조립 접시
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.5, 0.05, 24), mat(0xf5f2ea));
  plate.position.set(0, 1.1, 2.4);
  scene.add(plate);
  hitProxy(0, 1.55, 2.4, 1.3, 1.0, 1.5, { kind: 'plate', label: '조립 접시' });
  dynamic.plate = plate;

  const pl = labelSprite('🍔 조립대', 1.6, 0, scene, '#ffe08a');
  pl.sprite.position.set(0, 2.0, 2.4);
  dynamic.platePanel = new Panel(256, 64, 1.4);
  dynamic.platePanel.sprite.position.set(0, 1.78, 2.4);
  scene.add(dynamic.platePanel.sprite);
}

/* ──────────────── 빗자루 거치대 ──────────────── */
const BROOM_SPOTS = [
  { x: -4.6, z: -6.2, ry: 0 },
  { x: 4.6, z: -6.2, ry: 0 },
  { x: 0, z: 7.7, ry: Math.PI }
];

function buildBrooms() {
  const count = (S.cfg.slots && S.cfg.slots.brooms) || BROOM_SPOTS.length;
  for (let i = 0; i < count && i < BROOM_SPOTS.length; i++) {
    const s = BROOM_SPOTS[i];

    // 벽에 기대놓은 받침
    const stand = cyl(0.16, 0.1, 0x6b6660, s.x, 0.05, s.z, scene, 12);
    stand.userData.noTint = true;

    const broom = makeItemMesh({ type: 'broom' });
    broom.position.set(s.x, 0.78, s.z);
    broom.rotation.set(0.22, s.ry, 0.12);
    scene.add(broom);

    hitProxy(s.x, 1.0, s.z, 0.9, 1.9, 0.9, { kind: 'broom', rack: i, label: '빗자루' });

    const p = labelSprite('🧹 빗자루', 1.2, 0, scene, '#ffe08a');
    p.sprite.position.set(s.x, 1.75, s.z);

    dynamic.brooms.push({ mesh: broom, label: p });
  }
}

/** 누가 들고 있으면 거치대에서 사라진다 */
function syncBrooms() {
  if (!S.kitchen || !S.kitchen.brooms) return;
  for (let i = 0; i < dynamic.brooms.length; i++) {
    const taken = !!S.kitchen.brooms[i];
    const d = dynamic.brooms[i];
    if (d.mesh.visible === !taken) continue;
    d.mesh.visible = !taken;
    d.label.sprite.visible = !taken;
  }
}

function buildFrontCounter() {
  counterTop(0, -7.2, 11, 0.9, 0xe08a3c);

  // 주문패드 (태블릿)
  const padBody = box(0.62, 0.05, 0.44, 0x2b2b30, -2.2, 1.1, -7.1);
  const screen = box(0.54, 0.01, 0.36, 0x63a8e8, 0, 0.03, 0, padBody);
  padBody.rotation.x = -0.28;
  hitProxy(-2.2, 1.45, -7.0, 0.9, 0.8, 0.9, { kind: 'pad', label: '주문패드' });
  const pl = labelSprite('📝 주문패드', 1.4, 0, scene, '#9fd8ff');
  pl.sprite.position.set(-2.2, 1.62, -7.1);

  // 서빙 창구
  box(0.9, 0.05, 0.6, 0xc0c5cc, 2.4, 1.1, -7.1);
  hitProxy(2.4, 1.45, -7.0, 1.2, 0.8, 0.9, { kind: 'serve', label: '서빙 창구' });
  const sl = labelSprite('🛎️ 서빙 창구', 1.5, 0, scene, '#ffd27a');
  sl.sprite.position.set(2.4, 1.62, -7.1);

  // 손님
  const cust = new THREE.Group();
  cust.position.set(0, 0, -8.4);
  scene.add(cust);
  cyl(0.36, 1.05, 0xf0e2c8, 0, 0.55, 0, cust, 16);       // 몸
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 18, 14), mat(0xf6d9b0));
  head.position.y = 1.32; cust.add(head);
  cyl(0.31, 0.1, 0xe05252, 0, 1.52, 0, cust, 16);        // 모자
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), mat(0x222222));
  eyeL.position.set(-0.1, 1.36, 0.26); cust.add(eyeL);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.1; cust.add(eyeR);
  hitProxy(0, 1.15, -8.4, 1.2, 1.6, 1.2, { kind: 'customer', label: '손님과 대화' });
  addSolid(0, -8.4, 1.0, 1.0);
  dynamic.customer = cust;

  // 말풍선
  const bub = new Panel(512, 160, 3.4);
  bub.sprite.position.set(0, 2.35, -8.4);
  bub.sprite.visible = false;
  scene.add(bub.sprite);
  dynamic.bubble = bub;

  const nl = labelSprite('👤 손님', 1.4, 0, scene, '#fff');
  nl.sprite.position.set(0, 1.85, -8.4);
  dynamic.customerName = nl;
}

/* ──────────────── 손에 든 것 ──────────────── */
function updateHand() {
  const hands = S.kitchen && S.kitchen.hands;
  const mine = hands ? (hands.find((h) => h.id === S.meId) || {}).holding : null;
  const key = mine ? mine.uid : 'none';
  if (dynamic.handKey === key) return;
  dynamic.handKey = key;

  if (dynamic.hand) { camera.remove(dynamic.hand); dynamic.hand = null; }
  if (!mine) return;
  const g = makeItemMesh(mine);
  if (mine.type === 'broom') {
    // 자루를 잡고 솔이 위로 오게 — 오른쪽 위로 치켜든 자세
    // (메시는 솔이 -y 쪽에 있으므로 z 를 π 근처로 돌려 뒤집는다)
    g.position.set(0.52, -0.34, -0.85);
    g.rotation.set(-0.12, 0.18, Math.PI - 0.5);
    g.scale.setScalar(0.85);
  } else {
    g.position.set(0.42, -0.32, -0.78);
    g.rotation.set(0.25, 0.4, 0.12);
    g.scale.setScalar(1.15);
  }
  dynamic.handBase = { pos: g.position.clone(), rot: g.rotation.clone() };
  camera.add(g);
  dynamic.hand = g;
}

/** 빗자루 휘두르는 모션 (0~1 진행도) */
export function setSwingProgress(t) {
  const g = dynamic.hand;
  const base = dynamic.handBase;
  if (!g || !base) return;
  if (t <= 0) {
    g.position.copy(base.pos);
    g.rotation.copy(base.rot);
    return;
  }
  // 우상 → 좌하 대각선 내려치기. 내려칠 때 빠르고 복귀는 느리게.
  const DOWN = 0.35;
  const p = t < DOWN
    ? Math.pow(t / DOWN, 0.6)
    : 1 - Math.pow((t - DOWN) / (1 - DOWN), 1.4);

  // 위로 치켜든 상태에서 머리 위를 지나 왼쪽 아래로 내려친다.
  // (+ 방향이 화면상 반시계 = 위쪽을 거쳐 좌하로 가는 자연스러운 내려치기)
  g.rotation.z = base.rot.z + p * 3.3;
  g.rotation.x = base.rot.x + p * 0.55;     // 살짝 앞으로 눕히며
  g.position.x = base.pos.x - p * 0.55;     // 손도 왼쪽으로
  g.position.y = base.pos.y - p * 0.30;     // 아래로
  g.position.z = base.pos.z - p * 0.22;     // 앞으로 뻗음
}

/* ──────────────── 조리 상태 갱신 ──────────────── */
function cookInfo(type, elapsed) {
  const ing = S.cfg.ingredients[type];
  if (!ing) return { pct: 0, label: '?', color: '#888' };
  if (elapsed >= ing.burnt) return { pct: 1, label: '탐!', color: '#e05252' };
  let target = ing.target;
  if (ing.doneness) {
    const d = (S.state && S.state.orderSheet) ? S.state.orderSheet.pattyDoneness : 'normal';
    target = ing.doneness[d] || ing.doneness.normal;
  }
  const q = Math.max(0, Math.round(100 - (Math.abs(elapsed - target) / ing.tol) * 100));
  let label, color;
  if (q >= 85) { label = '완벽!'; color = '#58c07a'; }
  else if (q >= 60) { label = elapsed < target ? '거의 다 됨' : '살짝 과함'; color = '#8fd17a'; }
  else if (elapsed < target) { label = '덜 익음'; color = '#63a8e8'; }
  else { label = '과하게 익음'; color = '#f5b942'; }
  return { pct: Math.min(1, elapsed / ing.burnt), label, color, q };
}

function syncSlots(cells, views, yTop) {
  for (let i = 0; i < views.length; i++) {
    const cell = cells[i];
    const d = views[i];
    if (!cell) {
      if (d.mesh) { scene.remove(d.mesh); d.mesh = null; }
      d.panel.sprite.visible = false;
      d.key = null;
      continue;
    }
    const key = cell.type + cell.startedAt;
    if (d.key !== key) {
      if (d.mesh) scene.remove(d.mesh);
      d.mesh = makeItemMesh({ type: cell.type, raw: true, toasted: false });
      d.mesh.position.copy(d.pad.position);
      d.mesh.position.y = yTop;
      scene.add(d.mesh);
      d.key = key;
    }
    d.panel.sprite.visible = true;
  }
}

function tickCooking() {
  if (!S.kitchen) return;
  const t = now();

  const each = (arr, cells, yTop) => {
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i];
      const cell = cells[i];
      if (!cell || !d.mesh) continue;
      const el = t - cell.startedAt;
      const info = cookInfo(cell.type, el);
      d.panel.gauge(S.cfg.ingredients[cell.type].name, info.pct, info.color, info.label);
      // 익을수록 어두워짐
      const k = Math.min(1, el / S.cfg.ingredients[cell.type].burnt);
      d.mesh.traverse((o) => {
        if (o.isMesh && o.material && o.material.color && !o.userData.noTint) {
          if (!o.userData.baseColor) o.userData.baseColor = o.material.color.clone();
          o.material.color.copy(o.userData.baseColor).multiplyScalar(1 - k * 0.72);
        }
      });
      d.mesh.position.y = yTop + Math.sin(t / 260 + i) * 0.006;
    }
  };
  each(dynamic.grill, S.kitchen.grill, 1.17);
  each(dynamic.toaster, S.kitchen.toaster, 1.17);
}

function syncBoards() {
  if (!S.kitchen) return;
  for (let i = 0; i < dynamic.boards.length; i++) {
    const d = dynamic.boards[i];
    const b = S.kitchen.boards[i];
    if (!b) {
      if (d.itemMesh) { scene.remove(d.itemMesh); d.itemMesh = null; }
      d.panel.sprite.visible = false;
      d.key = null;
      continue;
    }
    const key = b.item + b.amount;
    if (d.key !== key) {
      if (d.itemMesh) scene.remove(d.itemMesh);
      d.itemMesh = makeItemMesh({ type: b.item, raw: false, amount: b.amount });
      d.itemMesh.position.copy(d.mesh.position);
      d.itemMesh.position.y = 1.18;
      scene.add(d.itemMesh);
      d.key = key;
    }
    d.panel.sprite.visible = true;
    d.panel.gauge(S.cfg.ingredients[b.item].name + ' ' + S.cfg.amountLabel[b.amount],
      b.chops / b.need, '#f5b942', '칼질 ' + b.chops + ' / ' + b.need);
  }
}

function syncPlate() {
  if (!S.kitchen) return;
  const plate = S.kitchen.plate || [];
  const key = plate.map((p) => p.uid).join(',');
  if (dynamic.plateKey === key) return;
  dynamic.plateKey = key;

  for (const m of dynamic.plateLayers) scene.remove(m);
  dynamic.plateLayers = [];

  let y = 1.14;
  for (const it of plate) {
    const m = makeItemMesh(it);
    const h = LAYER_H[it.type] || 0.06;
    m.position.set(0, y + h / 2, 2.4);
    m.rotation.y = Math.random() * 0.5 - 0.25;
    scene.add(m);
    dynamic.plateLayers.push(m);
    y += h;
  }
  dynamic.platePanel.text(plate.length ? plate.length + '층 쌓임' : '비어 있음',
    { color: plate.length ? '#f5b942' : '#9c8f7d' });
  dynamic.platePanel.sprite.position.y = Math.max(1.78, y + 0.4);
}

/* ──────────────── 손님 말풍선 ──────────────── */
export function updateCustomer() {
  const st = S.state;
  if (!dynamic.bubble) return;
  if (!st || !st.persona || st.phase === 'lobby') {
    dynamic.bubble.sprite.visible = false;
    if (dynamic.customer) dynamic.customer.visible = false;
    return;
  }
  if (dynamic.customer) dynamic.customer.visible = true;
  dynamic.customerName.text(st.persona.emoji + ' ' + st.persona.name, { color: '#ffd88a' });

  const last = [...st.chat].reverse().find((c) => c.role === 'customer');
  const text = st.customerBusy ? '...' : (last ? last.text : '');
  if (!text) { dynamic.bubble.sprite.visible = false; return; }

  const p = dynamic.bubble;
  const ctx = p.ctx, W = p.cv.width, H = p.cv.height;
  p.clear();
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.beginPath(); ctx.roundRect(4, 4, W - 8, H - 8, 22); ctx.fill();
  ctx.fillStyle = '#241d16';
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // 줄바꿈
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > W - 60 && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  const show = lines.slice(0, 4);
  show.forEach((l, i) => ctx.fillText(l, W / 2, H / 2 + (i - (show.length - 1) / 2) * 34));
  p.tex.needsUpdate = true;
  p.sprite.visible = true;
}

/* ──────────────── 원격 플레이어 ──────────────── */
function makeAvatar(name, color) {
  const g = new THREE.Group();
  cyl(0.3, 1.0, new THREE.Color(color).getHex(), 0, 0.5, 0, g, 14);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), mat(0xf6d9b0));
  head.position.y = 1.26; g.add(head);
  cyl(0.28, 0.09, 0xffffff, 0, 1.46, 0, g, 14);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), mat(0x222));
  eye.position.set(-0.09, 1.3, 0.23); g.add(eye);
  const eye2 = eye.clone(); eye2.position.x = 0.09; g.add(eye2);
  const p = labelSprite(name, 1.5, 1.85, g, '#fff');
  g.userData.panel = p;
  scene.add(g);
  return g;
}

export function updateRemotes() {
  const seen = new Set();
  const players = (S.state && S.state.players) || [];
  const hands = (S.kitchen && S.kitchen.hands) || [];

  for (const pos of S.positions) {
    if (pos.id === S.meId) continue;
    seen.add(pos.id);
    const info = players.find((p) => p.id === pos.id);
    let av = dynamic.remotes.get(pos.id);
    if (!av) {
      av = makeAvatar(info ? info.name : '직원', info ? info.color : '#f5b942');
      dynamic.remotes.set(pos.id, av);
    }
    av.position.x += (pos.x - av.position.x) * 0.25;
    av.position.z += (pos.z - av.position.z) * 0.25;
    // 점프/넉백 높이도 따라간다 (10Hz 스냅샷이라 보간)
    av.position.y += ((pos.y || 0) - av.position.y) * 0.3;
    // 아바타는 얼굴이 로컬 +z 를 향하도록 만들었지만
    // 플레이어의 yaw=0 은 -z 를 보는 방향이므로 π 를 더해 맞춘다.
    let d = (pos.ry + Math.PI) - av.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    av.rotation.y += d * 0.25;

    const h = hands.find((x) => x.id === pos.id);
    const key = h && h.holding ? h.holding.uid : 'none';
    if (av.userData.handKey !== key) {
      av.userData.handKey = key;
      if (av.userData.handMesh) { av.remove(av.userData.handMesh); av.userData.handMesh = null; }
      if (h && h.holding) {
        const m = makeItemMesh(h.holding);
        if (h.holding.type === 'broom') {
          // 남이 든 것도 솔이 위로 (메시 기준 솔은 -y 쪽)
          m.position.set(0.3, 1.05, 0.28);
          m.rotation.set(0, 0, Math.PI - 0.45);
          m.scale.setScalar(0.9);
        } else {
          m.position.set(0, 0.95, 0.45);
        }
        av.add(m);
        av.userData.handMesh = m;
      }
    }
  }
  for (const [id, av] of dynamic.remotes) {
    if (!seen.has(id)) { scene.remove(av); dynamic.remotes.delete(id); }
  }
}

/* ──────────────── 부트/렌더 ──────────────── */
export function initWorld(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  resize();
  window.addEventListener('resize', resize);

  camera.position.set(0, 1.62, 4);
  scene.add(camera);

  buildRoom();
  buildZones();
  buildIngredientLine();
  buildGrill();
  buildToaster();
  buildSauces();
  buildIsland();
  buildFrontCounter();
  buildBrooms();
}

function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

export function syncFromKitchen() {
  if (!S.kitchen) return;
  syncSlots(S.kitchen.grill, dynamic.grill, 1.17);
  syncSlots(S.kitchen.toaster, dynamic.toaster, 1.17);
  syncBoards();
  syncPlate();
  syncBrooms();
  updateHand();
}

export function render() {
  tickCooking();
  syncBoards();
  updateRemotes();
  renderer.render(scene, camera);
}
