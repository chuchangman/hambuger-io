'use strict';

const M = require('./menu');

const PHASE = {
  LOBBY: 'lobby',
  NEGOTIATION: 'negotiation',
  COOKING: 'cooking',
  RESULT: 'result'
};

/* 라운드 진행 속도 (방장이 대기실에서 선택) */
const PACES = {
  relaxed: { id: 'relaxed', name: '여유', negotiation: 180, cooking: 180, desc: '처음 해보는 사람과' },
  normal:  { id: 'normal',  name: '보통', negotiation: 120, cooking: 120, desc: '기본' },
  rush:    { id: 'rush',    name: '긴박', negotiation: 90,  cooking: 90,  desc: '손이 바쁩니다' }
};
const DEFAULT_PACE = 'normal';

/* 하위 호환용 (설정/문서에서 참조) */
const NEGOTIATION_SECONDS = PACES[DEFAULT_PACE].negotiation;
const COOKING_SECONDS = PACES[DEFAULT_PACE].cooking;

/* 버거의 표준 조립 순서 (아래 → 위). 조립 순서 채점의 기준이 된다. */
const LAYER_ORDER = [
  'bun_bottom', 'patty', 'cheese', 'bacon', 'egg',
  'lettuce', 'tomato', 'onion', 'pickle', 'sauce', 'bun_top'
];

const GRILL_SLOTS = 6;
const TOASTER_SLOTS = 3;
const CHOP_BOARDS = 2;

/* 재료통에서 꺼낼 수 있는 것들 */
const GRILLABLE = ['patty', 'bacon', 'egg'];
const TOASTABLE = ['bun_bottom', 'bun_top'];
const BIN_ITEMS = GRILLABLE.concat(TOASTABLE, ['cheese'], M.VEGGIES);

let uidSeq = 0;
function uid(p) { uidSeq += 1; return p + '_' + uidSeq.toString(36) + Date.now().toString(36).slice(-4); }

/* ────────────────────────────────────────────────────────────
   조리 품질
   ──────────────────────────────────────────────────────────── */
function cookQuality(type, elapsed, doneness) {
  const ing = M.INGREDIENTS[type];
  if (!ing) return { quality: 0, label: '?' };
  if (elapsed >= ing.burnt) return { quality: 0, label: '탐' };

  const target = ing.doneness ? ing.doneness[doneness || 'normal'] : ing.target;
  const diff = Math.abs(elapsed - target);
  const quality = Math.max(0, Math.round(100 - (diff / ing.tol) * 100));

  let label;
  if (quality >= 85) label = '완벽';
  else if (quality >= 55) label = elapsed < target ? '조금 덜 익음' : '조금 과함';
  else label = elapsed < target ? '덜 익음' : '많이 익음';
  return { quality, label };
}

function nearestDoneness(elapsed) {
  const d = M.INGREDIENTS.patty.doneness;
  let best = 'normal';
  let bestDiff = Infinity;
  for (const key of Object.keys(d)) {
    const diff = Math.abs(elapsed - d[key]);
    if (diff < bestDiff) { bestDiff = diff; best = key; }
  }
  return best;
}

/* ────────────────────────────────────────────────────────────
   접시 → 주문서 형태 요약
   ──────────────────────────────────────────────────────────── */
const AMT_VAL = { none: 0, little: 1, normal: 2, much: 3 };
const VAL_AMT = ['none', 'little', 'normal', 'much'];

function summarizeBuilt(plate) {
  const out = {
    patty: 0, cheese: 0, bacon: 0, egg: 0,
    pattyDoneness: 'normal', bunToasted: true,
    veggies: { lettuce: 'none', tomato: 'none', onion: 'none', pickle: 'none' },
    sauce: { type: 'none', amount: 'none' }
  };
  const veggieVal = { lettuce: 0, tomato: 0, onion: 0, pickle: 0 };
  let sauceVal = 0;
  const pattyElapsed = [];
  const bunToastFlags = [];
  const qualities = [];

  for (const it of plate) {
    if (typeof it.quality === 'number') qualities.push(it.quality);
    switch (it.type) {
      case 'patty':
        out.patty += 1;
        if (typeof it.elapsed === 'number') pattyElapsed.push(it.elapsed);
        break;
      case 'cheese': out.cheese += 1; break;
      case 'bacon': out.bacon += 1; break;
      case 'egg': out.egg += 1; break;
      case 'bun_bottom':
      case 'bun_top': bunToastFlags.push(!!it.toasted); break;
      case 'sauce':
        out.sauce.type = it.sauceType;
        sauceVal += AMT_VAL[it.amount] || 0;
        break;
      default:
        if (M.VEGGIES.includes(it.type)) veggieVal[it.type] += AMT_VAL[it.amount] || 0;
    }
  }

  for (const v of M.VEGGIES) out.veggies[v] = VAL_AMT[Math.min(3, veggieVal[v])];
  if (out.sauce.type !== 'none') out.sauce.amount = VAL_AMT[Math.max(1, Math.min(3, sauceVal))];
  if (pattyElapsed.length) {
    out.pattyDoneness = nearestDoneness(pattyElapsed.reduce((a, b) => a + b, 0) / pattyElapsed.length);
  }
  out.bunToasted = bunToastFlags.length ? bunToastFlags.every(Boolean) : true;

  return {
    order: out,
    cookScore: qualities.length ? Math.round(qualities.reduce((a, b) => a + b, 0) / qualities.length) : 0,
    itemCount: plate.length
  };
}

function describeBuilt(plate) {
  return plate.map((it) => it.label + (it.cookLabel ? ' (' + it.cookLabel + ')' : ''));
}

/* ────────────────────────────────────────────────────────────
   조립 순서 채점
   주문서로부터 "이렇게 쌓였어야 한다"는 층 목록을 만들고,
   실제로 쌓은 순서와 최장 공통 부분수열(LCS)로 비교한다.
   위치가 하나 밀렸다고 뒤가 전부 0점이 되지 않도록 LCS 를 쓴다.
   ──────────────────────────────────────────────────────────── */
function expectedLayers(order) {
  const out = [];
  for (const type of LAYER_ORDER) {
    if (type === 'bun_bottom' || type === 'bun_top') { out.push(type); continue; }
    if (type === 'sauce') {
      if (order.sauce && order.sauce.type !== 'none') out.push('sauce');
      continue;
    }
    if (M.VEGGIES.includes(type)) {
      if (order.veggies[type] !== 'none') out.push(type);
      continue;
    }
    for (let i = 0; i < (order[type] || 0); i++) out.push(type);
  }
  return out;
}

function lcsLength(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0);
  let cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
    cur.fill(0);
  }
  return prev[m];
}

function stackOrderScore(order, plate) {
  const expected = expectedLayers(order);
  const actual = plate.map((p) => p.type);
  if (!expected.length) return { score: 0, expected, actual };
  if (!actual.length) return { score: 0, expected, actual };
  const matched = lcsLength(expected, actual);
  // 순서는 맞췄지만 엉뚱한 재료를 잔뜩 올린 경우도 감점되도록 분모에 실제 길이를 섞는다
  const denom = Math.max(expected.length, actual.length);
  return { score: Math.round((matched / denom) * 100), expected, actual, matched };
}

/* ────────────────────────────────────────────────────────────
   주문서 비교
   ──────────────────────────────────────────────────────────── */
function countMatch(a, b, tolerance) {
  return Math.max(0, 1 - Math.abs(a - b) / (tolerance || 2));
}

function compareOrders(target, actual) {
  let earned = 0;
  const diffs = [];
  const W = { patty: 18, doneness: 8, cheese: 10, bacon: 6, egg: 6, bun: 6, veggie: 8, sauceType: 9, sauceAmount: 5 };

  for (const [key, name, w] of [
    ['patty', '패티', W.patty], ['cheese', '치즈', W.cheese],
    ['bacon', '베이컨', W.bacon], ['egg', '계란', W.egg]
  ]) {
    earned += w * countMatch(target[key], actual[key], 2);
    if (target[key] !== actual[key]) diffs.push(name + ' ' + target[key] + '개 → ' + actual[key] + '개');
  }

  earned += W.doneness * (target.pattyDoneness === actual.pattyDoneness ? 1 : 0.35);
  if (target.pattyDoneness !== actual.pattyDoneness) {
    diffs.push('굽기 ' + M.DONENESS_LABEL[target.pattyDoneness] + ' → ' + M.DONENESS_LABEL[actual.pattyDoneness]);
  }

  earned += W.bun * (target.bunToasted === actual.bunToasted ? 1 : 0);
  if (target.bunToasted !== actual.bunToasted) {
    diffs.push('빵 ' + (target.bunToasted ? '구움' : '안 구움') + ' → ' + (actual.bunToasted ? '구움' : '안 구움'));
  }

  for (const v of M.VEGGIES) {
    const t = AMT_VAL[target.veggies[v]];
    const a = AMT_VAL[actual.veggies[v]];
    earned += W.veggie * Math.max(0, 1 - Math.abs(t - a) / 2);
    if (t !== a) {
      diffs.push(M.INGREDIENTS[v].name + ' ' + M.AMOUNT_LABEL[target.veggies[v]] +
        ' → ' + M.AMOUNT_LABEL[actual.veggies[v]]);
    }
  }

  earned += W.sauceType * (target.sauce.type === actual.sauce.type ? 1 : 0);
  if (target.sauce.type !== actual.sauce.type) {
    diffs.push(M.SAUCE_LABEL[target.sauce.type] + ' → ' + M.SAUCE_LABEL[actual.sauce.type]);
  }
  earned += W.sauceAmount *
    Math.max(0, 1 - Math.abs(AMT_VAL[target.sauce.amount] - AMT_VAL[actual.sauce.amount]) / 2);

  return { score: Math.round(Math.max(0, Math.min(100, earned))), diffs };
}

/* ────────────────────────────────────────────────────────────
   Room
   ──────────────────────────────────────────────────────────── */
class Room {
  constructor(code) {
    this.code = code;
    this.hostId = null;
    this.players = new Map();
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.difficulty = 2;
    this.pace = DEFAULT_PACE;
    this.history = [];
    this.resetRound();
  }

  resetRound() {
    this.persona = null;
    this.trueOrder = null;
    this.chat = [];
    this.orderPad = M.emptyOrder();
    this.orderSheet = null;
    this.patience = 100;
    this.phaseEndsAt = 0;
    this.startedAt = 0;
    this.servedAt = 0;
    this.result = null;
    this.customerBusy = false;
    this.orderMutated = false;
    this.lastNagAt = 0;
    this.kitchen = {
      grill: new Array(GRILL_SLOTS).fill(null),
      toaster: new Array(TOASTER_SLOTS).fill(null),
      boards: new Array(CHOP_BOARDS).fill(null),
      plate: [],
      served: false
    };
    for (const p of this.players.values()) p.holding = null;
  }

  /* ── 플레이어 (역할 구분 없음) ── */
  addPlayer(socketId, name) {
    const n = this.players.size;
    const p = {
      id: socketId,
      name: name || '직원',
      color: PLAYER_COLORS[n % PLAYER_COLORS.length],
      holding: null,
      pos: { x: -1.6 + (n % 4) * 1.1, z: 6.5 + Math.floor(n / 4) * 1.1, ry: 0 }
    };
    this.players.set(socketId, p);
    if (!this.hostId) this.hostId = socketId;
    return p;
  }

  removePlayer(socketId) {
    const p = this.players.get(socketId);
    // 손에 든 재료는 사라진다
    this.players.delete(socketId);
    if (this.hostId === socketId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    return p;
  }

  setPos(socketId, pos) {
    const p = this.players.get(socketId);
    if (!p || !pos) return;
    p.pos = {
      x: Math.max(-20, Math.min(20, Number(pos.x) || 0)),
      z: Math.max(-20, Math.min(20, Number(pos.z) || 0)),
      ry: Number(pos.ry) || 0
    };
  }

  /* ── 라운드 ── */
  startRound(difficulty, pace) {
    this.resetRound();
    this.round += 1;
    this.difficulty = difficulty || this.difficulty;
    if (PACES[pace]) this.pace = pace;
    const pool = M.PERSONAS.filter((p) => Math.abs(p.difficulty - this.difficulty) <= 1);
    this.persona = M.pick(pool.length ? pool : M.PERSONAS);
    this.trueOrder = M.generateTrueOrder(this.difficulty);
    this.phase = PHASE.NEGOTIATION;
    this.startedAt = Date.now();
    this.phaseEndsAt = this.startedAt + PACES[this.pace].negotiation * 1000;
  }

  submitOrder(pad) {
    this.orderSheet = JSON.parse(JSON.stringify(pad));
    this.phase = PHASE.COOKING;
    this.startedAt = Date.now();
    this.phaseEndsAt = this.startedAt + PACES[this.pace].cooking * 1000;
    this.lastNagAt = Date.now();
  }

  /* ────────────────────────────────────────────────────────
     주방 액션 — 모든 플레이어가 사용 가능. 손(holding) 기반.
     ──────────────────────────────────────────────────────── */
  kitchenAction(playerId, action, payload) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, msg: '플레이어를 찾을 수 없습니다.' };
    if (this.phase !== PHASE.COOKING || this.kitchen.served) {
      return { ok: false, msg: '주문이 확정되어야 조리할 수 있습니다.' };
    }
    const k = this.kitchen;
    const now = Date.now();

    switch (action) {
      /* 재료통에서 집기 */
      case 'bin:take': {
        const item = payload.item;
        if (!BIN_ITEMS.includes(item)) return { ok: false, msg: '없는 재료입니다.' };
        if (p.holding) return { ok: false, msg: '손이 이미 차 있습니다. (Q: 버리기)' };
        const ing = M.INGREDIENTS[item];
        const raw = item !== 'cheese';
        p.holding = {
          uid: uid('it'), type: item, raw,
          label: ing.name + (raw && (GRILLABLE.includes(item) || M.VEGGIES.includes(item)) ? '(생)' : ''),
          emoji: ing.emoji,
          toasted: TOASTABLE.includes(item) ? false : undefined
        };
        return { ok: true, msg: ing.name + ' 집음' };
      }

      /* 그릴 */
      case 'grill:place': {
        const slot = payload.slot | 0;
        if (!p.holding) return { ok: false, msg: '손에 아무것도 없습니다.' };
        if (!GRILLABLE.includes(p.holding.type)) return { ok: false, msg: '그릴에 올릴 수 없는 재료입니다.' };
        if (!p.holding.raw) return { ok: false, msg: '이미 익힌 재료입니다.' };
        if (slot < 0 || slot >= GRILL_SLOTS) return { ok: false, msg: '잘못된 자리입니다.' };
        if (k.grill[slot]) return { ok: false, msg: '이미 사용 중인 자리입니다.' };
        k.grill[slot] = { type: p.holding.type, startedAt: now };
        const nm = M.INGREDIENTS[p.holding.type].name;
        p.holding = null;
        return { ok: true, msg: nm + ' 굽는 중' };
      }
      case 'grill:take': {
        const slot = payload.slot | 0;
        const cell = k.grill[slot];
        if (!cell) return { ok: false, msg: '비어 있습니다.' };
        if (p.holding) return { ok: false, msg: '손이 이미 차 있습니다.' };
        const elapsed = now - cell.startedAt;
        const doneness = this.orderSheet ? this.orderSheet.pattyDoneness : 'normal';
        const q = cookQuality(cell.type, elapsed, cell.type === 'patty' ? doneness : null);
        k.grill[slot] = null;
        p.holding = {
          uid: uid('it'), type: cell.type, raw: false,
          label: M.INGREDIENTS[cell.type].name, emoji: M.INGREDIENTS[cell.type].emoji,
          quality: q.quality, cookLabel: q.label, elapsed
        };
        return { ok: true, msg: M.INGREDIENTS[cell.type].name + ' — ' + q.label };
      }

      /* 토스터 */
      case 'toast:place': {
        const slot = payload.slot | 0;
        if (!p.holding) return { ok: false, msg: '손에 아무것도 없습니다.' };
        if (!TOASTABLE.includes(p.holding.type)) return { ok: false, msg: '토스터에 넣을 수 없습니다.' };
        if (p.holding.toasted) return { ok: false, msg: '이미 구운 빵입니다.' };
        if (slot < 0 || slot >= TOASTER_SLOTS) return { ok: false, msg: '잘못된 자리입니다.' };
        if (k.toaster[slot]) return { ok: false, msg: '이미 사용 중인 자리입니다.' };
        k.toaster[slot] = { type: p.holding.type, startedAt: now };
        p.holding = null;
        return { ok: true, msg: '빵 굽는 중' };
      }
      case 'toast:take': {
        const slot = payload.slot | 0;
        const cell = k.toaster[slot];
        if (!cell) return { ok: false, msg: '비어 있습니다.' };
        if (p.holding) return { ok: false, msg: '손이 이미 차 있습니다.' };
        const elapsed = now - cell.startedAt;
        const q = cookQuality(cell.type, elapsed, null);
        k.toaster[slot] = null;
        p.holding = {
          uid: uid('it'), type: cell.type, raw: false, toasted: true,
          label: M.INGREDIENTS[cell.type].name, emoji: M.INGREDIENTS[cell.type].emoji,
          quality: q.quality, cookLabel: q.label, elapsed
        };
        return { ok: true, msg: M.INGREDIENTS[cell.type].name + ' — ' + q.label };
      }

      /* 도마 */
      case 'board:place': {
        const board = payload.board | 0;
        const amount = payload.amount;
        if (!p.holding) return { ok: false, msg: '손에 아무것도 없습니다.' };
        if (!M.VEGGIES.includes(p.holding.type)) return { ok: false, msg: '도마에 올릴 수 없는 재료입니다.' };
        if (!p.holding.raw) return { ok: false, msg: '이미 썬 재료입니다.' };
        if (!['little', 'normal', 'much'].includes(amount)) return { ok: false, msg: '양을 골라주세요. (R)' };
        if (board < 0 || board >= CHOP_BOARDS) return { ok: false, msg: '잘못된 도마입니다.' };
        if (k.boards[board]) return { ok: false, msg: '이미 사용 중인 도마입니다.' };
        k.boards[board] = { item: p.holding.type, amount, chops: 0, need: M.CHOPS_REQUIRED[amount] };
        p.holding = null;
        return { ok: true, msg: '썰기 시작 — E 연타!' };
      }
      case 'board:chop': {
        const board = payload.board | 0;
        const b = k.boards[board];
        if (!b) return { ok: false, msg: '도마가 비어 있습니다.' };
        b.chops += 1;
        if (b.chops >= b.need) {
          const item = {
            uid: uid('it'), type: b.item, raw: false, amount: b.amount,
            label: M.INGREDIENTS[b.item].name + ' ' + M.AMOUNT_LABEL[b.amount],
            emoji: M.INGREDIENTS[b.item].emoji
          };
          k.boards[board] = null;
          if (p.holding) { k.plate.push(item); return { ok: true, msg: '손이 차서 접시에 바로 올렸습니다.' }; }
          p.holding = item;
          return { ok: true, done: true, msg: item.label + ' 완성' };
        }
        return { ok: true };
      }
      case 'board:clear': {
        k.boards[payload.board | 0] = null;
        return { ok: true, msg: '도마를 치웠습니다.' };
      }

      /* 소스 */
      case 'sauce:take': {
        const { sauceType, amount } = payload;
        if (p.holding) return { ok: false, msg: '손이 이미 차 있습니다.' };
        if (!M.SAUCES.includes(sauceType) || sauceType === 'none') return { ok: false, msg: '없는 소스입니다.' };
        if (!['little', 'normal', 'much'].includes(amount)) return { ok: false, msg: '양을 골라주세요. (R)' };
        p.holding = {
          uid: uid('it'), type: 'sauce', raw: false, sauceType, amount,
          label: M.SAUCE_LABEL[sauceType] + ' ' + M.AMOUNT_LABEL[amount],
          emoji: M.INGREDIENTS.sauce.emoji
        };
        return { ok: true, msg: p.holding.label };
      }

      /* 접시 */
      case 'plate:add': {
        if (!p.holding) return { ok: false, msg: '손에 아무것도 없습니다.' };
        const h = p.holding;
        if (h.raw && GRILLABLE.includes(h.type)) return { ok: false, msg: '생재료는 구워야 합니다!' };
        if (h.raw && M.VEGGIES.includes(h.type)) return { ok: false, msg: '채소는 썰어야 합니다!' };
        if (k.plate.length >= 20) return { ok: false, msg: '너무 많이 쌓았습니다.' };
        k.plate.push(h);
        p.holding = null;
        return { ok: true, msg: h.label + ' 올림' };
      }
      case 'plate:undo': {
        if (p.holding) return { ok: false, msg: '손이 차 있습니다.' };
        if (!k.plate.length) return { ok: false, msg: '접시가 비어 있습니다.' };
        p.holding = k.plate.pop();
        return { ok: true, msg: p.holding.label + ' 회수' };
      }

      case 'drop': {
        if (!p.holding) return { ok: false, msg: '손에 아무것도 없습니다.' };
        const nm = p.holding.label;
        p.holding = null;
        return { ok: true, msg: nm + ' 버림' };
      }

      default:
        return { ok: false, msg: '알 수 없는 동작입니다.' };
    }
  }

  /* ── 결과 ── */
  finish(timedOut) {
    const k = this.kitchen;
    k.served = true;
    this.servedAt = Date.now();

    const built = summarizeBuilt(k.plate);
    const sheet = this.orderSheet || M.emptyOrder();

    const neg = compareOrders(this.trueOrder, sheet);
    const kit = compareOrders(sheet, built.order);
    const fin = compareOrders(this.trueOrder, built.order);

    const elapsedMs = this.servedAt - this.startedAt;
    const usedRatio = Math.min(1, elapsedMs / (PACES[this.pace].cooking * 1000));
    let timeScore = Math.round((1 - Math.max(0, usedRatio - 0.5) / 0.5) * 100);
    if (timedOut) timeScore = 0;
    timeScore = Math.max(0, Math.min(100, timeScore));

    // 조립 순서: 손님이 진짜 원한 구성 기준으로 채점
    const stack = stackOrderScore(this.trueOrder, k.plate);

    this.result = {
      persona: this.persona,
      trueOrder: this.trueOrder,
      orderSheet: sheet,
      built: built.order,
      builtList: describeBuilt(k.plate),
      scores: {
        negotiation: neg.score,
        kitchen: kit.score,
        finalAccuracy: fin.score,
        cook: built.itemCount ? built.cookScore : 0,
        time: timeScore,
        stackOrder: stack.score,
        patience: Math.round(this.patience),
        satisfaction: 0,
        total: 0
      },
      stack: {
        expected: stack.expected.map((t) => M.INGREDIENTS[t].name),
        actual: stack.actual.map((t) => M.INGREDIENTS[t].name)
      },
      diffs: { negotiation: neg.diffs, kitchen: kit.diffs, final: fin.diffs },
      timedOut: !!timedOut,
      elapsedSec: Math.round(elapsedMs / 1000)
    };
    this.phase = PHASE.RESULT;
    return this.result;
  }

  applySatisfaction(evaluation) {
    if (!this.result) return;
    const s = this.result.scores;
    s.satisfaction = Math.max(0, Math.min(100, Math.round(evaluation.satisfaction)));
    s.total = Math.round(
      s.finalAccuracy * 0.32 +   // 손님이 원한 것 ↔ 실제 버거
      s.negotiation * 0.20 +     // 손님이 원한 것 ↔ 주문서 (대화로 캐낸 정확도)
      s.satisfaction * 0.18 +    // LLM 손님 만족도
      s.cook * 0.12 +            // 굽기 품질
      s.stackOrder * 0.10 +      // 조립 순서
      s.time * 0.08              // 제작 시간
    );
    this.result.evaluation = evaluation;
    this.history.push({
      round: this.round, persona: this.persona.name,
      total: s.total, satisfaction: s.satisfaction
    });
  }

  /* ── 직렬화 ── */
  publicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      difficulty: this.difficulty,
      pace: this.pace,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id, name: p.name, color: p.color
      })),
      persona: this.persona ? {
        name: this.persona.name, emoji: this.persona.emoji,
        tagline: this.persona.tagline, difficulty: this.persona.difficulty
      } : null,
      chat: this.chat,
      orderPad: this.orderPad,
      orderSheet: this.orderSheet,
      patience: Math.round(this.patience),
      phaseEndsAt: this.phaseEndsAt,
      customerBusy: this.customerBusy,
      history: this.history,
      now: Date.now()
    };
  }

  kitchenState() {
    return {
      grill: this.kitchen.grill,
      toaster: this.kitchen.toaster,
      boards: this.kitchen.boards,
      plate: this.kitchen.plate,
      served: this.kitchen.served,
      hands: Array.from(this.players.values()).map((p) => ({ id: p.id, holding: p.holding })),
      now: Date.now()
    };
  }

  /* 위치 스냅샷 (초당 10회 전송) */
  posSnapshot() {
    const out = [];
    for (const p of this.players.values()) {
      out.push({ id: p.id, x: p.pos.x, z: p.pos.z, ry: p.pos.ry, holding: p.holding ? p.holding.type : null });
    }
    return out;
  }
}

const PLAYER_COLORS = ['#f5b942', '#63a8e8', '#58c07a', '#e07a7a', '#b98ae0', '#4fc9c1'];

module.exports = {
  Room, PHASE, PACES, DEFAULT_PACE, LAYER_ORDER,
  NEGOTIATION_SECONDS, COOKING_SECONDS,
  GRILL_SLOTS, TOASTER_SLOTS, CHOP_BOARDS, BIN_ITEMS, GRILLABLE, TOASTABLE,
  cookQuality, summarizeBuilt, compareOrders, describeBuilt,
  expectedLayers, stackOrderScore, PLAYER_COLORS
};
