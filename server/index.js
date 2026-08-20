'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const M = require('./menu');
const G = require('./game');
const llm = require('./llm');
const lan = require('./lan');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public')));
/* three.js 를 node_modules 에서 그대로 서빙 (CDN 불필요) */
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build')));

app.get('/health', (req, res) => res.json({ ok: true, llm: llm.isEnabled() }));

app.get('/config.json', (req, res) => res.json({
  ingredients: M.INGREDIENTS,
  veggies: M.VEGGIES,
  amounts: M.AMOUNTS,
  amountLabel: M.AMOUNT_LABEL,
  donenessLabel: M.DONENESS_LABEL,
  sauces: M.SAUCES,
  sauceLabel: M.SAUCE_LABEL,
  chops: M.CHOPS_REQUIRED,
  grillable: G.GRILLABLE,
  toastable: G.TOASTABLE,
  binItems: G.BIN_ITEMS,
  slots: { grill: G.GRILL_SLOTS, toaster: G.TOASTER_SLOTS, boards: G.CHOP_BOARDS },
  paces: G.PACES,
  defaultPace: G.DEFAULT_PACE,
  layerOrder: G.LAYER_ORDER
}));

/** @type {Map<string, import('./game').Room>} */
const rooms = new Map();
const socketRoom = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const broadcast = (room) => io.to(room.code).emit('state', room.publicState());
const broadcastKitchen = (room) => io.to(room.code).emit('kitchen', room.kitchenState());
const sysMsg = (room, text) => room.chat.push({ role: 'system', text, name: '시스템', ts: Date.now() });

/* ────────────────────────────────────────────────────────────
   고객 발화
   ──────────────────────────────────────────────────────────── */
async function speakCustomer(room, note) {
  if (!room.persona || room.customerBusy) return;
  room.customerBusy = true;
  broadcast(room);
  try {
    const text = await llm.customerReply({
      persona: room.persona,
      trueOrder: room.trueOrder,
      history: room.chat.filter((c) => c.role !== 'system'),
      note
    });
    room.chat.push({ role: 'customer', text, name: room.persona.name, ts: Date.now() });
  } catch (err) {
    console.error('[customer] 실패:', err.message);
    room.chat.push({ role: 'customer', text: '...(손님이 멍하니 쳐다본다)', name: room.persona.name, ts: Date.now() });
  } finally {
    room.customerBusy = false;
    broadcast(room);
  }
}

/* ────────────────────────────────────────────────────────────
   라운드 종료 → 평가
   ──────────────────────────────────────────────────────────── */
async function finishRound(room, timedOut) {
  if (room.phase !== G.PHASE.COOKING) return;
  const result = room.finish(timedOut);
  broadcast(room);
  broadcastKitchen(room);
  io.to(room.code).emit('result', { ...result, pending: true });

  let evaluation = null;
  if (llm.isEnabled()) {
    evaluation = await llm.evaluateBurger({
      persona: room.persona,
      trueOrder: room.trueOrder,
      orderSheet: room.orderSheet,
      builtSummary: result.builtList,
      scores: result.scores,
      patience: result.scores.patience
    });
  }
  if (!evaluation) {
    evaluation = llm.fallbackEvaluate({
      persona: room.persona,
      scores: result.scores,
      diffs: result.diffs.final,
      patience: result.scores.patience
    });
  }
  room.applySatisfaction(evaluation);
  room.chat.push({ role: 'customer', text: evaluation.comment, name: room.persona.name, ts: Date.now() });

  broadcast(room);
  io.to(room.code).emit('result', { ...room.result, pending: false });
}

/* ────────────────────────────────────────────────────────────
   1초 틱: 타이머 · 인내심 · 재촉
   ──────────────────────────────────────────────────────────── */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === G.PHASE.NEGOTIATION) {
      room.patience = Math.max(0, room.patience - (room.persona.traits.impatient ? 0.30 : 0.15));
      io.to(room.code).emit('tick', { phaseEndsAt: room.phaseEndsAt, patience: Math.round(room.patience), now });
      if (now >= room.phaseEndsAt) {
        sysMsg(room, '시간 초과! 현재 주문패드 내용 그대로 주방에 전달됩니다.');
        room.submitOrder(room.orderPad);
        io.to(room.code).emit('toast', { msg: '협상 시간 종료 — 주문이 확정됐습니다!', kind: 'warn' });
        broadcast(room);
        broadcastKitchen(room);
      }
    } else if (room.phase === G.PHASE.COOKING) {
      room.patience = Math.max(0, room.patience - (room.persona.traits.impatient ? 0.45 : 0.25));
      io.to(room.code).emit('tick', { phaseEndsAt: room.phaseEndsAt, patience: Math.round(room.patience), now });

      if (now - room.lastNagAt > 35000 && !room.customerBusy) {
        room.lastNagAt = now;
        speakCustomer(room, '재촉: 음식이 아직 안 나왔습니다. 성격에 맞게 한 문장으로 재촉하세요.');
      }
      if (now >= room.phaseEndsAt) {
        io.to(room.code).emit('toast', { msg: '시간 종료! 만들던 그대로 손님에게 나갑니다.', kind: 'bad' });
        finishRound(room, true);
      }
    }
  }
}, 1000);

/* 위치 스냅샷 브로드캐스트 (10Hz) */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size < 2) continue;
    io.to(room.code).emit('positions', room.posSnapshot());
  }
}, 100);

/* ────────────────────────────────────────────────────────────
   소켓
   ──────────────────────────────────────────────────────────── */
io.on('connection', (socket) => {
  socket.emit('hello', { llm: llm.isEnabled(), id: socket.id });

  const currentRoom = () => {
    const code = socketRoom.get(socket.id);
    return code ? rooms.get(code) : null;
  };

  socket.on('room:create', ({ name }, cb) => {
    const code = makeCode();
    const room = new G.Room(code);
    rooms.set(code, room);
    room.addPlayer(socket.id, name);
    socket.join(code);
    socketRoom.set(socket.id, code);
    cb && cb({ ok: true, code, youId: socket.id });
    broadcast(room);
  });

  socket.on('room:join', ({ code, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase().trim());
    if (!room) return cb && cb({ ok: false, err: '그런 방이 없습니다.' });
    if (room.players.size >= 8) return cb && cb({ ok: false, err: '방이 가득 찼습니다. (최대 8명)' });
    room.addPlayer(socket.id, name);
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    cb && cb({ ok: true, code: room.code, youId: socket.id });
    broadcast(room);
    broadcastKitchen(room);
  });

  socket.on('game:start', ({ difficulty, pace }) => {
    const room = currentRoom();
    if (!room) return;
    if (room.hostId !== socket.id) {
      return socket.emit('toast', { msg: '방장만 시작할 수 있습니다.', kind: 'warn' });
    }
    if (room.phase !== G.PHASE.LOBBY && room.phase !== G.PHASE.RESULT) return;
    room.startRound(Math.max(1, Math.min(4, Number(difficulty) || 2)), pace);
    broadcast(room);
    broadcastKitchen(room);
    speakCustomer(room, null);
  });

  /* 손님과의 대화 — 누구나 가능 */
  socket.on('chat:send', ({ text }) => {
    const room = currentRoom();
    if (!room) return;
    if (room.phase !== G.PHASE.NEGOTIATION && room.phase !== G.PHASE.COOKING) return;
    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;
    if (room.customerBusy) return socket.emit('toast', { msg: '손님이 말하는 중입니다...', kind: 'warn' });

    const me = room.players.get(socket.id);
    room.chat.push({ role: 'staff', text: clean, name: me ? me.name : '직원', ts: Date.now() });

    if (room.phase === G.PHASE.COOKING) {
      room.patience = Math.min(100, room.patience + 8);
      room.lastNagAt = Date.now();
    }
    broadcast(room);

    let note = null;
    const staffTurns = room.chat.filter((c) => c.role === 'staff').length;
    if (room.phase === G.PHASE.NEGOTIATION && room.persona.traits.changes
        && !room.orderMutated && staffTurns >= 3) {
      const mut = M.mutateOrder(room.trueOrder);
      room.trueOrder = mut.order;
      room.orderMutated = true;
      note = '주문 변경: ' + mut.changes.join(', ');
    }
    speakCustomer(room, note);
  });

  /* 주문패드 — 누구나 수정 가능 (공용) */
  socket.on('pad:update', ({ order }) => {
    const room = currentRoom();
    if (!room || room.phase !== G.PHASE.NEGOTIATION || !order) return;
    try {
      const pad = M.emptyOrder();
      pad.patty = Math.max(0, Math.min(4, Number(order.patty) || 0));
      pad.cheese = Math.max(0, Math.min(3, Number(order.cheese) || 0));
      pad.bacon = Math.max(0, Math.min(2, Number(order.bacon) || 0));
      pad.egg = Math.max(0, Math.min(2, Number(order.egg) || 0));
      pad.pattyDoneness = ['rare', 'normal', 'well'].includes(order.pattyDoneness) ? order.pattyDoneness : 'normal';
      pad.bunToasted = !!order.bunToasted;
      for (const v of M.VEGGIES) {
        pad.veggies[v] = M.AMOUNTS.includes(order.veggies && order.veggies[v]) ? order.veggies[v] : 'none';
      }
      const st = order.sauce && M.SAUCES.includes(order.sauce.type) ? order.sauce.type : 'none';
      pad.sauce.type = st;
      pad.sauce.amount = st === 'none' ? 'none'
        : (M.AMOUNTS.includes(order.sauce.amount) && order.sauce.amount !== 'none' ? order.sauce.amount : 'normal');
      room.orderPad = pad;
      broadcast(room);
    } catch (err) {
      console.warn('[pad:update] 잘못된 값', err.message);
    }
  });

  socket.on('pad:draft', async () => {
    const room = currentRoom();
    if (!room || room.phase !== G.PHASE.NEGOTIATION) return;
    if (!llm.isEnabled()) {
      return socket.emit('toast', { msg: 'AI 받아쓰기는 API 키가 있을 때만 동작합니다.', kind: 'warn' });
    }
    socket.emit('toast', { msg: 'AI가 대화를 정리하는 중...', kind: 'info' });
    const draft = await llm.draftOrder({ history: room.chat.filter((c) => c.role !== 'system') });
    if (!draft) return socket.emit('toast', { msg: '받아쓰기에 실패했습니다.', kind: 'bad' });
    room.orderPad = Object.assign(M.emptyOrder(), draft);
    sysMsg(room, 'AI 받아쓰기로 주문패드를 채웠습니다. 반드시 직접 확인하세요!');
    broadcast(room);
  });

  /* 주문 확정 — 누구나 가능 */
  socket.on('order:submit', () => {
    const room = currentRoom();
    if (!room || room.phase !== G.PHASE.NEGOTIATION) return;
    room.submitOrder(room.orderPad);
    sysMsg(room, '주문이 확정되었습니다. 이제 만들면 됩니다!');
    io.to(room.code).emit('toast', { msg: '주문 확정! 조리 시작!', kind: 'good' });
    broadcast(room);
    broadcastKitchen(room);
  });

  /* 주방 액션 — 누구나 가능 */
  socket.on('kitchen:act', ({ action, payload }) => {
    const room = currentRoom();
    if (!room) return;
    const res = room.kitchenAction(socket.id, action, payload || {});
    if (!res.ok) return socket.emit('act:fail', { msg: res.msg });
    if (res.msg) socket.emit('act:ok', { msg: res.msg });
    broadcastKitchen(room);
  });

  socket.on('game:serve', () => {
    const room = currentRoom();
    if (!room || room.phase !== G.PHASE.COOKING) return;
    if (!room.kitchen.plate.length) {
      return socket.emit('act:fail', { msg: '접시가 비어 있습니다.' });
    }
    finishRound(room, false);
  });

  socket.on('game:next', () => {
    const room = currentRoom();
    if (!room || room.hostId !== socket.id) return;
    room.phase = G.PHASE.LOBBY;
    room.resetRound();
    broadcast(room);
    broadcastKitchen(room);
  });

  /* 위치 동기화 */
  socket.on('player:move', (pos) => {
    const room = currentRoom();
    if (room) room.setPos(socket.id, pos);
  });

  socket.on('disconnect', () => {
    const room = currentRoom();
    socketRoom.delete(socket.id);
    if (!room) return;
    room.removePlayer(socket.id);
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    broadcast(room);
    broadcastKitchen(room);
  });
});

const PORT = Number(process.env.PORT) || 3210;
server.listen(PORT, '0.0.0.0', () => {
  lan.printAccess(PORT, {
    llm: llm.isEnabled()
      ? 'Gemini (' + llm.MODEL + ')'
      : '오프라인 손님 (GEMINI_API_KEY 미설정 → npm run check:llm)'
  });
});
