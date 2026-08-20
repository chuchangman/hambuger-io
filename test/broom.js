/* 빗자루 난투 검증 — 집기 / 사거리 / 쿨다운 / 넉백 / 재료 놓침 / 반납 */
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://127.0.0.1:' + (process.env.PORT || 3210);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('❌ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✅ ' + m);

function mk(name) {
  const s = io(URL, { transports: ['websocket'] });
  s.state = null; s.kitchen = null; s.hits = []; s.swings = []; s.fails = [];
  s.on('state', (st) => { s.state = st; });
  s.on('kitchen', (k) => { s.kitchen = k; });
  s.on('hit', (d) => s.hits.push(d));
  s.on('swing', (d) => s.swings.push(d));
  s.on('act:fail', (d) => s.fails.push(d.msg));
  s.nm = name;
  s.hand = () => {
    if (!s.kitchen) return null;
    const h = s.kitchen.hands.find((x) => x.id === s.id);
    return h ? h.holding : null;
  };
  s.act = (a, p) => s.emit('kitchen:act', { action: a, payload: p || {} });
  s.moveTo = (x, z) => s.emit('player:move', { x, z, ry: 0 });
  return s;
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(60); }
  fail('타임아웃: ' + label);
  return false;
}

(async () => {
  const A = mk('때리는놈'); const B = mk('맞는놈');
  await sleep(400);

  const code = await new Promise((r) => A.emit('room:create', { name: '때리는놈' }, (x) => r(x.code)));
  await new Promise((r) => B.emit('room:join', { code, name: '맞는놈' }, r));
  await sleep(300);
  ok('2인 입장 (방 ' + code + ')');

  A.emit('game:start', { difficulty: 2, pace: 'relaxed' });
  if (!await waitFor(() => A.state.phase === 'negotiation', 4000, '라운드 시작')) return done();
  ok('라운드 시작 — 빗자루는 협상 중에도 집을 수 있어야 함');

  if (!A.kitchen || !Array.isArray(A.kitchen.brooms)) return fail('brooms 상태가 안 내려옴') || done();
  ok('빗자루 거치대 ' + A.kitchen.brooms.length + '개');

  // ── 빗자루 없이 휘두르기 → 거부 ──
  A.fails = [];
  A.emit('player:swing', { targetId: B.id });
  await sleep(250);
  if (!A.fails.length) fail('빗자루 없이도 휘둘러짐');
  else ok('빗자루 없이 휘두르기 거부: ' + A.fails[0]);

  // ── 빗자루 집기 ──
  A.act('broom:take', { rack: 0 });
  await sleep(300);
  if (!A.hand() || A.hand().type !== 'broom') return fail('빗자루를 못 집음') || done();
  ok('A가 빗자루를 들었다');
  if (A.kitchen.brooms[0] !== A.id) fail('거치대가 A 를 가리키지 않음');
  else ok('거치대 0번이 A 로 표시됨 (다른 사람은 못 집음)');

  // 같은 빗자루를 B 가 집으려 하면 거부
  B.fails = [];
  B.act('broom:take', { rack: 0 });
  await sleep(250);
  if (!B.fails.length) fail('이미 들린 빗자루를 또 집음');
  else ok('중복 집기 거부: ' + B.fails[0]);

  // ── 빗자루 들면 재료를 못 든다 ──
  A.fails = [];
  A.act('bin:take', { item: 'patty' });
  await sleep(250);
  if (A.hand().type !== 'broom') fail('빗자루가 재료로 바뀜');
  else ok('빗자루를 들면 재료를 못 든다 (트레이드오프 확인)');

  // ── 사거리 밖에서는 안 맞는다 ──
  A.moveTo(0, 0);
  B.moveTo(0, 9);           // 9m 밖
  await sleep(300);
  A.hits = []; B.hits = [];
  A.emit('player:swing', { targetId: B.id });
  await sleep(400);
  if (B.hits.length) fail('사거리 밖인데 맞음');
  else ok('사거리(2.6m) 밖에서는 안 맞음');
  if (!A.swings.length) fail('헛스윙 모션 이벤트가 안 옴');
  else ok('헛스윙도 swing 이벤트로 전파됨 (모션 표시용)');

  // ── 조리 단계로 넘어가야 재료를 들 수 있다 ──
  A.emit('order:submit');
  if (!await waitFor(() => A.state.phase === 'cooking', 3000, '조리 단계')) return done();
  ok('주문 확정 → 조리 단계 (빗자루는 그대로 들려 있어야 함)');
  if (!A.hand() || A.hand().type !== 'broom') fail('단계가 바뀌며 빗자루가 사라짐');
  else ok('단계 전환 후에도 빗자루 유지');

  // ── 사거리 안 + 재료 들고 있을 때 ──
  B.act('bin:take', { item: 'cheese' });
  await sleep(300);
  if (!B.hand()) return fail('B 가 재료를 못 들었음') || done();
  ok('B가 ' + B.hand().label + ' 을(를) 들고 있음');

  A.moveTo(0, 0);
  B.moveTo(0, 1.5);          // 1.5m — 사거리 안
  await sleep(300);
  A.hits = []; B.hits = [];
  await sleep(700);          // 쿨다운 지나가게
  A.emit('player:swing', { targetId: B.id });
  if (!await waitFor(() => B.hits.length, 2000, '타격 이벤트')) return done();

  const hit = B.hits[0];
  ok('명중! ' + hit.byName + ' → ' + hit.targetName);
  if (Math.abs(Math.hypot(hit.dirX, hit.dirZ) - 1) > 0.01) fail('넉백 방향이 단위벡터가 아님');
  else ok('넉백 방향 정규화 확인 (' + hit.dirX.toFixed(2) + ', ' + hit.dirZ.toFixed(2) + ')');
  if (hit.dirZ < 0.9) fail('넉백이 A→B 반대 방향임: dirZ=' + hit.dirZ);
  else ok('넉백이 때린 쪽에서 멀어지는 방향 (+z)');
  if (!hit.power) fail('넉백 세기가 0');
  else ok('넉백 세기 ' + hit.power);

  await sleep(300);
  if (B.hand()) fail('맞았는데 재료를 그대로 들고 있음');
  else ok('맞으면 들고 있던 재료를 놓친다 — ' + hit.dropped + ' 떨어뜨림');

  // ── 쿨다운 ──
  A.hits = []; B.hits = [];
  A.emit('player:swing', { targetId: B.id });
  await sleep(200);
  if (B.hits.length) fail('쿨다운 무시하고 연타됨');
  else ok('쿨다운(650ms) 동작 — 연타 차단');
  await sleep(700);
  A.emit('player:swing', { targetId: B.id });
  if (!await waitFor(() => B.hits.length, 1500, '쿨다운 후 재타격')) fail('쿨다운 후에도 안 맞음');
  else ok('쿨다운 후에는 다시 때릴 수 있음');

  // ── 빗자루 반납 ──
  A.act('drop');
  await sleep(300);
  if (A.hand()) fail('빗자루를 못 내려놓음');
  else if (A.kitchen.brooms[0] !== null) fail('빗자루가 거치대로 안 돌아감');
  else ok('Q 로 내려놓으면 거치대로 반납됨 (영영 사라지지 않음)');

  // ── 접속 종료 시 반납 ──
  B.act('broom:take', { rack: 1 });
  await sleep(300);
  if (B.kitchen.brooms[1] !== B.id) fail('B 가 빗자루 1번을 못 집음');
  else {
    B.close();
    await sleep(600);
    if (A.kitchen.brooms[1] !== null) fail('나간 사람의 빗자루가 안 돌아옴');
    else ok('접속 종료 시 빗자루 자동 반납');
  }

  done();
  function done() { setTimeout(() => { A.close(); try { B.close(); } catch (e) { /* 이미 닫힘 */ } process.exit(process.exitCode || 0); }, 300); }
})();
