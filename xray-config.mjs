const PRIVATE_CIDRS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '::1/128', 'fc00::/7', 'fe80::/10',
];

function decode(value = '') {
  try { return decodeURIComponent(value); } catch { return value; }
}

function decodeBase64(value) {
  const clean = value.split(/[?#]/, 1)[0].replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='), 'base64').toString('utf8');
}

function parseBoolean(value, fallback = false) {
  if (['1', 'true'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false'].includes(String(value).toLowerCase())) return false;
  return fallback;
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function applyQuery(profile, query, defaultSecurity = '') {
  profile.network = query.type || 'tcp';
  profile.headerType = query.headerType || '';
  profile.host = query.host || '';
  profile.path = query.path || '';
  profile.seed = query.seed || '';
  profile.mode = query.mode || '';
  profile.serviceName = query.serviceName || '';
  profile.authority = query.authority || '';
  profile.xhttpMode = query.mode || '';
  profile.xhttpExtra = query.extra || '';
  profile.security = ['tls', 'reality'].includes(query.security) ? query.security : defaultSecurity;
  profile.insecure = parseBoolean(query.insecure ?? query.allowInsecure ?? query.allow_insecure, false);
  profile.sni = query.sni || '';
  profile.fingerprint = query.fp || '';
  profile.alpn = query.alpn || '';
  profile.publicKey = query.pbk || '';
  profile.shortId = query.sid || '';
  profile.spiderX = query.spx || '';
  profile.flow = query.flow || '';
}

function parseUrlShare(rawUri, protocol, defaultSecurity = '') {
  const url = new URL(rawUri.replaceAll(' ', '%20'));
  if (!url.hostname || !url.port || !url.username) throw new Error(`Invalid ${protocol} share link`);
  const profile = {
    configType: protocol,
    remarks: decode(url.hash.slice(1)) || protocol.toUpperCase(),
    server: url.hostname,
    serverPort: url.port,
    password: decode(url.username),
    method: protocol === 'vless' ? (url.searchParams.get('encryption') || 'none') : '',
  };
  applyQuery(profile, queryObject(url), defaultSecurity);
  return profile;
}

function parseVmess(rawUri) {
  const payload = rawUri.slice('vmess://'.length);
  if (payload.includes('@')) return parseUrlShare(rawUri, 'vmess');
  const json = JSON.parse(decodeBase64(payload));
  const profile = {
    configType: 'vmess',
    remarks: String(json.ps || 'VMess'),
    server: String(json.add || ''),
    serverPort: String(json.port || ''),
    password: String(json.id || ''),
    method: String(json.scy || 'auto'),
    network: String(json.net || 'tcp'),
    headerType: String(json.type || ''),
    host: String(json.host || ''),
    path: String(json.path || ''),
    security: String(json.tls || ''),
    sni: String(json.sni || ''),
    fingerprint: String(json.fp || ''),
    alpn: String(json.alpn || ''),
    insecure: parseBoolean(json.insecure, false),
  };
  if (profile.network === 'kcp') profile.seed = profile.path;
  if (profile.network === 'grpc') {
    profile.mode = profile.headerType;
    profile.serviceName = profile.path;
    profile.authority = profile.host;
  }
  return profile;
}

function parseShadowsocks(rawUri) {
  const hashIndex = rawUri.indexOf('#');
  const remarks = hashIndex >= 0 ? decode(rawUri.slice(hashIndex + 1)) : 'Shadowsocks';
  const withoutHash = hashIndex >= 0 ? rawUri.slice(0, hashIndex) : rawUri;
  const body = withoutHash.slice('ss://'.length);
  let normalized = withoutHash;
  if (!body.includes('@')) normalized = `ss://${decodeBase64(body)}`;
  const url = new URL(normalized.replaceAll(' ', '%20'));
  let userInfo = decode(url.username);
  if (!userInfo.includes(':')) userInfo = decodeBase64(userInfo);
  const separator = userInfo.indexOf(':');
  if (separator <= 0 || !url.hostname || !url.port) throw new Error('Invalid Shadowsocks share link');
  return {
    configType: 'shadowsocks', remarks, server: url.hostname, serverPort: url.port,
    method: userInfo.slice(0, separator), password: userInfo.slice(separator + 1),
    network: 'tcp', security: '', insecure: false,
  };
}

export function parseShareUri(rawUri) {
  const uri = String(rawUri || '').trim();
  let profile;
  if (uri.startsWith('vless://')) profile = parseUrlShare(uri, 'vless');
  else if (uri.startsWith('trojan://')) profile = parseUrlShare(uri, 'trojan', 'tls');
  else if (uri.startsWith('vmess://')) profile = parseVmess(uri);
  else if (uri.startsWith('ss://')) profile = parseShadowsocks(uri);
  else throw new Error('Unsupported share link protocol');
  if (!profile.server || !profile.serverPort || !profile.password) throw new Error('Incomplete share link');
  return profile;
}

function looksLikeDomain(value = '') {
  return /^[a-z0-9.-]+$/i.test(value) && !/^\d+(\.\d+){3}$/.test(value);
}

function transportSettings(profile) {
  const network = profile.network || 'tcp';
  const stream = { network };
  if (network === 'ws') {
    stream.wsSettings = { path: profile.path || '/', host: profile.host || '' };
  } else if (network === 'grpc') {
    stream.grpcSettings = {
      serviceName: profile.serviceName || '', multiMode: profile.mode === 'multi', authority: profile.authority || '',
    };
  } else if (network === 'httpupgrade') {
    stream.httpupgradeSettings = { path: profile.path || '/', host: profile.host || '' };
  } else if (network === 'xhttp') {
    stream.xhttpSettings = { path: profile.path || '/', host: profile.host || '', mode: profile.xhttpMode || 'auto' };
    if (profile.xhttpExtra) {
      try { stream.xhttpSettings.extra = JSON.parse(profile.xhttpExtra); } catch { /* optional */ }
    }
  } else if (network === 'h2' || network === 'http') {
    stream.network = 'h2';
    stream.httpSettings = { host: String(profile.host || '').split(',').map(x => x.trim()).filter(Boolean), path: profile.path || '/' };
  } else if (network === 'kcp') {
    stream.kcpSettings = { seed: profile.seed || '', header: { type: profile.headerType || 'none' } };
  } else if (network === 'quic') {
    stream.quicSettings = { security: 'none', key: profile.seed || '', header: { type: profile.headerType || 'none' } };
  } else {
    stream.network = 'tcp';
    stream.tcpSettings = profile.headerType === 'http'
      ? { header: { type: 'http', request: { headers: { Host: profile.host ? [profile.host.split(',')[0].trim()] : [] }, path: [profile.path || '/'] } } }
      : { header: { type: 'none' } };
  }
  return stream;
}

function applyTls(stream, profile) {
  if (!profile.security) return;
  stream.security = profile.security;
  const host = String(profile.host || '').split(',')[0].trim();
  const serverName = profile.sni || (looksLikeDomain(host) ? host : looksLikeDomain(profile.server) ? profile.server : '');
  const settings = { allowInsecure: Boolean(profile.insecure), serverName };
  if (profile.fingerprint) settings.fingerprint = profile.fingerprint;
  else if (profile.security === 'reality') settings.fingerprint = 'chrome';
  const alpn = String(profile.alpn || '').split(',').map(x => x.trim()).filter(Boolean);
  if (alpn.length) settings.alpn = alpn;
  if (profile.publicKey) settings.publicKey = profile.publicKey;
  if (profile.shortId) settings.shortId = profile.shortId;
  if (profile.spiderX) settings.spiderX = profile.spiderX;
  stream[profile.security === 'reality' ? 'realitySettings' : 'tlsSettings'] = settings;
}

function applyFragment(outbound, profile, fragment) {
  if (!fragment?.enabled || !['tls', 'reality'].includes(profile.security)) return;
  let packets = fragment.packets || '10-20';
  if (profile.security === 'reality' && packets === 'tlshello') packets = '1-3';
  if (profile.security === 'tls' && packets !== 'tlshello') packets = 'tlshello';
  outbound.streamSettings.finalmask = {
    tcp: [{ type: 'fragment', settings: { packets, length: fragment.length || '100-200', delay: fragment.interval || '10-20' } }],
    udp: [{ type: 'noise', settings: { noise: [{ rand: '10-20', delay: '10-16' }] } }],
  };
}

export function buildProxyOutbound(rawUri, options = {}) {
  const profile = parseShareUri(rawUri);
  if (options.cleanIp) {
    const original = profile.server;
    profile.server = options.cleanIp;
    profile.host ||= original;
    profile.sni ||= original;
    profile.authority ||= original;
  }
  const tag = options.tag || 'proxy';
  let outbound;
  if (profile.configType === 'vless' || profile.configType === 'vmess') {
    const user = profile.configType === 'vless'
      ? { id: profile.password, encryption: profile.method || 'none', level: 8 }
      : { id: profile.password, alterId: 0, security: profile.method || 'auto', level: 8 };
    if (profile.flow) user.flow = profile.flow;
    outbound = {
      tag, protocol: profile.configType,
      settings: { vnext: [{ address: profile.server, port: Number(profile.serverPort), users: [user] }] },
      streamSettings: transportSettings(profile), mux: { enabled: false },
    };
  } else if (profile.configType === 'trojan') {
    outbound = {
      tag, protocol: 'trojan', settings: { servers: [{ address: profile.server, port: Number(profile.serverPort), password: profile.password, level: 8 }] },
      streamSettings: transportSettings(profile), mux: { enabled: false },
    };
  } else {
    outbound = {
      tag, protocol: 'shadowsocks', settings: { servers: [{ address: profile.server, port: Number(profile.serverPort), password: profile.password, method: profile.method, level: 8 }] },
      streamSettings: { network: 'tcp' }, mux: { enabled: false },
    };
  }
  applyTls(outbound.streamSettings, profile);
  applyFragment(outbound, profile, options.fragment);
  return outbound;
}

function dnsServers(dnsIp, strictDns, doh) {
  const servers = [];
  if (dnsIp && /^[0-9a-f:.]+$/i.test(dnsIp)) servers.push(dnsIp);
  if (!strictDns || !servers.length) {
    if (doh) servers.push('https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query');
    for (const item of ['1.1.1.1', '8.8.8.8']) if (!servers.includes(item)) servers.push(item);
  }
  return servers;
}

function commonConfig(outbounds, dnsIp, strictDns, doh) {
  return {
    log: { loglevel: 'warning' },
    stats: {},
    policy: {
      levels: { '8': { handshake: 4, connIdle: 300, uplinkOnly: 1, downlinkOnly: 1, bufferSize: 512 } },
      system: {
        statsInboundUplink: true, statsInboundDownlink: true,
        statsOutboundUplink: true, statsOutboundDownlink: true,
      },
    },
    inbounds: [],
    outbounds: [
      ...outbounds,
      { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } },
    ],
    routing: { domainStrategy: 'IPIfNonMatch', rules: [] },
    dns: { hosts: {}, servers: dnsServers(dnsIp, strictDns, doh), queryStrategy: 'UseIPv4' },
  };
}

export function buildSpeedTestConfig(payload, httpPort) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const outbound = buildProxyOutbound(parsed.shareUri, { cleanIp: parsed.cleanIp, fragment: parsed.fragment });
  delete outbound.mux;
  const config = commonConfig([outbound], parsed.dnsIp, Boolean(parsed.strictDns), false);
  config.inbounds = [{
    tag: 'speedtest', listen: '127.0.0.1', port: httpPort, protocol: 'http',
    settings: { userLevel: 8 },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
  }];
  config.routing.domainStrategy = 'AsIs';
  config.routing.rules = [{ type: 'field', inboundTag: ['speedtest'], network: 'tcp,udp', outboundTag: 'proxy' }];
  return config;
}
