import socket
import time
import urllib.parse
import sys
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional, Tuple

REQUEST_DELAY = 0.02
MAX_WORKERS = 20

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
            code = resp.json().get('countryCode', 'XX')
            return code if code else '??'
    except Exception:
        pass
    return '??'

def add_flag(config: str, country: str) -> str:
    """حذف نام قبلی و گذاشتن پرچم یا mirsub"""
    base = config.split('#')[0]  # قسمت قبل از #
    if country == '??':
        return f"{base}#mirsub"
    else:
        return f"{base}#{country}"

def test_one_config(line: str, threshold_ms: int) -> Optional[str]:
    line = line.strip()  # حذف فاصله‌های اضافی
    hp = extract_host_port(line)
    if not hp:
        return None
    host, port = hp

    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect((host, port))
        sock.close()
        latency = (time.time() - start) * 1000
    except Exception:
        return None

    if latency >= threshold_ms:
        return None

    country = get_country_code(host)
    return add_flag(line, country)

def main():
    if len(sys.argv) < 3:
        print("Usage: python test_configs_final.py <input_file> <output_file> [threshold_ms]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]
    threshold_ms = int(sys.argv[3]) if len(sys.argv) >= 4 else 150

    with open(input_file, 'r', encoding='utf-8') as f:
        lines = [line.strip() for line in f if line.strip() and line.startswith('vless://')]

    total = len(lines)
    print(f"Testing {total} configs (threshold={threshold_ms}ms)...")

    valid = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_line = {executor.submit(test_one_config, line, threshold_ms): line for line in lines}
        for i, future in enumerate(as_completed(future_to_line), 1):
            result = future.result()
            if result:
                valid.append(result)
                print(f"✅ {result[:80]}...")
            if i % 100 == 0:
                print(f"Progress: {i}/{total}")

    valid.sort()  # مرتب‌سازی الفبایی

    with open(output_file, 'w', encoding='utf-8') as f:
        for cfg in valid:
            f.write(cfg + '\n')

    print(f"✅ {len(valid)} valid configs saved to {output_file}")

if __name__ == "__main__":
    main()
