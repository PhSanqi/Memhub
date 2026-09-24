param([switch]$PurgeData, [string]$StateRoot = "$env:LOCALAPPDATA\Memhub")
$ErrorActionPreference = "SilentlyContinue"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$BundledNode = Join-Path $RepoRoot "runtime\node.exe"
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$Node = if (Test-Path $BundledNode) { $BundledNode } elseif ($NodeCommand) { $NodeCommand.Source } else { $null }
$StackEntry = Join-Path $RepoRoot "scripts\run-stack.mjs"
$StackLock = Join-Path $StateRoot ".server-stack.lock"
if (Test-Path $StackLock) {
  if (-not $Node -or -not (Test-Path $StackEntry)) {
    throw "Memhub Server Stack is registered, but its Node/launcher is unavailable. Refusing unsafe removal."
  }
  & $Node $StackEntry --mode server --home $StateRoot --action stop | Out-Null
  if ($LASTEXITCODE -ne 0 -or (Test-Path $StackLock)) {
    throw "Memhub Server Stack graceful stop did not finish. Refusing to terminate the parent without its children."
  }
}
foreach ($Task in @("Memhub-Server-Stack","Memhub-Server","Memhub-Server-Memory")) {
  & schtasks.exe /End /TN $Task | Out-Null
  & schtasks.exe /Delete /F /TN $Task | Out-Null
}
if ($PurgeData) { Remove-Item -Recurse -Force $StateRoot }
Write-Host "Memhub Server Edition tasks removed. Data kept unless -PurgeData was supplied."
