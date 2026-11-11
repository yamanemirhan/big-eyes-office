@echo off
rem Double-click once. Starts Big Eyes Office in the background now and at every login.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
pause
