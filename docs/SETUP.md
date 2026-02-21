# 🚀 راه‌اندازی کامل

## پیش‌نیازها

- اکاؤنت GitHub
- دسترسی به settings مخزن

## مراحل نصب

### 1️⃣ مخزن ایجاد شده

مخزن هم‌اکنون فعال است: `https://github.com/miraali1372/mirsub`

### 2️⃣ فایل‌های پروژه

تمام فایل‌های لازم قبلاً اضافه شده‌اند:

```
.github/workflows/update-sub.yml  ✅
test_configs.py                   ✅
README.md                         ✅
.gitignore                        ✅
docs/SETUP.md                     ✅
```

### 3️⃣ اولین اجرا

#### گزینه الف: Workflow دستی

1. به `https://github.com/miraali1372/mirsub/actions` برویم
2. **Update Subscription** را انتخاب کنیم
3. **Run workflow** را کلیک کنیم

#### گزینه ب: منتظر اولین زمان‌بندی

- workflow هر ساعت در دقیقه 0 اجرا می‌شود

### 4️⃣ بررسی نتایج

بعد از اولین اجرا:

1. ✅ `subscription.txt` باید آپدیت شود
2. ✅ Actions log باید نتایج را نشان دهد
3. ✅ لینک Raw کار کند

## 🔗 استفاده نهایی

### URL برای کلاینت‌ها:
```
https://raw.githubusercontent.com/miraali1372/mirsub/main/subscription.txt
```

### مثال استفاده:

**Sing-Box:**
```json
{
  "outbounds": [
    {
      "type": "vless",
      "server": "example.com",
      "server_port": 443,
      "uuid": "..."
    }
  ]
}
```

**V2Ray:**
- Settings → Subscription Manager
- Add: https://raw.githubusercontent.com/miraali1372/mirsub/main/subscription.txt

**Clash:**
- Profiles → Add Profile
- URL: https://raw.githubusercontent.com/miraali1372/mirsub/main/subscription.txt

## 🐛 عیب‌یابی

### مشکل: Workflow fail می‌شود

**حل:**
- Action logs را بررسی کنید
- بررسی کنید `test_configs.py` executable است
- `curl` و `bash` نصب باشند

### مشکل: هیچ کانفیگ معتبری نیست

**حل:**
- منبع اصلی (sevcator) دسترس‌پذیر باشد
- تایم‌اوت را بیشتر کنید
- فایل `unique.txt` خالی نیست

### مشکل: Commit fail می‌شود

**حل:**
- Branch protection rules را بررسی کنید
- GITHUB_TOKEN اجازه push داشته باشد
- No conflicting rules در settings

## 📊 نظارت

### چگونه logs را ببینم:

1. به `Actions` tab برویم
2. **Update Subscription** را انتخاب کنیم
3. آخرین run را کلیک کنیم
4. هر step را بررسی کنیم

### میانبر اجرا:

```bash
# اگر بخواهید محلی تست کنید:
python3 test_configs.py
```

## ✅ لیست بررسی

- [ ] مخزن ایجاد شد
- [ ] تمام فایل‌ها اضافه شدند
- [ ] Workflow اولین بار اجرا شد
- [ ] `subscription.txt` آپدیت شد
- [ ] لینک Raw کار می‌کند
- [ ] کلاینت شما subscription را قبول کرد

## 📞 کمک بیشتر

- سوالات: [GitHub Issues](https://github.com/miraali1372/mirsub/issues)
- درباره ما: [README.md](../README.md)

---

**راه‌اندازی کامل ✅**