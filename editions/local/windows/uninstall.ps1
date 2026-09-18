param([switch]$PurgeData, [string]$StateRoot = "$env:LOCALAPPDATA\Memhub")
$ErrorActionPreference = "SilentlyContinue"
foreach ($Task in @("Memhub-Bridge","Memhub-Local","Memhub-Memory")) {
  & schtasks.exe /End /TN $Task | Out-Null
  & schtasks.exe /Delete /F /TN $Task | Out-Null
}
if ($PurgeData) { Remove-Item -Recurse -Force $StateRoot }
Write-Host "Memhub Local Edition tasks removed. Data kept unless -PurgeData was supplied."
