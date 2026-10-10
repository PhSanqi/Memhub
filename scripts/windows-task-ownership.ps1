# An installer may replace only its own exact Task Scheduler registration.
# A familiar task name or a matching node.exe command line is not ownership.
function Get-MemhubInstallTask {
  param([Parameter(Mandatory)][string]$Name)
  try {
    $matches = @(Get-ScheduledTask -TaskPath "\" -TaskName $Name -ErrorAction Stop)
    if ($matches.Count -ne 1) { throw "Ambiguous scheduled task: $Name" }
    return $matches[0]
  } catch {
    if ($_.FullyQualifiedErrorId -like "CmdletizationQuery_NotFound*") { return $null }
    throw "Cannot inspect scheduled task $Name; refusing installation: $($_.Exception.Message)"
  }
}

function Assert-MemhubInstallTask {
  param(
    [Parameter(Mandatory)]$Task,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Launcher
  )
  if ($Task.TaskName -cne $Name -or $Task.TaskPath -ne "\") {
    throw "Scheduled task identity differs from expected root task $Name"
  }
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1 -or -not $actions[0].Execute -or
      -not [string]::IsNullOrWhiteSpace([string]$actions[0].Arguments)) {
    throw "Scheduled task $Name has an unexpected action; refusing to modify it"
  }
  $actualPath = [IO.Path]::GetFullPath(([string]$actions[0].Execute).Trim('"'))
  $expectedPath = [IO.Path]::GetFullPath($Launcher)
  if (-not [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Scheduled task $Name targets another launcher; refusing to modify it"
  }
  $principal = [string]$Task.Principal.UserId
  if (-not $principal) { throw "Scheduled task $Name has no verifiable principal" }
  try {
    $sid = if ($principal -match '^S-1-') { $principal } else {
      ([Security.Principal.NTAccount]::new($principal)).Translate(
        [Security.Principal.SecurityIdentifier]).Value
    }
  } catch {
    throw "Scheduled task $Name principal cannot be resolved; refusing to modify it"
  }
  if ($sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
    throw "Scheduled task $Name belongs to another user; refusing to modify it"
  }
}

function Assert-MemhubInstallTaskSet {
  param(
    [Parameter(Mandatory)][string]$StateRoot
  )
  $runtime = Join-Path ([IO.Path]::GetFullPath($StateRoot)) "runtime"
  $specs = @(
    @{ Name = "Memhub-Stack"; Launcher = "stack.cmd"; Legacy = $false },
    # Historical task names are migration blockers only. They are never
    # created by the current installer.
    @{ Name = "Memhub-Local-Stack"; Launcher = "stack-local.cmd"; Legacy = $true },
    @{ Name = "Memhub-Server-Stack"; Launcher = "stack-server.cmd"; Legacy = $true },
    @{ Name = "Memhub-Memory"; Launcher = "memory.cmd"; Legacy = $true },
    @{ Name = "Memhub-Local"; Launcher = "gateway.cmd"; Legacy = $true },
    @{ Name = "Memhub-Bridge"; Launcher = "bridge.cmd"; Legacy = $true },
    @{ Name = "Memhub-Server-Memory"; Launcher = "memory-server.cmd"; Legacy = $true },
    @{ Name = "Memhub-Server"; Launcher = "gateway-server.cmd"; Legacy = $true }
  )
  $managed = @()
  $legacy = @()
  foreach ($spec in $specs) {
    $task = Get-MemhubInstallTask -Name $spec.Name
    if ($null -eq $task) { continue }
    Assert-MemhubInstallTask -Task $task -Name $spec.Name -Launcher (Join-Path $runtime $spec.Launcher)
    if ($spec.Legacy) { $legacy += $spec.Name }
    else { $managed += $spec.Name }
  }
  if ($legacy.Count) {
    throw ("Legacy Memhub tasks ({0}) require an explicitly authorized, " +
      "version-matched migration. The installer will not stop, delete, or " +
      "replace them automatically." -f ($legacy -join ", "))
  }
  return $managed
}

function Remove-MemhubVerifiedStackTask {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Launcher
  )
  $task = Get-MemhubInstallTask -Name $Name
  if ($null -eq $task) { throw "Scheduled task $Name disappeared during install; refusing to continue" }
  Assert-MemhubInstallTask -Task $task -Name $Name -Launcher $Launcher
  & schtasks.exe /End /TN $Name 2>$null | Out-Null
  & schtasks.exe /Delete /F /TN $Name | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to remove verified scheduled task $Name" }
}
