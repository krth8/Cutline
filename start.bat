@echo off
title Cutline Server
cd /d "%~dp0"

REM Check if venv exists
if not exist "venv\Scripts\activate.bat" (
    echo Virtual environment not found.
    echo Running install.bat first...
    call install.bat
    exit /b
)

REM Activate and start
call venv\Scripts\activate.bat

REM Build the web bundle once if it is missing (needs Node.js)
if not exist "static\dist\pages.js" (
    where node >nul 2>&1
    if errorlevel 1 (
        echo [WARN] Node.js not found - starting without the new web interface.
        echo        Install Node.js 20+ from https://nodejs.org to get it.
    ) else (
        echo Building the web interface...
        pushd web
        if not exist "node_modules" call npm ci --no-audit --no-fund
        call npm run build
        popd
    )
)

echo.
echo   Cutline Server
echo   http://localhost:8099
echo   Press Ctrl+C to stop
echo.

python server.py
pause
