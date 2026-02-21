import socket
import time
import urllib.parse
import sys
import requests
import json
from typing import Optional, Tuple

TIMEOUT = 5          # ثانیه برای اتصال TCP
THRESHOLD_MS = 600   # میلی‌ثانیه
REQUEST_DELAY = 0.1  # تأخیر بین درخواست‌های ip-api (برای رعایت محدودیت)

def extract_host_port(vless_url: str) -> Optional[Tuple[str, int]]:
    """استخراج host و پورت از لینک vless://"""
    try:
        parsed = urllib.parse.urlparse(vless_url)
        netloc = parsed.netloc.split('@')[-1]  # remove userinfo if present
        if ':' in netloc:
            host, port_str = netloc.split(':', 1)
            port = int(port_str.split('/')[0].split('?')[0])
            return host, port
        else:
            return netloc, 443
    except Exception:
        return None

def get_country_code(host: str) -> str:
    """دریافت کد دو حرفی کشور با ip-api.com"""
    try:
        # اگر host دامنه است، ابتدا IP بگیر
        ip = socket.gethostbyname(host)
        time.sleep(REQUEST_DELAY)  # رعایت محدودیت
        response = requests.get(f"http://ip-api.com/json/{ip}?fields=countryCode", timeout=3)
        if response.status_code == 200:
            data = response.json()
            return data.get('countryCode', 'XX')
    except Exception:
        pass
    return 'XX'

def add_flag_to_config(config_url: str, country_code: str) -> str:
    """اضافه کردن پرچم به بخش name (بعد از #)"""
    if '#' not in config_url:
        return f"{config_url}#{country_code}"
    else:
        base, name = config_url.rsplit('#', 1)
        return f"{base}#{country_code} {name}"

def measure_tcp_latency(host: str, port: int) -> Optional[float]:
    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(TIMEOUT)
        sock.connect((host, port))
        sock.close()
        return (time.time() - start) * 1000
    except Exception:
        return None

def main():
    if len(sys.argv) != 3:
        print("Usage: python test_configs.py <input_file> <output_file>")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    with open(input_file, 'r', encoding='utf-8') as f:
        lines = [line.strip() for line in f if line.strip() and line.startswith('vless://')]

    valid_configs = []
    total = len(lines)
    print(f"Testing {total} configs from {input_file}...")

    for idx, line in enumerate(lines, 1):
        hp = extract_host_port(line)
        if not hp:
            continue
        host, port = hp

        latency = measure_tcp_latency(host, port)
        if latency is None or latency >= THRESHOLD_MS:
            continue

        # گرفتن کشور و اضافه کردن پرچم
        country = get_country_code(host)
        config_with_flag = add_flag_to_config(line, country)
        valid_configs.append(config_with_flag)

        if idx % 50 == 0:
            print(f"Progress: {idx}/{total}")

    with open(output_file, 'w', encoding='utf-8') as f:
        for cfg in valid_configs:
            f.write(cfg + '\n')

    print(f"✅ {len(valid_configs)} valid configs saved to {output_file}")

if __name__ == "__main__":
    main()
