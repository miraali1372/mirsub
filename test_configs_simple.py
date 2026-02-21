# test_configs_simple.py
import socket
import time
import urllib.parse
import sys
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional, Tuple

# ================== تنظیمات ==================
TIMEOUT = 10                    # زمان انتظار برای اتصال (ثانیه)
THRESHOLD_MS = 200              # حداکثر تأخیر مجاز (میلی‌ثانیه) - افزایش یافته
MAX_WORKERS = 200                # تعداد نخ‌های همزمان
REQUEST_DELAY = 0.02             # تأخیر بین درخواست‌های ip-api
# =============================================

def extract_host_port(vless_url: str) -> Optional[Tuple[str, int]]:
    """استخراج host و پورت از لینک vless، پشتیبانی از IPv6"""
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
    """دریافت کد دو حرفی کشور با ip-api.com"""
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
    """اضافه کردن پرچم به نام کانفیگ"""
    if '#' not in config:
        return f"{config}#{country}"
    base, name = config.rsplit('#', 1)
    return f"{base}#{country} {name}"

def test_one_config(line: str) -> Optional[str]:
    """تست یک کانفیگ با TCP Ping و در صورت قبول، با پرچم برمی‌گرداند"""
    hp = extract_host_port(line)
    if not hp:
        return None
    host, port = hp

    # اندازه‌گیری تأخیر TCP
    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(TIMEOUT)
        sock.connect((host, port))
        sock.close()
        latency = (time.time() - start) * 1000
    except Exception:
        return None

    if latency >= THRESHOLD_MS:
        return None

    country = get_country_code(host)
    return add_flag(line, country)

def main():
    if len(sys.argv) != 3:
        print("Usage: python test_configs_simple.py <input_file> <output_file>")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    with open(input_file, 'r', encoding='utf-8') as f:
        lines = [line.strip() for line in f if line.strip() and line.startswith('vless://')]

    total = len(lines)
    print(f"Testing {total} configs with TCP Ping (threshold={THRESHOLD_MS}ms)...")

    valid = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_line = {executor.submit(test_one_config, line): line for line in lines}
        for i, future in enumerate(as_completed(future_to_line), 1):
            result = future.result()
            if result:
                valid.append(result)
                print(f"✅ {result[:80]}...")
            if i % 100 == 0:
                print(f"Progress: {i}/{total}")

    with open(output_file, 'w', encoding='utf-8') as f:
        for cfg in valid:
            f.write(cfg + '\n')

    print(f"✅ {len(valid)} valid configs saved to {output_file}")

if __name__ == "__main__":
    main()
