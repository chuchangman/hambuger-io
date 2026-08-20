/* 엔트리 — 네트워크 · 월드 · 플레이어 · UI 를 연결하고 루프를 돈다 */
import { connect, on, S } from './net.js';
import { initWorld, render, syncFromKitchen, updateCustomer, scene, camera, interactables } from './world.js';
import { initPlayer, updatePlayer, resetPose, releaseLock, setLook, state as P } from './player.js';
import { initUI, renderHUD, route, toast } from './ui.js';

let last = performance.now();

function loop() {
  requestAnimationFrame(loop);
  const t = performance.now();
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;

  const playing = S.state && (S.state.phase === 'negotiation' || S.state.phase === 'cooking');
  if (playing) {
    updatePlayer(dt);
    renderHUD();
  }
  render();
}

async function boot() {
  try {
    await connect();
  } catch (err) {
    console.error(err);
    document.body.insertAdjacentHTML('beforeend',
      '<div class="fatal">서버에 연결하지 못했습니다.<br />' + err.message + '</div>');
    return;
  }

  const canvas = document.getElementById('gl');
  initWorld(canvas);
  initPlayer(canvas);
  initUI();

  on('kitchen', syncFromKitchen);
  on('state', updateCustomer);
  on('phase', (phase) => {
    if (phase === 'negotiation') {
      resetPose();
      toast('손님이 왔습니다! E 로 말을 걸어보세요.', 'good');
    } else if (phase === 'cooking') {
      toast('주문 확정! 재료를 모아 버거를 만드세요.', 'good');
    } else if (phase === 'result' || phase === 'lobby') {
      releaseLock();
    }
  });

  // 디버깅/자동 검증용 훅 (프레임을 수동으로 한 번 돌린다)
  window.HB = {
    S, scene, camera, interactables, player: P, setLook,
    step(dt) { updatePlayer(dt || 0.016); renderHUD(); render(); }
  };

  route();
  loop();
}

boot();
