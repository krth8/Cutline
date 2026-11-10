@echo off
setlocal enabledelayedexpansion
title Cutline - Full Installation

echo.
echo ╔════════════════════════════════════════════╗
echo ║       CUTLINE - Full Installation          ║
echo ╚════════════════════════════════════════════╝
echo.

REM ========== Check/Install Python ==========
echo [1/4] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo       Python not found. Installing via winget...
    winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo.
        echo [ERROR] Could not install Python automatically.
        echo         Please install Python 3.10+ manually from:
        echo         https://python.org/downloads
        echo.
        echo         Make sure to check "Add Python to PATH"!
        pause
        exit /b 1
    )
    echo       Python installed. Please restart this script.
    pause
    exit /b 0
) else (
    for /f "tokens=2" %%v in ('python --version 2^>^&1') do echo       Found Python %%v
)

REM ========== Check/Install FFmpeg ==========
echo.
echo [2/4] Checking FFmpeg...
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo       FFmpeg not found. Installing via winget...
    winget install Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo       [WARN] Could not install FFmpeg automatically.
        echo              Video thumbnails may not work.
        echo              Download manually: https://ffmpeg.org/download.html
    ) else (
        echo       FFmpeg installed successfully.
    )
) else (
    echo       FFmpeg found.
)

REM ========== Create Virtual Environment ==========
echo.
echo [3/4] Setting up Python environment...
if not exist "venv" (
    echo       Creating virtual environment...
    python -m venv venv
) else (
    echo       Virtual environment exists.
)

REM ========== Install Dependencies ==========
echo.
echo [4/4] Installing dependencies...
call venv\Scripts\activate.bat
pip install --upgrade pip -q
pip install -r requirements.txt -q

echo.
echo ╔════════════════════════════════════════════╗
echo ║         Installation Complete!             ║
echo ╠════════════════════════════════════════════╣
echo ║                                            ║
echo ║  To start the server:                      ║
echo ║    Double-click: start.bat                 ║
echo ║                                            ║
echo ║  Or run in terminal:                       ║
echo ║    venv\Scripts\activate                   ║
echo ║    python server.py                        ║
echo ║                                            ║
echo ║  Server URL: http://localhost:8099         ║
echo ║                                            ║
echo ╚════════════════════════════════════════════╝
echo.

set /p STARTSERVER="Start the server now? (Y/n): "
if /i "!STARTSERVER!"=="" set STARTSERVER=Y
if /i "!STARTSERVER!"=="Y" (
    echo.
    echo Starting Cutline...
    python server.py
)

pause
