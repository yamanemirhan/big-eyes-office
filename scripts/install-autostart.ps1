# Starts the Big Eyes Office supervisor now and at every Windows login, without a window.
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'Big Eyes Office.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcut)
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -Command `"Start-Process -FilePath '$node' -ArgumentList 'scripts\supervisor.mjs' -WorkingDirectory '$root' -WindowStyle Hidden`""
$lnk.WorkingDirectory = $root
$lnk.WindowStyle = 7
$lnk.Description = 'Big Eyes Office supervisor'
$lnk.Save()
Start-Process -FilePath $node -ArgumentList 'scripts\supervisor.mjs' -WorkingDirectory $root -WindowStyle Hidden
Write-Host "Big Eyes Office now starts at login. It is starting now: open http://localhost:47800 in a minute."
Write-Host "Shortcut: $shortcut"
