'use strict';

/**
 * LLM 진상 고객 엔진 — Google Gemini (Google AI Studio) 버전.
 *
 * GEMINI_API_KEY 가 있으면 Gemini 로 고객을 연기하고,
 * 없거나 호출이 실패하면 규칙 기반 오프라인 고객으로 자동 대체된다.
 * (API 키 없이도 게임이 항상 플레이 가능하도록)
 *
 * SDK 없이 REST 엔드포인트를 직접 호출한다. Node 18+ 내장 fetch 사용.
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=...
 */

const M = require('./menu');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/**
 * 기본 모델: gemini-flash-lite-latest
 *
 * - 별칭이라 특정 버전이 신규 사용자에게 막혀도 404 로 깨지지 않는다.
 * - 실측 응답 1.3초 내외. (gemini-flash-latest = 3.7-flash 는 16초에 무료 5 RPM 이라
 *   실시간 대화 게임에는 못 쓴다.)
 * 더 똑똑한 손님을 원하면 .env 에 GEMINI_MODEL 을 지정해 바꾸면 된다.
 */
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20000;

let disabledReason = '';

function isEnabled() { return !!API_KEY; }

/* ────────────────────────────────────────────────────────────
   Gemini 호출 (공통)
   ──────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 생각(thinking) 설정 모드.
 * 모델 세대마다 필드 이름이 달라서(3.x=thinkingLevel, 2.5=thinkingBudget)
 * 처음 한 번 순서대로 시도해 보고 통하는 것을 기억한다.
 */
let thinkingMode = null;                       // 'level' | 'budget' | 'none'
const THINKING_TRIES = ['level', 'budget', 'none'];

function withThinking(body, mode) {
  const g = body.generationConfig;
  delete g.thinkingConfig;
  if (mode === 'level') g.thinkingConfig = { thinkingLevel: 'low' };
  else if (mode === 'budget') g.thinkingConfig = { thinkingBudget: 0 };
  return body;
}

async function callOnce(body, timeoutMs) {
  const url = API_BASE + '/models/' + encodeURIComponent(MODEL) +
    ':generateContent?key=' + encodeURIComponent(API_KEY);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    const e = new Error(err.name === 'AbortError' ? ('응답 시간 초과(' + timeoutMs + 'ms)') : err.message);
    e.status = 0;                              // 네트워크/타임아웃 → 재시도 대상
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try { msg = JSON.parse(raw).error.message; } catch (e) { /* 원문 사용 */ }
    const e = new Error('Gemini ' + res.status + ': ' + msg);
    e.status = res.status;
    throw e;
  }

  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error('응답 JSON 파싱 실패'); }

  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const block = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(block ? ('요청이 차단됨(' + block + ')') : '응답 후보 없음');
  }
  if (cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') {
    throw new Error('생성 중단(' + cand.finishReason + ')');
  }

  const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('빈 응답');
  return text;
}

/**
 * 일시적 오류(과부하·네트워크)면 잠깐 쉬고 다시 시도한다.
 * 429(할당량 초과)는 제외 — 구글이 보통 몇 초 뒤 재시도를 요구하는데,
 * 실시간 대화 중에 그만큼 기다리느니 바로 오프라인 손님으로 넘기는 편이 낫다.
 */
const isTransient = (err) => err.status === 0 || err.status >= 500;

async function generate({ system, contents, json, maxOutputTokens, temperature, fast }) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY 없음');

  const body = {
    contents,
    generationConfig: {
      temperature: temperature === undefined ? 1.0 : temperature,
      maxOutputTokens: maxOutputTokens || 2048
    }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig.responseMimeType = 'application/json';

  // 대화는 응답 속도가 중요하므로 생각을 줄인다. 채점/받아쓰기는 기본값 사용.
  const modes = fast ? (thinkingMode ? [thinkingMode] : THINKING_TRIES) : ['none'];
  const timeout = fast ? Math.min(TIMEOUT_MS, 15000) : TIMEOUT_MS;
  let lastErr;

  for (const mode of modes) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const text = await callOnce(withThinking(body, mode), timeout);
        if (fast) thinkingMode = mode;         // 통하는 모드를 기억
        return text;
      } catch (err) {
        lastErr = err;
        // 이 모델이 해당 thinking 필드를 모르면 다음 모드로
        if (err.status === 400 && /thinking/i.test(err.message)) break;
        if (!isTransient(err) || attempt === 2) throw err;
        await sleep(700 * (attempt + 1));      // 0.7s → 1.4s
      }
    }
  }
  throw lastErr;
}

/** 코드펜스로 감싸 오는 경우까지 감안한 JSON 파서 */
function parseJson(text) {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

/* ────────────────────────────────────────────────────────────
   대화 기록 → Gemini contents
   Gemini 는 user / model 이 번갈아 나오는 것을 기대한다.
   손님 = model, 직원 = user 로 매핑하고, 같은 역할이 연달아 오면 합친다.
   ──────────────────────────────────────────────────────────── */
function toContents(history, note) {
  const items = [{ role: 'user', text: '(직원이 당신을 맞이합니다. 손님으로서 먼저 말을 거세요.)' }];
  for (const h of history) {
    items.push({ role: h.role === 'customer' ? 'model' : 'user', text: h.text });
  }
  if (note) items.push({ role: 'user', text: '[연출 지시] ' + note });
  if (items[items.length - 1].role === 'model') {
    items.push({ role: 'user', text: '(계속 이어서 손님으로서 한 마디 하세요.)' });
  }

  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && last.role === it.role) last.parts[0].text += '\n' + it.text;
    else merged.push({ role: it.role, parts: [{ text: it.text }] });
  }
  return merged;
}

function customerSystemPrompt(persona, trueOrder) {
  return [
    '당신은 햄버거 가게에 온 손님을 연기합니다. 한국어로만 말합니다.',
    '',
    '# 당신의 성격',
    persona.name + ': ' + persona.style,
    '',
    '# 당신이 진짜로 원하는 것 (절대 한 번에 전부 말하지 마세요)',
    M.describeOrder(trueOrder).map((l) => '- ' + l).join('\n'),
    '',
    '# 대화 규칙',
    '- 당신은 손님이고, 상대는 가게 직원입니다.',
    '- 한 번에 1~3문장으로만 말합니다. 길게 말하지 마세요.',
    '- 위 주문 내용을 목록처럼 정리해서 읊지 마세요. 성격에 맞게 흘리듯 말합니다.',
    '- 직원이 특정 재료를 콕 집어 물으면, 그 재료에 대해서는 위 내용과 일치하게 답합니다.',
    '- 직원이 묻지 않은 재료는 먼저 말하지 않습니다.',
    '- 위 내용과 모순되는 최종 답을 하지 마세요.',
    '- 메타 발언 금지. JSON, 목록, 시스템 설명, 괄호 지문 없이 오직 손님의 대사만 출력합니다.',
    '- 직원이 주문을 정리해서 확인해 주면 맞는지 틀리는지 반응해 줍니다.'
  ].join('\n');
}

/* ────────────────────────────────────────────────────────────
   1) 고객 대사
   ──────────────────────────────────────────────────────────── */
async function customerReply({ persona, trueOrder, history, note }) {
  if (!API_KEY) return fallbackReply({ persona, trueOrder, history, note });
  try {
    const text = await generate({
      system: customerSystemPrompt(persona, trueOrder),
      contents: toContents(history, note),
      maxOutputTokens: 1024,
      temperature: 1.1,
      fast: true
    });
    // 혹시 따옴표로 감싸 오면 벗긴다
    return text.replace(/^["'「『]|["'」』]$/g, '').trim();
  } catch (err) {
    console.warn('[gemini] customerReply 실패 → 오프라인 응답 사용:', err.message);
    return fallbackReply({ persona, trueOrder, history, note });
  }
}

/* ────────────────────────────────────────────────────────────
   2) 대화 기록 → 주문서 초안 (AI 받아쓰기)
   ──────────────────────────────────────────────────────────── */
const ORDER_SHAPE = [
  '{',
  '  "patty": 0~4 정수,',
  '  "cheese": 0~3 정수,',
  '  "bacon": 0~2 정수,',
  '  "egg": 0~2 정수,',
  '  "pattyDoneness": "rare" | "normal" | "well",',
  '  "bunToasted": true | false,',
  '  "veggies": {',
  '    "lettuce": "none"|"little"|"normal"|"much",',
  '    "tomato":  "none"|"little"|"normal"|"much",',
  '    "onion":   "none"|"little"|"normal"|"much",',
  '    "pickle":  "none"|"little"|"normal"|"much"',
  '  },',
  '  "sauce": {',
  '    "type": "none"|"ketchup"|"mustard"|"mayo"|"special",',
  '    "amount": "none"|"little"|"normal"|"much"',
  '  }',
  '}'
].join('\n');

async function draftOrder({ history }) {
  if (!API_KEY) return null;
  const transcript = history
    .map((h) => (h.role === 'customer' ? '손님: ' : '직원: ') + h.text)
    .join('\n');

  try {
    const text = await generate({
      system: [
        '당신은 햄버거 가게의 주문 받아쓰기 도우미입니다.',
        '아래 대화에서 직원이 실제로 파악한 주문 내용을 주문서 JSON 으로 옮겨 적으세요.',
        '',
        '규칙:',
        '- 대화에서 언급되지 않은 항목은 기본값을 씁니다. (수량 0, 채소 none, 소스 none, 굽기 normal, 빵 구움 true)',
        '- 손님이 중간에 말을 바꿨다면 가장 마지막 발언을 따릅니다.',
        '- 추측해서 채워 넣지 마세요. 대화에 근거가 없으면 기본값입니다.',
        '- 오직 아래 형식의 JSON 만 출력합니다. 설명이나 코드펜스를 붙이지 마세요.',
        '',
        ORDER_SHAPE
      ].join('\n'),
      contents: [{ role: 'user', parts: [{ text: '# 대화 기록\n' + transcript }] }],
      json: true,
      maxOutputTokens: 4096,
      temperature: 0.2
    });
    return normalizeOrder(parseJson(text));
  } catch (err) {
    console.warn('[gemini] draftOrder 실패:', err.message);
    return null;
  }
}

/** LLM 이 준 주문서를 게임이 쓰는 형태로 강제 정규화 */
function normalizeOrder(raw) {
  const o = M.emptyOrder();
  if (!raw || typeof raw !== 'object') return o;
  const int = (v, max) => Math.max(0, Math.min(max, parseInt(v, 10) || 0));
  o.patty = int(raw.patty, 4);
  o.cheese = int(raw.cheese, 3);
  o.bacon = int(raw.bacon, 2);
  o.egg = int(raw.egg, 2);
  o.pattyDoneness = ['rare', 'normal', 'well'].includes(raw.pattyDoneness) ? raw.pattyDoneness : 'normal';
  o.bunToasted = raw.bunToasted !== false;
  const v = raw.veggies || {};
  for (const key of M.VEGGIES) o.veggies[key] = M.AMOUNTS.includes(v[key]) ? v[key] : 'none';
  const s = raw.sauce || {};
  o.sauce.type = M.SAUCES.includes(s.type) ? s.type : 'none';
  o.sauce.amount = o.sauce.type === 'none' ? 'none'
    : (M.AMOUNTS.includes(s.amount) && s.amount !== 'none' ? s.amount : 'normal');
  return o;
}

/* ────────────────────────────────────────────────────────────
   3) 완성된 버거 평가
   ──────────────────────────────────────────────────────────── */
async function evaluateBurger({ persona, trueOrder, orderSheet, builtSummary, scores, patience }) {
  if (!API_KEY) return null;
  try {
    const text = await generate({
      system: [
        '당신은 햄버거 가게 손님입니다. 방금 주문한 버거를 받았습니다. 한국어로만 말합니다.',
        '성격: ' + persona.name + ' — ' + persona.style,
        '',
        '아래 정보를 보고 손님으로서 만족도를 매기고 반응을 남기세요.',
        '- 당신이 진짜 원했던 것과 실제 나온 버거의 차이가 만족도의 핵심입니다.',
        '- 조리 상태와 대기 시간도 반영합니다.',
        '- comment 는 캐릭터를 유지한 한두 문장의 대사입니다. 목록이나 설명이 아닙니다.',
        '- 오직 아래 형식의 JSON 만 출력합니다.',
        '',
        '{',
        '  "satisfaction": 0~100 정수,',
        '  "comment": "손님의 대사 한두 문장",',
        '  "complaints": ["불만 (최대 3개, 각 20자 이내)"],',
        '  "compliments": ["칭찬 (최대 2개, 각 20자 이내)"]',
        '}'
      ].join('\n'),
      contents: [{
        role: 'user',
        parts: [{
          text: [
            '# 내가 진짜 원했던 것',
            M.describeOrder(trueOrder).map((l) => '- ' + l).join('\n'),
            '',
            '# 직원이 적어서 주방에 넘긴 주문서',
            M.describeOrder(orderSheet).map((l) => '- ' + l).join('\n'),
            '',
            '# 실제로 나온 버거 (아래→위 순서)',
            builtSummary.length ? builtSummary.map((l, i) => (i + 1) + '. ' + l).join('\n') : '- (아무것도 없음)',
            '',
            '# 참고 수치',
            '- 최종 정확도(내가 원한 것 대비): ' + scores.finalAccuracy + '점',
            '- 쌓은 순서 정확도: ' + scores.stackOrder + '점',
            '- 조리 상태: ' + scores.cook + '점',
            '- 제작 시간 점수: ' + scores.time + '점',
            '- 내 인내심 잔량: ' + patience + '%'
          ].join('\n')
        }]
      }],
      json: true,
      maxOutputTokens: 4096,
      temperature: 0.9
    });

    const d = parseJson(text);
    return {
      satisfaction: Math.max(0, Math.min(100, parseInt(d.satisfaction, 10) || 0)),
      comment: String(d.comment || '').slice(0, 200) || '음... 뭐 그럭저럭이네요.',
      complaints: Array.isArray(d.complaints) ? d.complaints.slice(0, 3).map((x) => String(x).slice(0, 30)) : [],
      compliments: Array.isArray(d.compliments) ? d.compliments.slice(0, 2).map((x) => String(x).slice(0, 30)) : []
    };
  } catch (err) {
    console.warn('[gemini] evaluateBurger 실패:', err.message);
    return null;
  }
}

/* ────────────────────────────────────────────────────────────
   키/모델 점검 (npm run check:llm)
   ──────────────────────────────────────────────────────────── */
async function checkKey() {
  if (!API_KEY) {
    return { ok: false, reason: 'GEMINI_API_KEY 가 설정되지 않았습니다.' };
  }
  try {
    const text = await generate({
      system: '한국어로만 답합니다.',
      contents: [{ role: 'user', parts: [{ text: '연결 확인용입니다. "연결 성공" 이라고만 답하세요.' }] }],
      maxOutputTokens: 512,
      temperature: 0
    });
    return { ok: true, model: MODEL, reply: text };
  } catch (err) {
    return { ok: false, reason: err.message, model: MODEL };
  }
}

/** 사용 가능한 모델 목록 (모델명이 틀렸을 때 안내용). 페이지네이션까지 따라간다. */
async function listModels() {
  if (!API_KEY) return [];
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const url = API_BASE + '/models?pageSize=200&key=' + encodeURIComponent(API_KEY) +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url);
    if (!res.ok) {
      const raw = await res.text();
      let msg = raw.slice(0, 160);
      try { msg = JSON.parse(raw).error.message; } catch (e) { /* 원문 사용 */ }
      throw new Error(res.status + ' — ' + msg);
    }
    const data = await res.json();
    for (const m of data.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) {
        out.push(String(m.name).replace(/^models\//, ''));
      }
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

/* ════════════════════════════════════════════════════════════
   오프라인(규칙 기반) 고객 — API 키가 없을 때
   ════════════════════════════════════════════════════════════ */

const SYNONYMS = {
  patty:   ['패티', '고기', '미트', '소고기'],
  cheese:  ['치즈'],
  bacon:   ['베이컨'],
  egg:     ['계란', '달걀', '에그'],
  lettuce: ['양상추', '상추', '야채', '채소'],
  tomato:  ['토마토'],
  onion:   ['양파'],
  pickle:  ['피클', '오이'],
  sauce:   ['소스', '케첩', '케찹', '머스타드', '마요', '마요네즈', '스페셜'],
  bun:     ['빵', '번', '토스트', '구워', '구운'],
  doneness:['굽기', '익힘', '익혀', '바싹', '레어', '미디움', '미디엄', '살짝']
};

const OPENERS = {
  indecisive:   ['음... 버거 하나 주세요. 아 근데 잠깐만요, 뭐가 들어가죠?', '저기요, 하나 주문할게요. 음... 어떻게 하지.'],
  lazy_talker:  ['늘 먹던 걸로 주세요.', '아까 먹은 거랑 비슷하게 해주세요.'],
  perfectionist:['버거 하나요. 겉은 바삭한데 속은 촉촉해야 해요.', '하나 주시는데요, 균형이 중요해요. 아시죠?'],
  mind_changer: ['버거 하나 주세요. 아, 일단 그렇게 해주세요.', '하나 주문할게요. 마음이 좀 바뀔 수도 있어요.'],
  impatient:    ['빨리 하나 주세요. 저 시간 없어요.', '버거 하나요. 빨리요.'],
  freebie:      ['버거 하나요. 근데 제가 여기 단골인데 서비스 없어요?', '하나 주세요. 단골한테 뭐 얹어주는 거 없나요?'],
  contradictor: ['치즈버거 주세요. 근데 치즈는 별로예요.', '야채 듬뿍 넣어주세요. 아 근데 양상추는 빼고요.']
};

const NUDGES = {
  indecisive:   ['음... 그건 좀 고민되네요. 어떻게 하는 게 나을까요?', '아 잠깐만요, 다시 생각해볼게요.'],
  lazy_talker:  ['그냥 알아서 잘 해주세요.', '아 그런 거 잘 몰라요. 늘 먹던 거로요.'],
  perfectionist:['그러니까 너무 과하지 않게요. 아시죠?', '적당한 게 중요해요. 딱 좋게요.'],
  mind_changer: ['아 그건 아까 얘기고요, 다시 생각해볼게요.', '음, 방금 말한 건 좀 바꿀 수도 있어요.'],
  impatient:    ['그런 거 하나하나 물어보실 거예요? 빨리요.', '아 됐고요, 그냥 빨리 주세요.'],
  freebie:      ['그건 그렇고 서비스는요? 단골인데.', '뭐 하나 얹어주시면 안 돼요?'],
  contradictor: ['그러니까 제 말은... 아 아무튼요.', '음? 제가 그렇게 말했나요?']
};

const NAGS = {
  indecisive:   ['저기... 혹시 제가 말한 거 맞게 들어갔나요?', '음... 오래 걸리나요?'],
  lazy_talker:  ['아직인가요.', '언제 나와요?'],
  perfectionist:['식으면 안 되는데요. 온도 신경 써주세요.', '너무 오래 두면 눅눅해져요.'],
  mind_changer: ['아 맞다, 혹시 아직 안 만들었으면요...', '지금 바꿔도 되나요? 아 됐어요.'],
  impatient:    ['아직도예요? 저 진짜 바쁜데요.', '얼마나 더 걸려요? 빨리 좀요!'],
  freebie:      ['오래 걸리는 김에 감자 하나 서비스 안 돼요?', '기다리는 값은 해주셔야죠.'],
  contradictor: ['빨리 주세요. 아 천천히 해도 돼요.', '급한 건 아닌데 빨리요.']
};

function detect(text) {
  const found = [];
  for (const key of Object.keys(SYNONYMS)) {
    if (SYNONYMS[key].some((w) => text.includes(w))) found.push(key);
  }
  return found;
}

function countPhrase(name, n) {
  if (n === 0) return name + '는 빼주세요';
  if (n === 1) return name + '는 한 장만요';
  return name + ' ' + n + '장이요';
}

function answerFor(key, o) {
  switch (key) {
    case 'patty':  return o.patty === 1 ? '패티는 한 장이면 돼요' : '패티는 ' + o.patty + '장이요';
    case 'cheese': return countPhrase('치즈', o.cheese);
    case 'bacon':  return o.bacon === 0 ? '베이컨은 됐어요' : '베이컨은 넣어주세요';
    case 'egg':    return o.egg === 0 ? '계란은 안 넣어도 돼요' : '계란도 하나 올려주세요';
    case 'bun':    return o.bunToasted ? '빵은 살짝 구워주세요' : '빵은 안 구워도 돼요';
    case 'doneness': {
      const d = { rare: '살짝만 익혀주세요', normal: '보통으로요', well: '바싹 익혀주세요' };
      return '고기는 ' + d[o.pattyDoneness];
    }
    case 'sauce':
      return o.sauce.type === 'none'
        ? '소스는 빼주세요'
        : M.SAUCE_LABEL[o.sauce.type] + ' ' + M.AMOUNT_LABEL[o.sauce.amount] + '요';
    default: {
      if (M.VEGGIES.includes(key)) {
        const amt = o.veggies[key];
        const nm = M.INGREDIENTS[key].name;
        if (amt === 'none') return nm + '는 빼주세요';
        if (amt === 'little') return nm + '는 조금만요';
        if (amt === 'much') return nm + '는 많이 넣어주세요';
        return nm + '는 보통으로요';
      }
      return null;
    }
  }
}

function fallbackReply({ persona, trueOrder, history, note }) {
  const pid = persona.id;
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];

  if (note && note.indexOf('주문 변경') === 0) {
    return rnd(['아 잠깐만요! ', '아 죄송한데요, ']) + note.replace('주문 변경: ', '') + '으로 바꿔주세요.';
  }
  if (note && note.indexOf('재촉') === 0) return rnd(NAGS[pid] || NAGS.impatient);
  if (!history.length) return rnd(OPENERS[pid] || OPENERS.lazy_talker);

  const last = history[history.length - 1];
  const text = last && last.role === 'staff' ? last.text : '';
  const keys = detect(text);

  if (!keys.length) {
    if (/맞|확인|이렇게|정리|이대로/.test(text)) {
      return rnd(['네 그렇게 해주세요.', '음... 네, 그 정도면 됐어요.', '그렇게 주세요.']);
    }
    return rnd(NUDGES[pid] || NUDGES.lazy_talker);
  }

  const answers = keys.slice(0, 2).map((k) => answerFor(k, trueOrder)).filter(Boolean);
  if (!answers.length) return rnd(NUDGES[pid] || NUDGES.lazy_talker);

  let out = answers.join('. ') + '.';
  if (pid === 'indecisive' && Math.random() < 0.5) out = '음... ' + out + ' 아 잠깐, 그게 맞나? 네 그렇게요.';
  if (pid === 'impatient') out += ' 빨리요.';
  if (pid === 'freebie' && Math.random() < 0.4) out += ' 아 그리고 서비스 하나만요.';
  if (pid === 'perfectionist' && Math.random() < 0.5) out += ' 그게 딱 좋아요.';
  return out;
}

function fallbackEvaluate({ persona, scores, diffs, patience }) {
  const base = Math.round(
    scores.finalAccuracy * 0.5 + scores.stackOrder * 0.1 +
    scores.cook * 0.2 + scores.time * 0.05 + patience * 0.15
  );
  const satisfaction = Math.max(0, Math.min(100, base));
  let comment;
  if (satisfaction >= 85) comment = '오, 이거예요 이거. 딱 제가 원하던 거네요.';
  else if (satisfaction >= 65) comment = '음... 뭐 그럭저럭 먹을 만하네요.';
  else if (satisfaction >= 40) comment = '이게 제가 시킨 거 맞아요? 좀 다른 것 같은데요.';
  else comment = '저기요, 이건 제가 주문한 게 아닌데요. 다시 해주세요.';
  if (persona.id === 'impatient' && scores.time < 50) comment = '아니 이걸 이제 주면 어떡해요. 저 늦었잖아요.';
  if (persona.id === 'freebie') comment += ' 근데 서비스는 진짜 없어요?';
  return {
    satisfaction,
    comment,
    complaints: diffs.slice(0, 3),
    compliments: satisfaction >= 70 ? ['그래도 빨리 나왔네요'] : []
  };
}

module.exports = {
  isEnabled, customerReply, draftOrder, evaluateBurger,
  fallbackEvaluate, checkKey, listModels, MODEL, normalizeOrder
};
