@echo off
:: ─────────────────────────────────────────────────────────────────────────────
::  Curzon VoiceAI — Windows Setup Launcher
::  Double-click this file to run setup.ps1 with the correct permissions.
:: ─────────────────────────────────────────────────────────────────────────────
title Curzon VoiceAI Setup
echo.
echo  Launching Curzon VoiceAI Setup...
echo.

:: Run PowerShell setup script in the same directory
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  Setup encountered an error. See messages above.
    pause
)
