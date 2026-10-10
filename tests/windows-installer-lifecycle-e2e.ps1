param(
  [ValidateSet("local", "server")][string]$Edition = "server",
  [string]$TargetRoot = ""
)
$ErrorActionPreference = "Stop"
$RepoRoot = if ($TargetRoot) { (Resolve-Path $TargetRoot).Path }
  else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$Installer = Join-Path $RepoRoot "editions\$Edition\windows\install.ps1"
$Uninstaller = Join-Path $RepoRoot "editions\$Edition\windows\uninstall.ps1"
$BundledNode = Join-Path $RepoRoot "runtime\node\node.exe"
$Node = if (Test-Path $BundledNode) { $BundledNode }
  else { (Get-Command node.exe -ErrorAction Stop).Source }
$StackEntry = Join-Path $RepoRoot "scripts\run-stack.mjs"
$StateRoot = Join-Path ([IO.Path]::GetTempPath()) ("memhub-installer-e2e-" + $Edition + "-" + [guid]::NewGuid().ToString("N"))
$TaskName = "Memhub-Stack"
$global:OwnedProcesses = @()
$global:TaskRequests = @()
$global:UnrelatedProcess = $null
$global:TestSucceeded = $false

# Do not modify the real Windows task scheduler or ACLs. The installer script
# itself executes under PowerShell; /Run launches the real isolated process
# stack with a disposable StateRoot. Fixed port availability is checked first.
function schtasks.exe {
  $call = @($args)
  $global:TaskRequests += ($call -join " ")
  if ($call[0] -eq "/Create") {
    if (($call -join " ") -notmatch [regex]::Escape($TaskName)) {
      throw "unexpected task registration"
    }
  } elseif ($call[0] -eq "/Run") {
    if (($call -join " ") -notmatch [regex]::Escape($TaskName)) {
      throw "unexpected task start"
    }
    $argumentLine = ('"{0}" --home "{1}"' -f $StackEntry, $StateRoot)
    $logBase = Join-Path $StateRoot ("runtime\stack-test-" + $global:OwnedProcesses.Count)
    $process = Start-Process -FilePath $Node -ArgumentList $argumentLine -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput ($logBase + ".stdout.log") -RedirectStandardError ($logBase + ".stderr.log")
    $global:OwnedProcesses += $process
  } elseif ($call[0] -ne "/End" -and $call[0] -ne "/Delete") {
    throw "unexpected task operation"
  }
  $global:LASTEXITCODE = 0
}
function icacls.exe { $global:LASTEXITCODE = 0 }
function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
function Install-Edition {
  if ($Edition -eq "server") {
    & $Installer -StateRoot $StateRoot -SkipBuild -Username "isolated-owner"
  } else {
    & $Installer -StateRoot $StateRoot -SkipBuild
  }
  if ($LASTEXITCODE -ne 0) { throw "installer returned nonzero" }
}
function Check-PortsAvailable {
  $ports = @(18960, 3001)
  foreach ($port in $ports) {
    $listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try { $listener.Start() } catch { throw "test skipped: port $port is occupied; never touch the occupying process" }
    finally { $listener.Stop() }
  }
}

try {
  Check-PortsAvailable
  Install-Edition
  $configPath = Join-Path $StateRoot "memory-config.yaml"
  $envPath = Join-Path $StateRoot "memhub.env"
  $before = Get-Content -Raw $configPath
  . (Join-Path $RepoRoot "scripts\windows-memory-credentials.ps1")
  $token = Resolve-MemhubMemoryToken -ConfigPath $configPath -MemoryDir (Join-Path $StateRoot "memory")
  Assert-True ($token -match '^[a-f0-9]{64}$') "fresh Core token invalid"
  $environment = Get-Content -Raw $envPath
  Assert-True ($environment.Contains("MEMHUB_MEMORY_TOKEN=" + $token)) "Gateway and Core credentials mismatch"
  if ($Edition -eq "server") {
    Add-Content -Path $envPath -Value "MEMHUB_PUBLIC_HOST=memhub-e2e.invalid" -Encoding UTF8
  }
  $lock = Join-Path $StateRoot ".memhub-stack.lock"
  $ownerBefore = Get-Content -Raw $lock | ConvertFrom-Json
  Set-Content -Path $configPath -Value '{"memmyMemory":{"storage":{"token":""}}}' -Encoding UTF8
  $rejected = $false
  try { Install-Edition } catch { $rejected = $true }
  Assert-True $rejected "invalid existing config should reject reinstall"
  $ownerAfter = Get-Content -Raw $lock | ConvertFrom-Json
  Assert-True ($ownerAfter.token -eq $ownerBefore.token) "invalid config stopped the live stack owner"
  Assert-True ($global:OwnedProcesses.Count -eq 1) "invalid config launched a replacement stack"
  Set-Content -Path $configPath -Value $before -Encoding UTF8
  $unrelatedScript = Join-Path $StateRoot "runtime\unrelated-node.mjs"
  Set-Content -Path $unrelatedScript -Value 'setInterval(() => {}, 1000);' -Encoding UTF8
  $global:UnrelatedProcess = Start-Process -FilePath $Node -ArgumentList ('"{0}"' -f $unrelatedScript) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
  # The running Core has already normalized JSON-compatible config into YAML.
  # Preserve that exact live format; user modifications must survive reruns.
  $customized = $before + "`n# user-kept-on-reinstall-upgrade-rollback`n"
  Set-Content -Path $configPath -Value $customized -Encoding UTF8
  # Core may canonicalize YAML on every launch; compare credentials and
  # protected state here, while the separate no-Core fixture tests exact
  # installer byte preservation.
  $marker = Join-Path $StateRoot "memory\protected.txt"
  Set-Content -Path $marker -Value "KEEP" -Encoding UTF8
  # Exercise the actual installer guard while a real disposable stack is
  # running. A forged lock must not stop the owner or the unrelated Node,
  # rewrite protected files, or issue a Scheduler operation.
  $baselineLock = Get-Content -LiteralPath $lock -Raw
  $baselineLockBytes = [IO.File]::ReadAllBytes($lock)
  $baselineConfig = Get-Content -LiteralPath $configPath -Raw
  $baselineEnv = Get-Content -LiteralPath $envPath -Raw
  $baselineTaskRequests = $global:TaskRequests.Count
  $baselineLaunches = $global:OwnedProcesses.Count
  foreach ($case in @("reused-pid-start-time", "foreign-pid")) {
    $forged = $baselineLock | ConvertFrom-Json
    if ($case -eq "reused-pid-start-time") {
      $forged.started_at = "2000-01-01T00:00:00.000Z"
    } else {
      $forged.pid = $global:UnrelatedProcess.Id
    }
    $forged | ConvertTo-Json | Set-Content -LiteralPath $lock -Encoding UTF8
    try {
      $refused = $false
      try { Install-Edition } catch { $refused = $true }
      Assert-True $refused ("installer accepted forged " + $case + " owner")
      Assert-True ($global:OwnedProcesses.Count -eq $baselineLaunches) "forged lock launched an owner"
      Assert-True ($global:TaskRequests.Count -eq $baselineTaskRequests) "forged lock modified Task Scheduler"
      Assert-True ((Get-Content -LiteralPath $configPath -Raw) -eq $baselineConfig) "forged lock changed Core config"
      Assert-True ((Get-Content -LiteralPath $envPath -Raw) -eq $baselineEnv) "forged lock changed Gateway env"
      Assert-True ((Get-Content -LiteralPath $marker -Raw).Trim() -eq "KEEP") "forged lock changed protected data"
      $global:OwnedProcesses[0].Refresh()
      $global:UnrelatedProcess.Refresh()
      Assert-True (-not $global:OwnedProcesses[0].HasExited) "forged lock stopped real stack owner"
      Assert-True (-not $global:UnrelatedProcess.HasExited) "forged lock stopped unrelated Node"
    } finally {
      [IO.File]::WriteAllBytes($lock, $baselineLockBytes)
    }
  }
  # Reinstall, simulated upgrade and rollback against the exact script while
  # testing live stop/restart. Real cross-version package acceptance is separate.
  foreach ($phase in @("reinstall", "upgrade", "rollback")) {
    Install-Edition
    Assert-True ((Resolve-MemhubMemoryToken -ConfigPath $configPath -MemoryDir (Join-Path $StateRoot "memory")) -eq $token) ("Core credential changed on " + $phase)
    Assert-True ((Get-Content -Raw $marker).Trim() -eq "KEEP") ("user data changed on " + $phase)
    Assert-True ((Get-Content -Raw $envPath).Contains("MEMHUB_MEMORY_TOKEN=" + $token)) ("token changed on " + $phase)
    if ($Edition -eq "server") {
      Assert-True ((Get-Content -Raw $envPath).Contains("MEMHUB_PUBLIC_HOST=memhub-e2e.invalid")) ("public host removed on " + $phase)
    }
    $lock = Join-Path $StateRoot ".memhub-stack.lock"
    Assert-True (Test-Path $lock) ("stack owner lock absent on " + $phase)
  }
  & $Uninstaller -StateRoot $StateRoot
  Assert-True (-not (Test-Path (Join-Path $StateRoot ".memhub-stack.lock"))) "uninstall left stack owner"
  Assert-True (Test-Path $configPath) "uninstall without purge deleted config"
  Assert-True ((Get-Content -Raw $marker).Trim() -eq "KEEP") "uninstall without purge deleted user data"
  Install-Edition
  Assert-True ((Resolve-MemhubMemoryToken -ConfigPath $configPath -MemoryDir (Join-Path $StateRoot "memory")) -eq $token) "reinstall after uninstall changed Core credential"
  if ($Edition -eq "server") {
    Assert-True ((Get-Content -Raw $envPath).Contains("MEMHUB_PUBLIC_HOST=memhub-e2e.invalid")) "reinstall after uninstall removed public host"
  }
  & $Uninstaller -StateRoot $StateRoot
  Assert-True ($global:OwnedProcesses.Count -eq 5) "unexpected number of owner launches"
  Assert-True (($global:TaskRequests -join " ") -match [regex]::Escape($TaskName)) "task shim did not receive installer operations"
  $global:UnrelatedProcess.Refresh()
  Assert-True (-not $global:UnrelatedProcess.HasExited) "installer/uninstaller terminated unrelated Node"
  Write-Output ("memhub-windows-installer-lifecycle-e2e: ok edition=" + $Edition + " launches=" + $global:OwnedProcesses.Count + " task_scheduler=shim real_stack=true")
  $global:TestSucceeded = $true
} finally {
  $lock = Join-Path $StateRoot ".memhub-stack.lock"
  if (Test-Path $lock) {
    & $Node $StackEntry --home $StateRoot --action stop | Out-Null
  }
  foreach ($process in $global:OwnedProcesses) {
    $process.Refresh()
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit(5000) | Out-Null }
  }
  if ($global:UnrelatedProcess) {
    $global:UnrelatedProcess.Refresh()
    if (-not $global:UnrelatedProcess.HasExited) {
      $global:UnrelatedProcess.Kill()
      $global:UnrelatedProcess.WaitForExit(5000) | Out-Null
    }
  }
  if ($global:TestSucceeded) {
    Remove-Item -Recurse -Force $StateRoot -ErrorAction SilentlyContinue
  } else {
    Write-Warning ("QA failed; preserved disposable logs at " + $StateRoot)
  }
}
