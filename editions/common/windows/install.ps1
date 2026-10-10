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
  (Join-Path $RepoRoot "runtime\node\node.exe"),
  (Join-Path $RepoRoot "runtime\node.exe"),
  $env:NODE
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($BundledNode) { $BundledNode } elseif ($NodeCommand) { $NodeCommand.Source } else { throw "Node.js 20+ is required" }
$NpmCommand = Get-Command npm -ErrorAction SilentlyContinue
$Npm = if ($NpmCommand) { $NpmCommand.Source } else { $null }
$ControlRoot = Join-Path $StateRoot "server"
$MemoryDir = Join-Path $StateRoot "memory"
$ConfigPath = Join-Path $StateRoot "memory-config.yaml"
$RuntimeDir = Join-Path $StateRoot "runtime"
$EnvPath = Join-Path $StateRoot "memhub.env"

. (Join-Path $RepoRoot "scripts\windows-task-ownership.ps1")
$VerifiedStackTasks = @(Assert-MemhubInstallTaskSet -StateRoot $StateRoot)
New-Item -ItemType Directory -Force -Path $StateRoot,$ControlRoot,$MemoryDir,$RuntimeDir | Out-Null

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
  if (-not $Npm) { throw "npm is required because build output is missing" }
  Push-Location $RepoRoot
  try {
    & $Npm run build
    if ($LASTEXITCODE -ne 0) { throw "Memhub build failed" }
  } finally { Pop-Location }
}
if (!(Test-Path $MemoryEntry) -or !(Test-Path $McpEntry)) { throw "Build output is missing" }

. (Join-Path $RepoRoot "scripts\windows-memory-credentials.ps1")
$MemoryToken = Resolve-MemhubMemoryToken -ConfigPath $ConfigPath -MemoryDir $MemoryDir
if (-not $PSBoundParameters.ContainsKey("PublicHost") -and (Test-Path $EnvPath)) {
  $HostLines = @(Get-Content $EnvPath | Where-Object { $_ -match '^MEMHUB_PUBLIC_HOST=' })
  if ($HostLines.Count -gt 1) { throw "Existing memhub.env contains ambiguous public host" }
  if ($HostLines.Count -eq 1) { $PublicHost = $HostLines[0].Substring("MEMHUB_PUBLIC_HOST=".Length) }
}

$StackEntry = Join-Path $RepoRoot "scripts\run-stack.mjs"
$StackLock = Join-Path $StateRoot ".memhub-stack.lock"
$CurrentStackTasks = @(Assert-MemhubInstallTaskSet -StateRoot $StateRoot)
if ((@($CurrentStackTasks | Sort-Object) -join '|') -cne (@($VerifiedStackTasks | Sort-Object) -join '|')) {
  throw "Memhub Task Scheduler ownership changed during preparation; refusing installation"
}
if (Test-Path $StackLock) {
  . (Join-Path $RepoRoot "scripts\windows-stack-owner.ps1")
  Assert-MemhubStackProcessOwner -LockPath $StackLock -NodePath $Node -StackEntry $StackEntry -StateRoot $StateRoot | Out-Null
  & $Node $StackEntry --home $StateRoot --action stop | Out-Null
  if ($LASTEXITCODE -ne 0 -or (Test-Path $StackLock)) {
    throw "Existing Memhub Stack did not stop cleanly; refusing unsafe reinstall"
  }
}
& $Node $StackEntry --home $StateRoot --action preflight
if ($LASTEXITCODE -ne 0) { throw "Memhub ports or stack ownership are not clear; refusing unsafe reinstall" }

if (-not $MemoryToken) {
  $MemoryToken = New-MemhubMemoryToken
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
}

$Accounts = (& $Node $McpEntry account list --state-root $ControlRoot | ConvertFrom-Json)
$Account = @($Accounts) | Where-Object { $_.username -eq $Username } | Select-Object -First 1
if (-not $Account) {
  if ($Email) { $Account = (& $Node $McpEntry account add $Username $Email --state-root $ControlRoot | ConvertFrom-Json) }
  else { $Account = (& $Node $McpEntry account add $Username --state-root $ControlRoot | ConvertFrom-Json) }
}
$AccountId = $Account.account_id

$EnvironmentLines = @(
  "MEMHUB_ACCOUNT_ID=$AccountId"
  "MEMHUB_OWNER_ACCOUNT_ID=$AccountId"
  "MEMHUB_OWNER_USER_ID=local-user"
  "MEMHUB_MEMORY_TOKEN=$MemoryToken"
  "MEMHUB_MEMORY_URL=http://127.0.0.1:18960"
  "MEMHUB_STATE_ROOT=$ControlRoot"
)
if ($PublicHost) { $EnvironmentLines += "MEMHUB_PUBLIC_HOST=$PublicHost" }
$EnvironmentLines | Set-Content -Encoding UTF8 $EnvPath

$StackLauncher = Join-Path $RuntimeDir "stack.cmd"
@"
@echo off
"$Node" "$StackEntry" --home "$StateRoot"
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
Install-LogonTask "Memhub-Stack" $StackLauncher
& $Node (Join-Path $RepoRoot "scripts\wait-for-service.mjs") --url http://127.0.0.1:3001/memhub/health --kind gateway --timeout-ms 30000
if ($LASTEXITCODE -ne 0) { throw "Memhub Stack did not become ready" }

Write-Host "[memhub] installed"
Write-Host "[memhub] local MCP: http://127.0.0.1:3001/mcp"
Write-Host "[memhub] account: $Username"
if ($PublicHost) { Write-Host "[memhub] remote host enabled: $PublicHost" }
else { Write-Host "[memhub] remote host disabled; loopback MCP only" }
