# Actual candidate installer + mocked Scheduler; no real task or StateRoot.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$self = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$global:fakeTasks = @{}
$global:observed = @()
function Get-ScheduledTask {
  param([string]$TaskPath, [string]$TaskName)
  $global:observed += $TaskName
  $spec = $global:fakeTasks[$TaskName]
  if (-not $spec) { return $null }
  return [pscustomobject]@{
    TaskName = $TaskName; TaskPath = '\'
    Actions = @([pscustomobject]@{ Execute = $spec.Launcher; Arguments = '' })
    Principal = [pscustomobject]@{ UserId = $self }
  }
}
function schtasks.exe { throw 'Installer attempted Scheduler mutation during early refusal' }
function ExpectRefusal([string]$edition, [hashtable]$specs, [bool]$foreign) {
  $state = Join-Path ([IO.Path]::GetTempPath()) ('memhub-early-check-' + [guid]::NewGuid().ToString('N'))
  $global:fakeTasks = @{}
  $global:observed = @()
  foreach ($name in $specs.Keys) {
    $global:fakeTasks[$name] = [pscustomobject]@{
      Launcher = Join-Path (Join-Path $state 'runtime') $specs[$name]
    }
  }
  if ($foreign) {
    $first = @($specs.Keys | Sort-Object)[0]
    $global:fakeTasks[$first].Launcher = 'C:\foreign\unrelated.cmd'
  }
  $message = ''
  try {
    & (Join-Path $repo "editions\$edition\windows\install.ps1") -StateRoot $state -SkipBuild
  } catch { $message = $_.Exception.Message }
  $expected = if ($foreign) { 'another launcher' } else { 'Legacy Memhub tasks' }
  if ($message -notmatch $expected) { throw "Unexpected early refusal [$edition]: $message" }
  if (Test-Path -LiteralPath $state) { throw "[$edition] installer created StateRoot before ownership check" }
  if ($global:observed.Count -eq 0) { throw "[$edition] did not inspect Task Scheduler" }
}
$editions = @{
  server = @{ 'Memhub-Server-Memory' = 'memory-server.cmd'; 'Memhub-Server' = 'gateway-server.cmd' }
  local = @{ 'Memhub-Memory' = 'memory.cmd'; 'Memhub-Local' = 'gateway.cmd'; 'Memhub-Bridge' = 'bridge.cmd' }
}
foreach ($edition in @('server','local')) {
  ExpectRefusal $edition $editions[$edition] $false
  ExpectRefusal $edition $editions[$edition] $true
  Write-Output "windows-installer-early-legacy-guard-e2e: ok edition=$edition scheduler=shim no_state_created=true"
}
