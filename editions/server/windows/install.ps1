param(
  [string]$Username = "owner",
  [string]$Email = "",
  [string]$PublicHost = "",
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Npm = (Get-Command npm -ErrorAction Stop).Source
$ServerState = Join-Path $StateRoot "server"
$MemoryDir = Join-Path $StateRoot "memory"
$ConfigPath = Join-Path $StateRoot "memory-config.yaml"
$RuntimeDir = Join-Path $StateRoot "runtime"
New-Item -ItemType Directory -Force -Path $StateRoot,$ServerState,$MemoryDir,$RuntimeDir | Out-Null

$MemoryEntry = Join-Path $RepoRoot "vendor\memory-core\src\server\index.js"
$McpEntry = Join-Path $RepoRoot "dist\mcp.js"
$NodeModules = Join-Path $RepoRoot "node_modules"
if (-not (Test-Path $NodeModules)) {
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

$MemoryLauncher = Join-Path $RuntimeDir "memory-server.cmd"
$GatewayLauncher = Join-Path $RuntimeDir "gateway-server.cmd"
@"
@echo off
"$Node" "$MemoryEntry" --config "$ConfigPath" --host 127.0.0.1 --port 18960 --db "$MemoryDir\memory.sqlite"
"@ | Set-Content -Encoding ASCII $MemoryLauncher
$PublicArg = if ($PublicHost) { " --public-host $PublicHost" } else { "" }
$PublicEnv = if ($PublicHost) { "set `"MEMHUB_PUBLIC_HOST=$PublicHost`"`r`n" } else { "" }
@"
@echo off
set "MEMHUB_OWNER_ACCOUNT_ID=$AccountId"
set "MEMHUB_OWNER_USER_ID=local-user"
set "MEMHUB_MEMORY_TOKEN=$MemoryToken"
set "MEMHUB_MEMORY_URL=http://127.0.0.1:18960"
set "MEMHUB_STATE_ROOT=$ServerState"
set "MEMHUB_BINDINGS=$StateRoot\conversation-project-bindings.json"
$PublicEnv"$Node" "$McpEntry" --http 3001 --http-path /memhub/mcp --capture-path /memhub/capture --state-root "$ServerState" --memory-url http://127.0.0.1:18960$PublicArg
"@ | Set-Content -Encoding ASCII $GatewayLauncher
try { & icacls.exe $StateRoot /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F" | Out-Null } catch {}

function Install-LogonTask([string]$Name, [string]$Launcher) {
  & schtasks.exe /Create /F /SC ONLOGON /TN $Name /TR ('"' + $Launcher + '"') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to create scheduled task $Name" }
  & schtasks.exe /Run /TN $Name | Out-Null
}
Install-LogonTask "Memhub-Server-Memory" $MemoryLauncher
Start-Sleep -Seconds 1
Install-LogonTask "Memhub-Server" $GatewayLauncher

Write-Host "[memhub] Server Edition installed on loopback"
Write-Host "[memhub] Origin MCP:     http://127.0.0.1:3001/memhub/mcp"
Write-Host "[memhub] Origin capture: http://127.0.0.1:3001/memhub/capture"
Write-Host "[memhub] Account: $Username"
if (-not $PublicHost) { Write-Warning "No -PublicHost supplied. Configure it before publishing with Cloudflare Access." }
