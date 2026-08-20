/* 1인칭 컨트롤러 — WASD 이동, 마우스 시점, 충돌, 조준 상호작용 */
import * as THREE from '/vendor/three.module.js';
import { camera, interactables, solids, setSwingProgress } from './world.js';
import { S, act, emit, myHolding, now } from './net.js';

const keys = Object.create(null);
const RADIUS = 0.34;
const EYE = 1.62;
const SPEED = 3.6;
const RUN = 6.0;

let yaw = 0;            // yaw=0 → -z 방향(손님 카운터)을 본다
let pitch = 0;
let locked = false;
let bob = 0;
let lastSent = 0;

export const state = {
  amount: 'normal',        // 채소/소스 양 (R 로 순환)
  target: null,            // 현재 조준 중인 스테이션
  prompt: null,            // HUD 문구
  canvas: null,
  onOpenChat: () => {},
  onOpenPad: () => {},
  onCloseOverlay: () => {},
  overlayOpen: false
};

const AMOUNTS = ['little', 'normal', 'much'];

/* ──────────────── 점프 / 공중 물리 ──────────────── */
const GRAVITY = -24;              // 중력 (m/s²)
const JUMP_V = 6.4;               // 점프 초기 속도 → 최고점 약 0.85m, 체공 0.53초
const HIT_LAUNCH = 5.2;           // 빗자루에 맞았을 때 뜨는 높이
const AIR_CONTROL = 2.4;          // 공중에서 방향을 얼마나 바꿀 수 있는가 (작을수록 관성 유지)

let height = 0;                   // 지면 위 높이
let velY = 0;                     // 수직 속도
let airborne = false;
const moveVel = { x: 0, z: 0 };   // 이동 속도 (공중에서는 이륙 순간 값을 이어간다)

/* ──────────────── 빗자루 난투 ──────────────── */
const knock = { x: 0, z: 0 };     // 넉백 속도
let shakeUntil = 0;               // 화면 흔들림 종료 시각
let swingUntil = 0;               // 휘두르는 모션 종료 시각

function shakeOffset() {
  const left = shakeUntil - performance.now();
  if (left <= 0) return 0;
  return Math.sin(left * 0.09) * 0.04 * (left / 320);
}

/** 서버가 알려준 방향으로 밀려난다 — 위로 뜨면서 포물선을 그린다 */
export function applyKnockback(dirX, dirZ, power) {
  knock.x = dirX * power;
  knock.z = dirZ * power;
  velY = HIT_LAUNCH;
  height = Math.max(height, 0.01);
  airborne = true;
  shakeUntil = performance.now() + 320;
}

export const isAirborne = () => airborne;
export const getHeight = () => height;

export const isSwinging = () => performance.now() < swingUntil;

/** 조준 방향 앞쪽에서 가장 가까운 플레이어를 찾는다 */
function pickTarget() {
  const range = (S.cfg.combat && S.cfg.combat.range) || 2.6;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // 전방 벡터
  let best = null, bestD = Infinity;
  for (const o of S.positions) {
    if (o.id === S.meId) continue;
    const dx = o.x - camera.position.x;
    const dz = o.z - camera.position.z;
    const d = Math.hypot(dx, dz);
    if (d > range || d < 0.001) continue;
    const dot = (dx / d) * fx + (dz / d) * fz;
    if (dot < 0.35) continue;                        // 앞쪽 약 ±70도만
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function swing() {
  const cd = (S.cfg.combat && S.cfg.combat.cooldown) || 650;
  if (performance.now() < swingUntil - 200 + cd) return;   // 클라 쿨다운(서버도 재검사)
  swingUntil = performance.now() + 260;
  const t = pickTarget();
  emit('player:swing', { targetId: t ? t.id : null });
}

/** 지금 빗자루를 들고 있는가 */
function hasBroom() {
  const h = myHolding();
  return !!h && h.type === 'broom';
}

/* ──────────────── 입력 ──────────────── */
export function initPlayer(canvas) {
  state.canvas = canvas;

  canvas.addEventListener('click', () => {
    if (!state.overlayOpen) canvas.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
  });

  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    yaw -= e.movementX * 0.0022;
    pitch -= e.movementY * 0.0022;
    pitch = Math.max(-1.35, Math.min(1.35, pitch));
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      if (e.key === 'Escape') state.onCloseOverlay();
      return;
    }
    keys[e.code] = true;

    if (e.code === 'Escape') { state.onCloseOverlay(); return; }
    if (state.overlayOpen) return;

    if (e.code === 'KeyE') { e.preventDefault(); interact(); }
    else if (e.code === 'KeyQ') act('drop');
    else if (e.code === 'KeyR') {
      state.amount = AMOUNTS[(AMOUNTS.indexOf(state.amount) + 1) % AMOUNTS.length];
    } else if (e.code === 'KeyC' || e.code === 'Enter') { e.preventDefault(); state.onOpenChat(); }
    else if (e.code === 'KeyB') { e.preventDefault(); state.onOpenPad(); }
    else if (e.code === 'Space') e.preventDefault();
  });

  document.addEventListener('keyup', (e) => { keys[e.code] = false; });

  // 좌클릭: 빗자루를 들었으면 휘두르기, 아니면 상호작용
  document.addEventListener('mousedown', (e) => {
    if (!locked || state.overlayOpen || e.button !== 0) return;
    if (hasBroom()) swing();
    else interact();
  });
}

export function releaseLock() {
  if (document.pointerLockElement) document.exitPointerLock();
}

/* ──────────────── 조준 → 할 수 있는 행동 ──────────────── */
const ray = new THREE.Raycaster();
const CENTER = new THREE.Vector2(0, 0);

function aim() {
  ray.setFromCamera(CENTER, camera);
  const hits = ray.intersectObjects(interactables, false);
  for (const h of hits) {
    if (h.distance <= 2.8) return h.object;
  }
  return null;
}

function cellStatus(type, startedAt) {
  const ing = S.cfg.ingredients[type];
  const el = now() - startedAt;
  if (el >= ing.burnt) return '탐!';
  let target = ing.target;
  if (ing.doneness) {
    const d = (S.state && S.state.orderSheet) ? S.state.orderSheet.pattyDoneness : 'normal';
    target = ing.doneness[d] || ing.doneness.normal;
  }
  const q = Math.max(0, Math.round(100 - (Math.abs(el - target) / ing.tol) * 100));
  if (q >= 85) return '완벽!';
  if (el < target) return '덜 익음';
  return '과함';
}

/** 조준 대상 + 현재 손 상태로 무엇을 할 수 있는지 계산 */
export function resolveAction(obj) {
  if (!obj || !obj.userData.station) return null;
  const st = obj.userData.station;
  const h = myHolding();
  const cfg = S.cfg;
  const K = S.kitchen;
  const cooking = S.state && S.state.phase === 'cooking';
  const amtLabel = cfg.amountLabel[state.amount];

  switch (st.kind) {
    case 'customer':
      return { text: '손님과 대화', key: 'E', run: () => state.onOpenChat() };
    case 'pad':
      return { text: '주문패드 열기', key: 'E', run: () => state.onOpenPad() };
    case 'serve':
      if (!cooking) return { text: '아직 주문이 확정되지 않았습니다', disabled: true };
      return {
        text: '손님에게 서빙!' + (K && K.plate.length ? ' (' + K.plate.length + '층)' : ' (접시 비었음)'),
        key: 'E', danger: true, run: () => emit('game:serve')
      };
    case 'broom': {
      // 빗자루는 협상 중에도 집을 수 있다
      if (K && K.brooms && K.brooms[st.rack]) return { text: '누가 이미 들고 갔습니다', disabled: true };
      if (h) return { text: '손이 차 있습니다 (Q: 내려놓기)', disabled: true };
      return {
        text: '빗자루 집기 — 좌클릭으로 동료를 후려칩니다',
        key: 'E', run: () => act('broom:take', { rack: st.rack })
      };
    }
  }

  if (!cooking) return { text: '주문 확정 후 조리할 수 있습니다', disabled: true };

  switch (st.kind) {
    case 'bin': {
      const nm = cfg.ingredients[st.item].name;
      if (h) return { text: '손이 차 있습니다 (Q: 버리기)', disabled: true };
      return { text: nm + ' 집기', key: 'E', run: () => act('bin:take', { item: st.item }) };
    }
    case 'grill': {
      const cell = K && K.grill[st.slot];
      if (cell) {
        if (h) return { text: '손이 차 있습니다', disabled: true };
        return {
          text: cfg.ingredients[cell.type].name + ' 꺼내기 — ' + cellStatus(cell.type, cell.startedAt),
          key: 'E', run: () => act('grill:take', { slot: st.slot })
        };
      }
      if (h && cfg.grillable.includes(h.type) && h.raw) {
        return { text: cfg.ingredients[h.type].name + ' 굽기', key: 'E', run: () => act('grill:place', { slot: st.slot, item: h.type }) };
      }
      return { text: '생 패티/베이컨/계란을 들고 오세요', disabled: true };
    }
    case 'toast': {
      const cell = K && K.toaster[st.slot];
      if (cell) {
        if (h) return { text: '손이 차 있습니다', disabled: true };
        return {
          text: cfg.ingredients[cell.type].name + ' 꺼내기 — ' + cellStatus(cell.type, cell.startedAt),
          key: 'E', run: () => act('toast:take', { slot: st.slot })
        };
      }
      if (h && cfg.toastable.includes(h.type) && !h.toasted) {
        return { text: cfg.ingredients[h.type].name + ' 굽기', key: 'E', run: () => act('toast:place', { slot: st.slot }) };
      }
      return { text: '안 구운 빵을 들고 오세요', disabled: true };
    }
    case 'board': {
      const b = K && K.boards[st.board];
      if (b) {
        return {
          text: '썰기! (' + b.chops + '/' + b.need + ')',
          key: 'E', repeat: true, run: () => act('board:chop', { board: st.board })
        };
      }
      if (h && cfg.veggies.includes(h.type) && h.raw) {
        return {
          text: cfg.ingredients[h.type].name + ' — ' + amtLabel + ' 로 썰기 (R: 양 변경)',
          key: 'E', run: () => act('board:place', { board: st.board, amount: state.amount })
        };
      }
      return { text: '생 채소를 들고 오세요', disabled: true };
    }
    case 'sauce': {
      if (h) return { text: '손이 차 있습니다', disabled: true };
      return {
        text: cfg.sauceLabel[st.sauceType] + ' ' + amtLabel + ' 짜기 (R: 양 변경)',
        key: 'E', run: () => act('sauce:take', { sauceType: st.sauceType, amount: state.amount })
      };
    }
    case 'plate': {
      if (h) return { text: h.label + ' 올리기', key: 'E', run: () => act('plate:add') };
      if (K && K.plate.length) return { text: '맨 위 재료 되돌리기', key: 'E', run: () => act('plate:undo') };
      return { text: '재료를 들고 오세요', disabled: true };
    }
  }
  return null;
}

function interact() {
  const a = state.prompt;
  if (a && !a.disabled && a.run) a.run();
}

/* ──────────────── 이동 & 충돌 ──────────────── */
/* 다른 플레이어를 통과하지 못하게 밀어낸다 (원-원 충돌) */
function collidePlayers(pos) {
  const MIN = RADIUS * 2;              // 두 사람 반지름 합
  for (const other of S.positions) {
    if (other.id === S.meId) continue;
    const dx = pos.x - other.x;
    const dz = pos.z - other.z;
    const d = Math.hypot(dx, dz);
    if (d >= MIN) continue;
    if (d < 0.001) {                   // 완전히 겹쳤으면 아무 방향으로
      pos.x += MIN;
      continue;
    }
    pos.x = other.x + (dx / d) * MIN;
    pos.z = other.z + (dz / d) * MIN;
  }
}

function collide(pos) {
  for (const s of solids) {
    const cx = Math.max(s.minX, Math.min(pos.x, s.maxX));
    const cz = Math.max(s.minZ, Math.min(pos.z, s.maxZ));
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= RADIUS * RADIUS) continue;

    if (d2 > 0.0001) {
      const d = Math.sqrt(d2);
      pos.x = cx + (dx / d) * RADIUS;
      pos.z = cz + (dz / d) * RADIUS;
    } else {
      // 정확히 내부 — 가장 가까운 면으로 밀어낸다
      const left = Math.abs(pos.x - s.minX), right = Math.abs(s.maxX - pos.x);
      const front = Math.abs(pos.z - s.minZ), back = Math.abs(s.maxZ - pos.z);
      const m = Math.min(left, right, front, back);
      if (m === left) pos.x = s.minX - RADIUS;
      else if (m === right) pos.x = s.maxX + RADIUS;
      else if (m === front) pos.z = s.minZ - RADIUS;
      else pos.z = s.maxZ + RADIUS;
    }
  }
  pos.x = Math.max(-8.5, Math.min(8.5, pos.x));
  pos.z = Math.max(-9.5, Math.min(9.5, pos.z));
}

export function updatePlayer(dt) {
  const canMove = !state.overlayOpen && S.state && S.state.phase !== 'lobby' && S.state.phase !== 'result';

  let mx = 0, mz = 0;
  if (canMove) {
    if (keys.KeyW || keys.ArrowUp) mz -= 1;
    if (keys.KeyS || keys.ArrowDown) mz += 1;
    if (keys.KeyA || keys.ArrowLeft) mx -= 1;
    if (keys.KeyD || keys.ArrowRight) mx += 1;
  }

  const len = Math.hypot(mx, mz);

  // 입력 → 월드 기준 희망 속도 (yaw: 전방 = (-sin,-cos), 우측 = (cos,-sin))
  const speed = (keys.ShiftLeft || keys.ShiftRight) ? RUN : SPEED;
  let wx = 0, wz = 0;
  if (len > 0) {
    mx /= len; mz /= len;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    wx = (mx * cos + mz * sin) * speed;
    wz = (mz * cos - mx * sin) * speed;
  }

  // 점프 (땅에 있을 때만)
  if (canMove && keys.Space && !airborne) {
    velY = JUMP_V;
    airborne = true;
  }

  if (airborne) {
    // 공중에서는 이륙 순간의 속도를 이어가고 방향만 살짝 틀 수 있다 → 포물선
    const k = Math.min(1, AIR_CONTROL * dt);
    moveVel.x += (wx - moveVel.x) * k;
    moveVel.z += (wz - moveVel.z) * k;
  } else {
    moveVel.x = wx;
    moveVel.z = wz;
  }

  // 중력 적분
  velY += GRAVITY * dt;
  height += velY * dt;
  if (height <= 0) {
    height = 0;
    velY = 0;
    airborne = false;
  } else {
    airborne = true;
  }

  // 넉백은 착지 후에만 마찰로 줄어든다 (공중에서는 궤적을 유지)
  if (!airborne && (knock.x || knock.z)) {
    const decay = Math.exp(-7 * dt);
    knock.x *= decay;
    knock.z *= decay;
    if (Math.hypot(knock.x, knock.z) < 0.05) { knock.x = 0; knock.z = 0; }
  }

  const pos = { x: camera.position.x, z: camera.position.z };
  pos.x += (moveVel.x + knock.x) * dt;
  pos.z += (moveVel.z + knock.z) * dt;

  collidePlayers(pos);
  collide(pos);
  camera.position.x = pos.x;
  camera.position.z = pos.z;

  bob += dt * (airborne ? 0 : (len > 0 ? (keys.ShiftLeft ? 14 : 9) : 2));
  const bobY = airborne ? 0 : Math.sin(bob) * (len > 0 ? 0.035 : 0.008);
  camera.position.y = EYE + height + bobY + shakeOffset();
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  // 레이캐스트는 matrixWorld 를 쓰므로 먼저 갱신한다 (안 하면 조준이 한 프레임 밀린다)
  camera.updateMatrixWorld();

  // 휘두르는 모션
  const swingLeft = swingUntil - performance.now();
  setSwingProgress(swingLeft > 0 ? 1 - swingLeft / 260 : 0);

  // 조준
  const obj = state.overlayOpen ? null : aim();
  state.target = obj;
  state.prompt = resolveAction(obj);

  // 위치 동기화 (10Hz)
  const t = performance.now();
  if (t - lastSent > 100) {
    lastSent = t;
    emit('player:move', { x: camera.position.x, z: camera.position.z, y: height, ry: yaw });
  }
}

export function isLocked() { return locked; }

/** 시점을 직접 지정 (라운드 시작 연출/디버깅용) */
export function setLook(y, p) {
  yaw = y;
  pitch = Math.max(-1.35, Math.min(1.35, p));
}

export function resetPose() {
  // 가운데 아일랜드(z -1.4~3.8) 남쪽 통로에서 시작해 카운터(-z)를 바라본다
  camera.position.set(-2 + Math.random() * 4, EYE, 6.5);
  yaw = 0; pitch = 0;
  height = 0; velY = 0; airborne = false;
  moveVel.x = 0; moveVel.z = 0;
  knock.x = 0; knock.z = 0;
}
