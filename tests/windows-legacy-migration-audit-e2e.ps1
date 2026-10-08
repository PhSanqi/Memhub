# Pure fixture: actual PowerShell implementation, no real Task Scheduler calls.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\scripts\windows-legacy-migration-audit.ps1") -LibraryOnly
. (Join-Path $PSScriptRoot "..\scripts\windows-legacy-migration-plan.ps1") -LibraryOnly
$root = Join-Path ([IO.Path]::GetTempPath()) ("memhub-legacy-readonly-" + [guid]::NewGuid().ToString("N"))
$runtime = Join-Path $root "runtime"
$memory = Join-Path $root "memory"
$self = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$token = "a" * 64
$script:fakeTasks = @{}
$script:fakeProcesses = @()
$script:processSnapshotReads = 0
$script:xmlVariant = ''
$script:xmlDrift = $false
$script:xmlReads = @{}
function Get-MemhubInstallTask { param([string]$Name) return $script:fakeTasks[$Name] }
function Get-MemhubLegacyProcessSnapshot {
  $script:processSnapshotReads++
  return $script:fakeProcesses
}
function schtasks.exe { throw "Read-only audit must not mutate Task Scheduler" }
function Export-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskPath, [string]$TaskName)
  if ($TaskPath -ne '\' -or -not $script:fakeTasks.ContainsKey($TaskName)) {
    throw "Unexpected task XML lookup"
  }
  $task = $script:fakeTasks[$TaskName]
  $command = [Security.SecurityElement]::Escape($task.Actions[0].Execute)
  $script:xmlReads[$TaskName] = [int]$script:xmlReads[$TaskName] + 1
  $trigger = if ($script:xmlVariant -eq 'wrong-trigger') { 'TimeTrigger' } else { 'LogonTrigger' }
  $extra = if ($script:xmlDrift -and $script:xmlReads[$TaskName] -gt 1) { '<Enabled>false</Enabled>' } else { '' }
  return '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><' + $trigger +
    '/></Triggers><Actions><Exec><Command>' + $command + '</Command></Exec></Actions>' + $extra + '</Task>'
}
function FakeTask([string]$name, [string]$launcher) {
  [pscustomobject]@{ TaskName = $name; TaskPath = "\"; Actions = @([pscustomobject]@{ Execute = $launcher; Arguments = "" }); Principal = [pscustomobject]@{ UserId = $self } }
}
function ExpectRefusal([scriptblock]$action, [string]$pattern) {
  $caught = $false
  try { & $action | Out-Null } catch {
    if ($_.Exception.Message -notmatch $pattern) { throw }
    $caught = $true
  }
  if (-not $caught) { throw "Expected fail-closed result: $pattern" }
}
function WriteLegacy([string]$mode) {
  $script:fakeTasks.Clear()
  if ($mode -eq "server") {
    $entries = @(
      @{ Name = "Memhub-Server-Memory"; File = "memory-server.cmd"; Kind = "memory" },
      @{ Name = "Memhub-Server"; File = "gateway-server.cmd"; Kind = "gateway" }
    )
  } else {
    $entries = @(
      @{ Name = "Memhub-Memory"; File = "memory.cmd"; Kind = "memory" },
      @{ Name = "Memhub-Local"; File = "gateway.cmd"; Kind = "gateway" },
      @{ Name = "Memhub-Bridge"; File = "bridge.cmd"; Kind = "bridge" }
    )
  }
  foreach ($entry in $entries) {
    $launcher = Join-Path $runtime $entry.File
    $source = switch ($entry.Kind) {
      "memory" { '@echo off' + "`r`n" + ('"C:\node.exe" "C:\package\vendor\memory-core\src\server\index.js" --config "{0}" --host 127.0.0.1 --port 18960 --db "{1}"' -f (Join-Path $root 'memory-config.yaml'), (Join-Path $memory 'memory.sqlite')) }
      "gateway" { '@echo off' + "`r`n" + ('set "MEMHUB_MEMORY_TOKEN={0}"' -f $token) + "`r`n" + ('set "MEMHUB_STATE_ROOT={0}"' -f (Join-Path $root 'server')) + "`r`n" + ('"C:\node.exe" "C:\package\dist\mcp.js" --http 3001 --state-root "{0}"' -f (Join-Path $root 'server')) }
      "bridge" { '@echo off' + "`r`n" + ('set "MEMHUB_BRIDGE_HOME={0}"' -f $root) + "`r`n" + '"C:\node.exe" "C:\package\dist\bridge.js" serve --port 17861' }
    }
    Set-Content -LiteralPath $launcher -Value $source -Encoding ASCII
    $script:fakeTasks[$entry.Name] = FakeTask $entry.Name $launcher
  }
}

try {
  New-Item -ItemType Directory -Force -Path $runtime,$memory | Out-Null
  # An uninstalled host must not be characterized as a failed migration or
  # require an otherwise nonexistent Memory config.
  $script:fakeTasks.Clear()
  ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode server -StateRoot $root } 'No eligible legacy Memhub tasks found'
  ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode local -StateRoot $root } 'No eligible legacy Memhub tasks found'
  if ($script:processSnapshotReads -ne 0) {
    throw 'Uninstalled host must not query all Node processes'
  }
  $script:fakeTasks['Memhub-Server-Memory'] = FakeTask 'Memhub-Server-Memory' (Join-Path $runtime 'memory-server.cmd')
  ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode server -StateRoot $root } 'Partial legacy task set'
  if ($script:processSnapshotReads -ne 0) {
    throw 'Partial task set must not scan processes'
  }
  $script:fakeTasks.Clear()
  Set-Content -LiteralPath (Join-Path $root 'memory-config.yaml') -Encoding UTF8 -Value ('{"memmyMemory":{"storage":{"token":"' + $token + '"}}}')
  Set-Content -LiteralPath (Join-Path $memory 'memory.sqlite') -Encoding ASCII -Value 'protected simulated database'
  foreach ($mode in @('server','local')) {
    WriteLegacy $mode
    $script:fakeProcesses = @()
    $script:xmlVariant = ''
    $script:xmlDrift = $false
    $script:xmlReads.Clear()
    $audit = Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root
    $expected = if ($mode -eq 'server') { 2 } else { 3 }
    if ($audit.legacy_tasks.Count -ne $expected -or -not $audit.inspection_only -or $audit.authorized_to_migrate -or
        $audit.detected_task_layout -ne 'split-task' -or $audit.installed_source_revision_verified) {
      throw "$mode read-only audit did not return the expected task evidence"
    }
    $json = $audit | ConvertTo-Json -Depth 8
    if ($json.Contains($token)) { throw "Audit leaked the Memory token" }
    $plan = New-MemhubLegacyMigrationPlan -Audit $audit
    if ($plan.ready_to_apply -or $plan.authorized_to_migrate -or
        $plan.evidence_sha256 -notmatch '^[a-f0-9]{64}$' -or
        $plan.evidence.tasks.Count -ne $expected -or
        $plan.blockers.Count -lt 5 -or
        ($plan | ConvertTo-Json -Depth 8).Contains($token)) {
      throw "$mode plan must be a credential-free, blocked decision artifact"
    }
    $secondPlan = New-MemhubLegacyMigrationPlan -Audit $audit
    if ($secondPlan.evidence_sha256 -ne $plan.evidence_sha256) {
      throw "$mode identical read-only evidence changed the plan digest"
    }
    $bad = $audit.PSObject.Copy()
    $bad.installed_source_revision_verified = $true
    ExpectRefusal { New-MemhubLegacyMigrationPlan -Audit $bad } 'Unverified or non-read-only'
    if (($audit.legacy_tasks | Where-Object { $_.task_to_pid_verified }).Count) {
      throw "Task-to-PID correlation must not be inferred from a command line"
    }
    if (($audit.legacy_tasks | Where-Object { $_.task_xml_sha256 -notmatch '^[a-f0-9]{64}$' }).Count) {
      throw "Audit did not hash every task XML"
    }
    # A tagged v0.2.2 managed-stack task can coexist with stale split-task
    # registrations. Do not treat this mixed lineage as a clean old install.
    $managedName = if ($mode -eq 'server') { 'Memhub-Server-Stack' } else { 'Memhub-Local-Stack' }
    $script:fakeTasks[$managedName] = FakeTask $managedName (Join-Path $runtime 'stack.cmd')
    ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'Managed stack task exists'
    $script:fakeTasks.Remove($managedName)
    $opposite = if ($mode -eq 'server') { 'Memhub-Bridge' } else { 'Memhub-Server' }
    $script:fakeTasks[$opposite] = FakeTask $opposite (Join-Path $runtime 'opposite.cmd')
    ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'Opposite-edition or mixed'
    $script:fakeTasks.Remove($opposite)
    # Identical Node image alone is not a match: require exact quoted binary
    # and entrypoint. Even a unique candidate remains unattributed to the task.
    $memoryFile = if ($mode -eq 'server') { 'memory-server.cmd' } else { 'memory.cmd' }
    $memorySource = Get-Content -LiteralPath (Join-Path $runtime $memoryFile) -Raw
    $commandLine = [regex]::Match($memorySource, '(?m)^"[^"\r\n]*node\.exe"\s+"[^"\r\n]+\.js".*$').Value.Trim()
    if (-not $commandLine) { throw "Test fixture Node command is missing" }
    $candidate = [pscustomobject]@{
      ProcessId = 12345; ParentProcessId = 555
      CreationDate = [datetime]'2026-09-26T10:00:00Z'
      ExecutablePath = 'C:\node.exe'; CommandLine = $commandLine
    }
    $decoy = [pscustomobject]@{
      ProcessId = 12346; ParentProcessId = 777
      CreationDate = [datetime]'2026-09-26T10:01:00Z'
      ExecutablePath = 'C:\node.exe'; CommandLine = '"C:\node.exe" "C:\package\other.js"'
    }
    $script:fakeProcesses = @($candidate, $decoy)
    $withCandidate = Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root
    if ($withCandidate.legacy_tasks[0].process_candidates.Count -ne 1 -or
        $withCandidate.legacy_tasks[0].process_candidates[0].pid -ne 12345 -or
        $withCandidate.legacy_tasks[0].task_to_pid_verified) {
      throw "Exact candidate was not recorded without ownership inference"
    }
    $script:fakeProcesses = @($candidate, $candidate.PSObject.Copy())
    $script:fakeProcesses[1].ProcessId = 12347
    $ambiguous = Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root
    if (-not $ambiguous.legacy_tasks[0].process_candidates_ambiguous) {
      throw "Duplicate exact process candidates must remain ambiguous"
    }
    $candidate.ExecutablePath = 'C:\unrelated\node.exe'
    $script:fakeProcesses = @($candidate)
    ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'executable path cannot be verified'
    $script:fakeProcesses = @()
    $script:xmlReads.Clear()
    $script:xmlVariant = 'wrong-trigger'
    ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'unexpected trigger/action'
    $script:xmlVariant = ''
    $script:xmlReads.Clear()
    $script:xmlDrift = $true
    ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'changed during audit'
    $script:xmlDrift = $false
    $script:xmlReads.Clear()
    $first = $audit.legacy_tasks[0].task
    $script:fakeTasks[$first].Actions[0].Execute = Join-Path $runtime 'foreign.cmd'
    ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'another launcher'
    $script:fakeTasks[$first].Actions[0].Execute = $audit.legacy_tasks[0].launcher
    if ($mode -eq 'server') {
      $gateway = Join-Path $runtime 'gateway-server.cmd'
      $original = Get-Content -LiteralPath $gateway -Raw
      Set-Content -LiteralPath $gateway -Encoding ASCII -Value ($original + "`r`n" + ('set "MEMHUB_MEMORY_TOKEN={0}"' -f $token))
      ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'ambiguous'
      Set-Content -LiteralPath $gateway -Encoding ASCII -Value ($original.Replace($token, ('b' * 64)))
      ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'inconsistent with Core'
    }
    $script:fakeTasks.Remove($first)
    ExpectRefusal { Get-MemhubLegacyMigrationAudit -Mode $mode -StateRoot $root } 'Partial legacy task set'
  }
  Write-Output 'memhub-windows-legacy-migration-audit-e2e: ok (server/local, read-only, no scheduler mutation)'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
