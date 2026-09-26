param([switch]$PurgeData, [string]$StateRoot = "$env:LOCALAPPDATA\Memhub")
$ErrorActionPreference = "Stop"
. (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path "scripts\windows-task-ownership.ps1")
$VerifiedStackTasks = @(Assert-MemhubInstallTaskSet -Mode local -StateRoot $StateRoot)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$BundledNode = @(
  (Join-Path $RepoRoot "runtime\node\node.exe"),
  (Join-Path $RepoRoot "runtime\node.exe"),
  $env:NODE
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$StackEntry = Join-Path $RepoRoot "scripts\run-stack.mjs"
$StackLock = Join-Path $StateRoot ".local-stack.lock"
if (Test-Path $StackLock) {
  if (-not $Node -or -not (Test-Path $StackEntry)) {
    throw "Memhub Local Stack is registered, but its Node/launcher is unavailable. Refusing unsafe removal."
  }
  . (Join-Path $RepoRoot "scripts\windows-stack-owner.ps1")
  Assert-MemhubStackProcessOwner -LockPath $StackLock -NodePath $Node -StackEntry $StackEntry -Mode local -StateRoot $StateRoot | Out-Null
  & $Node $StackEntry --mode local --home $StateRoot --action stop | Out-Null
  if ($LASTEXITCODE -ne 0 -or (Test-Path $StackLock)) {
    throw "Memhub Local Stack graceful stop did not finish. Refusing to terminate the parent without its children."
  }
}
foreach ($Task in $VerifiedStackTasks) {
  Remove-MemhubVerifiedStackTask -Name $Task -Launcher (Join-Path $StateRoot "runtime\stack-local.cmd")
}
if ($PurgeData) { Remove-Item -Recurse -Force $StateRoot }
Write-Host "Memhub Local Edition tasks removed. Data kept unless -PurgeData was supplied."
