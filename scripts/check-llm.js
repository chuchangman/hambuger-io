#!/usr/bin/env node
'use strict';

/**
 * Gemini API 키/모델 점검.
 *   npm run check:llm
 *
 * 키가 유효한지, 지정한 모델을 쓸 수 있는지 한 번 호출해 보고,
 * 실패하면 원인과 사용 가능한 모델 목록을 보여준다.
 */

require('dotenv').config();
const llm = require('../server/llm');

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

function line() { console.log('─'.repeat(52)); }

(async () => {
  console.log('');
  console.log('  Gemini 연결 점검');
  line();

  if (!KEY) {
    console.log('  ❌ GEMINI_API_KEY 가 없습니다.');
    console.log('');
    console.log('  해결 방법:');
    console.log('   1) 프로젝트 폴더에 .env 파일을 만듭니다.  (cp .env.example .env)');
    console.log('   2) 그 안에 아래 한 줄을 넣습니다.');
    console.log('        GEMINI_API_KEY=여기에_발급받은_키');
    console.log('   3) 다시 `npm run check:llm` 을 실행합니다.');
    console.log('');
    console.log('  ※ 키가 없어도 게임은 오프라인 규칙 기반 손님으로 플레이됩니다.');
    line();
    process.exit(1);
  }

  console.log('  키      : ' + KEY.slice(0, 6) + '…' + KEY.slice(-4) + ' (' + KEY.length + '자)');
  console.log('  모델    : ' + llm.MODEL);
  console.log('  호출 중...');

  const res = await llm.checkKey();

  if (res.ok) {
    console.log('');
    console.log('  ✅ 연결 성공');
    console.log('  응답    : ' + res.reply.replace(/\s+/g, ' ').slice(0, 60));
    console.log('');
    console.log('  이제 `npm start` 로 서버를 켜면 Gemini 손님이 등장합니다.');
    line();
    process.exit(0);
  }

  console.log('');
  console.log('  ❌ 실패: ' + res.reason);
  console.log('');

  if (/API[_ ]?key not valid|API_KEY_INVALID|400/i.test(res.reason)) {
    console.log('  → 키가 잘못되었을 가능성이 큽니다.');
    console.log('    Google AI Studio(aistudio.google.com/apikey)에서 키를 다시 확인하세요.');
    console.log('    앞뒤 공백이나 따옴표가 섞이지 않았는지도 보세요.');
  } else if (/403|PERMISSION|SERVICE_DISABLED/i.test(res.reason)) {
    console.log('  → 키는 있지만 권한이 없습니다.');
    console.log('    해당 Google Cloud 프로젝트에서 Generative Language API 가 켜져 있는지 확인하세요.');
  } else if (/429|RESOURCE_EXHAUSTED|quota/i.test(res.reason)) {
    console.log('  → 무료 할당량을 초과했습니다. 잠시 후 다시 시도하세요.');
  } else if (/404|not found|NOT_FOUND/i.test(res.reason)) {
    console.log('  → 모델 이름이 이 키에서 지원되지 않습니다.');
  }

  try {
    console.log('');
    console.log('  이 키로 쓸 수 있는 모델:');
    const models = await llm.listModels();
    const picks = models.filter((m) => m.startsWith('gemini'));
    (picks.length ? picks : models).slice(0, 12).forEach((m) => console.log('    · ' + m));
    console.log('');
    console.log('  다른 모델을 쓰려면 .env 에 추가하세요:  GEMINI_MODEL=모델이름');
  } catch (err) {
    console.log('    (목록을 가져오지 못했습니다: ' + err.message + ')');
  }

  line();
  process.exit(1);
})().catch((err) => {
  console.error('점검 중 오류:', err);
  process.exit(1);
});
