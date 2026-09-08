# البدء السريع ⚡

## لـ Windows 🪟

### 1️⃣ اضغط مرتين على ملف `start.bat`

سيفتح Command Prompt ويشتغل كل حاجة تلقائياً!

### 2️⃣ انتظر لما تشوف:
```
✅ Server running on http://localhost:3000
```

### 3️⃣ اضغط على الروابط:
- **Admin**: http://localhost:3000/admin.html
- **Store**: http://localhost:3000/store.html

### لإيقاف الخادم:
اضغط `Ctrl + C` في نافذة Command Prompt

---

## لـ Mac/Linux 🍎🐧

### 1️⃣ افتح Terminal في مجلد المشروع

```bash
cd /path/to/estore
```

### 2️⃣ شغّل الملف:

```bash
./start.sh
```

### 3️⃣ انتظر لما تشوف:
```
✅ Server running on http://localhost:3000
```

### 4️⃣ اضغط على الروابط:
- **Admin**: http://localhost:3000/admin.html
- **Store**: http://localhost:3000/store.html

### لإيقاف الخادم:
اضغط `Ctrl + C` في Terminal

---

## بدون استخدام الـ Scripts 📝

### Windows / Mac / Linux:

```bash
# 1. فتح Terminal/Command Prompt في المجلد

# 2. تثبيت الحزم (المرة الأولى فقط)
npm install

# 3. تشغيل الخادم
npm start
```

---

## الخطوة الأولى بعد التشغيل 🚀

1. **افتح لوحة التحكم**
   ```
   http://localhost:3000/admin.html
   ```

2. **أكمل إعدادات البراند**
   - اسم متجرك
   - رقم واتس آب (مهم!)
   - وسائل التواصل الأخرى

3. **أضف منتجات**
   - اسم المنتج
   - السعر
   - الكمية
   - صورة (رابط)

4. **شوف متجرك**
   ```
   http://localhost:3000/store.html
   ```

---

## المشاكل الشائعة 🔧

### ❌ "npm: command not found"
**الحل:** ثبّت Node.js من [nodejs.org](https://nodejs.org)

### ❌ "Port 3000 is already in use"
**الحل:** أغلق برنامج يستخدم المنفذ 3000

### ❌ الصور لا تظهر
**الحل:** تأكد أن رابط الصورة صحيح والموقع يعمل

### ❌ الواتس لا ينفتح
**الحل:** تأكد من رقم الواتس `201012345678` (يبدأ بـ 20)

---

## التعديل السريع ✏️

### تغيير المنفذ (Port)
في `server.js`:
```javascript
const PORT = 3001; // غيّر 3000 إلى 3001 أو ما تريد
```

### تغيير ألوان الموقع
في `public/admin.html` و `public/store.html`:
```css
#667eea /* اللون الأزرق - غيّره كما تشاء */
```

---

**تمام! متجرك جاهز الآن! 🎉**

لو في مشكلة، اقرأ `README.md` للتفاصيل الكاملة.
