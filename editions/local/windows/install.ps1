param(
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$BundledNode = Join-Path $RepoRoot "runtime\node\node.exe"
$BundledNpmCli = Join-Path $RepoRoot "runtime\node\node_modules\npm\bin\npm-cli.js"
if ($env:NODE) { $Node = $env:NODE }
elseif (Test-Path $BundledNode) { $Node = $BundledNode }
else { $Node = (Get-Command node -ErrorAction Stop).Source }
$NpmCommand = Get-Command npm -ErrorAction SilentlyContinue
$Npm = if ($NpmCommand) { $NpmCommand.Source } else { "" }
$NodeMajor = [int](& $Node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 20) { throw "Node.js 20+ is required" }

function Invoke-Npm([string[]]$Arguments) {
  if ($Node -eq $BundledNode -and (Test-Path $BundledNpmCli)) {
    & $Node $BundledNpmCli @Arguments
  } elseif ($Npm) {
    & $Npm @Arguments
  } else {
    throw "npm is required when dependencies or build output are missing"
  }
  if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed" }
}
$ServerState = Join-Path $StateRoot "server"
$MemoryDir = Join-Path $StateRoot "memory"
$ConfigPath = Join-Path $StateRoot "memory-config.yaml"
$RuntimeDir = Join-Path $StateRoot "runtime"

New-Item -ItemType Directory -Force -Path $StateRoot,$ServerState,$MemoryDir,$RuntimeDir | Out-Null

$MemoryEntry = Join-Path $RepoRoot "vendor\memory-core\src\server\index.js"
$McpEntry = Join-Path $RepoRoot "dist\mcp.js"
$BridgeEntry = Join-Path $RepoRoot "dist\bridge.js"
$NodeModules = Join-Path $RepoRoot "node_modules"
if (-not (Test-Path $NodeModules)) {
  Push-Location $RepoRoot
  try {
    $PreviousCudaInstall = $env:ONNXRUNTIME_NODE_INSTALL_CUDA
    $env:ONNXRUNTIME_NODE_INSTALL_CUDA = "skip"
    Invoke-Npm @("ci", "--workspaces=false")
  } finally {
    if ($null -eq $PreviousCudaInstall) { Remove-Item Env:ONNXRUNTIME_NODE_INSTALL_CUDA -ErrorAction SilentlyContinue }
    else { $env:ONNXRUNTIME_NODE_INSTALL_CUDA = $PreviousCudaInstall }
    Pop-Location
  }
}
if (-not $SkipBuild -and (!(Test-Path $MemoryEntry) -or !(Test-Path $McpEntry) -or !(Test-Path $BridgeEntry))) {
  Push-Location $RepoRoot
  try {
    Invoke-Npm @("run", "build")
  } finally { Pop-Location }
}
if (!(Test-Path $MemoryEntry) -or !(Test-Path $McpEntry) -or !(Test-Path $BridgeEntry)) {
  throw "Build output is missing. Run without -SkipBuild or build Memory and Memhub first."
}

$MemoryTokenBytes = New-Object byte[] 32
$MemoryTokenRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $MemoryTokenRng.GetBytes($MemoryTokenBytes) } finally { $MemoryTokenRng.Dispose() }
$MemoryToken = -join ($MemoryTokenBytes | ForEach-Object { $_.ToString("x2") })
$Config = @{
  memmyMemory = @{
    version = 1
    userId = "local-user"
    roleRouting = @{ summary = "follow"; evolution = "follow" }
    storage = @{ mode = "local"; backend = "sqlite"; sqlitePath = (Join-Path $MemoryDir "memory.sqlite"); endpoint = "http://127.0.0.1:18960"; token = $MemoryToken }
    algorithm = @{ enableMemoryAdd = $true; enableMemorySearch = $true; enableQueryRewrite = $false }
    agentAccess = @{ autoScanKnownAgents = $false; watchFileChanges = $false; autoInjectSkill = $false }
  }
  providers = @{}
  modelAssignments = @{ default = $null; memorySummary = $null; memoryEvolution = $null; embedding = $null; asr = $null; imageGeneration = $null }
  modelPresets = @{}
  app = @{}
}
$Config | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $ConfigPath

$Accounts = (& $Node $McpEntry account list --state-root $ServerState | ConvertFrom-Json)
$Account = @($Accounts) | Where-Object { $_.username -eq "local" } | Select-Object -First 1
if (-not $Account) {
  $Account = (& $Node $McpEntry account add local --state-root $ServerState | ConvertFrom-Json)
}
$AccountId = $Account.account_id

$BridgePath = Join-Path $StateRoot "bridge.json"
$NeedsDevice = $true
if (Test-Path $BridgePath) {
  try {
    $ExistingBridge = Get-Content -Raw $BridgePath | ConvertFrom-Json
    if ($ExistingBridge.device_token) { $NeedsDevice = $false }
  } catch {}
}
if ($NeedsDevice) {
  $Device = (& $Node $McpEntry device add $AccountId "local-$env:COMPUTERNAME" --state-root $ServerState | ConvertFrom-Json)
  $env:MEMHUB_BRIDGE_HOME = $StateRoot
  $env:MEMHUB_DEVICE_TOKEN = $Device.token
  & $Node $BridgeEntry configure --mcp-endpoint http://127.0.0.1:3001/memhub/mcp --endpoint http://127.0.0.1:3001/memhub/capture | Out-Null
  Remove-Item Env:MEMHUB_DEVICE_TOKEN -ErrorAction SilentlyContinue
}

$MemoryLauncher = Join-Path $RuntimeDir "memory.cmd"
$GatewayLauncher = Join-Path $RuntimeDir "gateway.cmd"
$BridgeLauncher = Join-Path $RuntimeDir "bridge.cmd"
@"
@echo off
"$Node" "$MemoryEntry" --config "$ConfigPath" --host 127.0.0.1 --port 18960 --db "$MemoryDir\memory.sqlite"
"@ | Set-Content -Encoding ASCII $MemoryLauncher
@"
@echo off
set "MEMHUB_ACCOUNT_ID=$AccountId"
set "MEMHUB_OWNER_ACCOUNT_ID=$AccountId"
set "MEMHUB_OWNER_USER_ID=local-user"
set "MEMHUB_MEMORY_TOKEN=$MemoryToken"
set "MEMHUB_MEMORY_URL=http://127.0.0.1:18960"
set "MEMHUB_STATE_ROOT=$ServerState"
set "MEMHUB_BINDINGS=$StateRoot\conversation-project-bindings.json"
"$Node" "$McpEntry" --http 3001 --http-path /memhub/mcp --capture-path /memhub/capture --state-root "$ServerState" --memory-url http://127.0.0.1:18960
"@ | Set-Content -Encoding ASCII $GatewayLauncher
@"
@echo off
set "MEMHUB_BRIDGE_HOME=$StateRoot"
"$Node" "$BridgeEntry" serve --port 17861
"@ | Set-Content -Encoding ASCII $BridgeLauncher

try { & icacls.exe $StateRoot /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null } catch {}

function Install-LogonTask([string]$Name, [string]$Launcher) {
  & cmd.exe /c "schtasks.exe /End /TN $Name >NUL 2>&1" | Out-Null
  & schtasks.exe /Create /F /SC ONLOGON /TN $Name /TR ('"' + $Launcher + '"') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to create scheduled task $Name" }
  & schtasks.exe /Run /TN $Name | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to start scheduled task $Name" }
}
Install-LogonTask "Memhub-Memory" $MemoryLauncher
Start-Sleep -Seconds 1
Install-LogonTask "Memhub-Local" $GatewayLauncher
Start-Sleep -Seconds 1
Install-LogonTask "Memhub-Bridge" $BridgeLauncher

Write-Host "[memhub] Local Edition installed"
Write-Host "[memhub] MCP for plugins: http://127.0.0.1:17861/mcp"
Write-Host "[memhub] Capture for plugins: http://127.0.0.1:17861/capture"
Write-Host "[memhub] State: $StateRoot"
