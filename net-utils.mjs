import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(250);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return false;
}

export async function tcpPing(host, port = 443, timeoutMs = 1000) {
  return new Promise(resolve => {
    // Keep DNS setup outside the TCP metric. Node still resolves the hostname normally (including
    // family selection), but the latency clock starts only when lookup has completed.
    let resolvedIp = net.isIP(host) ? host : null;
    let started = net.isIP(host) ? performance.now() : null;
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      const latency = ok
        ? Math.max(0, Math.round(performance.now() - (started ?? performance.now())))
        : -1;
      socket.destroy();
      const res = { latency, ok };
      if (ok && resolvedIp) res.ip = resolvedIp;
      resolve(res);
    };
    socket.setTimeout(Math.max(50, Number(timeoutMs) || 1000));
    socket.once('lookup', (err, address) => {
      if (!err && address) resolvedIp = address;
      started = performance.now();
    });
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function buildDnsQuery(domain, id) {
  const labels = String(domain).split('.').filter(Boolean);
  const size = 12 + labels.reduce((sum, label) => sum + 1 + Buffer.byteLength(label), 0) + 1 + 4;
  const packet = Buffer.alloc(size);
  packet.writeUInt16BE(id, 0);
  packet.writeUInt16BE(0x0100, 2);
  packet.writeUInt16BE(1, 4);
  let offset = 12;
  for (const label of labels) {
    const bytes = Buffer.from(label, 'ascii');
    packet[offset++] = bytes.length;
    bytes.copy(packet, offset);
    offset += bytes.length;
  }
  packet[offset++] = 0;
  packet.writeUInt16BE(1, offset);
  packet.writeUInt16BE(1, offset + 2);
  return packet;
}

function skipDnsName(packet, offset) {
  while (offset < packet.length) {
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) return offset + 2;
    offset += 1;
    if (length === 0) return offset;
    offset += length;
  }
  throw new Error('Malformed DNS response');
}

function firstIpv4Answer(packet) {
  const questions = packet.readUInt16BE(4);
  const answers = packet.readUInt16BE(6);
  let offset = 12;
  for (let i = 0; i < questions; i += 1) offset = skipDnsName(packet, offset) + 4;
  for (let i = 0; i < answers; i += 1) {
    offset = skipDnsName(packet, offset);
    if (offset + 10 > packet.length) break;
    const type = packet.readUInt16BE(offset);
    const dataLength = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (type === 1 && dataLength === 4 && offset + 4 <= packet.length) {
      return [...packet.subarray(offset, offset + 4)].join('.');
    }
    offset += dataLength;
  }
  return '';
}

export async function resolveWithDns(dnsIp, domain, timeoutMs = 2500) {
  const id = Math.floor(Math.random() * 0xffff);
  const packet = buildDnsQuery(domain, id);
  const family = net.isIP(dnsIp);
  if (!family) return { ok: false, latency: -1, address: '', message: 'Invalid DNS address' };
  const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  const started = performance.now();
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, latency: -1, address: '', message: 'DNS timeout' }), timeoutMs);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    socket.once('error', error => finish({ ok: false, latency: -1, address: '', message: error.message }));
    socket.once('message', response => {
      if (response.length < 12 || response.readUInt16BE(0) !== id || (response.readUInt16BE(2) & 0x000f) !== 0) {
        finish({ ok: false, latency: -1, address: '', message: 'Invalid DNS response' });
        return;
      }
      const address = firstIpv4Answer(response);
      finish({ ok: Boolean(address), latency: Math.max(0, Math.round(performance.now() - started)), address, message: address ? undefined : 'No IPv4 answer' });
    });
    socket.send(packet, 53, dnsIp, error => {
      if (error) finish({ ok: false, latency: -1, address: '', message: error.message });
    });
  });
}

export async function downloadWithResolvedIp(rawUrl, resolvedIp, timeoutMs = 8000, maxBytes = 512000) {
  const url = new URL(rawUrl);
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 8000);
  const transport = await openDirectTransferSocket(url, resolvedIp, timeoutMs);
  const transferTimeoutMs = deadline - Date.now();
  if (transferTimeoutMs < 250) {
    transport.socket.destroy();
    throw new Error('Download deadline exceeded');
  }
  return downloadOverConnectedSocket(
    transport.socket,
    transport.secure,
    url,
    transferTimeoutMs,
    maxBytes,
    'Mir2rayV2-Windows'
  );
}

function connectHttpProxy(proxyPort, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('Proxy connect timeout')), timeoutMs);
    const fail = error => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });
    const onData = chunk => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      socket.off('error', fail);
      clearTimeout(timer);
      const status = response.subarray(0, end).toString('latin1').split('\r\n')[0];
      if (!/\s200\s/.test(status)) { socket.destroy(); reject(new Error(`Proxy rejected CONNECT: ${status}`)); return; }
      const remainder = response.subarray(end + 4);
      if (remainder.length) socket.unshift(remainder);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

export async function requestThroughHttpProxy(proxyPort, rawUrl, options = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS probes are supported');
  }
  const timeoutMs = Math.max(1000, options.timeoutMs || 8000);
  const maxBytes = Math.max(0, options.maxBytes || 0);
  const deadline = Date.now() + timeoutMs;
  const transport = await openProxyTransferSocket(proxyPort, url, timeoutMs);
  const transferTimeoutMs = deadline - Date.now();
  if (transferTimeoutMs < 250) {
    transport.socket.destroy();
    throw new Error('Download deadline exceeded');
  }
  return downloadOverConnectedSocket(
    transport.socket,
    transport.secure,
    url,
    transferTimeoutMs,
    options.headersOnly ? 0 : maxBytes,
    'Mir2rayV2-Windows',
    Boolean(options.collectBody)
  );
}

function singleSocketAgent(socket, secure) {
  const Agent = secure ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  let claimed = false;
  agent.createConnection = () => {
    if (claimed) throw new Error('Transfer tunnel is no longer available');
    claimed = true;
    return socket;
  };
  return agent;
}

function downloadOverConnectedSocket(socket, secure, url, timeoutMs, maxBytes, userAgent, collectBody = false) {
  const transport = secure ? https : http;
  const agent = singleSocketAgent(socket, secure);
  const byteLimit = Math.max(0, Number(maxBytes) || 0);

  return new Promise((resolve, reject) => {
    let bodyBytes = 0;
    const bodyChunks = [];
    let statusCode = 0;
    let settled = false;
    let request;
    const startedAt = performance.now();
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
      request?.destroy();
      agent.destroy();
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      const ok = statusCode >= 200 && statusCode < 300;
      resolve({
        ok,
        statusCode,
        bytes: bodyBytes,
        elapsed,
        bps: ok && bodyBytes > 0 ? calculateTransferBps(bodyBytes, elapsed) : -1,
        ...(collectBody ? { body: Buffer.concat(bodyChunks).toString('utf8') } : {}),
        message: ok ? undefined : `HTTP ${statusCode}`,
      });
    };
    const timer = setTimeout(
      () => finish(new Error('Download transfer timeout')),
      timeoutMs
    );

    request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent,
      headers: {
        Host: url.host,
        'User-Agent': userAgent,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-store',
        Connection: 'close',
      },
      ...(secure ? { servername: url.hostname, rejectUnauthorized: true } : {}),
    }, response => {
      statusCode = Number(response.statusCode || 0);
      if (statusCode < 200 || statusCode >= 300 || byteLimit === 0) {
        response.resume();
        finish();
        return;
      }
      response.on('data', chunk => {
        const acceptedBytes = Math.min(chunk.length, Math.max(0, byteLimit - bodyBytes));
        if (collectBody && acceptedBytes > 0) {
          bodyChunks.push(chunk.subarray(0, acceptedBytes));
        }
        bodyBytes += acceptedBytes;
        if (bodyBytes >= byteLimit) finish();
      });
      response.once('end', () => finish());
      response.once('error', finish);
    });
    request.once('error', finish);
    request.end();
  });
}

async function openProxyTransferSocket(proxyPort, url, timeoutMs) {
  if (url.protocol === 'https:') {
    return {
      socket: await openProxyTlsTunnel(proxyPort, url, timeoutMs, true),
      secure: true,
    };
  }
  const socket = await connectHttpProxy(
    proxyPort,
    url.hostname,
    Number(url.port || 80),
    timeoutMs
  );
  socket.setKeepAlive(true, 1000);
  return { socket, secure: false };
}

function openDirectPlainSocket(url, resolvedIp, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: resolvedIp,
      port: Number(url.port || 80),
    });
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Direct connection timeout')),
      timeoutMs
    );
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        socket.setKeepAlive(true, 1000);
        resolve(value);
      }
    };
    socket.once('connect', () => finish(null, socket));
    socket.once('error', error => finish(error));
  });
}

async function openDirectTransferSocket(url, resolvedIp, timeoutMs) {
  if (url.protocol === 'https:') {
    return {
      socket: await openDirectTlsTunnel(url, resolvedIp, timeoutMs),
      secure: true,
    };
  }
  if (url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS probes are supported');
  }
  return {
    socket: await openDirectPlainSocket(url, resolvedIp, timeoutMs),
    secure: false,
  };
}

export function calculateTransferBps(bytes, elapsedMs) {
  const safeBytes = Math.max(0, Number(bytes) || 0);
  const safeElapsedMs = Math.max(1, Number(elapsedMs) || 0);
  return safeBytes > 0 ? Math.round((safeBytes * 8000) / safeElapsedMs) : -1;
}

/**
 * Uploads a fixed synthetic payload through an already-established Xray tunnel. The timer starts
 * after CONNECT/TLS setup and ends at the first response byte, matching Cloudflare's upload test.
 */
export async function uploadThroughHttpProxy(proxyPort, rawUrl, options = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS probes are supported');
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 8000));
  const bytes = Math.max(1, Math.min(25_000_000, Number(options.bytes || 512000)));
  const deadline = Date.now() + timeoutMs;
  const transport = await openProxyTransferSocket(proxyPort, url, timeoutMs);
  const transferTimeoutMs = deadline - Date.now();
  if (transferTimeoutMs < 250) {
    transport.socket.destroy();
    throw new Error('Upload deadline exceeded');
  }
  return uploadOverConnectedSocket(
    transport.socket,
    transport.secure,
    url,
    transferTimeoutMs,
    bytes,
    'Mir2rayV2-Windows'
  );
}

export async function uploadWithResolvedIp(rawUrl, resolvedIp, timeoutMs = 8000, bytes = 512000) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS probes are supported');
  }
  const safeTimeoutMs = Math.max(1000, Number(timeoutMs || 8000));
  const safeBytes = Math.max(1, Math.min(25_000_000, Number(bytes || 512000)));
  const deadline = Date.now() + safeTimeoutMs;
  const transport = await openDirectTransferSocket(url, resolvedIp, safeTimeoutMs);
  const transferTimeoutMs = deadline - Date.now();
  if (transferTimeoutMs < 250) {
    transport.socket.destroy();
    throw new Error('Upload deadline exceeded');
  }
  return uploadOverConnectedSocket(
    transport.socket,
    transport.secure,
    url,
    transferTimeoutMs,
    safeBytes,
    'Mir2rayV2-DnsBandwidth'
  );
}

function uploadOverConnectedSocket(socket, secure, url, timeoutMs, bytes, userAgent) {
  const transport = secure ? https : http;
  const agent = singleSocketAgent(socket, secure);

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStartedAt = 0;
    let requestFinishedAt = 0;
    let responseEnded = false;
    let statusCode = 0;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      agent,
      headers: {
        Host: url.host,
        'User-Agent': userAgent,
        Accept: '*/*',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes),
        Connection: 'close',
      },
      ...(secure ? { servername: url.hostname, rejectUnauthorized: true } : {}),
    }, response => {
      responseStartedAt = performance.now();
      statusCode = Number(response.statusCode || 0);
      response.resume();
      response.once('end', () => {
        responseEnded = true;
        if (requestFinishedAt > 0) finish();
      });
      response.once('error', error => finish(error));
    });
    const startedAt = performance.now();
    const timer = setTimeout(
      () => request.destroy(new Error('Proxy upload request timeout')),
      timeoutMs
    );
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      const completedAt = Math.max(responseStartedAt, requestFinishedAt);
      const elapsed = Math.max(1, Math.round(completedAt - startedAt));
      const ok = statusCode >= 200 && statusCode < 300;
      resolve({
        ok,
        statusCode,
        bytes: ok ? bytes : 0,
        elapsed,
        writeElapsed: Math.max(1, Math.round(requestFinishedAt - startedAt)),
        responseElapsed: Math.max(1, Math.round(responseStartedAt - startedAt)),
        responseBeforeRequestFinished: responseStartedAt < requestFinishedAt,
        bps: ok ? calculateTransferBps(bytes, elapsed) : -1,
        message: ok ? undefined : `HTTP ${statusCode}`,
      });
    };
    request.once('error', error => finish(error));
    request.once('finish', () => {
      requestFinishedAt = performance.now();
      if (responseEnded) finish();
    });
    request.end(Buffer.alloc(bytes));
  });
}

function openDirectTlsTunnel(url, resolvedIp, timeoutMs) {
  const targetPort = Number(url.port || 443);
  return new Promise((resolve, reject) => {
    const plain = net.connect({ host: resolvedIp, port: targetPort });
    let secure = null;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Direct TLS handshake timeout')), timeoutMs);
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        secure?.destroy();
        plain.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    plain.once('error', error => finish(error));
    plain.once('connect', () => {
      secure = tls.connect({
        socket: plain,
        servername: url.hostname,
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
      });
      secure.once('secureConnect', () => finish(null, secure));
      secure.once('error', error => finish(error));
    });
  });
}

async function openProxyTlsTunnel(proxyPort, url, timeoutMs, rejectUnauthorized) {
  const deadline = Date.now() + timeoutMs;
  const plain = await connectHttpProxy(proxyPort, url.hostname, Number(url.port || 443), timeoutMs);
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket: plain,
      servername: url.hostname,
      rejectUnauthorized,
      ALPNProtocols: ['http/1.1'],
    });
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Proxy TLS handshake timeout')),
      Math.max(250, deadline - Date.now())
    );
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        secure.destroy();
        reject(error);
      } else {
        secure.setKeepAlive(true, 1000);
        resolve(socket);
      }
    };
    secure.once('secureConnect', () => finish(null, secure));
    secure.once('error', error => finish(error));
  });
}

function requestDelaySample(agent, url, timeoutMs, startedAt) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.hostname,
      agent,
      headers: {
        Host: url.host,
        'User-Agent': 'Mir2rayV2-Windows',
        Accept: '*/*',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      },
      rejectUnauthorized: true,
    }, response => {
      const responseStartedAt = performance.now();
      const statusCode = Number(response.statusCode || 0);
      const ok = isDelayResponseStatus(statusCode);
      response.once('error', error => finish(error));
      response.resume();
      response.once('end', () => {
        finish(ok ? null : new Error(`HTTP ${statusCode}`), {
          ok,
          statusCode,
          elapsed: Math.max(1, Math.round(responseStartedAt - startedAt)),
        });
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Proxy delay request timeout')), timeoutMs);
    const finish = (error, sample) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(sample);
    };
    request.once('error', error => finish(error));
    request.end();
  });
}

export function isDelayResponseStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 500;
}

export function selectMedianDelaySample(samples) {
  const successful = samples.filter(sample => (
    sample?.ok
    && Number.isFinite(sample.elapsed)
    && sample.elapsed >= 0
  )).sort((a, b) => a.elapsed - b.elapsed);
  if (successful.length === 0) return null;
  return successful[Math.floor(successful.length / 2)];
}

export function selectSlowestDelaySample(samples) {
  const successful = samples.filter(sample => (
    sample?.ok
    && Number.isFinite(sample.elapsed)
    && sample.elapsed >= 0
  ));
  if (successful.length === 0) return null;
  return successful.reduce((slowest, sample) => (
    sample.elapsed > slowest.elapsed ? sample : slowest
  ));
}

export function selectPreferredDelaySample(samples, preferredTarget) {
  const normalizedTarget = String(preferredTarget || '').trim();
  if (!normalizedTarget) return selectSlowestDelaySample(samples);
  return samples.find(sample => (
    sample?.ok
    && Number.isFinite(sample.elapsed)
    && sample.elapsed >= 0
    && sample.target === normalizedTarget
  )) ?? null;
}

/**
 * Measures application response delay over one established Xray tunnel. TCP reachability is
 * screened separately; the median of warm HTTP samples avoids both handshake contention and
 * lucky lows.
 */
export async function measureHttpsDelayThroughHttpProxy(proxyPort, rawUrl, options = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS probes are supported');

  const timeoutMs = Math.max(2000, Number(options.timeoutMs || 8000));
  const attempts = Math.max(1, Math.min(3, Number(options.attempts || 3)));
  const rejectUnauthorized = options.rejectUnauthorized !== false;
  const deadline = Date.now() + timeoutMs;
  const secure = await openProxyTlsTunnel(
    proxyPort,
    url,
    Math.max(1000, deadline - Date.now()),
    rejectUnauthorized
  );
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  let tunnelClaimed = false;
  agent.createConnection = () => {
    if (tunnelClaimed) throw new Error('Reusable proxy tunnel is no longer available');
    tunnelClaimed = true;
    return secure;
  };
  const samples = [];
  const failures = [];
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining < 250) break;
      const attemptsLeft = attempts - attempt;
      const attemptTimeout = Math.max(250, Math.floor(remaining / attemptsLeft));
      try {
        samples.push(await requestDelaySample(
          agent,
          url,
          attemptTimeout,
          performance.now()
        ));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Unknown probe failure');
        if (secure.destroyed) break;
      }
    }
  } finally {
    agent.destroy();
    secure.destroy();
  }

  if (samples.length < Math.ceil(attempts / 2)) {
    const reason = failures.find(Boolean) || 'No response';
    throw new Error(`Real-delay probe received ${samples.length}/${attempts} valid responses: ${reason}`);
  }
  const representative = selectMedianDelaySample(samples);
  if (!representative) throw new Error('Real-delay probe did not receive a valid response');
  return {
    ...representative,
    attempts: samples.length,
    samples: samples.map(sample => sample.elapsed),
  };
}

const DEFAULT_PUBLIC_IP_ENDPOINTS = [
  'https://1.1.1.1/cdn-cgi/trace',
  'https://api.ipify.org?format=json',
  'https://icanhazip.com/',
];

export function parsePublicIpBody(body) {
  const trimmed = String(body || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{')) {
    try {
      const ip = JSON.parse(trimmed).ip;
      if (net.isIP(ip)) return ip;
    } catch {
      // Fall through to plain-text formats.
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.startsWith('ip=') ? line.slice(3).trim() : line.trim();
    if (net.isIP(candidate)) return candidate;
  }
  return '';
}

export function isUsablePublicIp(value) {
  const ip = String(value || '').trim();
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return !(
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    );
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return false;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    if (/^fe[89ab]/.test(normalized) || normalized.startsWith('ff')) return false;
    if (normalized.startsWith('::ffff:')) {
      return isUsablePublicIp(normalized.slice('::ffff:'.length));
    }
    return true;
  }
  return false;
}

export async function fetchPublicIpThroughHttpProxy(proxyPort, timeoutMs = 4500, options = {}) {
  const endpoints = Array.isArray(options.endpoints) && options.endpoints.length
    ? options.endpoints
    : DEFAULT_PUBLIC_IP_ENDPOINTS;
  const totalBudgetMs = Math.max(800, Number(timeoutMs) || 4500);
  const deadline = Date.now() + totalBudgetMs;
  const reservePerEndpointMs = Math.min(
    1000,
    Math.max(250, Math.floor(totalBudgetMs / Math.max(2, endpoints.length * 2)))
  );
  let lastMessage = 'Exit IP could not be verified';

  for (let index = 0; index < endpoints.length; index += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 250) break;
    const attemptsAfterThis = endpoints.length - index - 1;
    const reservedMs = attemptsAfterThis * reservePerEndpointMs;
    const attemptTimeoutMs = Math.max(250, Math.min(3500, remainingMs - reservedMs));
    try {
      const response = await requestThroughHttpProxy(proxyPort, endpoints[index], {
        timeoutMs: attemptTimeoutMs,
        maxBytes: 64 * 1024,
        collectBody: true,
      });
      if (!response.ok) {
        lastMessage = `Exit IP endpoint returned HTTP ${response.statusCode}`;
        continue;
      }
      const ip = parsePublicIpBody(response.body);
      if (isUsablePublicIp(ip)) return { ok: true, ip };
      lastMessage = 'Exit IP endpoint returned an invalid or local address';
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : 'Exit IP endpoint failed';
    }
  }

  return { ok: false, ip: '', message: lastMessage };
}

export async function fetchPublicIp(timeoutMs = 7000, options = {}) {
  const endpoints = Array.isArray(options.endpoints) && options.endpoints.length
    ? options.endpoints
    : DEFAULT_PUBLIC_IP_ENDPOINTS;
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch;
  const totalBudgetMs = Math.max(500, Number(timeoutMs) || 7000);
  const deadline = Date.now() + totalBudgetMs;
  const reservePerEndpointMs = Math.min(
    1000,
    Math.max(250, Math.floor(totalBudgetMs / Math.max(2, endpoints.length * 2)))
  );
  let lastMessage = 'Unable to determine public IP';

  for (let index = 0; index < endpoints.length; index += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 200) break;
    const attemptsAfterThis = endpoints.length - index - 1;
    const reservedMs = attemptsAfterThis * reservePerEndpointMs;
    const attemptTimeoutMs = Math.max(200, Math.min(3500, remainingMs - reservedMs));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await fetchImpl(endpoints[index], {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        lastMessage = `IP endpoint returned HTTP ${response.status}`;
        continue;
      }
      const ip = parsePublicIpBody(await response.text());
      if (isUsablePublicIp(ip)) return { ok: true, ip };
      lastMessage = 'IP endpoint returned an invalid response';
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : 'IP endpoint failed';
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, ip: '', message: lastMessage };
}
