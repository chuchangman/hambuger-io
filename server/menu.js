'use strict';

/* ────────────────────────────────────────────────────────────
   재료 정의
   kind: grill(굽기) | toast(굽기) | instant(즉시) | chop(썰기) | sauce
   ──────────────────────────────────────────────────────────── */
const INGREDIENTS = {
  bun_bottom: { name: '아래 번', emoji: '🍞', kind: 'toast', target: 4000, burnt: 9500, tol: 3000 },
  bun_top:    { name: '위 번',   emoji: '🍞', kind: 'toast', target: 4000, burnt: 9500, tol: 3000 },
  patty:      { name: '패티',    emoji: '🥩', kind: 'grill', burnt: 17000, tol: 4200,
                doneness: { rare: 5000, normal: 8500, well: 12000 } },
  bacon:      { name: '베이컨',  emoji: '🥓', kind: 'grill', target: 6000, burnt: 12500, tol: 3000 },
  egg:        { name: '계란',    emoji: '🍳', kind: 'grill', target: 5000, burnt: 11500, tol: 3000 },
  cheese:     { name: '치즈',    emoji: '🧀', kind: 'instant' },
  lettuce:    { name: '양상추',  emoji: '🥬', kind: 'chop' },
  tomato:     { name: '토마토',  emoji: '🍅', kind: 'chop' },
  onion:      { name: '양파',    emoji: '🧅', kind: 'chop' },
  pickle:     { name: '피클',    emoji: '🥒', kind: 'chop' },
  sauce:      { name: '소스',    emoji: '🥫', kind: 'sauce' }
};

const VEGGIES = ['lettuce', 'tomato', 'onion', 'pickle'];
const AMOUNTS = ['none', 'little', 'normal', 'much'];
const AMOUNT_LABEL = { none: '없음', little: '조금', normal: '보통', much: '많이' };
const DONENESS_LABEL = { rare: '살짝', normal: '보통', well: '바싹' };
const SAUCES = ['none', 'ketchup', 'mustard', 'mayo', 'special'];
const SAUCE_LABEL = {
  none: '소스 없음', ketchup: '케첩', mustard: '머스타드',
  mayo: '마요네즈', special: '스페셜 소스'
};

/* 재료를 원하는 양만큼 썰 때 필요한 칼질 횟수 */
const CHOPS_REQUIRED = { little: 2, normal: 4, much: 6 };

/* ────────────────────────────────────────────────────────────
   진상 고객 유형
   ──────────────────────────────────────────────────────────── */
const PERSONAS = [
  {
    id: 'indecisive',
    name: '우유부단형',
    emoji: '😵',
    difficulty: 1,
    tagline: '음... 넣을까요? 아니 빼주세요. 아니 잠깐만요.',
    style: [
      '당신은 결정을 못 내리는 손님입니다.',
      '재료 하나를 말할 때마다 한 번은 번복했다가 다시 원래대로 돌아옵니다.',
      '"음...", "아니 잠깐만요", "그냥 알아서..." 같은 말버릇을 씁니다.',
      '직원이 구체적인 선택지를 제시하면 그제서야 하나를 고릅니다.'
    ].join(' '),
    traits: { vague: true, changes: false, impatient: false }
  },
  {
    id: 'lazy_talker',
    name: '설명 부족형',
    emoji: '🙄',
    difficulty: 2,
    tagline: '제가 항상 먹던 걸로 주세요.',
    style: [
      '당신은 설명을 극도로 아끼는 손님입니다.',
      '"늘 먹던 거", "아까 먹은 거랑 비슷하게", "알아서 잘" 같이 뭉뚱그려 말합니다.',
      '직원이 재료를 콕 집어 물어봐야만 그 재료에 대해서만 짧게 답합니다.',
      '먼저 나서서 정보를 주는 일은 없습니다.'
    ].join(' '),
    traits: { vague: true, changes: false, impatient: false }
  },
  {
    id: 'perfectionist',
    name: '과도한 요구형',
    emoji: '🧐',
    difficulty: 3,
    tagline: '겉은 바삭한데 속은 촉촉했으면 좋겠어요.',
    style: [
      '당신은 요구사항이 지나치게 까다로운 손님입니다.',
      '식감, 온도, 비율 같은 추상적인 조건을 계속 덧붙입니다.',
      '직원이 구체적인 수치나 단계로 바꿔서 확인해 주면 그제서야 수긍합니다.',
      '단, 숨겨진 실제 주문 내용과 모순되는 말은 하지 않습니다.'
    ].join(' '),
    traits: { vague: true, changes: false, impatient: false }
  },
  {
    id: 'mind_changer',
    name: '말 바꾸기형',
    emoji: '🔄',
    difficulty: 4,
    tagline: '주문 확정 직전에 재료를 계속 바꿉니다.',
    style: [
      '당신은 마음이 자주 바뀌는 손님입니다.',
      '대화 중간에 이미 정한 재료를 다른 것으로 바꿔달라고 말합니다.',
      '바꿀 때는 무엇을 어떻게 바꾸는지 분명히 말합니다.',
      '바꾸기 전 내용을 직원이 다시 확인하면 "아 그건 아까 얘기고요" 라고 정정합니다.'
    ].join(' '),
    traits: { vague: false, changes: true, impatient: false }
  },
  {
    id: 'impatient',
    name: '성격 급한 고객',
    emoji: '⏰',
    difficulty: 3,
    tagline: '아직도 주문받아요? 저 바쁜데.',
    style: [
      '당신은 시간에 쫓기는 손님입니다.',
      '문장이 짧고 재촉하는 말이 섞입니다. "빨리요", "그냥 아무거나", "됐고요".',
      '직원이 한 번에 여러 개를 묶어서 물어보면 만족하고 빠르게 답합니다.',
      '하나씩 천천히 물어보면 짜증을 냅니다.'
    ].join(' '),
    traits: { vague: false, changes: false, impatient: true }
  },
  {
    id: 'freebie',
    name: '억지 할인형',
    emoji: '🤑',
    difficulty: 2,
    tagline: '제가 여기 단골인데 서비스 같은 거 없어요?',
    style: [
      '당신은 서비스와 덤을 계속 요구하는 손님입니다.',
      '주문 이야기 중간중간에 단골이라며 추가 재료를 공짜로 얹어달라고 조릅니다.',
      '직원이 정중히 거절하거나 대안을 제시하면 투덜대면서도 넘어갑니다.',
      '단, 숨겨진 실제 주문 내용 자체는 바꾸지 않습니다.'
    ].join(' '),
    traits: { vague: false, changes: false, impatient: false }
  },
  {
    id: 'contradictor',
    name: '모순 화법형',
    emoji: '🤯',
    difficulty: 4,
    tagline: '치즈버거 주세요. 근데 치즈는 빼주세요.',
    style: [
      '당신은 앞뒤가 안 맞는 말을 자연스럽게 하는 손님입니다.',
      '메뉴 이름과 실제 요구가 어긋나게 말합니다.',
      '직원이 모순을 짚어주면 "아 그러니까 제 말은..." 하며 숨겨진 실제 주문 쪽으로 정리해 줍니다.'
    ].join(' '),
    traits: { vague: true, changes: false, impatient: false }
  }
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

/* ────────────────────────────────────────────────────────────
   숨겨진 진짜 주문서 생성
   ──────────────────────────────────────────────────────────── */
function generateTrueOrder(difficulty = 2) {
  const veggies = {};
  for (const v of VEGGIES) {
    if (difficulty <= 1) veggies[v] = Math.random() < 0.4 ? 'none' : 'normal';
    else if (difficulty <= 3) veggies[v] = pick(['none', 'little', 'normal', 'normal', 'much']);
    else veggies[v] = pick(AMOUNTS);
  }
  // 최소 한 가지 채소는 들어가도록 보정
  if (VEGGIES.every((v) => veggies[v] === 'none')) veggies[pick(VEGGIES)] = 'normal';

  const sauceType = difficulty <= 1
    ? pick(['ketchup', 'mayo'])
    : pick(['none', 'ketchup', 'mustard', 'mayo', 'special']);

  return {
    patty: difficulty <= 1 ? 1 : randInt(1, difficulty >= 4 ? 3 : 2),
    cheese: difficulty <= 1 ? randInt(0, 1) : randInt(0, 2),
    bacon: difficulty <= 2 ? 0 : randInt(0, 1),
    egg: difficulty <= 2 ? 0 : randInt(0, 1),
    pattyDoneness: difficulty <= 1 ? 'normal' : pick(['rare', 'normal', 'normal', 'well']),
    bunToasted: Math.random() < 0.75,
    veggies,
    sauce: {
      type: sauceType,
      amount: sauceType === 'none' ? 'none' : pick(['little', 'normal', 'much'])
    }
  };
}

/* 말 바꾸기형이 도중에 주문을 바꿀 때 사용 */
function mutateOrder(order) {
  const next = JSON.parse(JSON.stringify(order));
  const changes = [];
  const kind = pick(['patty', 'cheese', 'veggie', 'sauce', 'doneness']);

  if (kind === 'patty') {
    const before = next.patty;
    next.patty = before >= 3 ? before - 1 : before + 1;
    changes.push('패티 ' + before + '장 → ' + next.patty + '장');
  } else if (kind === 'cheese') {
    const before = next.cheese;
    next.cheese = before >= 2 ? 0 : before + 1;
    changes.push('치즈 ' + before + '장 → ' + next.cheese + '장');
  } else if (kind === 'veggie') {
    const v = pick(VEGGIES);
    const before = next.veggies[v];
    next.veggies[v] = pick(AMOUNTS.filter((a) => a !== before));
    changes.push(INGREDIENTS[v].name + ' ' + AMOUNT_LABEL[before] + ' → ' + AMOUNT_LABEL[next.veggies[v]]);
  } else if (kind === 'sauce') {
    const before = next.sauce.type;
    next.sauce.type = pick(SAUCES.filter((s) => s !== before));
    if (next.sauce.type === 'none') next.sauce.amount = 'none';
    else if (next.sauce.amount === 'none') next.sauce.amount = 'normal';
    changes.push(SAUCE_LABEL[before] + ' → ' + SAUCE_LABEL[next.sauce.type]);
  } else {
    const before = next.pattyDoneness;
    next.pattyDoneness = pick(['rare', 'normal', 'well'].filter((d) => d !== before));
    changes.push('패티 굽기 ' + DONENESS_LABEL[before] + ' → ' + DONENESS_LABEL[next.pattyDoneness]);
  }
  return { order: next, changes };
}

/* 빈 주문서(카운터 주문패드 초기값) */
function emptyOrder() {
  return {
    patty: 1, cheese: 0, bacon: 0, egg: 0,
    pattyDoneness: 'normal', bunToasted: true,
    veggies: { lettuce: 'none', tomato: 'none', onion: 'none', pickle: 'none' },
    sauce: { type: 'none', amount: 'none' }
  };
}

/* 주문서를 사람이 읽는 문장 배열로 */
function describeOrder(o) {
  const lines = [];
  lines.push('빵: ' + (o.bunToasted ? '구움' : '안 구움'));
  lines.push('패티 ' + o.patty + '장 (' + DONENESS_LABEL[o.pattyDoneness] + ' 익힘)');
  if (o.cheese > 0) lines.push('치즈 ' + o.cheese + '장');
  if (o.bacon > 0) lines.push('베이컨 ' + o.bacon + '장');
  if (o.egg > 0) lines.push('계란 ' + o.egg + '개');
  for (const v of VEGGIES) {
    if (o.veggies[v] !== 'none') lines.push(INGREDIENTS[v].name + ' ' + AMOUNT_LABEL[o.veggies[v]]);
  }
  const off = VEGGIES.filter((v) => o.veggies[v] === 'none').map((v) => INGREDIENTS[v].name);
  if (off.length) lines.push('제외: ' + off.join(', '));
  lines.push(o.sauce.type === 'none'
    ? '소스 없음'
    : SAUCE_LABEL[o.sauce.type] + ' ' + AMOUNT_LABEL[o.sauce.amount]);
  return lines;
}

module.exports = {
  INGREDIENTS, VEGGIES, AMOUNTS, AMOUNT_LABEL, DONENESS_LABEL,
  SAUCES, SAUCE_LABEL, CHOPS_REQUIRED, PERSONAS,
  generateTrueOrder, mutateOrder, emptyOrder, describeOrder, pick, randInt
};
