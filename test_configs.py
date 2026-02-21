#!/usr/bin/env python3
"""
تست و فیلتر کردن کانفیگ‌های VLESS
این اسکریپت کانفیگ‌های یکتا شده را تست می‌کند
"""

import subprocess
import sys
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

def test_config(config: str, timeout: int = 10) -> bool:
    """
    تست یک کانفیگ با استفاده از curl
    سعی می‌کند به URL موجود در کانفیگ متصل شود
    """
    try:
        # استخراج آدرس سرور از کانفیگ VLESS
        if not config.startswith("vless://"):
            return False
        
        # تست ساده: بررسی فرمت صحیح
        if "@" not in config:
            return False
        
        parts = config.split("@")
        if len(parts) < 2:
            return False
        
        # آدرس سرور و پورت را استخراج کن
        server_port = parts[1].split("?")[0]  # حذف query parameters
        
        if ":" not in server_port:
            return False
        
        server, port_str = server_port.rsplit(":", 1)
        
        try:
            port = int(port_str)
            if not (1 <= port <= 65535):
                return False
        except ValueError:
            return False
        
        # تست اتصال با timeout
        result = subprocess.run(
            ["timeout", str(timeout), "bash", "-c", f"echo > /dev/tcp/{server}/{port}"],
            capture_output=True,
            timeout=timeout + 2
        )
        
        return result.returncode == 0
        
    except Exception as e:
        return False

def main():
    input_file = "unique.txt"
    output_file = "result.txt"
    
    # بررسی وجود فایل ورودی
    if not Path(input_file).exists():
        print(f"خطا: فایل {input_file} یافت نشد")
        sys.exit(1)
    
    # خواندن تمام کانفیگ‌ها
    with open(input_file, "r", encoding="utf-8") as f:
        configs = [line.strip() for line in f if line.strip()]
    
    print(f"🔍 در حال تست {len(configs)} کانفیگ...")
    
    valid_configs = []
    
    # تست موازی (برای سرعت بیشتر)
    with ThreadPoolExecutor(max_workers=10) as executor:
        future_to_config = {executor.submit(test_config, config): config for config in configs}
        
        completed = 0
        for future in as_completed(future_to_config):
            config = future_to_config[future]
            completed += 1
            
            try:
                if future.result():
                    valid_configs.append(config)
                    print(f"✅ [{completed}/{len(configs)}] کانفیگ معتبر")
                else:
                    print(f"❌ [{completed}/{len(configs)}] کانفیگ نامعتبر")
            except Exception as e:
                print(f"⚠️  [{completed}/{len(configs)}] خطا: {str(e)}")
    
    # ذخیره نتایج
    with open(output_file, "w", encoding="utf-8") as f:
        for config in valid_configs:
            f.write(config + "\n")
    
    print(f"\n📊 نتیجه: {len(valid_configs)} کانفیگ معتبر از {len(configs)} کانفیگ")
    print(f"💾 فایل {output_file} با موفقیت ذخیره شد")

if __name__ == "__main__":
    main()