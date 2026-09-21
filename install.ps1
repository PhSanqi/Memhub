param(
  [ValidateSet("local", "server")]
  [string]$Edition = $(if ($env:MEMHUB_EDITION) { $env:MEMHUB_EDITION } else { "local" }),
  [string]$Version = $(if ($env:MEMHUB_VERSION) { $env:MEMHUB_VERSION } else { "latest" }),
  [string]$InstallRoot = $(if ($env:MEMHUB_INSTALL_DIR) { $env:MEMHUB_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Memhub\app" }),
  [string]$StateRoot = $(if ($env:MEMHUB_HOME) { $env:MEMHUB_HOME } else { Join-Path $env:LOCALAPPDATA "Memhub" }),
  [string]$Username = $(if ($env:MEMHUB_USERNAME) { $env:MEMHUB_USERNAME } else { "owner" }),
  [string]$Email = $(if ($env:MEMHUB_EMAIL) { $env:MEMHUB_EMAIL } else { "" }),
  [string]$PublicHost = $(if ($env:MEMHUB_PUBLIC_HOST) { $env:MEMHUB_PUBLIC_HOST } else { "" }),
  [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"
$Repo = "PhSanqi/Memhub"

foreach ($Command in @("node", "npm")) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Command is required. Install Node.js 20+ before installing Memhub."
  }
}

$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 20) {
  throw "Node.js 20+ is required. Found: $(& node --version)"
}

if ($Version -eq "latest") {
  $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "Memhub-Installer" }
  $Tag = [string]$Release.tag_name
} else {
  $Tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
}

if ($Tag -notmatch '^v\d+\.\d+\.\d+$') {
  throw "Could not resolve a stable Memhub release tag: $Tag"
}

$EditionLower = $Edition.ToLowerInvariant()
$Asset = "memhub-$Tag-windows-$EditionLower.zip"
$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("memhub-install-" + [Guid]::NewGuid().ToString("N"))
$Archive = Join-Path $Temp $Asset
$Sums = Join-Path $Temp "SHA256SUMS.txt"
$Extract = Join-Path $Temp "extract"

try {
  New-Item -ItemType Directory -Force -Path $Temp,$Extract,$InstallRoot | Out-Null
  Write-Host "[memhub] release: $Tag"
  Write-Host "[memhub] edition: Windows $EditionLower"
  Write-Host "[memhub] downloading: $Asset"

  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile $Archive
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $Sums

  $Line = Get-Content $Sums | Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s\s" + [Regex]::Escape($Asset) + "$") } | Select-Object -First 1
  if (-not $Line) { throw "Checksum entry missing for $Asset" }
  $Expected = ($Line -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $Archive).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "SHA-256 verification failed for $Asset" }
  Write-Host "[memhub] SHA-256 verified"

  Expand-Archive -Path $Archive -DestinationPath $Extract -Force
  $RootName = [IO.Path]::GetFileNameWithoutExtension($Asset)
  $Source = Join-Path $Extract $RootName
  if (-not (Test-Path $Source)) { throw "Unexpected release archive layout" }

  $Target = Join-Path $InstallRoot "$Tag-$EditionLower"
  if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
  Move-Item -Path $Source -Destination $Target

  $Installer = Join-Path $Target "editions\$EditionLower\windows\install.ps1"
  if ($PrepareOnly) {
    Write-Host "[memhub] package prepared and verified: $Target"
    return
  }
  Write-Host "[memhub] installing from: $Target"
  if ($EditionLower -eq "server") {
    & $Installer -Username $Username -Email $Email -PublicHost $PublicHost -StateRoot $StateRoot
  } else {
    & $Installer -StateRoot $StateRoot
  }
  Write-Host "[memhub] installation complete"
  Write-Host "[memhub] app files: $Target"
  if ($EditionLower -eq "local") {
    Write-Host "[memhub] MCP: http://127.0.0.1:17861/mcp"
  } else {
    Write-Host "[memhub] Origin MCP: http://127.0.0.1:3001/memhub/mcp"
  }
} finally {
  if (Test-Path $Temp) { Remove-Item -Recurse -Force $Temp }
}
