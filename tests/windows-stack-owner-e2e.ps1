# PowerShell execution of exact PID/start/executable/argv guard with a mocked
# read-only CIM snapshot. No real processes or Task Scheduler entries touched.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\windows-stack-owner.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('memhub-stack-owner-qa-' + [guid]::NewGuid().ToString('N'))
$lock = Join-Path $root '.server-stack.lock'
$node = 'C:\package\runtime\node\node.exe'
$entry = 'C:\package\scripts\run-stack.mjs'
$stateHome = 'C:\QA State\Memhub'
$script:creation = (Get-Date).ToUniversalTime().AddSeconds(-1)
$script:processes = @()
$script:ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId=12345') {
    throw 'Unexpected CIM query'
  }
  return $script:processes
}
function Invoke-CimMethod {
  [CmdletBinding()]
  param($InputObject, [string]$MethodName)
  if ($MethodName -ne 'GetOwnerSid') { throw 'Unexpected CIM method' }
  return [pscustomobject]@{ ReturnValue = 0; Sid = $script:ownerSid }
}
function ExpectRefusal([scriptblock]$action, [string]$reason) {
  $denied = $false
  try { & $action | Out-Null } catch {
    if ($_.Exception.Message -notmatch $reason) { throw }
    $denied = $true
  }
  if (-not $denied) { throw "Expected refusal: $reason" }
}
function Verify([string]$mode = 'server') {
  Assert-MemhubStackProcessOwner -LockPath $lock -NodePath $node -StackEntry $entry -Mode $mode -StateRoot $stateHome
}
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $owner = [pscustomobject]@{ pid = 12345; token = [guid]::NewGuid().ToString(); started_at = $script:creation.AddSeconds(1).ToString('o') }
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  $script:processes = @([pscustomobject]@{
    ProcessId = 12345
    CreationDate = $script:creation
    ExecutablePath = $node
    CommandLine = '"' + $node + '" "' + $entry + '" --mode server --home "' + $stateHome + '"'
  })
  $verified = Verify
  if ($verified.pid -ne 12345) { throw 'Exact owner PID did not verify' }
  $script:ownerSid = 'S-1-5-18'
  ExpectRefusal { Verify } 'another principal'
  $script:ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $script:processes[0].ExecutablePath = 'C:\other\node.exe'
  ExpectRefusal { Verify } 'executable differs'
  $script:processes[0].ExecutablePath = $node
  $script:processes[0].CommandLine = '"' + $node + '" "' + $entry + '" --mode local --home "' + $stateHome + '"'
  ExpectRefusal { Verify } 'argv differs'
  $script:processes[0].CommandLine = '"' + $node + '" "' + $entry + '" --mode server --home "' + $stateHome + '"'
  $script:processes[0].CreationDate = $script:creation.AddHours(-1)
  ExpectRefusal { Verify } 'PID/start time differs'
  $script:processes[0].CreationDate = $script:creation
  $script:processes = @()
  ExpectRefusal { Verify } 'missing or ambiguous'
  $script:processes = @([pscustomobject]@{
    ProcessId = 12345; CreationDate = $script:creation; ExecutablePath = $node
    CommandLine = '"' + $node + '" "' + $entry + '" --mode server --home "' + $stateHome + '"'
  })
  $owner.started_at = $script:creation.AddHours(1).ToString('o')
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  ExpectRefusal { Verify } 'PID/start time differs'
  $owner.started_at = 'not-a-date'
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  ExpectRefusal { Verify } 'invalid start timestamp'
  # A tagged managed-stack lock without identity metadata cannot authorize
  # a cross-release stop: its old executable/entrypoint differ from the
  # selected package. A newer owner with complete metadata can be verified
  # without executing any path obtained from the lock.
  $oldNode = 'C:\previous-release\runtime\node\node.exe'
  $oldEntry = 'C:\previous-release\scripts\run-stack.mjs'
  $owner.started_at = $script:creation.AddSeconds(1).ToString('o')
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  $script:processes[0].ExecutablePath = $oldNode
  $script:processes[0].CommandLine = '"' + $oldNode + '" "' + $oldEntry + '" --mode server --home "' + $stateHome + '"'
  ExpectRefusal { Verify } 'executable differs'
  $owner | Add-Member -NotePropertyName entrypoint -NotePropertyValue $oldEntry
  $owner | Add-Member -NotePropertyName exec_path -NotePropertyValue $oldNode
  $owner | Add-Member -NotePropertyName home -NotePropertyValue $stateHome
  $owner | Add-Member -NotePropertyName mode -NotePropertyValue 'server'
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  if ((Verify).pid -ne 12345) { throw 'Cross-release owner identity did not verify' }
  $owner.home = 'C:\different-state'
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  ExpectRefusal { Verify } 'another StateRoot'
  $owner.home = $stateHome
  $owner.mode = 'local'
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  ExpectRefusal { Verify } 'another StateRoot or edition'
  $owner.mode = 'server'
  $owner.entrypoint = 'C:\previous-release\other\run-stack.mjs'
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  ExpectRefusal { Verify } 'not a managed run-stack'
  $owner.entrypoint = $oldEntry
  $owner.exec_path = 'C:\imposter\node.exe'
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  ExpectRefusal { Verify } 'executable differs'
  $owner.exec_path = $oldNode
  $owner.PSObject.Properties.Remove('mode')
  $owner | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
  ExpectRefusal { Verify } 'partial identity metadata'
  Write-Output 'memhub-windows-stack-owner-e2e: ok (mock CIM, no process/task mutation)'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
