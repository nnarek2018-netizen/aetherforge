@echo off
echo ╔══════════════════════════════════════╗
echo ║       Aetherforge — Setup            ║
echo ╚══════════════════════════════════════╝
echo.

echo [1/2] Installing Python backend dependencies...
pip install fastapi "uvicorn[standard]" ollama pydantic
if errorlevel 1 (
    echo ERROR: pip install failed. Make sure Python is in PATH.
    pause & exit /b 1
)

echo.
echo [2/2] Installing Node.js frontend dependencies...
npm install
if errorlevel 1 (
    echo ERROR: npm install failed. Make sure Node.js is in PATH.
    pause & exit /b 1
)

echo.
echo ✓ Setup complete.  Run start.bat to launch Aetherforge.
pause
