param(
  [string]$Username = "owner",
  [string]$Email = "",
  [string]$PublicHost = "",
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$BundledNode = @(
  $env:NODE,
  (Join-Path $RepoRoot "runtime\node\node.exe"),
  (Join-Path $RepoRoot "runtime\node.exe")
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($BundledNode) { $BundledNode } elseif ($NodeCommand) { $NodeCommand.Source } else { throw "Node.js 20+ is required" }
$NpmCommand = Get-Command npm -ErrorAction SilentlyContinue
$Npm = if ($NpmCommand) { $NpmCommand.Source } else { $null }
$ServerState = Join-Path $StateRoot "server"
$MemoryDir = Join-Path $StateRoot "memory"
$ConfigPath = Join-Path $StateRoot "memory-config.yaml"
$RuntimeDir = Join-Path $StateRoot "runtime"
New-Item -ItemType Directory -Force -Path $StateRoot,$ServerState,$MemoryDir,$RuntimeDir | Out-Null

$MemoryEntry = Join-Path $RepoRoot "vendor\memory-core\src\server\index.js"
$McpEntry = Join-Path $RepoRoot "dist\mcp.js"
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
if (-not $SkipBuild -and (!(Test-Path $MemoryEntry) -or !(Test-Path $McpEntry))) {
  if (-not $Npm) { throw "npm is required because bundled build output is missing" }
  Push-Location $RepoRoot
  try {
    & $Npm run build
    if ($LASTEXITCODE -ne 0) { throw "Memhub build failed" }
  } finally { Pop-Location }
}
if (!(Test-Path $MemoryEntry) -or !(Test-Path $McpEntry)) { throw "Build output is missing." }

$MemoryToken = & $Node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
$Config = @{
  memmyMemory = @{
    version = 1; userId = "local-user"; roleRouting = @{ summary = "follow"; evolution = "follow" }
    storage = @{ mode = "local"; backend = "sqlite"; sqlitePath = (Join-Path $MemoryDir "memory.sqlite"); endpoint = "http://127.0.0.1:18960"; token = $MemoryToken }
    algorithm = @{ enableMemoryAdd = $true; enableMemorySearch = $true; enableQueryRewrite = $false }
    agentAccess = @{ autoScanKnownAgents = $false; watchFileChanges = $false; autoInjectSkill = $false }
  }
  providers = @{}; modelAssignments = @{ default = $null; memorySummary = $null; memoryEvolution = $null; embedding = $null; asr = $null; imageGeneration = $null }; modelPresets = @{}; app = @{}
}
$Config | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $ConfigPath

$Accounts = (& $Node $McpEntry account list --state-root $ServerState | ConvertFrom-Json)
$Account = @($Accounts) | Where-Object { $_.username -eq $Username } | Select-Object -First 1
if (-not $Account) {
  if ($Email) { $Account = (& $Node $McpEntry account add $Username $Email --state-root $ServerState | ConvertFrom-Json) }
  else { $Account = (& $Node $McpEntry account add $Username --state-root $ServerState | ConvertFrom-Json) }
}
$AccountId = $Account.account_id

$EnvPath = Join-Path $StateRoot "server.env"
$EnvironmentLines = @(
  "MEMHUB_OWNER_ACCOUNT_ID=$AccountId"
  "MEMHUB_OWNER_USER_ID=local-user"
  "MEMHUB_MEMORY_TOKEN=$MemoryToken"
  "MEMHUB_MEMORY_URL=http://127.0.0.1:18960"
  "MEMHUB_STATE_ROOT=$ServerState"
  "MEMHUB_BINDINGS=$StateRoot\conversation-project-bindings.json"
)
if ($PublicHost) { $EnvironmentLines += "MEMHUB_PUBLIC_HOST=$PublicHost" }
$EnvironmentLines | Set-Content -Encoding UTF8 $EnvPath
$StackLauncher = Join-Path $RuntimeDir "stack-server.cmd"
$StackEntry = Join-Path $RepoRoot "scripts\run-stack.mjs"
$StackLock = Join-Path $StateRoot ".server-stack.lock"
@"
@echo off
"$Node" "$StackEntry" --mode server --home "$StateRoot"
"@ | Set-Content -Encoding ASCII $StackLauncher
try { & icacls.exe $StateRoot /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null } catch {}

function Install-LogonTask([string]$Name, [string]$Launcher) {
  & schtasks.exe /Create /F /SC ONLOGON /TN $Name /TR ('"' + $Launcher + '"') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to create scheduled task $Name" }
  & schtasks.exe /Run /TN $Name | Out-Null
}
if (Test-Path $StackLock) {
  & $Node $StackEntry --mode server --home $StateRoot --action stop | Out-Null
  if ($LASTEXITCODE -ne 0 -or (Test-Path $StackLock)) {
    throw "Existing Memhub Server Stack did not stop cleanly; refusing unsafe reinstall"
  }
}
foreach ($Task in @("Memhub-Server-Stack", "Memhub-Server-Memory", "Memhub-Server")) {
  & cmd.exe /d /c "schtasks.exe /Query /TN `"$Task`" >NUL 2>&1" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    & cmd.exe /d /c "schtasks.exe /End /TN `"$Task`" >NUL 2>&1" | Out-Null
    & cmd.exe /d /c "schtasks.exe /Delete /F /TN `"$Task`" >NUL 2>&1" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to remove existing scheduled task $Task" }
  }
}
function Stop-MemhubNodeProcesses {
  $Needles = @($MemoryEntry, $McpEntry) | ForEach-Object { $_.ToLowerInvariant() }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $CommandLine = [string]$_.CommandLine
    if (-not $CommandLine) { return }
    $Lower = $CommandLine.ToLowerInvariant()
    if ($Needles | Where-Object { $Lower.Contains($_) }) {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}
    }
  }
}
Stop-MemhubNodeProcesses
Start-Sleep -Milliseconds 500
Install-LogonTask "Memhub-Server-Stack" $StackLauncher
& $Node (Join-Path $RepoRoot "scripts\wait-for-service.mjs") --url http://127.0.0.1:3001/memhub/health --kind gateway --timeout-ms 30000
if ($LASTEXITCODE -ne 0) { throw "Memhub Server Stack did not become ready" }

Write-Host "[memhub] Server Edition installed on loopback"
Write-Host "[memhub] Origin MCP:     http://127.0.0.1:3001/memhub/mcp"
Write-Host "[memhub] Origin capture: http://127.0.0.1:3001/memhub/capture"
Write-Host "[memhub] Account: $Username"
if (-not $PublicHost) { Write-Warning "No -PublicHost supplied. Configure it before publishing with Cloudflare Access." }
