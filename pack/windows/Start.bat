@echo off
rem SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
rem SPDX-License-Identifier: AGPL-3.0-only
rem
rem Double-click to host a co-op game on this PC. Keep the window open while you play; close it to stop.

title PokeRogue Co-op
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\start.ps1" %*
if errorlevel 1 pause
