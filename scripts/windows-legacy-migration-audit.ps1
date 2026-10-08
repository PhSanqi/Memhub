# Read-only v0.2.2 legacy Task Scheduler evidence. This script NEVER stops,
# deletes, creates or runs a task, and never stops a process. A matching report
# is not authorization to migrate: task XML/PID and rollback still need review.
param(
  [ValidateSet("local", "server")][string]$Mode = "server",
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub",
  [switch]$LibraryOnly
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-task-ownership.ps1")
. (Join-Path $PSScriptRoot "windows-memory-credentials.ps1")

function Get-MemhubLegacyTaskXmlEvidence {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Launcher
  )
  # Task Scheduler owns this XML; never emit its raw contents or write it to
  # disk as a side effect of inspection.
  $source = Export-ScheduledTask -TaskPath "\" -TaskName $Name -ErrorAction Stop
  if ([string]::IsNullOrWhiteSpace($source)) {
    throw "Legacy task $Name XML is missing; refusing migration audit"
  }
  try { [xml]$document = $source }
  catch { throw "Legacy task $Name XML is unreadable; refusing migration audit" }
  $triggers = @($document.SelectNodes("/*[local-name()='Task']/*[local-name()='Triggers']/*[local-name()='LogonTrigger']"))
  $allTriggers = @($document.SelectNodes("/*[local-name()='Task']/*[local-name()='Triggers']/*"))
  $actions = @($document.SelectNodes("/*[local-name()='Task']/*[local-name()='Actions']/*"))
  if ($triggers.Count -ne 1 -or $allTriggers.Count -ne 1 -or
      $actions.Count -ne 1 -or $actions[0].LocalName -ne 'Exec') {
    throw "Legacy task $Name XML has unexpected trigger/action; refusing migration audit"
  }
  $command = $actions[0].SelectSingleNode("*[local-name()='Command']")
  $arguments = $actions[0].SelectSingleNode("*[local-name()='Arguments']")
  if ($null -eq $command -or
      -not [string]::IsNullOrWhiteSpace([string]$arguments.InnerText)) {
    throw "Legacy task $Name XML has unexpected command/arguments; refusing migration audit"
  }
  try { $path = [IO.Path]::GetFullPath($command.InnerText.Trim('"')) }
  catch { throw "Legacy task $Name XML command is invalid; refusing migration audit" }
  if (-not [string]::Equals($path, [IO.Path]::GetFullPath($Launcher),
      [StringComparison]::OrdinalIgnoreCase)) {
    throw "Legacy task $Name XML command differs from verified action; refusing migration audit"
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString(
      $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($source))
    )).Replace("-", "").ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-MemhubLegacyProcessSnapshot {
  # Read-only query. Never infer ownership from a shared node.exe image alone.
  return @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
}

function Get-MemhubLegacyProcessCandidates {
  param(
    [Parameter(Mandatory)][string]$LauncherSource,
    [object[]]$Snapshot = @()
  )
  # v0.2.2 launchers invoke one fully quoted Node binary + entrypoint. An
  # unexpected launcher shape is not sufficient evidence for a migration.
  $invocations = [regex]::Matches($LauncherSource,
    '(?m)^"(?<node>[^"\r\n]*node\.exe)"\s+"(?<entry>[^"\r\n]+\.js)"(?=\s|$)')
  if ($invocations.Count -ne 1) {
    throw "Legacy launcher has an ambiguous Node invocation; refusing migration audit"
  }
  $node = [IO.Path]::GetFullPath($invocations[0].Groups['node'].Value)
  $entry = [IO.Path]::GetFullPath($invocations[0].Groups['entry'].Value)
  $expectedCommand = '^\s*"' + [regex]::Escape($node) + '"\s+"' +
    [regex]::Escape($entry) + '"(?=\s|$)'
  $candidates = @()
  foreach ($process in $Snapshot) {
    if (-not $process.CommandLine -or
        -not [regex]::IsMatch([string]$process.CommandLine, $expectedCommand,
          [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { continue }
    if (-not $process.ExecutablePath -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$process.ExecutablePath), $node,
          [StringComparison]::OrdinalIgnoreCase)) {
      throw "Legacy process matches argv but executable path cannot be verified; refusing migration audit"
    }
    if (-not $process.CreationDate -or -not $process.ProcessId -or
        [long]$process.ProcessId -le 0) {
      throw "Legacy process is missing PID or start time; refusing migration audit"
    }
    $candidates += [pscustomobject]@{
      pid = [long]$process.ProcessId
      parent_pid = [long]$process.ParentProcessId
      started_at_utc = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
      executable = $node
      entrypoint = $entry
    }
  }
  return $candidates
}

function Get-MemhubLegacyMigrationAudit {
  param(
    [Parameter(Mandatory)][ValidateSet("local", "server")][string]$Mode,
    [Parameter(Mandatory)][string]$StateRoot
  )
  $root = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
  $runtime = Join-Path $root "runtime"
  $memory = Join-Path $root "memory"
  $config = Join-Path $root "memory-config.yaml"
  # Do not inspect protected config or scan processes when no eligible task
  # exists on this machine. This is a normal, explicit not-installed result,
  # not evidence that a legacy migration was attempted.
  $knownNames = @(
    "Memhub-Server-Memory", "Memhub-Server", "Memhub-Memory",
    "Memhub-Local", "Memhub-Bridge", "Memhub-Server-Stack",
    "Memhub-Local-Stack"
  )
  $observedNames = @($knownNames | Where-Object {
    $null -ne (Get-MemhubInstallTask -Name $_)
  })
  if ($observedNames.Count -eq 0) {
    throw "No eligible legacy Memhub tasks found; refusing migration audit"
  }
  $managedName = if ($Mode -eq "server") { "Memhub-Server-Stack" } else { "Memhub-Local-Stack" }
  if ($null -ne (Get-MemhubInstallTask -Name $managedName)) {
    throw "Managed stack task exists; refusing to treat mixed/current installation as legacy"
  }
  $oppositeNames = if ($Mode -eq "server") {
    @("Memhub-Memory", "Memhub-Local", "Memhub-Bridge", "Memhub-Local-Stack")
  } else {
    @("Memhub-Server-Memory", "Memhub-Server", "Memhub-Server-Stack")
  }
  if (@($observedNames | Where-Object { $_ -in $oppositeNames }).Count -gt 0) {
    throw "Opposite-edition or mixed Memhub task set; refusing migration audit"
  }
  $specs = if ($Mode -eq "server") {
    @(
      @{ Name = "Memhub-Server-Memory"; Launcher = "memory-server.cmd"; Kind = "memory" },
      @{ Name = "Memhub-Server"; Launcher = "gateway-server.cmd"; Kind = "gateway" }
    )
  } else {
    @(
      @{ Name = "Memhub-Memory"; Launcher = "memory.cmd"; Kind = "memory" },
      @{ Name = "Memhub-Local"; Launcher = "gateway.cmd"; Kind = "gateway" },
      @{ Name = "Memhub-Bridge"; Launcher = "bridge.cmd"; Kind = "bridge" }
    )
  }
  foreach ($spec in $specs) {
    if ($spec.Name -notin $observedNames) {
      throw "Partial legacy task set: missing $($spec.Name); refusing migration audit"
    }
  }
  # Task-family validation precedes reading protected config and querying
  # all Node processes; a wrong/partial installation is not a migration.
  $token = Resolve-MemhubMemoryToken -ConfigPath $config -MemoryDir $memory
  if (-not $token) { throw "Legacy Memory config/token missing; refusing migration audit" }
  $processSnapshot = @(Get-MemhubLegacyProcessSnapshot)
  $evidence = @()
  foreach ($spec in $specs) {
    $task = Get-MemhubInstallTask -Name $spec.Name
    if ($null -eq $task) { throw "Partial legacy task set: missing $($spec.Name); refusing migration audit" }
    $launcher = Join-Path $runtime $spec.Launcher
    Assert-MemhubInstallTask -Task $task -Name $spec.Name -Launcher $launcher
    $xmlHash = Get-MemhubLegacyTaskXmlEvidence -Name $spec.Name -Launcher $launcher
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
      throw "Verified legacy task $($spec.Name) has no launcher; refusing migration audit"
    }
    $source = Get-Content -LiteralPath $launcher -Raw
    if ($spec.Kind -eq "gateway") {
      # A token fragment in a comment or duplicate environment assignment is
      # not evidence of the actual Gateway credential.
      $tokenLines = [regex]::Matches($source, '(?im)^set "MEMHUB_MEMORY_TOKEN=([a-f0-9]{64})"\s*$')
      if ($tokenLines.Count -ne 1 -or
          -not [string]::Equals($tokenLines[0].Groups[1].Value, $token, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Legacy Gateway credential is missing, ambiguous or inconsistent with Core; refusing migration audit"
      }
    }
    # One expression per output item: PowerShell's comma/+ precedence can
    # otherwise concatenate the entire expected contract into one string.
    $needles = @(switch ($spec.Kind) {
      "memory" {
        ('--config "' + $config + '"')
        ('--db "' + (Join-Path $memory 'memory.sqlite') + '"')
        '--port 18960'
        'memory-core\src\server\index.js'
      }
      "gateway" {
        ('MEMHUB_STATE_ROOT=' + (Join-Path $root 'server'))
        ('--state-root "' + (Join-Path $root 'server') + '"')
        ('MEMHUB_MEMORY_TOKEN=' + $token)
        '--http 3001'
        'dist\mcp.js'
      }
      "bridge" {
        ('MEMHUB_BRIDGE_HOME=' + $root)
        'serve --port 17861'
        'dist\bridge.js'
      }
    })
    $fragment = 0
    foreach ($needle in $needles) {
      $fragment += 1
      if ($source.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Legacy launcher $($spec.Name) differs from v0.2.2 expected $($spec.Kind) contract (fragment $fragment); refusing migration audit"
      }
    }
    $candidates = @(Get-MemhubLegacyProcessCandidates -LauncherSource $source -Snapshot $processSnapshot)
    $evidence += [pscustomobject]@{
      task = $spec.Name
      launcher = $launcher
      task_xml_sha256 = $xmlHash
      launcher_sha256 = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant()
      process_candidates = $candidates
      process_candidates_ambiguous = ($candidates.Count -gt 1)
      task_to_pid_verified = $false
    }
  }
  # Recheck Scheduler identity, XML and launcher immediately before returning
  # evidence. This narrows, but cannot eliminate, a later time-of-check race.
  foreach ($item in $evidence) {
    $task = Get-MemhubInstallTask -Name $item.task
    if ($null -eq $task) { throw "Legacy task $($item.task) disappeared during audit" }
    Assert-MemhubInstallTask -Task $task -Name $item.task -Launcher $item.launcher
    if ((Get-MemhubLegacyTaskXmlEvidence -Name $item.task -Launcher $item.launcher) -ne $item.task_xml_sha256 -or
        (Get-FileHash -LiteralPath $item.launcher -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.launcher_sha256) {
      throw "Legacy task $($item.task) changed during audit; refusing migration evidence"
    }
  }
  # Never include Memory credentials or launcher contents in a report.
  return [pscustomobject]@{
    mode = $Mode
    state_root = $root
    detected_task_layout = "split-task"
    installed_source_revision_verified = $false
    legacy_tasks = $evidence
    memory_config_sha256 = (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash.ToLowerInvariant()
    memory_database_exists = [bool](Test-Path -LiteralPath (Join-Path $memory "memory.sqlite") -PathType Leaf)
    credential_consistent_with_gateway = $true
    inspection_only = $true
    authorized_to_migrate = $false
    next_gate = "Verify installed source/package provenance independently (task names do not prove a v0.2.2 commit); export actual XML/launchers separately; correlate process candidate PID/start/path to Task Scheduler instance (argv match alone is not ownership); prepare rollback and obtain explicit authorization before stop/task mutation"
  }
}

if (-not $LibraryOnly) {
  Get-MemhubLegacyMigrationAudit -Mode $Mode -StateRoot $StateRoot | ConvertTo-Json -Depth 8
}
