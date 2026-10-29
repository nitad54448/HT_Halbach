@echo off
setlocal
cd /d "%~dp0"
title Halbach Hall Workstation Service

echo ========================================================
echo       Starting Halbach Hall Workstation Service
echo ========================================================
echo.
echo Starting local service on http://127.0.0.1:8765 ...
echo Opening workstation interface in your default browser...
echo.

start http://127.0.0.1:8765

powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0rust-backend\start.ps1' -ServeUi"
if errorlevel 1 (
    echo.
    echo Service stopped with an error code.
    pause
)

