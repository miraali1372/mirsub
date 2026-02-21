import urllib.request
import socket
import time
from urllib.parse import urlparse

SOURCE_URL = 'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vless.txt'
INPUT_FILE = 'unique.txt'   # این فایل توسط workflow قبلاً از sort | uniq ایجاد شده
OUTPUT_FILE = 'result.txt'
TIMEOUT = 5
THRESHOLD_MS = 600

def load_config_from_url():
    with urllib.request.urlopen(SOURCE_URL) as response:
        data = response.read().decode('utf-8')
        return data.splitlines()

def extract_host_port(vless_url):
    try:
        parsed = urlparse(vless_url)
        # بخش netloc ممکن است شامل userinfo@host:port باشد
        netloc = parsed.netloc.split('@')[-1]  # بعد از @ را برمی‌داریم
        if ':' in netloc:
            host, port_str = netloc.split(':', 1)
            port = int(port_str.split('/')[0].split('?')[0])
            return host, port
        else:
            return netloc, 443
    except:
        return None

def measure_tcp_latency(host, port):
    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(TIMEOUT)
        sock.connect((host, port))
        sock.close()
        return (time.time() - start) * 1000
    except:
        return None

def main():
    # بارگذاری لیست یکتا شده از فایل (که workflow قبلاً ساخته)
    with open(INPUT_FILE, 'r') as f:
        lines = [line.strip() for line in f if line.strip() and line.startswith('vless://')]

    valid = []
    for line in lines:
        hp = extract_host_port(line)
        if not hp:
            continue
        host, port = hp
        lat = measure_tcp_latency(host, port)
        if lat and lat < THRESHOLD_MS:
            valid.append(line)
        # (اختیاری) می‌توانید وضعیت را چاپ کنید

    with open(OUTPUT_FILE, 'w') as f:
        for cfg in valid:
            f.write(cfg + '\n')

    print(f"{len(valid)} configs با تأخیر زیر {THRESHOLD_MS} ms یافت شد.")

if __name__ == '__main__':
    main()
