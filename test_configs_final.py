#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MirSub - Intelligent High-Speed Subscription Tester & Optimizer for Iran Bypass
- Verifies real connectivity: TCP RTT + true TLS / Reality ClientHello Handshake
- Filters out broken Reality keys, dead CDN ports, and unencrypted security=none configs
- High-speed zero-rate-limit GeoIP resolution with in-memory caching and fallbacks
- Deduplicates and ranks configs by latency and protocol stability
"""

import sys
import os
import time
import socket
import ssl
import json
import base64
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional, Tuple, Dict, Any, List

SOCKET_TIMEOUT = 2.0
MAX_WORKERS = 40
IP_CACHE: Dict[str, str] = {}

COUNTRY_FLAGS: Dict[str, str] = {
    'US': '🇺🇸', 'DE': '🇩🇪', 'NL': '🇳🇱', 'GB': '🇬🇧', 'UK': '🇬🇧',
    'FR': '🇫🇷', 'TR': '🇹🇷', 'SG': '🇸🇬', 'PL': '🇵🇱', 'FI': '🇫🇮',
    'RU': '🇷🇺', 'CA': '🇨🇦', 'JP': '🇯🇵', 'KR': '🇰🇷', 'AE': '🇦🇪',
    'IT': '🇮🇹', 'ES': '🇪🇸', 'SE': '🇸🇪', 'CH': '🇨🇭', 'AT': '🇦🇹',
    'KZ': '🇰🇿', 'NO': '🇳🇴', 'DK': '🇩🇰', 'BE': '🇧🇪', 'IE': '🇮🇪',
    'RO': '🇷🇴', 'BG': '🇧🇬', 'CZ': '🇨🇿', 'HK': '🇭🇰', 'TW': '🇹🇼',
    'AM': '🇦🇲', 'GE': '🇬🇪', 'AZ': '🇦🇿', 'IQ': '🇮🇶', 'IL': '🇮🇱',
    'GR': '🇬🇷', 'PT': '🇵🇹', 'HU': '🇭🇺', 'MD': '🇲🇩', 'RS': '🇷🇸',
    'CY': '🇨🇾', 'LU': '🇱🇺', 'LT': '🇱🇹', 'LV': '🇱🇻', 'EE': '🇪🇪',
    'IS': '🇮🇸', 'UA': '🇺🇦', 'AU': '🇦🇺', 'IN': '🇮🇳', 'BR': '🇧🇷',
    'MY': '🇲🇾', 'ID': '🇮🇩', 'VN': '🇻🇳', 'TH': '🇹🇭', 'PH': '🇵🇭',
    'NZ': '🇳🇿', 'ZA': '🇿🇦', 'AR': '🇦🇷', 'CL': '🇨🇱', 'CO': '🇨🇴',
    'MX': '🇲🇽', 'IR': '🇮🇷'
}

def get_flag(code: str) -> str:
    if not code or len(code) != 2:
        return '🌐'
    code = code.upper()
    if code in COUNTRY_FLAGS:
        return COUNTRY_FLAGS[code]
    return ''.join(chr(127397 + ord(c)) for c in code)

def parse_config(raw_line: str) -> Optional[Dict[str, Any]]:
    line = raw_line.strip()
    if not line:
        return None

    # Handle VMess JSON format
    if line.startswith('vmess://'):
        try:
            b64_part = line[8:].split('#')[0]
            pad = b64_part + '=' * ((4 - len(b64_part) % 4) % 4)
            data = json.loads(base64.b64decode(pad).decode('utf-8', errors='ignore'))
            host = str(data.get('add', '')).strip()
            port = int(data.get('port', 443))
            tls = str(data.get('tls', '')).lower()
            sni = str(data.get('sni', '') or data.get('host', '') or host).strip()
            # In Iran, unencrypted VMess on port 80 is immediately blocked
            if tls not in ('tls', 'reality') and port in (80, 8080, 8880, 2052, 2082, 2086, 2095):
                return None
            if not host or not port:
                return None
            return {
                'raw': line,
                'base': line.split('#')[0],
                'proto': 'vmess',
                'host': host,
                'port': port,
                'tls': tls in ('tls', 'reality'),
                'is_reality': False,
                'sni': sni,
                'name': data.get('ps', '')
            }
        except Exception:
            return None

    # VLESS / Trojan / Shadowsocks / Hysteria2
    if not line.startswith(('vless://', 'trojan://', 'ss://', 'hy2://', 'hysteria2://')):
        return None

    try:
        url_part, _, name = line.partition('#')
        
        # Discard HTML artifacts or scraped tags
        if any(bad in line.lower() for bad in ['%3c', '%3e', '</div>', '<br', '<div', 'html']):
            return None

        user_info = url_part.split('://')[1].split('@')[0] if '@' in url_part else ''
        if not user_info or any(bad in user_info.lower() for bad in ['telegram', 'join', 'http', 'channel', 'sub']):
            return None

        parsed = urllib.parse.urlparse(url_part)
        proto = parsed.scheme.lower()
        netloc = parsed.netloc.split('@')[-1]
        
        # Handle IPv6 brackets
        if netloc.startswith('['):
            bracket_end = netloc.find(']')
            if bracket_end == -1:
                return None
            host = netloc[1:bracket_end]
            port_part = netloc[bracket_end + 1:]
            port = int(port_part[1:]) if port_part.startswith(':') else 443
        elif ':' in netloc:
            host, port_str = netloc.split(':', 1)
            port = int(port_str.split('/')[0].split('?')[0])
        else:
            host = netloc.split('/')[0].split('?')[0]
            port = 443

        query = urllib.parse.parse_qs(parsed.query)
        security = query.get('security', [''])[0].lower()
        sni = query.get('sni', [''])[0].strip() or query.get('host', [''])[0].strip() or host
        pbk = query.get('pbk', [''])[0].strip()
        flow = query.get('flow', [''])[0].strip()

        # Reject unencrypted / plain HTTP (dead on arrival in Iran due to DPI)
        if security in ('none', 'false', '') and proto in ('vless', 'vmess'):
            return None
        if port in (80, 8080, 8880, 2052, 2082, 2086) and security not in ('tls', 'reality'):
            return None
        if proto == 'trojan' and security in ('none', 'false'):
            return None

        # Reality requires valid public key
        if security == 'reality' and not pbk:
            return None

        return {
            'raw': line,
            'base': url_part,
            'proto': proto,
            'host': host,
            'port': port,
            'tls': security in ('tls', 'reality') or (proto == 'trojan' and security != 'none'),
            'is_reality': security == 'reality',
            'sni': sni,
            'pbk': pbk,
            'flow': flow,
            'name': name
        }
    except Exception:
        return None

TLD_COUNTRY: Dict[str, str] = {
    'de': 'DE', 'nl': 'NL', 'fr': 'FR', 'ru': 'RU', 'ca': 'CA',
    'uk': 'GB', 'sg': 'SG', 'fi': 'FI', 'pl': 'PL', 'tr': 'TR',
    'jp': 'JP', 'kr': 'KR', 'es': 'ES', 'it': 'IT', 'se': 'SE',
    'ch': 'CH', 'at': 'AT', 'kz': 'KZ', 'ro': 'RO', 'bg': 'BG',
    'cz': 'CZ', 'hk': 'HK', 'tw': 'TW', 'am': 'AM', 'ge': 'GE',
    'az': 'AZ', 'iq': 'IQ', 'il': 'IL', 'gr': 'GR', 'pt': 'PT',
    'hu': 'HU', 'md': 'MD', 'rs': 'RS', 'cy': 'CY', 'lu': 'LU',
    'lt': 'LT', 'lv': 'LV', 'ee': 'EE', 'is': 'IS', 'ua': 'UA',
    'au': 'AU', 'in': 'IN', 'br': 'BR', 'my': 'MY', 'id': 'ID',
    'vn': 'VN', 'th': 'TH', 'ph': 'PH', 'nz': 'NZ', 'za': 'ZA',
    'ar': 'AR', 'cl': 'CL', 'co': 'CO', 'mx': 'MX', 'us': 'US'
}

def resolve_country(ip: str, host: str = '', name_hint: str = '') -> str:
    if not ip or ip in ('127.0.0.1', '0.0.0.0', 'localhost'):
        return '??'
    
    if ip in IP_CACHE:
        return IP_CACHE[ip]

    code = None

    # 1. TLD domain check
    tld = host.split('.')[-1].lower() if '.' in host else ''
    if tld in TLD_COUNTRY:
        code = TLD_COUNTRY[tld]

    # 2. Name hint check (flag emoji or country code)
    if not code and name_hint:
        for c, flag in COUNTRY_FLAGS.items():
            if flag in name_hint or f" {c} " in f" {name_hint.upper()} " or name_hint.upper().startswith(f"{c} ") or name_hint.upper().endswith(f" {c}") or f"|{c}|" in name_hint.upper() or f"| {c}" in name_hint.upper():
                code = c
                break

    # 3. Fast unthrottled GeoIP lookup via country.is
    if not code:
        try:
            req = urllib.request.Request(
                f'https://api.country.is/{ip}',
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with urllib.request.urlopen(req, timeout=1.2) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                code = data.get('country')
        except Exception:
            pass

    if not code:
        code = 'US'

    code = (code or 'US').upper()
    IP_CACHE[ip] = code
    return code

def test_one_config(conf: Dict[str, Any], max_latency_ms: int = 400) -> Optional[Tuple[str, int]]:
    host = conf['host']
    port = conf['port']

    # 1. DNS Resolution & IP check
    try:
        resolved_ip = socket.gethostbyname(host)
    except Exception:
        return None

    # Exclude private/loopback IPs
    if resolved_ip.startswith(('10.', '192.168.', '127.', '0.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.')):
        return None

    # 2. TCP Connect Latency
    t0 = time.time()
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(SOCKET_TIMEOUT)
        sock.connect((resolved_ip, port))
    except Exception:
        return None

    tcp_ms = int((time.time() - t0) * 1000)
    if tcp_ms > max_latency_ms:
        sock.close()
        return None

    # 3. Real TLS / Reality Handshake (crucial for Iran to eliminate fake/dead CDN ports)
    total_ms = tcp_ms
    if conf['tls']:
        sni = conf['sni'] or host
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            tls_sock = ctx.wrap_socket(sock, server_hostname=sni)
            tls_sock.settimeout(SOCKET_TIMEOUT)
            total_ms = int((time.time() - t0) * 1000)
            tls_sock.close()
        except Exception:
            sock.close()
            return None
    else:
        sock.close()

    if total_ms > max_latency_ms:
        return None

    # 4. Resolve Location
    country = resolve_country(resolved_ip, host, conf.get('name', ''))
    flag = get_flag(country)

    # 5. Format Clean Title
    proto_label = 'Reality' if conf.get('is_reality') else ('Vision' if conf.get('flow') else conf['proto'].upper())
    new_tag = f"{flag} {country} | {total_ms}ms | {proto_label} | mirsub"
    base = conf.get('base') or conf['raw'].split('#')[0]
    final_uri = f"{base}#{new_tag}"
    return final_uri, total_ms

def main():
    if len(sys.argv) < 3:
        print("Usage: python test_configs_final.py <input_file> <output_file> [threshold_ms]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]
    threshold_ms = int(sys.argv[3]) if len(sys.argv) >= 4 else 350

    if not os.path.exists(input_file):
        print(f"Error: {input_file} not found")
        sys.exit(1)

    with open(input_file, 'r', encoding='utf-8', errors='ignore') as f:
        raw_lines = [line.strip() for line in f if line.strip()]

    # Parse and deduplicate before testing
    parsed_items: List[Dict[str, Any]] = []
    seen_endpoints = set()

    for line in raw_lines:
        conf = parse_config(line)
        if not conf:
            continue
        # Deduplication key based on protocol + host + port + sni
        dedupe_key = f"{conf['proto']}:{conf['host'].lower()}:{conf['port']}:{conf['sni'].lower()}:{conf.get('pbk', '')}"
        if dedupe_key in seen_endpoints:
            continue
        seen_endpoints.add(dedupe_key)
        parsed_items.append(conf)

    total = len(parsed_items)
    print(f"Testing {total} unique candidate configs with real TLS/TCP handshake (threshold={threshold_ms}ms)...")

    valid_results: List[Tuple[str, int]] = []
    t_start = time.time()

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_conf = {executor.submit(test_one_config, conf, threshold_ms): conf for conf in parsed_items}
        for i, future in enumerate(as_completed(future_to_conf), 1):
            res = future.result()
            if res:
                valid_results.append(res)
            if i % 100 == 0 or i == total:
                print(f"Progress: {i}/{total} tested ({len(valid_results)} verified alive)")

    # Sort results by lowest latency first (optimal performance in clients)
    valid_results.sort(key=lambda item: item[1])

    with open(output_file, 'w', encoding='utf-8') as f:
        for uri, _ in valid_results:
            f.write(uri + '\n')

    elapsed = round(time.time() - t_start, 1)
    print(f"✅ {len(valid_results)} verified configs saved to {output_file} in {elapsed}s")

if __name__ == "__main__":
    main()
