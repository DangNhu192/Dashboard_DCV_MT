@echo off
chcp 65001 >nul
title Dong Bo Len GitHub - Dashboard_DCV_MT
cd /d "%~dp0"

set "GIT_EXE=C:\Users\User\AppData\Local\github-copilot-git-2.53.0-4\cmd\git.exe"
if not exist "%GIT_EXE%" where git >nul 2>&1 && set "GIT_EXE=git"

echo ======================================================================
echo   DONG BO MA NGUON LEN GITHUB: DangNhu192/Dashboard_DCV_MT
echo ======================================================================

"%GIT_EXE%" add .
"%GIT_EXE%" commit -m "update: Dong bo ma nguon Web PWA tu dong"
"%GIT_EXE%" push origin main

echo ======================================================================
echo   HOAN TAT! Vercel se tu dong bat dau Build & Deploy ban moi.
echo ======================================================================
pause
