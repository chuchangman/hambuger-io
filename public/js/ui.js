/* DOM UI — 입장/대기실, HUD, 대화·주문패드 오버레이, 결과 */
import { S, emit, on, isHost, myHolding, now } from './net.js';
import { state as P, releaseLock } from './player.js';
import { currentZone, camera } from './world.js';

export const $ = (s, r) => (r || document).querySelector(s);
export const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const QUICK = [
  '패티는 몇 장 드릴까요?',
  '치즈는 넣어드릴까요?',
  '야채는 어떻게 해드릴까요?',
  '소스는 뭘로 하시겠어요?',
  '빵은 구워드릴까요?',
  '고기는 얼마나 익혀드릴까요?',
  '정리해드릴게요. 이대로 맞으실까요?'
];

let openOverlay = null;   // 'chat' | 'pad' | null

/* ──────────────── 공통 ──────────────── */
export function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('#toast-area').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2400);
}

function fmtTime(ms) {
  if (ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  const playing = id === 'screen-game';
  $('#hud').classList.toggle('hidden', !playing);
}

/* ──────────────── 오버레이 ──────────────── */
function setOverlay(name) {
  openOverlay = name;
  P.overlayOpen = !!name;
  $('#overlay-chat').classList.toggle('hidden', name !== 'chat');
  $('#overlay-pad').classList.toggle('hidden', name !== 'pad');
  $('#overlay-bg').classList.toggle('hidden', !name);
  if (name) {
    releaseLock();
    if (name === 'chat') setTimeout(() => $('#chat-text').focus(), 30);
  }
}

export function openChat() {
  if (!S.state || (S.state.phase !== 'negotiation' && S.state.phase !== 'cooking')) return;
  setOverlay('chat');
  renderChat();
}
export function openPad() {
  if (!S.state || S.state.phase === 'lobby' || S.state.phase === 'result') return;
  setOverlay('pad');
  renderPad();
}
export function closeOverlay() { setOverlay(null); }

/* ──────────────── HUD ──────────────── */
/* 매 프레임 호출되므로 변한 것만 DOM 에 반영한다 */
const hudCache = {};
function setHTML(sel, key, html) {
  if (hudCache[key] === html) return false;
  hudCache[key] = html;
  $(sel).innerHTML = html;
  return true;
}

export function renderHUD() {
  const st = S.state;
  if (!st) return;

  // 조준 문구
  const p = P.prompt;
  const promptEl = $('#prompt');
  const pHtml = !p ? '' : (p.disabled
    ? '<span class="msg">' + esc(p.text) + '</span>'
    : '<b class="key">' + (p.key || 'E') + '</b><span class="msg">' + esc(p.text) + '</span>');
  if (setHTML('#prompt', 'prompt', pHtml)) {
    promptEl.className = !p ? 'hidden' : (p.disabled ? 'off' : (p.danger ? 'danger' : ''));
  }

  // 손
  const h = myHolding();
  const handHtml = h
    ? '<span class="emoji">' + (h.emoji || '📦') + '</span><span class="nm">' + esc(h.label) + '</span>' +
      (h.cookLabel ? '<span class="q">' + esc(h.cookLabel) + '</span>' : '')
    : '<span class="nm empty">빈손</span>';
  if (setHTML('#hand', 'hand', handHtml)) $('#hand').classList.toggle('has', !!h);

  setHTML('#amount-pill', 'amt', 'R · ' + S.cfg.amountLabel[P.amount]);

  // 현재 구역 안내
  const zone = currentZone(camera.position.x, camera.position.z);
  if (hudCache.zone !== zone.id) {
    hudCache.zone = zone.id;
    $('#location-name').textContent = zone.name;
    $('#location-help').textContent = zone.help;
    $('#location').className = 'location ' + zone.id;
  }

  // 타이머/인내심
  const left = st.phaseEndsAt - now();
  $('#timer').textContent = fmtTime(left);
  $('#timer').classList.toggle('urgent', left < 30000);
  $('#phase-chip').textContent = st.phase === 'negotiation' ? '주문 받는 중' : '조리 중';
  const pat = $('#patience-bar');
  pat.style.width = st.patience + '%';
  pat.classList.toggle('low', st.patience < 40);

  // 주문서
  const ticketHtml = st.orderSheet
    ? '<h4>🧾 확정 주문서</h4><ul>' +
      orderLines(st.orderSheet).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>'
    : '<h4>📝 주문 받는 중</h4>' +
      '<p class="tip">손님(<b>E</b>)에게 물어보고<br /><b>B</b> 로 주문패드를 채우세요.</p><ul>' +
      orderLines(st.orderPad).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>';
  setHTML('#ticket', 'ticket', ticketHtml);

  // 손님 최근 대사 (미니)
  const last = [...st.chat].reverse().find((c) => c.role === 'customer');
  setHTML('#say', 'say', st.customerBusy
    ? '<i>손님이 생각하는 중...</i>'
    : (last ? '<b>' + esc(last.name) + ':</b> ' + esc(last.text) : ''));
}

function orderLines(o) {
  const cfg = S.cfg;
  const lines = [];
  lines.push('빵 ' + (o.bunToasted ? '구움' : '안 구움'));
  lines.push('패티 ' + o.patty + '장 · ' + cfg.donenessLabel[o.pattyDoneness]);
  if (o.cheese) lines.push('치즈 ' + o.cheese + '장');
  if (o.bacon) lines.push('베이컨 ' + o.bacon + '장');
  if (o.egg) lines.push('계란 ' + o.egg + '개');
  for (const v of cfg.veggies) {
    if (o.veggies[v] !== 'none') lines.push(cfg.ingredients[v].name + ' ' + cfg.amountLabel[o.veggies[v]]);
  }
  const off = cfg.veggies.filter((v) => o.veggies[v] === 'none').map((v) => cfg.ingredients[v].name);
  if (off.length) lines.push('제외: ' + off.join(', '));
  lines.push(o.sauce.type === 'none' ? '소스 없음'
    : cfg.sauceLabel[o.sauce.type] + ' ' + cfg.amountLabel[o.sauce.amount]);
  return lines;
}

/* ──────────────── 대화 ──────────────── */
export function renderChat() {
  const st = S.state;
  if (!st || openOverlay !== 'chat') return;
  const log = $('#chat-log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 60;

  let html = st.chat.map((m) => {
    if (m.role === 'system') return '<div class="msg system"><div class="bubble">' + esc(m.text) + '</div></div>';
    const cls = m.role === 'customer' ? 'customer' : 'staff';
    return '<div class="msg ' + cls + '"><div><div class="who">' + esc(m.name) + '</div>' +
      '<div class="bubble">' + esc(m.text) + '</div></div></div>';
  }).join('');
  if (st.customerBusy) html += '<div class="msg customer typing"><div class="bubble">…생각하는 중</div></div>';

  log.innerHTML = html;
  if (stick) log.scrollTop = log.scrollHeight;

  $('#chat-persona').textContent = st.persona
    ? st.persona.emoji + ' ' + st.persona.name + ' — ' + st.persona.tagline : '';
}

function sendChat() {
  const el = $('#chat-text');
  const t = el.value.trim();
  if (!t) return;
  emit('chat:send', { text: t });
  el.value = '';
}

/* ──────────────── 주문패드 ──────────────── */
function padEmit(mut) {
  const p = JSON.parse(JSON.stringify(S.state.orderPad));
  mut(p);
  S.state.orderPad = p;
  emit('pad:update', { order: p });
  renderPad();
}

function stepperRow(key, label, val, max) {
  return '<div class="pad-row"><div class="lbl">' + label + '</div><div class="stepper">' +
    '<button data-step="' + key + '" data-d="-1">−</button>' +
    '<span class="val">' + val + '</span>' +
    '<button data-step="' + key + '" data-d="1" data-max="' + max + '">+</button></div></div>';
}

function segRow(label, name, options, current) {
  return '<div class="pad-row"><div class="lbl">' + label + '</div><div class="seg small">' +
    options.map((o) => '<button data-seg="' + name + '" data-v="' + o.v + '"' +
      (o.v === current ? ' class="on"' : '') + '>' + o.t + '</button>').join('') + '</div></div>';
}

export function renderPad() {
  const st = S.state;
  if (!st || openOverlay !== 'pad') return;
  const o = st.orderPad;
  const cfg = S.cfg;
  const amtOpts = cfg.amounts.map((a) => ({ v: a, t: cfg.amountLabel[a] }));
  const locked = st.phase !== 'negotiation';

  let html = '';
  html += segRow('🍞 빵', 'bunToasted', [{ v: 'true', t: '구움' }, { v: 'false', t: '안 구움' }], String(o.bunToasted));
  html += stepperRow('patty', '🥩 패티', o.patty, 4);
  html += segRow('🔥 굽기', 'pattyDoneness',
    [{ v: 'rare', t: '살짝' }, { v: 'normal', t: '보통' }, { v: 'well', t: '바싹' }], o.pattyDoneness);
  html += stepperRow('cheese', '🧀 치즈', o.cheese, 3);
  html += stepperRow('bacon', '🥓 베이컨', o.bacon, 2);
  html += stepperRow('egg', '🍳 계란', o.egg, 2);
  for (const v of cfg.veggies) {
    html += segRow(cfg.ingredients[v].emoji + ' ' + cfg.ingredients[v].name, 'veg:' + v, amtOpts, o.veggies[v]);
  }
  html += segRow('🥫 소스', 'sauceType', cfg.sauces.map((s) => ({ v: s, t: cfg.sauceLabel[s] })), o.sauce.type);
  if (o.sauce.type !== 'none') {
    html += segRow('🥫 소스 양', 'sauceAmt', amtOpts.filter((a) => a.v !== 'none'), o.sauce.amount);
  }

  $('#pad-body').innerHTML = html;
  $$('#pad-body button').forEach((b) => { b.disabled = locked; });
  $('#btn-submit').classList.toggle('hidden', locked);
  $('#btn-draft').classList.toggle('hidden', locked);
  $('#pad-locked').classList.toggle('hidden', !locked);
}

/* ──────────────── 대기실 ──────────────── */
export function renderLobby() {
  const st = S.state;
  if (!st) return;
  $('#lobby-code').textContent = st.code;
  $('#player-list').innerHTML = st.players.map((p) =>
    '<li><span class="dot" style="background:' + p.color + '"></span>' +
    '<span class="' + (p.id === S.meId ? 'me' : '') + '">' + esc(p.name) + '</span>' +
    (p.id === st.hostId ? '<span class="tag host">방장</span>' : '') + '</li>').join('');

  const host = isHost();
  $('#host-controls').classList.toggle('hidden', !host);
  $('#not-host-hint').classList.toggle('hidden', host);
  $$('#difficulty-seg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.diff) === st.difficulty));

  // 진행 속도
  const paceSeg = $('#pace-seg');
  if (!paceSeg.children.length) {
    paceSeg.innerHTML = Object.values(S.cfg.paces).map((p) =>
      '<button data-pace="' + p.id + '">' + esc(p.name) + '</button>').join('');
    paceSeg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pace]');
      if (!b || !S.state) return;
      S.state.pace = b.dataset.pace;
      renderLobby();
    });
  }
  const pace = S.cfg.paces[st.pace] ? st.pace : S.cfg.defaultPace;
  $$('#pace-seg button').forEach((b) => b.classList.toggle('on', b.dataset.pace === pace));
  const pc = S.cfg.paces[pace];
  $('#pace-desc').textContent = '주문 받기 ' + pc.negotiation + '초 · 조리 ' + pc.cooking + '초 — ' + pc.desc;

  $('#lobby-history').innerHTML = (st.history && st.history.length)
    ? '<h3>지난 라운드</h3>' + st.history.map((h) =>
      '<div class="row"><span>R' + h.round + ' · ' + esc(h.persona) + '</span><b>' + h.total + '점</b></div>').join('')
    : '';
}

/* ──────────────── 결과 ──────────────── */
const colorFor = (v) => (v >= 80 ? 'var(--green)' : v >= 55 ? 'var(--gold)' : 'var(--red)');
const bar = (label, v) => '<div class="sbar"><span>' + label + '</span>' +
  '<span class="track"><i style="width:' + v + '%;background:' + colorFor(v) + '"></i></span>' +
  '<span class="num">' + v + '</span></div>';
const diffList = (items, okText) => (!items || !items.length)
  ? '<li class="ok">✔ ' + okText + '</li>'
  : items.map((d) => '<li>✗ ' + esc(d) + '</li>').join('');

export function renderResult(r) {
  if (!r || !S.cfg) return;
  const s = r.scores;
  $('#r-title').textContent = (r.timedOut ? '⏰ 시간 초과 — ' : '🍔 ') + '라운드 ' + (S.state ? S.state.round : '') + ' 결과';
  $('#r-total').textContent = r.pending ? '···' : s.total;

  const ev = r.evaluation;
  $('#r-quote').innerHTML = ev
    ? '<div class="who">' + esc(r.persona.name) + ' ' + r.persona.emoji + '</div>"' + esc(ev.comment) + '"' +
      (ev.complaints && ev.complaints.length
        ? '<div class="cmp bad">😤 ' + ev.complaints.map(esc).join(' · ') + '</div>' : '') +
      (ev.compliments && ev.compliments.length
        ? '<div class="cmp good">👍 ' + ev.compliments.map(esc).join(' · ') + '</div>' : '')
    : '<div class="who">손님이 버거를 살펴보는 중...</div>';

  $('#r-bars').innerHTML =
    bar('😤 고객 만족도', s.satisfaction) + bar('🎯 최종 정확도', s.finalAccuracy) +
    bar('📝 주문 정확도', s.negotiation) + bar('👨‍🍳 제작 정확도', s.kitchen) +
    bar('🔥 조리 상태', s.cook) + bar('🥞 조립 순서', s.stackOrder) +
    bar('⏱️ 제작 시간', s.time) + bar('🫧 남은 인내심', s.patience);

  $('#r-compare').innerHTML =
    '<div class="col want"><h4>😀 손님이 원한 것</h4><ul>' +
      orderLines(r.trueOrder).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></div>' +
    '<div class="col sheet"><h4>📝 확정한 주문서</h4><ul>' +
      orderLines(r.orderSheet).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></div>' +
    '<div class="col made"><h4>🍔 실제로 만든 것</h4><ul>' +
      orderLines(r.built).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></div>';

  $('#r-diff-neg').innerHTML = diffList(r.diffs.negotiation, '손님 말을 완벽히 옮겼습니다');
  $('#r-diff-kit').innerHTML = diffList(r.diffs.kitchen, '주문서대로 정확히 만들었습니다');
  $('#r-diff-fin').innerHTML = diffList(r.diffs.final, '원하던 그대로 나왔습니다');

  $('#r-built').innerHTML = (r.builtList && r.builtList.length)
    ? r.builtList.map((l) => '<li>' + esc(l) + '</li>').join('')
    : '<li>아무것도 만들지 못했습니다...</li>';

  if (r.stack) {
    $('#r-stack').innerHTML =
      '<div class="stack-col"><h4>이렇게 쌓였어야 함 (아래→위)</h4><ol>' +
        r.stack.expected.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ol></div>' +
      '<div class="stack-col"><h4>실제로 쌓은 순서</h4><ol>' +
        (r.stack.actual.length
          ? r.stack.actual.map((l) => '<li>' + esc(l) + '</li>').join('')
          : '<li class="none">(비어 있음)</li>') + '</ol></div>';
  }

  if (S.state) {
    $('#r-transcript').innerHTML = S.state.chat.map((m) =>
      m.role === 'system'
        ? '<div class="msg system"><div class="bubble">' + esc(m.text) + '</div></div>'
        : '<div class="msg ' + (m.role === 'customer' ? 'customer' : 'staff') + '"><div>' +
          '<div class="who">' + esc(m.name) + '</div><div class="bubble">' + esc(m.text) + '</div></div></div>'
    ).join('');
  }

  $('#btn-next').classList.toggle('hidden', !isHost());
  $('#r-hint').classList.toggle('hidden', isHost());
}

/* ──────────────── 라우팅 ──────────────── */
export function route() {
  const st = S.state;
  if (!st) return showScreen('screen-join');
  if (st.phase === 'lobby') { showScreen('screen-lobby'); renderLobby(); setOverlay(null); return; }
  if (st.phase === 'result') { showScreen('screen-result'); setOverlay(null); return; }
  showScreen('screen-game');
}

/* ──────────────── 초기화 ──────────────── */
export function initUI() {
  P.onOpenChat = openChat;
  P.onOpenPad = openPad;
  P.onCloseOverlay = closeOverlay;

  // 입장
  const nameInput = $('#input-name');
  nameInput.value = localStorage.getItem('hb_name') || '';
  const getName = () => {
    const v = nameInput.value.trim() || '직원' + Math.floor(Math.random() * 90 + 10);
    localStorage.setItem('hb_name', v);
    S.meName = v;
    return v;
  };

  $('#btn-create').onclick = () => emit('room:create', { name: getName() }, (res) => {
    if (res.ok) { S.meId = res.youId; location.hash = res.code; }
  });
  $('#btn-join').onclick = () => {
    const code = $('#input-code').value.trim().toUpperCase();
    if (code.length !== 4) return ($('#join-err').textContent = '4글자 방 코드를 입력하세요.');
    emit('room:join', { code, name: getName() }, (res) => {
      if (!res.ok) return ($('#join-err').textContent = res.err);
      S.meId = res.youId;
      location.hash = res.code;
    });
  };
  $('#input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });
  if (location.hash.length === 5) $('#input-code').value = location.hash.slice(1).toUpperCase();

  // 대기실
  $$('#difficulty-seg button').forEach((b) => {
    b.onclick = () => {
      $$('#difficulty-seg button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      if (S.state) S.state.difficulty = Number(b.dataset.diff);
    };
  });
  $('#btn-start').onclick = () => {
    const d = $('#difficulty-seg button.on');
    const p = $('#pace-seg button.on');
    emit('game:start', {
      difficulty: d ? Number(d.dataset.diff) : 2,
      pace: p ? p.dataset.pace : S.cfg.defaultPace
    });
  };
  $('#btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.origin + '/#' + S.state.code);
      toast('초대 링크를 복사했습니다!', 'good');
    } catch (e) { toast('방 코드: ' + S.state.code, 'warn'); }
  };
  $('#btn-next').onclick = () => emit('game:next');

  // 오버레이
  $('#overlay-bg').onclick = closeOverlay;
  $$('.overlay-close').forEach((b) => { b.onclick = closeOverlay; });
  $('#btn-send').onclick = sendChat;
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });
  $('#quick-asks').innerHTML = QUICK.map((q) => '<button data-q="' + esc(q) + '">' + esc(q) + '</button>').join('');
  $('#quick-asks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b) return;
    $('#chat-text').value = b.dataset.q;
    $('#chat-text').focus();
  });

  $('#pad-body').addEventListener('click', (e) => {
    if (S.state.phase !== 'negotiation') return;
    const st2 = e.target.closest('[data-step]');
    if (st2) {
      const key = st2.dataset.step, d = Number(st2.dataset.d), max = Number(st2.dataset.max || 99);
      return padEmit((p) => { p[key] = Math.max(0, Math.min(max, p[key] + d)); });
    }
    const sg = e.target.closest('[data-seg]');
    if (!sg) return;
    const name = sg.dataset.seg, v = sg.dataset.v;
    padEmit((p) => {
      if (name === 'bunToasted') p.bunToasted = v === 'true';
      else if (name === 'pattyDoneness') p.pattyDoneness = v;
      else if (name === 'sauceType') {
        p.sauce.type = v;
        p.sauce.amount = v === 'none' ? 'none' : (p.sauce.amount === 'none' ? 'normal' : p.sauce.amount);
      } else if (name === 'sauceAmt') p.sauce.amount = v;
      else if (name.startsWith('veg:')) p.veggies[name.slice(4)] = v;
    });
  });

  $('#btn-submit').onclick = () => {
    if (confirm('이 내용으로 주문을 확정할까요? 되돌릴 수 없습니다.')) {
      emit('order:submit');
      closeOverlay();
    }
  };
  $('#btn-draft').onclick = () => emit('pad:draft');

  // 이벤트 구독
  const llmNote = () => {
    $('#llm-note').textContent = S.llmOn
      ? '🤖 Claude 손님 연결됨 — 매번 다른 손님이 등장합니다.'
      : '⚙️ 오프라인 모드 — API 키 없이 규칙 기반 손님으로 플레이합니다.';
  };
  llmNote();          // hello 는 initUI 이전에 이미 도착했을 수 있다
  on('hello', llmNote);
  on('state', () => { route(); renderChat(); renderPad(); });
  on('result', (r) => { renderResult(r); showScreen('screen-result'); });
  on('toast', (d) => toast(d.msg, d.kind));
  on('act', (d) => {
    if (d.msg) toast(d.msg, d.ok ? 'good' : 'warn');
  });
}
