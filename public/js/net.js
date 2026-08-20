/* 소켓 + 공유 상태 저장소 */

const listeners = new Map();

export const S = {
  socket: null,
  meId: null,
  meName: '',
  llmOn: false,
  cfg: null,
  state: null,       // 방/라운드 공개 상태
  kitchen: null,     // 주방 상태 (그릴/토스터/도마/접시/손)
  positions: [],     // 다른 플레이어 위치
  result: null,
  serverOffset: 0
};

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, []);
  listeners.get(evt).push(fn);
}
function fire(evt, data) {
  (listeners.get(evt) || []).forEach((fn) => {
    try { fn(data); } catch (err) { console.error('[net] ' + evt, err); }
  });
}

export const now = () => Date.now() + S.serverOffset;

export function myHolding() {
  if (!S.kitchen || !S.kitchen.hands) return null;
  const h = S.kitchen.hands.find((x) => x.id === S.meId);
  return h ? h.holding : null;
}

export function isHost() {
  return !!S.state && S.state.hostId === S.meId;
}

export function emit(evt, data, cb) {
  if (S.socket) S.socket.emit(evt, data, cb);
}

export function act(action, payload) {
  emit('kitchen:act', { action, payload: payload || {} });
}

export async function connect() {
  S.cfg = await fetch('/config.json').then((r) => r.json());

  const socket = window.io();
  S.socket = socket;

  socket.on('hello', (d) => { S.meId = d.id; S.llmOn = d.llm; fire('hello', d); });

  socket.on('state', (st) => {
    S.serverOffset = st.now - Date.now();
    const prevPhase = S.state && S.state.phase;
    S.state = st;
    fire('state', st);
    if (prevPhase !== st.phase) fire('phase', st.phase);
  });

  socket.on('kitchen', (k) => {
    S.serverOffset = k.now - Date.now();
    S.kitchen = k;
    fire('kitchen', k);
  });

  socket.on('positions', (list) => { S.positions = list; fire('positions', list); });

  socket.on('tick', (d) => {
    if (!S.state) return;
    S.state.patience = d.patience;
    S.state.phaseEndsAt = d.phaseEndsAt;
    S.serverOffset = d.now - Date.now();
    fire('tick', d);
  });

  socket.on('swing', (d) => fire('swing', d));
  socket.on('hit', (d) => fire('hit', d));
  socket.on('result', (r) => { S.result = r; fire('result', r); });
  socket.on('toast', (d) => fire('toast', d));
  socket.on('act:ok', (d) => fire('act', { ...d, ok: true }));
  socket.on('act:fail', (d) => fire('act', { ...d, ok: false }));
  socket.on('disconnect', () => fire('toast', { msg: '서버와 연결이 끊겼습니다.', kind: 'bad' }));

  return new Promise((res) => socket.on('connect', res));
}
