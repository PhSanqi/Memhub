param(
  [ValidateSet('server','local')][string]$Edition = 'server',
  [Parameter(Mandatory)][string]$LegacyRoot,
  [switch]$CompatTokenQuote,
  [switch]$CompatBundledNode,
  [switch]$RehearseRollback,
  [string]$CrossVersionRoot = "",
  [string]$CrossVersion = "",
  [switch]$ExpectCrossVersionTokenRotation
)
# Historical a00fba92 installer, real isolated old Core/Gateway(/Bridge),
# mocked Scheduler + ACL. The current installer MUST refuse before mutation.
$ErrorActionPreference = 'Stop'
$CandidateRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LegacyRoot = (Resolve-Path $LegacyRoot).Path
$oldInstaller = Join-Path $LegacyRoot "editions\$Edition\windows\install.ps1"
$newInstaller = Join-Path $CandidateRoot "editions\$Edition\windows\install.ps1"
$state = Join-Path ([IO.Path]::GetTempPath()) ('memhub-historical-split-qa-' + $Edition + '-' + [guid]::NewGuid().ToString('N'))
$global:tasks = @{}
$global:children = @()
$global:requests = @()
$global:succeeded = $false
$global:rollbackSnapshot = $null
$global:unrelatedProcess = $null
$PreviousNodeOverride = $env:NODE
$CrossVersionPackage = $null
$CrossVersionStackEntry = $null
$CrossVersionNode = $null
$self = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function AssertTrue([bool]$condition,[string]$message) { if(-not $condition){throw $message} }
if ($CrossVersionRoot) {
  if (-not $RehearseRollback -or [string]::IsNullOrWhiteSpace($CrossVersion)) {
    throw 'Cross-version requires -RehearseRollback and explicit -CrossVersion'
  }
  $CrossVersionPackage = (Resolve-Path -LiteralPath $CrossVersionRoot).Path
  $pkg = Get-Content -LiteralPath (Join-Path $CrossVersionPackage 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.version -ne $CrossVersion -or $CrossVersion -notmatch '^0\.2\.[0-9]+$') {
    throw 'Cross-version candidate package provenance/version mismatch'
  }
  $candidateInstaller = Join-Path $CrossVersionPackage "editions\$Edition\windows\install.ps1"
  $CrossVersionStackEntry = Join-Path $CrossVersionPackage 'scripts\run-stack.mjs'
  foreach ($requiredPath in @($candidateInstaller, $CrossVersionStackEntry,
      (Join-Path $CrossVersionPackage 'dist\mcp.js'),
      (Join-Path $CrossVersionPackage 'vendor\memory-core\src\server\index.js'),
      (Join-Path $CrossVersionPackage 'node_modules\better-sqlite3'))) {
    if (-not (Test-Path -LiteralPath $requiredPath)) { throw 'Cross-version candidate is not a built runtime package' }
  }
  $CrossVersionNode = (Get-Command node.exe -ErrorAction Stop).Source
} elseif ($ExpectCrossVersionTokenRotation) {
  throw '-ExpectCrossVersionTokenRotation requires a real -CrossVersionRoot'
}
function Get-TreeManifest([string]$path) {
  $prefix = [IO.Path]::GetFullPath($path).TrimEnd('\') + '\'
  return @(
    Get-ChildItem -LiteralPath $path -Recurse -Force -File |
      ForEach-Object {
        ($_.FullName.Substring($prefix.Length).ToLowerInvariant() + ':' +
          (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)
      } | Sort-Object
  )
}
function Stop-TrackedLegacyProcesses {
  # Isolated fixture only: tracked child process IDs were created by our
  # Scheduler shim. Never use image/path scans against the real host.
  foreach($p in $global:children) {
    $p.Refresh()
    if($p -and -not $p.HasExited) {
      & taskkill.exe /T /F /PID $p.Id 2>$null | Out-Null
      $p.WaitForExit(5000) | Out-Null
    }
  }
}
function schtasks.exe {
  $call = @($args)
  $global:requests += ($call -join ' ')
  if ($call[0] -eq '/Create') {
    $name = $call[[array]::IndexOf($call,'/TN')+1]
    $launcher = [string]$call[[array]::IndexOf($call,'/TR')+1]
    $global:tasks[$name] = $launcher.Trim('"')
  } elseif ($call[0] -eq '/Run') {
    $name = $call[[array]::IndexOf($call,'/TN')+1]
    $launcher = $global:tasks[$name]
    if (-not $launcher) { throw 'Unknown shim task' }
    $index = $global:children.Count
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList ('/D /C ""' + $launcher + '""') `
      -WorkingDirectory $LegacyRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $state ("legacy-$index.out.log")) `
      -RedirectStandardError (Join-Path $state ("legacy-$index.err.log"))
    $global:children += $process
  } else { throw 'Candidate attempted Task Scheduler mutation before migration approval' }
  $global:LASTEXITCODE = 0
}
function icacls.exe { $global:LASTEXITCODE = 0 }
function Get-ScheduledTask {
  param([string]$TaskPath,[string]$TaskName)
  if (-not $global:tasks.ContainsKey($TaskName)) { return $null }
  return [pscustomobject]@{
    TaskName = $TaskName; TaskPath = '\'
    Actions = @([pscustomobject]@{ Execute=$global:tasks[$TaskName]; Arguments='' })
    Principal = [pscustomobject]@{ UserId=$self }
  }
}
function CheckPorts {
  foreach($port in @(18960,3001,17861)) {
    $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
    try{$l.Start()}catch{throw "Isolated test ports are occupied: $port"}
    finally{$l.Stop()}
  }
}
try {
  CheckPorts
  # The historical Complete artifact has a Node 22 native SQLite binding.
  # A host Node 24 (ABI 137) must not be substituted for bundled Node 22
  # (ABI 127); otherwise the Gateway appears healthy while Core crashes.
  $HistoricalNode = Join-Path $LegacyRoot 'runtime\node\node.exe'
  if (Test-Path -LiteralPath $HistoricalNode -PathType Leaf) {
    $env:NODE = $HistoricalNode
  }
  New-Item -ItemType Directory -Force -Path $state | Out-Null
  if ($CompatTokenQuote -or $CompatBundledNode) {
    # Test-only adaptations of historical Windows packaging/quoting bugs.
    # The original source is independently saved and never rewritten.
    $source = if (Test-Path ($oldInstaller+'.original')) {
      [IO.File]::ReadAllText(($oldInstaller+'.original'))
    } else { [IO.File]::ReadAllText($oldInstaller) }
    $candidateSource = $source
    if ($CompatTokenQuote) {
      $original = '$MemoryToken = & $Node -e ''process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'''
      if ($source.Split(@($original),[StringSplitOptions]::None).Count -ne 2) {
        throw 'Historical token source does not match the reviewed fixture'
      }
      $replacement = '$tokenBytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes); $MemoryToken = ([BitConverter]::ToString($tokenBytes)).Replace(''-'','''').ToLowerInvariant()'
      $candidateSource = $candidateSource.Replace($original,$replacement)
    }
    if ($CompatBundledNode) {
      # Historical source expects runtime/node.exe, whereas Complete shipped
      # runtime/node/node.exe; host Node 24 cannot load bundled ABI 127.
      $originalNode = '$BundledNode = Join-Path $RepoRoot "runtime\node.exe"'
      if ($source.Split(@($originalNode),[StringSplitOptions]::None).Count -ne 2 -or
          -not (Test-Path -LiteralPath $HistoricalNode -PathType Leaf)) {
        throw 'Historical bundled Node source/package mismatch'
      }
      $candidateSource = $candidateSource.Replace($originalNode,
        '$BundledNode = Join-Path $RepoRoot "runtime\node\node.exe"')
    }
    [IO.File]::WriteAllText(($oldInstaller+'.original'),$source)
    [IO.File]::WriteAllText($oldInstaller,$candidateSource)
  }
  if($Edition -eq 'server') { & $oldInstaller -StateRoot $state -SkipBuild -Username 'historical-owner' }
  else { & $oldInstaller -StateRoot $state -SkipBuild }
  $expected = if($Edition -eq 'server'){@('Memhub-Server-Memory','Memhub-Server')}
    else {@('Memhub-Memory','Memhub-Local','Memhub-Bridge')}
  AssertTrue ($global:tasks.Count -eq $expected.Count) 'Old installer did not register expected split tasks'
  foreach($name in $expected) { AssertTrue $global:tasks.ContainsKey($name) ("Missing old task "+$name) }
  $health = 'http://127.0.0.1:3001/memhub/health'
  $coreHealth = 'http://127.0.0.1:18960/health'
  # Historical bridge exposes GET /status, not the managed bridge /health.
  $historicalBridgeHealth = 'http://127.0.0.1:17861/status'
  $candidateBridgeHealth = 'http://127.0.0.1:17861/health'
  $ready = $false
  for($i=0;$i -lt 80;$i++) {
    try {
      $reply=Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 2
      $coreReply=Invoke-WebRequest -UseBasicParsing -Uri $coreHealth -TimeoutSec 2
      $bridgeReady = $Edition -ne 'local' -or
        (Invoke-WebRequest -UseBasicParsing -Uri $historicalBridgeHealth -TimeoutSec 2).StatusCode -eq 200
      if($reply.StatusCode -eq 200 -and $coreReply.StatusCode -eq 200 -and $bridgeReady){$ready=$true;break}
    }
    catch {}
    # A dead Core must fail immediately, not spend 80 attempts polling only
    # the independently healthy Gateway.
    $global:children[0].Refresh()
    if ($global:children[0].HasExited) { throw 'Historical Memory Core task exited before readiness' }
    Start-Sleep -Milliseconds 250
  }
  AssertTrue $ready 'Historical Gateway/Core did not become healthy'
  $config = Join-Path $state 'memory-config.yaml'
  $db = Join-Path $state 'memory\memory.sqlite'
  $marker = Join-Path $state 'memory\protected-migration-marker.txt'
  Set-Content -LiteralPath $marker -Encoding ASCII -Value 'KEEP'
  $beforeConfig = (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash
  $beforeMarker = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash
  $oldTasks = @($global:tasks.Keys | Sort-Object | ForEach-Object { $_ + ':' + $global:tasks[$_] })
  $beforeRequests = $global:requests.Count
  $attemptRefused = $false
  try {
    if($Edition -eq 'server'){ & $newInstaller -StateRoot $state -SkipBuild -Username 'historical-owner' }
    else { & $newInstaller -StateRoot $state -SkipBuild }
  } catch {
    if($_.Exception.Message -notmatch 'Legacy Memhub tasks'){ throw }
    $attemptRefused = $true
  }
  AssertTrue $attemptRefused 'Candidate unexpectedly accepted an unauthorized old task migration'
  AssertTrue ($global:requests.Count -eq $beforeRequests) 'Candidate requested Scheduler mutation'
  AssertTrue ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -eq $beforeConfig) 'Candidate changed old config'
  AssertTrue ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -eq $beforeMarker) 'Candidate changed protected marker'
  AssertTrue ((@($global:tasks.Keys | Sort-Object | ForEach-Object { $_ + ':' + $global:tasks[$_] }) -join '|') -eq ($oldTasks -join '|')) 'Candidate changed old task registrations'
  AssertTrue (-not (Test-Path (Join-Path $state ($Edition+'.env')))) 'Candidate wrote a managed-stack env before authorization'
  AssertTrue (-not (Test-Path (Join-Path $state ('.'+$Edition+'-stack.lock')))) 'Candidate started a managed owner'
  AssertTrue ((Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 2).StatusCode -eq 200) 'Historical Gateway died during rejected upgrade'
  AssertTrue ((Invoke-WebRequest -UseBasicParsing -Uri $coreHealth -TimeoutSec 2).StatusCode -eq 200) 'Historical Core died during rejected upgrade'
  if ($Edition -eq 'local') {
    AssertTrue ((Invoke-WebRequest -UseBasicParsing -Uri $historicalBridgeHealth -TimeoutSec 2).StatusCode -eq 200) 'Historical Bridge died during rejected upgrade'
  }
  AssertTrue (Test-Path $db) 'Old database missing'
  if ($RehearseRollback) {
    # Exercise the restore contract with the REAL historical Core/Gateway
    # processes, but still a fake Scheduler and a synthetic candidate
    # mutation. This is not a successful cross-version migration.
    $unrelatedScript = Join-Path $state 'unrelated.mjs'
    [IO.File]::WriteAllText($unrelatedScript, 'setInterval(() => {}, 1000);')
    $oldNode = (Get-Command node.exe -ErrorAction Stop).Source
    $global:unrelatedProcess = Start-Process -FilePath $oldNode -ArgumentList ('"{0}"' -f $unrelatedScript) -WindowStyle Hidden -PassThru
    Stop-TrackedLegacyProcesses
    Start-Sleep -Milliseconds 350
    CheckPorts
    $global:unrelatedProcess.Refresh()
    AssertTrue (-not $global:unrelatedProcess.HasExited) 'Stopping old tracked tasks stopped an unrelated Node process'

    $global:rollbackSnapshot = Join-Path ([IO.Path]::GetTempPath()) ('memhub-historical-rollback-' + [guid]::NewGuid().ToString('N'))
    $snapshotState = Join-Path $global:rollbackSnapshot 'state'
    $snapshotXml = Join-Path $global:rollbackSnapshot 'task-xml'
    New-Item -ItemType Directory -Force -Path $snapshotState,$snapshotXml | Out-Null
    Get-ChildItem -LiteralPath $state -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $snapshotState -Recurse -Force
    }
    $baselineFiles = @(Get-TreeManifest $snapshotState)
    $registered = @{}
    $xmlHashes = @{}
    foreach($name in $expected) {
      $registered[$name] = $global:tasks[$name]
      $escaped = [Security.SecurityElement]::Escape($registered[$name])
      $xml = '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger/></Triggers><Actions><Exec><Command>' + $escaped + '</Command></Exec></Actions></Task>'
      $xmlPath = Join-Path $snapshotXml ($name + '.xml')
      [IO.File]::WriteAllText($xmlPath,$xml)
      $xmlHashes[$name] = (Get-FileHash -LiteralPath $xmlPath -Algorithm SHA256).Hash
    }
    AssertTrue ((@($baselineFiles) -join '|') -eq (@(Get-TreeManifest $snapshotState) -join '|')) 'Rollback snapshot changed after sealing'

    if ($CrossVersionPackage) {
      # These task changes happen ONLY in the disposable Scheduler shim after
      # every old process has exited and the independent snapshot is sealed.
      # Candidate installation is real code and boots real candidate Core +
      # Gateway, but this is NOT a real Task Scheduler migration.
      foreach ($name in $expected) { $global:tasks.Remove($name) }
      $managedName = if ($Edition -eq 'server') { 'Memhub-Server-Stack' } else { 'Memhub-Local-Stack' }
      $priorNode = $env:NODE
      $env:NODE = $CrossVersionNode
      try {
        if ($Edition -eq 'server') {
          & $candidateInstaller -StateRoot $state -SkipBuild -Username 'historical-owner'
        } else {
          & $candidateInstaller -StateRoot $state -SkipBuild
        }
        AssertTrue $global:tasks.ContainsKey($managedName) 'Candidate did not register the managed task in the shim'
        $candidateHealthy = $false
        for ($i=0;$i -lt 80;$i++) {
          try {
            $core = Invoke-WebRequest -UseBasicParsing -Uri $coreHealth -TimeoutSec 2
            $gateway = Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 2
            $bridgeReady = $Edition -ne 'local' -or
              (Invoke-WebRequest -UseBasicParsing -Uri $candidateBridgeHealth -TimeoutSec 2).StatusCode -eq 200
            if ($core.StatusCode -eq 200 -and $gateway.StatusCode -eq 200 -and $bridgeReady) { $candidateHealthy=$true;break }
          } catch {}
          Start-Sleep -Milliseconds 250
        }
        AssertTrue $candidateHealthy 'Real candidate Core/Gateway failed readiness after upgrade'
        # v0.2.5 package predates the shared credentials helper. The current
        # QA parser is read-only and works with both historical JSON/YAML.
        . (Join-Path $CandidateRoot 'scripts\windows-memory-credentials.ps1')
        $candidateToken = Resolve-MemhubMemoryToken -ConfigPath $config -MemoryDir (Join-Path $state 'memory')
        $baselineToken = Resolve-MemhubMemoryToken -ConfigPath (Join-Path $snapshotState 'memory-config.yaml') -MemoryDir (Join-Path $snapshotState 'memory')
        if ($ExpectCrossVersionTokenRotation) {
          AssertTrue ($candidateToken -ne $baselineToken) 'Expected historical candidate credential-rotation regression was not reproduced'
          Write-Output ('historical-real-candidate-refused: ok edition='+$Edition+' candidate='+$CrossVersion+' reason=core_token_rotated rollback_required=true')
        } else {
          AssertTrue ($candidateToken -eq $baselineToken) 'Candidate rotated the historical Core credential'
        }
        AssertTrue ((Get-Content -LiteralPath $marker -Raw).Trim() -eq 'KEEP') 'Candidate changed protected user data'
        $global:unrelatedProcess.Refresh()
        AssertTrue (-not $global:unrelatedProcess.HasExited) 'Candidate killed an unrelated Node process'
        if (-not $ExpectCrossVersionTokenRotation) {
          Write-Output ('historical-real-candidate-upgrade: ok edition='+$Edition+' candidate='+$CrossVersion+' core_gateway_http=true historical_token_preserved=true scheduler=shim')
        }
      } finally {
        $stackLock = Join-Path $state ('.'+$Edition+'-stack.lock')
        if (Test-Path -LiteralPath $stackLock) {
          & $CrossVersionNode $CrossVersionStackEntry --mode $Edition --home $state --action stop | Out-Null
          if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $stackLock)) {
            throw 'Disposable candidate stack could not stop cleanly; refusing restore'
          }
        }
        $env:NODE = $priorNode
      }
      Stop-TrackedLegacyProcesses
      Start-Sleep -Milliseconds 350
      CheckPorts
      $global:tasks.Remove($managedName)
    }

    # Deliberate candidate-only drift (credentials, protected data, XML,
    # launcher and account registry) followed by an EXACT restore.
    Set-Content -LiteralPath $config -Encoding ASCII -Value 'candidate-only-invalid-token'
    Set-Content -LiteralPath $marker -Encoding ASCII -Value 'CANDIDATE-ONLY'
    Set-Content -LiteralPath (Join-Path $state 'server\accounts.json') -Encoding ASCII -Value '{}'
    $global:tasks[$expected[0]] = 'C:\candidate\foreign.cmd'
    $launcherDrift = Join-Path $state ('runtime\' + [IO.Path]::GetFileName($registered[$expected[0]]))
    Set-Content -LiteralPath $launcherDrift -Encoding ASCII -Value '@echo off'
    AssertTrue ((@($baselineFiles) -join '|') -ne (@(Get-TreeManifest $state) -join '|')) 'Simulated candidate did not mutate state'
    Get-ChildItem -LiteralPath $state -Force | Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $snapshotState -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $state -Recurse -Force
    }
    foreach($name in $expected) {
      $global:tasks[$name] = $registered[$name]
      $xmlPath = Join-Path $snapshotXml ($name + '.xml')
      AssertTrue ((Get-FileHash -LiteralPath $xmlPath -Algorithm SHA256).Hash -eq $xmlHashes[$name]) ('Rollback XML was corrupted: '+$name)
    }
    AssertTrue ((@($baselineFiles) -join '|') -eq (@(Get-TreeManifest $state) -join '|')) 'Protected state and launchers not restored byte-for-byte'
    AssertTrue ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -eq $beforeConfig) 'Rollback Core config differs'
    AssertTrue ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -eq $beforeMarker) 'Rollback protected marker differs'
    foreach($name in $expected) { & schtasks.exe /Run /TN $name }
    $ready = $false
    for($i=0;$i -lt 80;$i++) {
      try {
        if ((Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 2).StatusCode -eq 200 -and
            (Invoke-WebRequest -UseBasicParsing -Uri $coreHealth -TimeoutSec 2).StatusCode -eq 200 -and
            ($Edition -ne 'local' -or
             (Invoke-WebRequest -UseBasicParsing -Uri $historicalBridgeHealth -TimeoutSec 2).StatusCode -eq 200)) {
          $ready=$true;break
        }
      }
      catch {}
      Start-Sleep -Milliseconds 250
    }
    AssertTrue $ready 'Historical Gateway/Core did not restart from restored snapshot'
    . (Join-Path $CandidateRoot 'scripts\windows-memory-credentials.ps1')
    AssertTrue ((Resolve-MemhubMemoryToken -ConfigPath $config -MemoryDir (Join-Path $state 'memory')) -eq
      (Resolve-MemhubMemoryToken -ConfigPath (Join-Path $snapshotState 'memory-config.yaml') -MemoryDir (Join-Path $snapshotState 'memory'))) 'Restored historical Core credential changed'
    $global:unrelatedProcess.Refresh()
    AssertTrue (-not $global:unrelatedProcess.HasExited) 'Rollback touched an unrelated Node process'
    Write-Output ('historical-split-rollback-rehearsal: ok edition='+$Edition+' old_runtime_restarted=true state_and_launcher_hashes_restored=true scheduler=shim candidate=synthetic')
  }
  Write-Output ('historical-split-upgrade-failclosed: ok edition='+$Edition+' source=a00fba92 compat_token_quote='+[bool]$CompatTokenQuote+' compat_bundled_node='+[bool]$CompatBundledNode+' task_scheduler=shim real_old_processes=true')
  $global:succeeded = $true
} catch {
  Write-Warning ('QA failing line=' + $_.InvocationInfo.ScriptLineNumber + '; error=' + $_.Exception.GetType().Name)
  throw
} finally {
  # Terminate ONLY exact disposable processes started by our shim, not
  # arbitrary node.exe instances. The test never touches real scheduled tasks.
  Stop-TrackedLegacyProcesses
  if($global:unrelatedProcess) {
    $global:unrelatedProcess.Refresh()
    if(-not $global:unrelatedProcess.HasExited) {
      $global:unrelatedProcess.Kill()
      $global:unrelatedProcess.WaitForExit(5000) | Out-Null
    }
  }
  if($global:rollbackSnapshot -and $global:succeeded) { Remove-Item -LiteralPath $global:rollbackSnapshot -Recurse -Force -ErrorAction SilentlyContinue }
  # Restore only the disposable historical QA installer, never touch the
  # independently preserved pristine archive or any installed host package.
  if (($CompatTokenQuote -or $CompatBundledNode) -and
      (Test-Path -LiteralPath ($oldInstaller+'.original') -PathType Leaf)) {
    [IO.File]::WriteAllBytes($oldInstaller,
      [IO.File]::ReadAllBytes(($oldInstaller+'.original')))
  }
  if ($null -eq $PreviousNodeOverride) { Remove-Item Env:NODE -ErrorAction SilentlyContinue }
  else { $env:NODE = $PreviousNodeOverride }
  if($global:succeeded){Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction SilentlyContinue}
  else{Write-Warning ('QA failed; preserved disposable evidence at '+$state)}
}
