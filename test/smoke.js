/* 3인 플레이 자동 시뮬레이션 — 역할 구분 없는 3D 버전 전체 흐름 검증 */
const { io } = require('socket.io-client');
const G = require('../server/game');

const URL = process.env.URL || 'http://127.0.0.1:' + (process.env.PORT || 3210);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('❌ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✅ ' + m);

function mk(name) {
  const s = io(URL, { transports: ['websocket'] });
  s.state = null; s.kitchen = null; s.result = null; s.fails = []; s.oks = [];
  s.on('state', (st) => { s.state = st; });
  s.on('kitchen', (k) => { s.kitchen = k; });
  s.on('result', (r) => { s.result = r; });
  s.on('act:fail', (d) => s.fails.push(d.msg));
  s.on('act:ok', (d) => s.oks.push(d.msg));
  s.nm = name;
  s.hand = () => {
    if (!s.kitchen) return null;
    const h = s.kitchen.hands.find((x) => x.id === s.id);
    return h ? h.holding : null;
  };
  s.act = (action, payload) => s.emit('kitchen:act', { action, payload: payload || {} });
  return s;
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(70);
  }
  fail('타임아웃: ' + label);
  return false;
}

(async () => {
  /* ── 조립 순서 채점 단위 검증 (서버 모듈 직접 호출) ── */
  const sample = {
    patty: 2, cheese: 1, bacon: 0, egg: 0, pattyDoneness: 'normal', bunToasted: true,
    veggies: { lettuce: 'much', tomato: 'none', onion: 'none', pickle: 'none' },
    sauce: { type: 'ketchup', amount: 'normal' }
  };
  const exp = G.expectedLayers(sample);
  const asPlate = (types) => types.map((t) => ({ type: t }));
  const perfect = G.stackOrderScore(sample, asPlate(exp)).score;
  const reversed = G.stackOrderScore(sample, asPlate(exp.slice().reverse())).score;
  const missing = G.stackOrderScore(sample, asPlate(exp.filter((t) => t !== 'cheese'))).score;
  const empty = G.stackOrderScore(sample, []).score;

  console.log('   기대 층: ' + exp.join(' → '));
  if (perfect !== 100) fail('정확한 순서인데 100점이 아님: ' + perfect);
  else ok('조립 순서 채점 — 정확한 순서 100점');
  if (reversed >= 60) fail('뒤집힌 순서 점수가 너무 높음: ' + reversed);
  else ok('조립 순서 채점 — 뒤집힌 순서 ' + reversed + '점 (감점 확인)');
  if (missing >= 100 || missing < 50) fail('한 층 누락 점수가 이상함: ' + missing);
  else ok('조립 순서 채점 — 한 층 누락 ' + missing + '점 (부분 점수)');
  if (empty !== 0) fail('빈 접시가 0점이 아님: ' + empty);
  else ok('조립 순서 채점 — 빈 접시 0점');

  const A = mk('알바A'); const B = mk('알바B'); const C = mk('알바C');
  await sleep(500);

  const code = await new Promise((res) => A.emit('room:create', { name: '알바A' }, (r) => res(r.code)));
  ok('방 생성: ' + code);
  await new Promise((res) => B.emit('room:join', { code, name: '알바B' }, res));
  await new Promise((res) => C.emit('room:join', { code, name: '알바C' }, res));
  await sleep(350);

  if (A.state.players.length !== 3) fail('참가자 3명이 아님');
  else ok('참가자 3명 입장');
  if (A.state.players.some((p) => p.role)) fail('아직 role 필드가 남아 있음');
  else ok('역할 구분 없음 확인 (role 필드 제거됨)');

  A.emit('game:start', { difficulty: 2, pace: 'rush' });
  if (!await waitFor(() => A.state.phase === 'negotiation', 4000, '협상 진입')) return done();
  ok('라운드 시작 — 손님: ' + A.state.persona.name);

  const negLeft = Math.round((A.state.phaseEndsAt - A.state.now) / 1000);
  if (A.state.pace !== 'rush' || Math.abs(negLeft - 90) > 3) {
    fail('진행 속도(긴박) 반영 실패 — pace=' + A.state.pace + ', 남은시간=' + negLeft + '초');
  } else ok('진행 속도 "긴박" 반영 — 주문 받기 ' + negLeft + '초');
  if (!await waitFor(() => A.state.chat.some((c) => c.role === 'customer'), 8000, '손님 첫 대사')) return done();
  ok('손님 첫 대사: "' + A.state.chat.find((c) => c.role === 'customer').text + '"');

  // ── 누구나 대화 가능 ──
  for (const [cli, q] of [[A, '패티는 몇 장 드릴까요?'], [B, '치즈는 넣어드릴까요?'], [C, '소스는 뭘로 하시겠어요?']]) {
    const before = A.state.chat.length;
    cli.emit('chat:send', { text: q });
    await waitFor(() => A.state.chat.length >= before + 2, 8000, '응답(' + cli.nm + ')');
    console.log('   💬 ' + cli.nm + ': ' + q);
    console.log('   💬 손님: ' + A.state.chat[A.state.chat.length - 1].text);
  }
  ok('세 명 모두 손님과 대화 성공 (역할 제한 없음)');

  // ── 누구나 주문패드 수정 ──
  B.emit('pad:update', {
    order: {
      patty: 1, cheese: 1, bacon: 0, egg: 0, pattyDoneness: 'normal', bunToasted: true,
      veggies: { lettuce: 'much', tomato: 'none', onion: 'none', pickle: 'none' },
      sauce: { type: 'ketchup', amount: 'normal' }
    }
  });
  await sleep(300);
  if (A.state.orderPad.patty !== 1 || A.state.orderPad.veggies.lettuce !== 'much') fail('주문패드 공유 실패');
  else ok('B가 수정한 주문패드가 A에게도 보임 (공용 패드)');

  C.emit('order:submit');
  if (!await waitFor(() => C.state.phase === 'cooking', 3000, '조리 진입')) return done();
  const cookLeft = Math.round((C.state.phaseEndsAt - C.state.now) / 1000);
  if (Math.abs(cookLeft - 90) > 3) fail('조리 시간이 긴박(90초)이 아님: ' + cookLeft);
  else ok('C가 주문 확정 → 조리 ' + cookLeft + '초 시작 (누구나 확정 가능)');

  // ── 손(holding) 규칙 ──
  A.act('bin:take', { item: 'patty' });
  await sleep(250);
  if (!A.hand() || A.hand().type !== 'patty') fail('재료 집기 실패');
  else ok('A가 생패티를 손에 듦: ' + A.hand().label);

  A.fails = [];
  A.act('bin:take', { item: 'cheese' });
  await sleep(250);
  if (!A.fails.length) fail('손이 찬 상태에서 또 집기가 허용됨');
  else ok('손 하나 규칙 동작: ' + A.fails[0]);

  A.fails = [];
  A.act('plate:add');
  await sleep(250);
  if (!A.fails.length) fail('생재료가 접시에 올라감');
  else ok('생재료 접시 금지: ' + A.fails[0]);

  // ── 세 명이 동시에 서로 다른 스테이션 ──
  A.act('grill:place', { slot: 0 });
  B.act('bin:take', { item: 'bun_bottom' });
  C.act('bin:take', { item: 'lettuce' });
  await sleep(400);
  B.act('toast:place', { slot: 0 });
  C.act('board:place', { board: 0, amount: 'much' });
  await sleep(400);
  if (!A.kitchen.grill[0] || !A.kitchen.toaster[0] || !A.kitchen.boards[0]) fail('동시 조작 실패');
  else ok('3명이 동시에 그릴/토스터/도마 사용 중');

  // C: 썰기 6회 → 자동으로 손에
  for (let i = 0; i < 6; i++) { C.act('board:chop', { board: 0 }); await sleep(80); }
  await sleep(300);
  if (!C.hand() || C.hand().type !== 'lettuce') fail('썰기 완료 후 손에 안 들어옴');
  else ok('썰기 완료 → 자동으로 손에: ' + C.hand().label);
  C.act('plate:add');
  await sleep(200);

  // B: 빵 (target 4000ms)
  await sleep(3300);
  B.act('toast:take', { slot: 0 });
  await sleep(250);
  if (!B.hand()) fail('빵을 꺼내지 못함');
  else ok('빵 완성 — 품질 ' + B.hand().quality + ' (' + B.hand().cookLabel + ')');
  B.act('plate:add');
  await sleep(200);

  // A: 패티 (normal = 8500ms)
  await sleep(4200);
  A.act('grill:take', { slot: 0 });
  await sleep(250);
  if (!A.hand()) fail('패티를 꺼내지 못함');
  else ok('패티 완성 — 품질 ' + A.hand().quality + ' (' + A.hand().cookLabel + ')');
  A.act('plate:add');
  await sleep(200);

  // 치즈 · 소스 · 위 번
  B.act('bin:take', { item: 'cheese' }); await sleep(200);
  B.act('plate:add'); await sleep(200);
  C.act('sauce:take', { sauceType: 'ketchup', amount: 'normal' }); await sleep(200);
  C.act('plate:add'); await sleep(200);
  A.act('bin:take', { item: 'bun_top' }); await sleep(200);
  A.act('plate:add'); await sleep(300);

  ok('접시 조립: ' + A.kitchen.plate.map((p) => p.label).join(' / '));

  // 되돌리기
  B.act('plate:undo'); await sleep(250);
  if (!B.hand() || B.hand().type !== 'bun_top') fail('접시 되돌리기 실패');
  else ok('접시 되돌리기 동작 — 손에 ' + B.hand().label);
  B.act('plate:add'); await sleep(250);

  // ── 위치 동기화 ──
  // 스냅샷은 100ms 주기로 계속 오므로, 갱신된 값이 실릴 때까지 기다린다
  let seenPos = null;
  B.on('positions', (list) => {
    const mine = list.find((p) => p.id === A.id);
    if (mine && Math.abs(mine.x - 3.2) < 0.01 && Math.abs(mine.z + 1.5) < 0.01) seenPos = mine;
  });
  A.emit('player:move', { x: 3.2, z: -1.5, ry: 1.2 });
  if (!await waitFor(() => seenPos, 2500, '위치 스냅샷 반영')) fail('위치 동기화 실패');
  else ok('위치 동기화 확인 — A가 (' + seenPos.x + ', ' + seenPos.z + ') 로 이동한 것이 B에게 보임');

  // ── 서빙 ──
  C.emit('game:serve');
  if (!await waitFor(() => A.result && A.result.pending === false, 15000, '평가 완료')) return done();

  const r = A.result;
  console.log('');
  console.log('════════ 결과 ════════');
  console.log('총점:', r.scores.total);
  console.log('  🎯 최종 정확도:', r.scores.finalAccuracy, ' 📝 주문 정확도:', r.scores.negotiation);
  console.log('  👨‍🍳 제작 정확도:', r.scores.kitchen, ' 🔥 조리 상태:', r.scores.cook);
  console.log('  ⏱️ 시간:', r.scores.time, ' 😤 만족도:', r.scores.satisfaction);
  console.log('손님 반응: "' + r.evaluation.comment + '"');
  console.log('만든 것:', r.builtList.join(' / '));
  console.log('══════════════════════');
  console.log('');

  if (typeof r.scores.total !== 'number' || r.scores.total < 0 || r.scores.total > 100) fail('총점 이상: ' + r.scores.total);
  else ok('총점 범위 정상: ' + r.scores.total);
  if (!r.trueOrder || !r.orderSheet || !r.built) fail('비교 데이터 누락');
  else ok('원본/주문서/실제 3종 비교 데이터 포함');
  if (typeof r.scores.stackOrder !== 'number' || !r.stack || !Array.isArray(r.stack.expected)) {
    fail('조립 순서 결과 누락');
  } else {
    ok('조립 순서 결과 포함 — ' + r.scores.stackOrder + '점');
    console.log('   기대: ' + r.stack.expected.join(' → '));
    console.log('   실제: ' + r.stack.actual.join(' → '));
  }

  A.emit('game:next');
  await waitFor(() => A.state.phase === 'lobby', 3000, '대기실 복귀');
  if (A.state.history.length !== 1) fail('라운드 기록 누적 실패');
  else ok('라운드 기록 누적 (' + A.state.history[0].total + '점)');

  done();

  function done() {
    setTimeout(() => { A.close(); B.close(); C.close(); process.exit(process.exitCode || 0); }, 400);
  }
})();
