# test_configs.py
import socket
import time
import urllib.parse
import sys
from typing import Optional, Tuple

def extract_host_port(vless_url: str) -> Optional[Tuple[str, int]]:
    try:
        parsed = urllib.parse.urlparse(vless_url)
        host_port = parsed.netloc.split('@')[-1]
        if ':' in host_port:
            host, port_str = host_port.split(':', 1)
            port = int(port_str.split('/')[0].split('?')[0])
            return host, port
        else:
            return host_port, 443
    except Exception:
        return None

def measure_tcp_latency(host: str, port: int) -> Optional[float]:
    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
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
    threshold_ms = 600

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
        if latency is not None and latency < threshold_ms:
            valid_configs.append(line)
        if idx % 50 == 0:
            print(f"Progress: {idx}/{total}")

    with open(output_file, 'w', encoding='utf-8') as f:
        for cfg in valid_configs:
            f.write(cfg + '\n')

    print(f"✅ {len(valid_configs)} valid configs saved to {output_file}")

if __name__ == "__main__":
    main()
