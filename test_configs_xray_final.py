# test_configs_xray_final.py
import subprocess
import time
import json
import os
import socket
import urllib.parse
import sys
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional, Tuple

# ================== تنظیمات ==================
TIMEOUT = 15
THRESHOLD_MS = 600
MAX_WORKERS = 20
TEST_URL = "http://cp.cloudflare.com/generate_204"
XRAY_PATH = "./xray-core/xray"
SOCKS_PORT_START = 10000
REQUEST_DELAY = 0.02
# =============================================

def extract_host_port(vless_url: str) -> Optional[Tuple[str, int]]:
    try:
        parsed = urllib.parse.urlparse(vless_url)
        netloc = parsed.netloc.split('@')[-1].split('/')[0].split('?')[0]
        if netloc.startswith('['):
            bracket_end = netloc.find(']')
            if bracket_end == -1:
                return None
            host = netloc[1:bracket_end]
            remainder = netloc[bracket_end+1:]
            if remainder.startswith(':'):
                port = int(remainder[1:])
            else:
                port = 443
        else:
            if ':' in netloc:
                host, port_str = netloc.split(':', 1)
                port = int(port_str)
            else:
                host = netloc
                port = 443
        return host, port
    except Exception:
        return None

def get_country_code(host: str) -> str:
    try:
        ip = socket.gethostbyname(host)
        time.sleep(REQUEST_DELAY)
        resp = requests.get(f"http://ip-api.com/json/{ip}?fields=countryCode", timeout=3)
        if resp.status_code == 200:
            return resp.json().get('countryCode', 'XX')
    except Exception:
        pass
    return 'XX'

def add_flag(config: str, country: str) -> str:
    if '#' not in config:
        return f"{config}#{country}"
    base, name = config.rsplit('#', 1)
    return f"{base}#{country} {name}"

def create_vless_config(vless_url: str, socks_port: int) -> dict:
    parsed = urllib.parse.urlparse(vless_url)
    userinfo, server = parsed.netloc.split('@', 1)
    uuid = userinfo

    host_port = extract_host_port(vless_url)
    if not host_port:
        raise ValueError("Cannot extract host/port")
    address, port = host_port

    query = urllib.parse.parse_qs(parsed.query)

    outbound_settings = {
        "vnext": [{
            "address": address,
            "port": port,
            "users": [{
                "id": uuid,
                "encryption": query.get('encryption', ['none'])[0]
            }]
        }]
    }

    stream_settings = {}
    protocol_type = query.get('type', ['tcp'])[0]
    security = query.get('security', ['none'])[0]

    if protocol_type == 'tcp':
        stream_settings["network"] = "tcp"
        if 'headerType' in query and query['headerType'][0] == 'http':
            tcp_settings = {
                "header": {
                    "type": "http",
                    "request": {
                        "path": [query.get('path', ['/'])[0]],
                        "headers": {"Host": query.get('host', [''])[0].split(',')[0]}
                    }
                }
            }
            stream_settings["tcpSettings"] = tcp_settings
    elif protocol_type == 'ws':
        stream_settings["network"] = "ws"
        ws_settings = {}
        if 'path' in query:
            ws_settings["path"] = query['path'][0]
        if 'host' in query:
            ws_settings["headers"] = {"Host": query['host'][0].split(',')[0]}
        stream_settings["wsSettings"] = ws_settings
    elif protocol_type == 'grpc':
        stream_settings["network"] = "grpc"
        grpc_settings = {}
        if 'serviceName' in query:
            grpc_settings["serviceName"] = query['serviceName'][0]
        elif 'path' in query:
            grpc_settings["serviceName"] = query['path'][0]
        stream_settings["grpcSettings"] = grpc_settings

    if security == 'tls':
        stream_settings["security"] = "tls"
        tls_settings = {}
        if 'sni' in query:
            tls_settings["serverName"] = query['sni'][0]
        elif 'host' in query:
            tls_settings["serverName"] = query['host'][0].split(',')[0]
        if 'alpn' in query:
            tls_settings["alpn"] = query['alpn'][0].split(',')
        if 'fp' in query or 'fingerprint' in query:
            tls_settings["fingerprint"] = query.get('fp', query.get('fingerprint', ['chrome']))[0]
        if 'allowInsecure' in query or 'insecure' in query:
            tls_settings["allowInsecure"] = query.get('insecure', query.get('allowInsecure', ['0']))[0] == '1'
        stream_settings["tlsSettings"] = tls_settings
    elif security == 'reality':
        stream_settings["security"] = "reality"
        reality_settings = {}
        if 'sni' in query:
            reality_settings["serverName"] = query['sni'][0]
        if 'fp' in query:
            reality_settings["fingerprint"] = query['fp'][0]
        if 'pbk' in query:
            reality_settings["publicKey"] = query['pbk'][0]
        if 'sid' in query:
            reality_settings["shortId"] = query['sid'][0]
        if 'spx' in query:
            reality_settings["spiderX"] = query['spx'][0]
        stream_settings["realitySettings"] = reality_settings
    else:
        stream_settings["security"] = "none"

    config = {
        "log": {"loglevel": "none"},
        "inbounds": [{
            "port": socks_port,
            "listen": "127.0.0.1",
            "protocol": "socks",
            "settings": {"auth": "noauth", "udp": True}
        }],
        "outbounds": [{
            "protocol": "vless",
            "settings": outbound_settings,
            "streamSettings": stream_settings
        }]
    }
    return config

def test_one_config_real(line: str, socks_port: int) -> Optional[Tuple[str, float]]:
    try:
        config_json = create_vless_config(line, socks_port)
    except Exception as e:
        return None

    config_file = f"temp_config_{socks_port}.json"
    with open(config_file, 'w') as f:
        json.dump(config_json, f)

    error_log = f"xray_error_{socks_port}.log"
    proc = None
    try:
        with open(error_log, 'w') as errf:
            proc = subprocess.Popen([XRAY_PATH, "-c", config_file], stdout=subprocess.DEVNULL, stderr=errf)
            time.sleep(2)

            proxies = {"http": f"socks5://127.0.0.1:{socks_port}", "https": f"socks5://127.0.0.1:{socks_port}"}
            start = time.time()
            resp = requests.get(TEST_URL, proxies=proxies, timeout=TIMEOUT)
            latency = (time.time() - start) * 1000

            if resp.status_code == 204 and latency < THRESHOLD_MS:
                host_port = extract_host_port(line)
                country = get_country_code(host_port[0]) if host_port else 'XX'
                return (add_flag(line, country), latency)
    except Exception as e:
        if os.path.exists(error_log):
            with open(error_log, 'r') as errf:
                err_content = errf.read().strip()
                if err_content:
                    print(f"Xray error for {line[:80]}: {err_content}")
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        for f in [config_file, error_log]:
            if os.path.exists(f):
                os.remove(f)
    return None

def main():
    if len(sys.argv) != 3:
        print("Usage: python test_configs_xray_final.py <input_file> <output_file>")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    with open(input_file, 'r', encoding='utf-8') as f:
        lines = [line.strip() for line in f if line.strip() and line.startswith('vless://')]

    total = len(lines)
    print(f"Testing {total} configs with real delay method (Xray-core)...")

    valid = []
    futures = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        for idx, line in enumerate(lines):
            socks_port = SOCKS_PORT_START + idx
            futures.append(executor.submit(test_one_config_real, line, socks_port))

        for i, future in enumerate(as_completed(futures), 1):
            result = future.result()
            if result:
                config, latency = result
                valid.append(config)
                print(f"✅ {config[:80]}... ({latency:.0f}ms)")
            if i % 50 == 0:
                print(f"Progress: {i}/{total}")

    with open(output_file, 'w', encoding='utf-8') as f:
        for cfg in valid:
            f.write(cfg + '\n')

    print(f"✅ {len(valid)} valid configs saved to {output_file}")

if __name__ == "__main__":
    main()
