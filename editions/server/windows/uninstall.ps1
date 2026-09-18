param([switch]$PurgeData, [string]$StateRoot = "$env:LOCALAPPDATA\Memhub")
$ErrorActionPreference = "SilentlyContinue"
foreach ($Task in @("Memhub-Server","Memhub-Server-Memory")) {
  & schtasks.exe /End /TN $Task | Out-Null
  & schtasks.exe /Delete /F /TN $Task | Out-Null
}
if ($PurgeData) { Remove-Item -Recurse -Force $StateRoot }
Write-Host "Memhub Server Edition tasks removed. Data kept unless -PurgeData was supplied."
