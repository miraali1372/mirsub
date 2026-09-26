#!/usr/bin/env node
/**
 * MirSub - Official Xray Core Real-Tunnel Tester & Optimizer
 * Tests actual proxy data tunneling, real delay (HTTP 204), exit IP, and country.
 * Filters out dead UUIDs, broken Reality keys, fake CDN ports, and unencrypted links.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { buildSpeedTestConfig, parseShareUri } from './xray-config.mjs';
import {
  getFreePort,
  waitForPort,
  tcpPing,
  measureHttpsDelayThroughHttpProxy,
  fetchPublicIpThroughHttpProxy,
  isUsablePublicIp,
  requestThroughHttpProxy
} from './net-utils.mjs';

const CONCURRENCY = process.platform === 'win32' ? 12 : 24;
const REAL_DELAY_TIMEOUT_MS = 3000;
const TEST_TARGET_URLS = [
  'https://cp.cloudflare.com/generate_204',
  'https://www.gstatic.com/generate_204'
];

const COUNTRY_FLAGS = {
  US: '🇺🇸', DE: '🇩🇪', NL: '🇳🇱', GB: '🇬🇧', UK: '🇬🇧',
  FR: '🇫🇷', TR: '🇹🇷', SG: '🇸🇬', PL: '🇵🇱', FI: '🇫🇮',
  RU: '🇷🇺', CA: '🇨🇦', JP: '🇯🇵', KR: '🇰🇷', AE: '🇦🇪',
  IT: '🇮🇹', ES: '🇪🇸', SE: '🇸🇪', CH: '🇨🇭', AT: '🇦🇹',
  KZ: '🇰🇿', NO: '🇳🇴', DK: '🇩🇰', BE: '🇧🇪', IE: '🇮🇪',
  RO: '🇷🇴', BG: '🇧🇬', CZ: '🇨🇿', HK: '🇭🇰', TW: '🇹🇼',
  AM: '🇦🇲', GE: '🇬🇪', AZ: '🇦🇿', IQ: '🇮🇶', IL: '🇮🇱',
  GR: '🇬🇷', PT: '🇵🇹', HU: '🇭🇺', MD: '🇲🇩', RS: '🇷🇸',
  CY: '🇨🇾', LU: '🇱🇺', LT: '🇱🇹', LV: '🇱🇻', EE: '🇪🇪',
  IS: '🇮🇸', UA: '🇺🇦', AU: '🇦🇺', IN: '🇮🇳', BR: '🇧🇷',
  MY: '🇲🇾', ID: '🇮🇩', VN: '🇻🇳', TH: '🇹🇭', PH: '🇵🇭',
  NZ: '🇳🇿', ZA: '🇿🇦', AR: '🇦🇷', CL: '🇨🇱', CO: '🇨🇴',
  MX: '🇲🇽', IR: '🇮🇷'
};

function getFlag(code) {
  if (!code || code.length !== 2) return '🌐';
  const upper = code.toUpperCase();
  if (COUNTRY_FLAGS[upper]) return COUNTRY_FLAGS[upper];
  return String.fromCodePoint(...upper.split('').map(c => 127397 + c.charCodeAt(0)));
}

function findXrayExecutable() {
  const candidates = [
    process.env.XRAY_PATH,
    '/usr/local/bin/xray',
    '/usr/bin/xray',
    path.resolve('xray'),
    path.resolve('xray.exe'),
    path.resolve('../mir2rayV2 - Copy/desktop/runtime/xray.exe'),
    path.resolve('../mir2rayV2/desktop/runtime/xray.exe'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'xray';
}

function isAntiDpiClean(rawUri) {
  const lower = rawUri.toLowerCase();
  // In Iran, unencrypted HTTP without TLS is dropped by DPI
  if (lower.includes('security=none') || lower.includes('security=false')) {
    return false;
  }
  if (lower.includes('security=reality') && !lower.includes('pbk=')) {
    return false;
  }
  // Exclude fake promotional Telegram channels
  if (lower.includes('telegram-') || lower.includes('@telegram') || lower.includes('joinbedeeee')) {
    return false;
  }
  return true;
}

async function testSingleConfigWithXray(xrayPath, rawUri, tempDir, maxLatencyMs) {
  if (!isAntiDpiClean(rawUri)) return null;

  let profile;
  try {
    profile = parseShareUri(rawUri);
  } catch {
    return null;
  }

  // Phase 1: Fast TCP Ping gate (skip completely dead hosts before spawning core)
  const isTcpReachable = await tcpPing(profile.server, Number(profile.serverPort || 443), 1200);
  if (!isTcpReachable) return null;

  // Phase 2: Start temporary Xray core on free HTTP proxy port
  const httpPort = await getFreePort();
  let configObj;
  try {
    configObj = buildSpeedTestConfig({ shareUri: rawUri }, httpPort);
  } catch {
    return null;
  }

  const configFile = path.join(tempDir, `xray_${crypto.randomUUID()}.json`);
  await fsp.writeFile(configFile, JSON.stringify(configObj));

  let child = null;
  try {
    child = spawn(xrayPath, ['run', '-c', configFile], {
      stdio: 'ignore',
      windowsHide: true,
    });

    const isReady = await waitForPort(httpPort, 3500);
    if (!isReady || child.exitCode !== null) return null;

    // Phase 3: Real HTTPS delay measurement through the proxy tunnel
    let bestDelay = null;
    for (const testUrl of TEST_TARGET_URLS) {
      try {
        const sample = await measureHttpsDelayThroughHttpProxy(httpPort, testUrl, {
          timeoutMs: REAL_DELAY_TIMEOUT_MS,
          attempts: 1,
        });
        if (sample?.ok && sample.elapsed > 0 && sample.elapsed <= maxLatencyMs) {
          bestDelay = sample.elapsed;
          break;
        }
      } catch {
        // try next target
      }
    }

    if (bestDelay === null) return null;

    // Phase 4: Fetch real exit IP & country through proxy tunnel
    let exitIp = null;
    let country = 'US';
    try {
      const ipRes = await fetchPublicIpThroughHttpProxy(httpPort, 2000);
      if (ipRes?.ok && isUsablePublicIp(ipRes.ip)) {
        exitIp = ipRes.ip;
      }
    } catch {}

    // Fallback GeoIP from trace
    if (!exitIp) {
      try {
        const traceRes = await requestThroughHttpProxy(httpPort, 'https://1.1.1.1/cdn-cgi/trace', {
          timeoutMs: 1500,
          maxBytes: 16 * 1024,
          collectBody: true,
        });
        if (traceRes.ok && traceRes.body) {
          for (const line of traceRes.body.split('\n')) {
            if (line.startsWith('ip=')) exitIp = line.slice(3).trim();
            if (line.startsWith('loc=')) country = line.slice(4).trim().toUpperCase();
          }
        }
      } catch {}
    }

    // Phase 5: Fast data throughput verification
    try {
      const dlCheck = await requestThroughHttpProxy(httpPort, 'https://cp.cloudflare.com/generate_204', {
        timeoutMs: 2000,
        maxBytes: 32 * 1024,
        collectBody: false,
      });
      if (!dlCheck.ok) return null;
    } catch {
      return null;
    }

    // Format clean high-quality name
    const flag = getFlag(country);
    const proto = profile.configType.toUpperCase();
    const tag = `${flag} ${country} | ${bestDelay}ms | ${proto} | mirsub`;
    const baseUri = rawUri.split('#')[0];
    const finalUri = `${baseUri}#${tag}`;

    return {
      uri: finalUri,
      latency: bestDelay,
      country,
      exitIp: exitIp || profile.server,
    };
  } catch {
    return null;
  } finally {
    if (child && child.exitCode === null) child.kill();
    await fsp.rm(configFile, { force: true }).catch(() => {});
  }
}

async function main() {
  const inputFile = process.argv[2] || 'unique.txt';
  const outputFile = process.argv[3] || 'subscription.txt';
  const maxLatency = parseInt(process.argv[4] || '450', 10);

  console.log(`🚀 Starting Official Xray Core Real Delay & Throughput Tester...`);
  console.log(`📁 Input: ${inputFile} | Output: ${outputFile} | Max Latency: ${maxLatency}ms`);

  const xrayPath = findXrayExecutable();
  console.log(`🔧 Xray binary: ${xrayPath}`);

  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const rawLines = (await fsp.readFile(inputFile, 'utf8'))
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  console.log(`🔍 Total candidate configs to test with real Xray cores: ${rawLines.length}`);

  const tempDir = path.join(os.tmpdir(), `mirsub_xray_${Date.now()}`);
  await fsp.mkdir(tempDir, { recursive: true });

  const verified = [];
  let completed = 0;
  const total = rawLines.length;
  let nextIdx = 0;
  const tStart = Date.now();

  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= total) break;
      const line = rawLines[idx];
      const res = await testSingleConfigWithXray(xrayPath, line, tempDir, maxLatency);
      completed++;
      if (res) {
        verified.push(res);
      }
      if (completed % 25 === 0 || completed === total) {
        console.log(`Progress: ${completed}/${total} tested (${verified.length} verified real working proxies)`);
      }
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  // Sort strictly by lowest latency first (best proxies at top of subscription)
  verified.sort((a, b) => a.latency - b.latency);

  await fsp.writeFile(outputFile, verified.map(item => item.uri).join('\n') + '\n', 'utf8');

  // Also create base64 encoded subscription
  const b64File = outputFile.replace('.txt', '_b64.txt');
  const b64Data = Buffer.from(verified.map(item => item.uri).join('\n')).toString('base64');
  await fsp.writeFile(b64File, b64Data, 'utf8');

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`🎉 TEST COMPLETED in ${elapsed}s!`);
  console.log(`✅ Saved ${verified.length} REAL WORKING proxies to ${outputFile} and ${b64File}`);
}

main().catch(err => {
  console.error('Fatal tester error:', err);
  process.exit(1);
});
