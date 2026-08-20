'use strict';

const os = require('os');

/** 같은 네트워크에서 접속 가능한 주소들 (IPv4 사설망 우선) */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.internal) continue;
      out.push({ name, address: net.address, priority: rank(name, net.address) });
    }
  }
  // 가상 어댑터(VirtualBox/WSL/Docker)는 뒤로 밀어 실제 랜/와이파이가 위에 오게
  out.sort((a, b) => a.priority - b.priority);
  return out;
}

function rank(name, addr) {
  const n = name.toLowerCase();
  // Hyper-V / WSL / VM 가상 어댑터는 팀원이 접속할 수 없으므로 뒤로
  if (/vethernet|default switch|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier|host-only/.test(n)) return 90;
  if (/^169\.254\./.test(addr)) return 95;              // 자동 사설 주소(연결 안 됨)
  if (/wi-?fi|wlan|무선/.test(n)) return 10;
  if (/ethernet|이더넷|eth/.test(n)) return 20;
  return 50;
}

function lanUrls(port) {
  return lanAddresses().map((a) => ({ ...a, url: 'http://' + a.address + ':' + port }));
}

/** 터미널에 접속 안내 출력 */
function printAccess(port, opts) {
  const o = opts || {};
  const urls = lanUrls(port);
  const line = '  ' + '─'.repeat(52);

  console.log('');
  console.log('  🍔 진상 고객 햄버거 가게 (3D)');
  console.log(line);
  console.log('  내 PC          http://localhost:' + port);
  if (urls.length) {
    console.log('');
    console.log('  📡 팀원에게 이 주소를 보내세요 (같은 Wi-Fi / 같은 공유기)');
    urls.forEach((u, i) => {
      const tag = i === 0 ? '  ➜ ' : '    ';
      console.log(tag + u.url.padEnd(26) + '(' + u.name + ')');
    });
  } else {
    console.log('  (외부 네트워크 주소를 찾지 못했습니다 — 유선/와이파이 연결 확인)');
  }
  if (o.llm) console.log('\n  LLM            ' + o.llm);
  console.log(line);
  if (urls.length) {
    console.log('  ⚠️  팀원이 못 들어오면 방화벽입니다. 관리자 PowerShell 에서 한 번만:');
    console.log('     netsh advfirewall firewall add rule name="Burger ' + port + '" ' +
      'dir=in action=allow protocol=TCP localport=' + port);
    console.log('  🌍 다른 네트워크에 있는 팀원까지 부르려면:  npm run share');
    console.log(line);
  }
  console.log('');
}

module.exports = { lanAddresses, lanUrls, printAccess };
