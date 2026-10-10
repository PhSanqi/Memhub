param(
  [switch]$PurgeData,
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub"
)
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
. (Join-Path $RepoRoot "scripts\windows-task-ownership.ps1")
$VerifiedStackTasks = @(Assert-MemhubInstallTaskSet -StateRoot $StateRoot)
$BundledNode = @(
  (Join-Path $RepoRoot "runtime\node\node.exe"),
  (Join-Path $RepoRoot "runtime\node.exe"),
  $env:NODE
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($BundledNode) { $BundledNode } elseif ($NodeCommand) { $NodeCommand.Source } else { $null }
$StackEntry = Join-Path $RepoRoot "scripts\run-stack.mjs"
$StackLock = Join-Path $StateRoot ".memhub-stack.lock"
if (Test-Path $StackLock) {
  if (-not $Node -or -not (Test-Path $StackEntry)) {
    throw "Memhub Stack is registered, but its Node/launcher is unavailable. Refusing unsafe removal."
  }
  . (Join-Path $RepoRoot "scripts\windows-stack-owner.ps1")
  Assert-MemhubStackProcessOwner -LockPath $StackLock -NodePath $Node -StackEntry $StackEntry -StateRoot $StateRoot | Out-Null
  & $Node $StackEntry --home $StateRoot --action stop | Out-Null
  if ($LASTEXITCODE -ne 0 -or (Test-Path $StackLock)) {
    throw "Memhub Stack graceful stop did not finish. Refusing unsafe removal."
  }
}
foreach ($Task in $VerifiedStackTasks) {
  Remove-MemhubVerifiedStackTask -Name $Task -Launcher (Join-Path $StateRoot "runtime\stack.cmd")
}
if ($PurgeData) { Remove-Item -Recurse -Force $StateRoot }
Write-Host "Memhub tasks removed. Data kept unless -PurgeData was supplied."
