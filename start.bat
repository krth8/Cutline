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

echo.
echo   Cutline Server
echo   http://localhost:8099
echo   Press Ctrl+C to stop
echo.

python server.py
pause
