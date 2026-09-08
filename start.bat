@echo off
chcp 65001 >nul
cls
echo.
echo ╔════════════════════════════════════════╗
echo ║   متجرك الأون لاين                    ║
echo ║   🛍️  Online Store                    ║
echo ╚════════════════════════════════════════╝
echo.

if not exist node_modules (
    echo 📦 تثبيت الحزم للمرة الأولى...
    echo Installing packages for the first time...
    echo.
    call npm install
    echo.
)

echo ✅ تشغيل الخادم...
echo ✅ Starting server...
echo.
echo 🌐 الروابط:
echo.
echo 👨‍💼 Admin Dashboard: http://localhost:3000/admin.html
echo 🛒 Store:          http://localhost:3000/store.html
echo.
echo 💡 اضغط Ctrl+C لإيقاف الخادم
echo 💡 Press Ctrl+C to stop the server
echo.
echo ════════════════════════════════════════
echo.

call npm start
pause
