@echo off
REM Local dev server: its own database with demo data, web rebuilt on save, server restarted on Python changes.
REM   dev.bat           start (seeds demo data the first time)
REM   dev.bat --reset   start over with fresh demo data
title Cutline Dev
cd /d "%~dp0"
if exist "venv\Scripts\activate.bat" call venv\Scripts\activate.bat
if not exist "web\node_modules" (
    pushd web
    call npm ci --no-audit --no-fund
    popd
)
python dev_server.py %*
