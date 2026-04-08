@echo off
echo ╔══════════════════════════════════════════╗
echo ║     Aetherforge — Build Executable       ║
echo ╚══════════════════════════════════════════╝
echo.
cd /d "%~dp0"

:: Disable code-signing auto-discovery.
:: Without this, electron-builder downloads winCodeSign which contains
:: macOS .dylib symlinks that Windows cannot extract without admin/Dev Mode.
set CSC_IDENTITY_AUTO_DISCOVERY=false

:: Clear any corrupted winCodeSign cache from previous attempts
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
    echo Clearing winCodeSign cache...
    rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" 2>nul
)

echo [1/3] Installing / updating dependencies...
call npm install
if errorlevel 1 ( echo ERROR: npm install failed. & pause & exit /b 1 )

echo.
echo [2/3] Compiling TypeScript...
call npm run build
if errorlevel 1 ( echo ERROR: TypeScript build failed. & pause & exit /b 1 )

echo.
echo [3/3] Packaging with electron-builder...
call npx electron-builder --win --x64
if errorlevel 1 ( echo ERROR: electron-builder failed. & pause & exit /b 1 )

echo.
echo ══════════════════════════════════════════════
echo   Done!  Your files are in the release\ folder:
echo.
echo   Installer : release\Aetherforge Setup 1.0.0.exe
echo   Portable  : release\Aetherforge 1.0.0.exe
echo ══════════════════════════════════════════════
echo.
echo NOTE: Python must be installed on the target machine with:
echo   pip install fastapi "uvicorn[standard]" ollama pydantic
echo Ollama must also be running when you launch the app.
echo.
pause
