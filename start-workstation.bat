@echo off
setlocal
cd /d "%~dp0"
title Halbach Physical Properties Workstation

echo ========================================================
echo       Starting Halbach Physical Properties Workstation
echo ========================================================
echo.
echo Starting local service on http://127.0.0.1:8765 ...
echo The interface will open when the service is ready.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rust-backend\start.ps1" -ServeUi -OpenBrowser
if errorlevel 1 (
    echo.
    echo Service stopped with an error code.
    pause
)

