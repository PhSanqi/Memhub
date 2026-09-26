param(
  [ValidateSet('server','local')][string]$Edition = 'server',
  [Parameter(Mandatory)][string]$LegacyRoot,
  [switch]$CompatTokenQuote
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
$self = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function AssertTrue([bool]$condition,[string]$message) { if(-not $condition){throw $message} }
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
  New-Item -ItemType Directory -Force -Path $state | Out-Null
  if ($CompatTokenQuote) {
    # Test-only repair of one PowerShell 5.1 -> Node 24 native-argv quoting
    # incompatibility in the historical source. Preserve the pristine Git
    # archive and backup the exact original source alongside the fixture.
    $source = if (Test-Path ($oldInstaller+'.original')) {
      [IO.File]::ReadAllText(($oldInstaller+'.original'))
    } else { [IO.File]::ReadAllText($oldInstaller) }
    $original = '$MemoryToken = & $Node -e ''process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'''
    if ($source.Split(@($original),[StringSplitOptions]::None).Count -ne 2) {
      throw 'Historical token source does not match the reviewed fixture'
    }
    [IO.File]::WriteAllText(($oldInstaller+'.original'),$source)
    $replacement = '$tokenBytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes); $MemoryToken = ([BitConverter]::ToString($tokenBytes)).Replace(''-'','''').ToLowerInvariant()'
    [IO.File]::WriteAllText($oldInstaller,$source.Replace($original,$replacement))
  }
  if($Edition -eq 'server') { & $oldInstaller -StateRoot $state -SkipBuild -Username 'historical-owner' }
  else { & $oldInstaller -StateRoot $state -SkipBuild }
  $expected = if($Edition -eq 'server'){@('Memhub-Server-Memory','Memhub-Server')}
    else {@('Memhub-Memory','Memhub-Local','Memhub-Bridge')}
  AssertTrue ($global:tasks.Count -eq $expected.Count) 'Old installer did not register expected split tasks'
  foreach($name in $expected) { AssertTrue $global:tasks.ContainsKey($name) ("Missing old task "+$name) }
  $health = 'http://127.0.0.1:3001/memhub/health'
  $ready = $false
  for($i=0;$i -lt 80;$i++) {
    try { $reply=Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 2; if($reply.StatusCode -eq 200){$ready=$true;break} }
    catch {}
    Start-Sleep -Milliseconds 250
  }
  AssertTrue $ready 'Historical Gateway did not become healthy'
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
  AssertTrue (Test-Path $db) 'Old database missing'
  Write-Output ('historical-split-upgrade-failclosed: ok edition='+$Edition+' source=a00fba92 compat_token_quote='+[bool]$CompatTokenQuote+' task_scheduler=shim real_old_processes=true')
  $global:succeeded = $true
} catch {
  Write-Warning ('QA failing line=' + $_.InvocationInfo.ScriptLineNumber + '; error=' + $_.Exception.GetType().Name)
  throw
} finally {
  # Terminate ONLY exact disposable processes started by our shim, not
  # arbitrary node.exe instances. The test never touches real scheduled tasks.
  foreach($p in $global:children) {
    if($p -and -not $p.HasExited) {
      & taskkill.exe /T /F /PID $p.Id 2>$null | Out-Null
    }
  }
  if($global:succeeded){Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction SilentlyContinue}
  else{Write-Warning ('QA failed; preserved disposable evidence at '+$state)}
}
