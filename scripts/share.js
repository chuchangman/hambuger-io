#!/usr/bin/env node
'use strict';

/**
 * 한 명령으로 서버 + 공개 주소를 띄운다.
 *   npm run share
 *
 * 같은 Wi-Fi 면 `npm start` 만으로 충분하다. 이건 팀원이 다른 네트워크에 있을 때 쓴다.
 * Cloudflare 임시 터널(trycloudflare.com)을 쓰며 계정·로그인이 필요 없다.
 */

require('dotenv').config();
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');
const lan = require('../server/lan');

const PORT = Number(process.env.PORT) || 3210;
const ROOT = path.join(__dirname, '..');
const line = '  ' + '─'.repeat(52);

let serverProc = null;
let tunnelProc = null;

function bye(code) {
  if (tunnelProc) { try { tunnelProc.kill(); } catch (e) { /* 이미 종료 */ } }
  if (serverProc) { try { serverProc.kill(); } catch (e) { /* 이미 종료 */ } }
  process.exit(code || 0);
}
process.on('SIGINT', () => bye(0));
process.on('SIGTERM', () => bye(0));

/* 이미 서버가 떠 있으면 그걸 쓰고, 아니면 새로 띄운다 */
function isUp() {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1200 },
      (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

async function waitUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * cloudflared 실행 방법 결정.
 * 설치본이 있으면 그걸 쓰고, 없으면 npx 로 시도한다.
 * (npx 는 첫 실행 때 바이너리를 내려받느라 오래 걸리므로 미리 떠보지 않고 바로 실행)
 */
function findCloudflared() {
  const r = spawnSync('cloudflared', ['--version'], {
    encoding: 'utf8', timeout: 4000, shell: process.platform === 'win32'
  });
  if (r.status === 0) return { cmd: 'cloudflared', pre: [], installed: true };
  return { cmd: 'npx', pre: ['--yes', 'cloudflared'], installed: false };
}

function helpNoTunnel() {
  console.log('');
  console.log('  ⚠️  cloudflared 를 찾지 못해 공개 주소를 만들지 못했습니다.');
  console.log('');
  console.log('  같은 Wi-Fi 라면 아래 주소로 이미 접속 가능합니다:');
  lan.lanUrls(PORT).slice(0, 2).forEach((u) => console.log('     ' + u.url));
  console.log('');
  console.log('  다른 네트워크 팀원까지 부르려면 한 번만 설치하세요:');
  console.log('     winget install --id Cloudflare.cloudflared      (Windows)');
  console.log('     brew install cloudflared                        (macOS)');
  console.log('  설치 후 다시:  npm run share');
  console.log(line);
}

(async () => {
  // 1) 서버 확보
  if (await isUp()) {
    console.log('\n  기존 서버를 사용합니다 (포트 ' + PORT + ')');
  } else {
    console.log('\n  서버를 시작합니다...');
    serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT, stdio: 'inherit', env: process.env
    });
    serverProc.on('exit', (c) => { if (c) bye(c); });
    if (!await waitUp(15000)) {
      console.error('  서버가 뜨지 않았습니다.');
      bye(1);
    }
  }

  // 2) 터널
  const cf = findCloudflared();
  console.log(cf.installed
    ? '  공개 주소를 만드는 중... (10초 정도 걸립니다)'
    : '  cloudflared 를 내려받아 실행합니다... (처음 한 번은 1~2분 걸릴 수 있습니다)');
  tunnelProc = spawn(cf.cmd, cf.pre.concat(['tunnel', '--url', 'http://localhost:' + PORT]), {
    cwd: ROOT, shell: process.platform === 'win32'
  });

  let shown = false;
  const scan = (buf) => {
    const s = buf.toString();
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !shown) {
      shown = true;
      const url = m[0];
      console.log('');
      console.log(line);
      console.log('  🌍 팀원에게 이 주소를 보내세요 (어느 네트워크든 접속 가능)');
      console.log('');
      console.log('     ' + url);
      console.log('');
      console.log('  · 이 창을 닫으면 주소도 사라집니다. 게임하는 동안 켜두세요.');
      console.log('  · 같은 Wi-Fi 팀원은 아래가 더 빠릅니다:');
      lan.lanUrls(PORT).slice(0, 1).forEach((u) => console.log('       ' + u.url));
      console.log(line);
      console.log('');
    }
  };
  tunnelProc.stdout.on('data', scan);
  tunnelProc.stderr.on('data', scan);      // cloudflared 는 주소를 stderr 로 낸다
  tunnelProc.on('error', () => { if (!shown) helpNoTunnel(); });
  tunnelProc.on('exit', () => { if (!shown) helpNoTunnel(); });

  // 너무 오래 걸리면 LAN 안내로 넘어간다 (게임은 이미 돌고 있으므로)
  setTimeout(() => {
    if (!shown) {
      console.log('\n  공개 주소 생성이 지연되고 있습니다. 계속 기다려도 되고,');
      console.log('  같은 Wi-Fi 팀원은 지금 바로 아래로 들어올 수 있습니다:');
      lan.lanUrls(PORT).slice(0, 1).forEach((u) => console.log('     ' + u.url));
      console.log('');
    }
  }, 45000);
})();
