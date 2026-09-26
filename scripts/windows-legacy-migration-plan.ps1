# Read-only split-task -> managed-stack decision artifact. Not an executor.
param(
  [ValidateSet('local', 'server')][string]$Mode = 'server',
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub",
  [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
if (-not $LibraryOnly) {
  . (Join-Path $PSScriptRoot 'windows-legacy-migration-audit.ps1') -LibraryOnly
}

function New-MemhubLegacyMigrationPlan {
  param([Parameter(Mandatory)]$Audit)
  if ($Audit.detected_task_layout -ne 'split-task' -or
      $Audit.inspection_only -ne $true -or
      $Audit.authorized_to_migrate -ne $false -or
      $Audit.installed_source_revision_verified -ne $false -or
      $Audit.mode -notin @('server','local')) {
    throw 'Unverified or non-read-only legacy evidence; refusing migration plan'
  }
  $expected = if ($Audit.mode -eq 'server') {
    @('Memhub-Server-Memory','Memhub-Server')
  } else { @('Memhub-Memory','Memhub-Local','Memhub-Bridge') }
  $tasks = @($Audit.legacy_tasks)
  if ($tasks.Count -ne $expected.Count -or
      @($tasks | Where-Object { $_.task -notin $expected }).Count) {
    throw 'Incomplete or foreign split-task evidence'
  }
  foreach ($name in $expected) {
    if (@($tasks | Where-Object { $_.task -eq $name }).Count -ne 1) {
      throw 'Duplicate or missing split-task evidence'
    }
  }
  if ($Audit.memory_config_sha256 -notmatch '^[a-f0-9]{64}$' -or
      [string]::IsNullOrWhiteSpace([string]$Audit.state_root)) {
    throw 'Legacy config or StateRoot evidence is unavailable'
  }
  $blockers = @(
    'fresh-explicit-authorization-required',
    'installed-package-provenance-unverified',
    'task-xml-rollback-backup-unverified',
    'task-to-PID-ownership-unverified',
    'isolated-real-cross-version-rollback-unverified'
  )
  $summary = @($tasks | ForEach-Object {
    if ($_.task_to_pid_verified -ne $false -or
        $_.task_xml_sha256 -notmatch '^[a-f0-9]{64}$' -or
        $_.launcher_sha256 -notmatch '^[a-f0-9]{64}$') {
      throw 'Unverifiable task evidence'
    }
    if ($_.process_candidates_ambiguous) {
      $blockers += ('ambiguous-process:' + $_.task)
    }
    [pscustomobject]@{
      task = $_.task
      task_xml_sha256 = $_.task_xml_sha256
      launcher_sha256 = $_.launcher_sha256
      task_to_pid_verified = $false
    }
  })
  $evidence = [ordered]@{
    layout = 'split-task'
    mode = $Audit.mode
    state_root = [string]$Audit.state_root
    memory_config_sha256 = $Audit.memory_config_sha256
    tasks = $summary
  }
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = ([BitConverter]::ToString($hash.ComputeHash(
      [Text.Encoding]::UTF8.GetBytes(($evidence | ConvertTo-Json -Compress -Depth 6))
    ))).Replace('-','').ToLowerInvariant()
  } finally { $hash.Dispose() }
  return [pscustomobject]@{
    plan_format = 'memhub-split-task-readonly-v1'
    evidence_sha256 = $digest
    evidence = $evidence
    blockers = $blockers
    ready_to_apply = $false
    authorized_to_migrate = $false
    require_fresh_evidence_at_execution = $true
    phases = @(
      'Back up exact task XML and launchers securely, without exposing credentials.',
      'Verify installed source provenance, task principal and exact StateRoot.',
      'Prove Task-to-PID identity (SID, process start, executable and full argv).',
      'Only after separate approval, stop verified old owners without name/path scanning.',
      'Verify old listeners released and candidate preflight passes before any task replacement.',
      'Verify configuration, credentials, account binding, protected DB and authenticated endpoints.',
      'If a gate fails, restore backed-up XML, launcher, config and compatible package; never rerun the historical installer as rollback (it regenerates the Core token and overwrites configuration), and never purge data.'
    )
  }
}

if (-not $LibraryOnly) {
  $audit = Get-MemhubLegacyMigrationAudit -Mode $Mode -StateRoot $StateRoot
  New-MemhubLegacyMigrationPlan -Audit $audit | ConvertTo-Json -Depth 8
}
