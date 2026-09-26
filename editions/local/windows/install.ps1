param(
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$BundledNode = @(
  (Join-Path $RepoRoot "runtime\node\node.exe"),
  (Join-Path $RepoRoot "runtime\node.exe"),
  $env:NODE
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($BundledNode) { $BundledNode } elseif ($NodeCommand) { $NodeCommand.Source } else { throw "Node.js 20+ is required" }
$NpmCommand = Get-Command npm -ErrorAction SilentlyContinue
$Npm = if ($NpmCommand) { $NpmCommand.Source } else { $null }
$ServerState = Join-Path $StateRoot "server"
$MemoryDir = Join-Path $StateRoot "memory"
$ConfigPath = Join-Path $StateRoot "memory-config.yaml"
$RuntimeDir = Join-Path $StateRoot "runtime"

# Inspect Scheduler ownership before creating even a directory, fetching
# dependencies or touching credentials. Legacy split tasks are NOT a managed
# stack and must go through a separately authorized migration.
. (Join-Path $RepoRoot "scripts\windows-task-ownership.ps1")
$VerifiedStackTasks = @(Assert-MemhubInstallTaskSet -Mode local -StateRoot $StateRoot)
New-Item -ItemType Directory -Force -Path $StateRoot,$ServerState,$MemoryDir,$RuntimeDir | Out-Null

$MemoryEntry = Join-Path $RepoRoot "vendor\memory-core\src\server\index.js"
$McpEntry = Join-Path $RepoRoot "dist\mcp.js"
$BridgeEntry = Join-Path $RepoRoot "dist\bridge.js"
$NodeModules = Join-Path $RepoRoot "node_modules"
if (-not (Test-Path $NodeModules)) {
  if (-not $Npm) { throw "npm is required because bundled dependencies are missing" }
  Push-Location $RepoRoot
  try {
    $PreviousCudaInstall = $env:ONNXRUNTIME_NODE_INSTALL_CUDA
    $env:ONNXRUNTIME_NODE_INSTALL_CUDA = "skip"
    & $Npm ci --workspaces=false
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  } finally {
    if ($null -eq $PreviousCudaInstall) { Remove-Item Env:ONNXRUNTIME_NODE_INSTALL_CUDA -ErrorAction SilentlyContinue }
    else { $env:ONNXRUNTIME_NODE_INSTALL_CUDA = $PreviousCudaInstall }
    Pop-Location
  }
}
if (-not $SkipBuild -and (!(Test-Path $MemoryEntry) -or !(Test-Path $McpEntry) -or !(Test-Path $BridgeEntry))) {
  if (-not $Npm) { throw "npm is required because bundled build output is missing" }
  Push-Location $RepoRoot
  try {
    & $Npm run build
    if ($LASTEXITCODE -ne 0) { throw "Memhub build failed" }
  } finally { Pop-Location }
}
if (!(Test-Path $MemoryEntry) -or !(Test-Path $McpEntry) -or !(Test-Path $BridgeEntry)) {
  throw "Build output is missing. Run without -SkipBuild or build Memory and Memhub first."
}

# Resolve existing credentials before stopping a running stack. Core can
# rewrite the initial JSON-compatible config into YAML at first launch.
. (Join-Path $RepoRoot "scripts\windows-memory-credentials.ps1")
$MemoryToken = Resolve-MemhubMemoryToken -ConfigPath $ConfigPath -MemoryDir $MemoryDir

$StackEntry = Join-Path $RepoRoot "scripts\run-stack.mjs"
$StackLock = Join-Path $StateRoot ".local-stack.lock"
# Recheck after build/credential inspection. A task swapped while the
# installer was preparing cannot be silently adopted.
$CurrentStackTasks = @(Assert-MemhubInstallTaskSet -Mode local -StateRoot $StateRoot)
if ((@($CurrentStackTasks | Sort-Object) -join '|') -cne
    (@($VerifiedStackTasks | Sort-Object) -join '|')) {
  throw "Memhub Task Scheduler ownership changed during preparation; refusing installation"
}
if (Test-Path $StackLock) {
  . (Join-Path $RepoRoot "scripts\windows-stack-owner.ps1")
  Assert-MemhubStackProcessOwner -LockPath $StackLock -NodePath $Node -StackEntry $StackEntry -Mode local -StateRoot $StateRoot | Out-Null
  & $Node $StackEntry --mode local --home $StateRoot --action stop | Out-Null
  if ($LASTEXITCODE -ne 0 -or (Test-Path $StackLock)) {
    throw "Existing Memhub Local Stack did not stop cleanly; refusing unsafe reinstall"
  }
}
& $Node $StackEntry --mode local --home $StateRoot --action preflight
if ($LASTEXITCODE -ne 0) { throw "Memhub Local ports or stack ownership are not clear; refusing unsafe reinstall" }

if (-not $MemoryToken) {
  $MemoryToken = New-MemhubMemoryToken
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
}

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

$EnvPath = Join-Path $StateRoot "local.env"
@(
  "MEMHUB_ACCOUNT_ID=$AccountId"
  "MEMHUB_OWNER_ACCOUNT_ID=$AccountId"
  "MEMHUB_OWNER_USER_ID=local-user"
  "MEMHUB_MEMORY_TOKEN=$MemoryToken"
  "MEMHUB_MEMORY_URL=http://127.0.0.1:18960"
  "MEMHUB_STATE_ROOT=$ServerState"
  "MEMHUB_BINDINGS=$StateRoot\conversation-project-bindings.json"
) | Set-Content -Encoding UTF8 $EnvPath
$StackLauncher = Join-Path $RuntimeDir "stack-local.cmd"
@"
@echo off
"$Node" "$StackEntry" --mode local --home "$StateRoot"
"@ | Set-Content -Encoding ASCII $StackLauncher

try { & icacls.exe $StateRoot /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null } catch {}

function Install-LogonTask([string]$Name, [string]$Launcher) {
  & schtasks.exe /Create /SC ONLOGON /TN $Name /TR ('"' + $Launcher + '"') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to create scheduled task $Name" }
  & schtasks.exe /Run /TN $Name | Out-Null
}
foreach ($Task in $VerifiedStackTasks) {
  Remove-MemhubVerifiedStackTask -Name $Task -Launcher $StackLauncher
}
# Only run-stack's verified owner may stop its children. An orphan or unrelated
# process occupying a port is a preflight error, never a path-based kill target.
Install-LogonTask "Memhub-Local-Stack" $StackLauncher
& $Node (Join-Path $RepoRoot "scripts\wait-for-service.mjs") --url http://127.0.0.1:17861/health --kind bridge --timeout-ms 30000
if ($LASTEXITCODE -ne 0) { throw "Memhub Local Stack did not become ready" }

Write-Host "[memhub] Local Edition installed"
Write-Host "[memhub] MCP for plugins: http://127.0.0.1:17861/mcp"
Write-Host "[memhub] Capture for plugins: http://127.0.0.1:17861/capture"
Write-Host "[memhub] State: $StateRoot"
