@echo off
rem Removes the login shortcut and stops the background supervisor and server.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Big Eyes Office.lnk" 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'supervisor\.mjs|server\\src\\main\.ts' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Big Eyes Office no longer starts at login, and it has been stopped.
pause
