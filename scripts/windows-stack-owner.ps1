# Only an exact, live stack owner can receive the cooperative stop request.
# This is read-only OS verification: no process termination or lock cleanup.
function Assert-MemhubStackProcessOwner {
  param(
    [Parameter(Mandatory)][string]$LockPath,
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$StackEntry,
    [Parameter(Mandatory)][ValidateSet('local', 'server')][string]$Mode,
    [Parameter(Mandatory)][string]$StateRoot
  )
  $lockInfo = Get-Item -LiteralPath $LockPath -ErrorAction Stop
  if (($lockInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Stack owner lock is a reparse point; refusing stop'
  }
  try { $owner = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'Stack owner lock is unreadable; refusing stop' }
  $pidValue = 0L
  if (-not [long]::TryParse([string]$owner.pid, [ref]$pidValue) -or $pidValue -le 0 -or
      $pidValue -gt [int]::MaxValue -or [string]::IsNullOrWhiteSpace([string]$owner.token)) {
    throw 'Stack owner lock has an invalid PID/token; refusing stop'
  }
  try {
    $lockStarted = [datetimeoffset]::Parse([string]$owner.started_at,
      [Globalization.CultureInfo]::InvariantCulture)
  } catch { throw 'Stack owner lock has an invalid start timestamp; refusing stop' }
  if ($lockStarted -eq [datetimeoffset]::MinValue) {
    throw 'Stack owner lock has an invalid start timestamp; refusing stop'
  }
  $matches = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction Stop)
  if ($matches.Count -ne 1) { throw 'Stack owner PID is missing or ambiguous; refusing stop' }
  $process = $matches[0]
  try { $processOwner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop }
  catch { throw 'Stack owner principal cannot be verified; refusing stop' }
  if ($processOwner.ReturnValue -ne 0 -or
      $processOwner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
    throw 'Stack owner process belongs to another principal; refusing stop'
  }
  $selectedNode = [IO.Path]::GetFullPath($NodePath)
  $selectedScript = [IO.Path]::GetFullPath($StackEntry)
  $stateHome = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
  $node = $selectedNode
  $script = $selectedScript
  $identityFields = @('entrypoint', 'exec_path', 'home', 'mode')
  $presentFields = @($identityFields | Where-Object {
    $owner.PSObject.Properties.Name -contains $_ -and
    -not [string]::IsNullOrWhiteSpace([string]$owner.$_)
  })
  if ($presentFields.Count -gt 0 -and $presentFields.Count -ne $identityFields.Count) {
    throw 'Stack owner lock has partial identity metadata; refusing stop'
  }
  if ($presentFields.Count -eq $identityFields.Count) {
    try {
      $declaredNode = [IO.Path]::GetFullPath([string]$owner.exec_path)
      $declaredScript = [IO.Path]::GetFullPath([string]$owner.entrypoint)
      $declaredHome = [IO.Path]::GetFullPath([string]$owner.home).TrimEnd('\')
    } catch { throw 'Stack owner lock identity contains invalid paths; refusing stop' }
    if (-not [string]::Equals($declaredHome, $stateHome, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$owner.mode, $Mode, [StringComparison]::Ordinal)) {
      throw 'Stack owner lock belongs to another StateRoot or edition; refusing stop'
    }
    if (-not [string]::Equals($declaredScript, $selectedScript,
        [StringComparison]::OrdinalIgnoreCase)) {
      # The previous installed package may be in a different release folder.
      # Do not execute its entrypoint. Accept only its declared run-stack.mjs
      # with full OS PID/SID/start/exe/argv verification below.
      if (-not [string]::Equals([IO.Path]::GetFileName($declaredScript), 'run-stack.mjs',
          [StringComparison]::OrdinalIgnoreCase) -or
          -not [string]::Equals([IO.Path]::GetFileName(
            [IO.Path]::GetDirectoryName($declaredScript)), 'scripts',
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Previous stack entrypoint is not a managed run-stack script; refusing stop'
      }
    }
    $node = $declaredNode
    $script = $declaredScript
  }
  if (-not $process.ExecutablePath -or
      -not [string]::Equals([IO.Path]::GetFullPath([string]$process.ExecutablePath), $node,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Stack owner executable differs from the selected Node runtime; refusing stop'
  }
  # Windows quotes space-containing paths, but may elide quotes otherwise.
  # Require full argv, not a substring occurrence in another Node instance.
  $pattern = '^\s*"?' + [regex]::Escape($node) + '"?\s+"?' +
    [regex]::Escape($script) + '"?\s+--mode\s+' + $Mode +
    '\s+--home\s+"?' + [regex]::Escape($stateHome) + '"?\s*$'
  if (-not $process.CommandLine -or
      -not [regex]::IsMatch([string]$process.CommandLine, $pattern,
        [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    throw 'Stack owner argv differs from the exact managed stack invocation; refusing stop'
  }
  if (-not $process.CreationDate) { throw 'Stack owner start time is unavailable; refusing stop' }
  $processStarted = ([datetime]$process.CreationDate).ToUniversalTime()
  $lag = ($lockStarted.UtcDateTime - $processStarted).TotalSeconds
  # The lock is written shortly after process creation, before Core startup.
  # This time window is a fail-closed PID-reuse guard, not an OS start-time ID.
  if ($lag -lt -2 -or $lag -gt 30) {
    throw 'Stack owner PID/start time differs from the lock; refusing stop'
  }
  return [pscustomobject]@{ pid = $pidValue; started_at_utc = $processStarted.ToString('o') }
}
