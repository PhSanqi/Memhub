$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\scripts\windows-task-ownership.ps1")
$state = Join-Path ([IO.Path]::GetTempPath()) "memhub-task-ownership-qa"
$runtime = Join-Path $state "runtime"
$self = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function FakeTask([string]$name, [string]$launcher, [string]$principal = $self) {
  return [pscustomobject]@{
    TaskName = $name
    TaskPath = "\"
    Actions = @([pscustomobject]@{ Execute = $launcher; Arguments = "" })
    Principal = [pscustomobject]@{ UserId = $principal }
  }
}
function ExpectRefusal([scriptblock]$action, [string]$pattern) {
  $caught = $false
  try { & $action | Out-Null } catch {
    if ($_.Exception.Message -notmatch $pattern) { throw }
    $caught = $true
  }
  if (-not $caught) { throw "Expected fail-closed result: $pattern" }
}
$script:fakeTasks = @{}
function Get-MemhubInstallTask {
  param([string]$Name)
  return $script:fakeTasks[$Name]
}
function schtasks.exe {
  throw "No Task Scheduler mutation is allowed by this test"
}
$managedName = "Memhub-Stack"
$managedLauncher = Join-Path $runtime "stack.cmd"
$script:fakeTasks[$managedName] = FakeTask $managedName $managedLauncher
$matched = @(Assert-MemhubInstallTaskSet -StateRoot $state)
if ($matched.Count -ne 1 -or $matched[0] -cne $managedName) {
  throw "Verified owner was not recognized"
}
# Exact path, principal, one action and empty arguments are mandatory.
$script:fakeTasks[$managedName].Actions[0].Execute = Join-Path $runtime "another.cmd"
ExpectRefusal { Assert-MemhubInstallTaskSet -StateRoot $state } "another launcher"
$script:fakeTasks[$managedName] = FakeTask $managedName $managedLauncher
$script:fakeTasks[$managedName].Actions[0].Arguments = "/c something"
ExpectRefusal { Assert-MemhubInstallTaskSet -StateRoot $state } "unexpected action"
$script:fakeTasks[$managedName] = FakeTask $managedName $managedLauncher "S-1-5-18"
ExpectRefusal { Assert-MemhubInstallTaskSet -StateRoot $state } "another user"
$script:fakeTasks[$managedName] = FakeTask $managedName $managedLauncher
$script:fakeTasks["Memhub-Server"] = FakeTask "Memhub-Server" (Join-Path $runtime "gateway-server.cmd")
ExpectRefusal { Assert-MemhubInstallTaskSet -StateRoot $state } "Legacy Memhub tasks"
$script:fakeTasks.Remove("Memhub-Server")
# Re-read immediately before removal: a modified registration must never be deleted.
$script:fakeTasks[$managedName].Actions[0].Execute = Join-Path $runtime "changed.cmd"
ExpectRefusal { Remove-MemhubVerifiedStackTask -Name $managedName -Launcher $managedLauncher } "another launcher"
$script:fakeTasks[$managedName] = FakeTask $managedName $managedLauncher
$script:taskCalls = @()
function schtasks.exe {
  $script:taskCalls += ($args -join " ")
  $global:LASTEXITCODE = 0
}
Remove-MemhubVerifiedStackTask -Name $managedName -Launcher $managedLauncher
if ($script:taskCalls.Count -ne 2 -or
    $script:taskCalls[0] -ne "/End /TN $managedName" -or
    $script:taskCalls[1] -ne "/Delete /F /TN $managedName") {
  throw "Verified task removal did not target the exact expected registration"
}
$script:fakeTasks.Clear()
$local = @(Assert-MemhubInstallTaskSet -StateRoot $state)
if ($local.Count -ne 0) { throw "Absent tasks unexpectedly reported as owned" }
# v0.2.2 Complete uses memory.cmd/gateway.cmd/bridge.cmd for Local, but
# memory-server.cmd/gateway-server.cmd for Server. Identifying a legitimate
# legacy registration must report the migration gate, not a foreign action.
foreach ($entry in @(
  @{ Name = "Memhub-Memory"; File = "memory.cmd" },
  @{ Name = "Memhub-Local"; File = "gateway.cmd" },
  @{ Name = "Memhub-Bridge"; File = "bridge.cmd" }
)) {
  $script:fakeTasks[$entry.Name] = FakeTask $entry.Name (Join-Path $runtime $entry.File)
}
ExpectRefusal { Assert-MemhubInstallTaskSet -StateRoot $state } "Legacy Memhub tasks"
$script:fakeTasks["Memhub-Local"].Actions[0].Execute = Join-Path $runtime "gateway-server.cmd"
ExpectRefusal { Assert-MemhubInstallTaskSet -StateRoot $state } "another launcher"
$script:fakeTasks.Clear()
Write-Output "memhub-windows-task-ownership-e2e: ok (no real scheduler changes)"
