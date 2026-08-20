/* 다른 유저의 동작이 나에게 전달되는지 검증 — 점프 높이 · 휘두르기 이벤트 */
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://127.0.0.1:' + (process.env.PORT || 3210);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('❌ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✅ ' + m);

function mk(name) {
  const s = io(URL, { transports: ['websocket'] });
  s.state = null; s.kitchen = null; s.positions = []; s.swings = []; s.hits = [];
  s.on('state', (st) => { s.state = st; });
  s.on('kitchen', (k) => { s.kitchen = k; });
  s.on('positions', (p) => { s.positions = p; });
  s.on('swing', (d) => s.swings.push(d));
  s.on('hit', (d) => s.hits.push(d));
  s.nm = name;
  s.act = (a, p) => s.emit('kitchen:act', { action: a, payload: p || {} });
  s.seen = (id) => s.positions.find((p) => p.id === id);
  return s;
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(60); }
  fail('타임아웃: ' + label);
  return false;
}

(async () => {
  const A = mk('뛰는놈'); const B = mk('보는놈');
  await sleep(400);

  const code = await new Promise((r) => A.emit('room:create', { name: '뛰는놈' }, (x) => r(x.code)));
  await new Promise((r) => B.emit('room:join', { code, name: '보는놈' }, r));
  await sleep(300);
  A.emit('game:start', { difficulty: 2, pace: 'relaxed' });
  if (!await waitFor(() => A.state.phase === 'negotiation', 4000, '라운드 시작')) return done();
  ok('2인 입장 + 라운드 시작');

  /* ── 1. 점프 높이가 상대에게 보이는가 ── */
  A.emit('player:move', { x: 1, z: 5, y: 0, ry: 0 });
  await waitFor(() => B.seen(A.id), 2000, 'A 위치 수신');
  const ground = B.seen(A.id).y;
  if (ground !== 0) fail('지상인데 y 가 0 이 아님: ' + ground);
  else ok('지상일 때 상대에게 y=0 으로 보임');

  // 점프 중 높이를 여러 번 보낸다 (클라 물리가 매 프레임 보내는 것을 흉내)
  const heights = [0.35, 0.68, 0.80, 0.62, 0.21, 0];
  const seenHeights = [];
  for (const h of heights) {
    A.emit('player:move', { x: 1, z: 5, y: h, ry: 0 });
    await sleep(160);                       // 스냅샷 주기(100ms)보다 길게
    seenHeights.push(B.seen(A.id).y);
  }
  console.log('   보낸 높이: ' + heights.join(' → '));
  console.log('   보인 높이: ' + seenHeights.join(' → '));

  const maxSeen = Math.max(...seenHeights);
  if (maxSeen < 0.7) fail('점프 높이가 상대에게 전달되지 않음 (최대 ' + maxSeen + ')');
  else ok('점프 높이가 그대로 전달됨 (최고 ' + maxSeen + 'm)');
  if (seenHeights[seenHeights.length - 1] !== 0) fail('착지 후에도 떠 있음');
  else ok('착지하면 다시 y=0');

  /* ── 2. 높이 범위 제한 ── */
  A.emit('player:move', { x: 1, z: 5, y: 999, ry: 0 });
  await sleep(200);
  if (B.seen(A.id).y > 6) fail('비정상 높이가 그대로 반영됨 (치팅 가능): ' + B.seen(A.id).y);
  else ok('비정상 높이는 6m 로 제한됨 (' + B.seen(A.id).y + ')');
  A.emit('player:move', { x: 1, z: 5, y: 0, ry: 0 });
  await sleep(200);

  /* ── 3. 휘두르기가 상대에게 보이는가 ── */
  A.act('broom:take', { rack: 0 });
  await sleep(400);
  const hand = A.kitchen.hands.find((h) => h.id === A.id);
  if (!hand || !hand.holding || hand.holding.type !== 'broom') return fail('빗자루를 못 집음') || done();
  ok('A 가 빗자루를 들었다');

  const bHand = B.kitchen.hands.find((h) => h.id === A.id);
  if (!bHand || !bHand.holding || bHand.holding.type !== 'broom') fail('B 에게 A 의 빗자루가 안 보임');
  else ok('B 에게도 A 가 빗자루 든 것이 보임');

  // 아무도 없는 방향으로 헛스윙
  B.swings = [];
  A.emit('player:swing', { targetId: null });
  if (!await waitFor(() => B.swings.length, 2000, '헛스윙 전파')) return done();
  if (B.swings[0].by !== A.id) fail('swing 이벤트의 by 가 A 가 아님');
  else ok('헛스윙도 B 에게 전달됨 (모션 재생용) — by=' + (B.swings[0].by === A.id ? 'A' : '?'));

  // 명중 스윙도 swing + hit 둘 다 오는지
  A.emit('player:move', { x: 0, z: 0, y: 0, ry: 0 });
  B.emit('player:move', { x: 0, z: 1.5, y: 0, ry: 0 });
  await sleep(300);
  B.swings = []; B.hits = [];
  await sleep(700);                          // 쿨다운
  A.emit('player:swing', { targetId: B.id });
  if (!await waitFor(() => B.hits.length, 2000, '명중 전파')) return done();
  if (!B.swings.length) fail('명중했는데 swing 모션 이벤트가 없음');
  else ok('명중 시 swing(모션) + hit(넉백) 둘 다 전달됨');

  done();
  function done() { setTimeout(() => { A.close(); B.close(); process.exit(process.exitCode || 0); }, 300); }
})();
