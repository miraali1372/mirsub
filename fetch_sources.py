#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MirSub - Multi-source Harvester & Normalizer for Iran Bypass
- Scrapes from top community and Iran-specific proxy subscription repositories
- Decodes Base64 encoded subscriptions automatically
- Extracts VLESS, VMess, Trojan, and Shadowsocks configs
- Filters out broken, plain HTTP (security=none on port 80), and empty Reality configs
- Performs pre-deduplication to ensure clean candidate inputs
"""

import sys
import re
import base64
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Set

SOURCES = [
    # Top Reality Sources (Best for Iran)
    "https://raw.githubusercontent.com/Mosifree/-FREE2CONFIG/refs/heads/main/Reality",
    "https://raw.githubusercontent.com/10ium/V2Hub3/refs/heads/main/Split/Normal/reality",
    "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/meta/reality",
    "https://raw.githubusercontent.com/soroushmirzaei/telegram-configs-collector/main/protocols/reality",
    "https://raw.githubusercontent.com/Surfboardv2ray/Proxy-sorter/main/sub/normal/reality",
    "https://raw.githubusercontent.com/yebekhe/TVC/main/subscriptions/xray/normal/reality",
    
    # VLESS & Multi-protocol Iran-tested Sources
    "https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vless.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/trojan.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/ss.txt",
    "https://raw.githubusercontent.com/soroushmirzaei/telegram-configs-collector/main/protocols/vless",
    "https://raw.githubusercontent.com/soroushmirzaei/telegram-configs-collector/main/protocols/trojan",
    "https://raw.githubusercontent.com/mohamadfg-dev/telegram-v2ray-configs-collector/refs/heads/main/category/vless.txt",
    "https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/subscriptions/filtered/subs/vless.txt",
    "https://raw.githubusercontent.com/F0rc3Run/F0rc3Run/main/splitted-by-protocol/vless.txt",
    "https://raw.githubusercontent.com/V2RayRoot/V2RayConfig/refs/heads/main/Config/vless.txt",
    "https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/refs/heads/main/Protocols/vless.txt",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/sub/vless.txt",
    "https://raw.githubusercontent.com/10ium/ScrapeAndCategorize/refs/heads/main/output_configs/Vless.txt",
    "https://raw.githubusercontent.com/10ium/MihomoSaz/main/Sublist/arshiacomplus/v2rayExtractor_vless.yaml",
    "https://raw.githubusercontent.com/mahsanet/MahsaZero/master/sub.txt",
    "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/Vless-Reality-White-Lists-Rus-Mobile.txt",
]

def fetch_single_url(url: str) -> List[str]:
    configs = []
    try:
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'v2rayN/6.42 Mozilla/5.0'}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode('utf-8', errors='ignore').strip()

        # Handle Base64 encoded subscriptions
        if '://' not in text:
            try:
                padded = text + '=' * ((4 - len(text) % 4) % 4)
                decoded = base64.b64decode(padded).decode('utf-8', errors='ignore')
                if '://' in decoded:
                    text = decoded
            except Exception:
                pass

        # Extract all supported URIs
        matches = re.findall(r'(?:vless|trojan|ss|vmess|hy2|hysteria2)://[^\s\"\'<>]+', text)
        for m in matches:
            cleaned = m.strip()
            if cleaned:
                configs.append(cleaned)
    except Exception as e:
        print(f"⚠️ Source failed {url[:60]}...: {e}")
    return configs

def is_clean_candidate(uri: str) -> bool:
    """Pre-filters configs that will fail or are banned in Iran."""
    lower = uri.lower()
    
    # 1. Plain unencrypted HTTP on standard HTTP ports is blocked in Iran
    if 'security=none' in lower and ('port=80' in lower or ':80?' in lower or ':8080?' in lower or ':2095?' in lower or ':8880?' in lower):
        return False

    # 2. Reality must have public key (pbk)
    if 'security=reality' in lower and 'pbk=' not in lower:
        return False

    # 3. Discard localhost or private network links
    if '@127.0.0.1' in lower or '@localhost' in lower or '@0.0.0.0' in lower:
        return False

    return True

def dedupe_key(uri: str) -> str:
    """Extracts fundamental network identity of a config."""
    try:
        url_part = uri.split('#')[0]
        parsed = urllib.parse.urlparse(url_part)
        proto = parsed.scheme.lower()
        netloc = parsed.netloc.split('@')[-1].lower()
        query = urllib.parse.parse_qs(parsed.query)
        sni = query.get('sni', [''])[0].strip().lower()
        pbk = query.get('pbk', [''])[0].strip()
        path = query.get('path', [''])[0].strip().lower()
        return f"{proto}:{netloc}:{sni}:{pbk}:{path}"
    except Exception:
        return uri.split('#')[0].lower()

def main():
    out_file = sys.argv[1] if len(sys.argv) > 1 else "raw_candidates.txt"
    print(f"📥 Harvester starting for {len(SOURCES)} sources...")

    all_raw: List[str] = []
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch_single_url, u): u for u in SOURCES}
        for fut in as_completed(futures):
            res = fut.result()
            all_raw.extend(res)

    print(f"📦 Total raw configs collected: {len(all_raw)}")

    # Pre-filter and deduplicate
    seen_keys: Set[str] = set()
    clean_candidates: List[str] = []

    for raw in all_raw:
        if not is_clean_candidate(raw):
            continue
        key = dedupe_key(raw)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        clean_candidates.append(raw)

    print(f"✨ Clean unique candidate configs: {len(clean_candidates)}")

    with open(out_file, 'w', encoding='utf-8') as f:
        for c in clean_candidates:
            f.write(c + '\n')

    print(f"✅ Successfully written to {out_file}")

if __name__ == '__main__':
    main()
