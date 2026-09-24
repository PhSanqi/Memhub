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
$PackageRoot = $PSScriptRoot
$BundledNode = Join-Path $PackageRoot "runtime\node\node.exe"

if (Test-Path $BundledNode) {
  if ($PrepareOnly) {
    & $BundledNode (Join-Path $PackageRoot "scripts\complete-runtime-smoke.cjs")
    if ($LASTEXITCODE -ne 0) { throw "Complete runtime smoke failed" }
    Write-Host "[memhub] complete package verified: $PackageRoot"
    return
  }
  $env:NODE = $BundledNode
  if ($Edition -eq "server") {
    & (Join-Path $PackageRoot "editions\server\windows\install.ps1") -Username $Username -Email $Email -PublicHost $PublicHost -StateRoot $StateRoot
  } else {
    & (Join-Path $PackageRoot "editions\local\windows\install.ps1") -StateRoot $StateRoot
  }
  return
}

if ($Version -eq "latest") {
  $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "Memhub-Complete-Installer" }
  $Tag = [string]$Release.tag_name
} else {
  $Tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
}
if ($Tag -notmatch '^v\d+\.\d+\.\d+$') { throw "Could not resolve a stable Memhub release tag: $Tag" }

$Asset = "memhub-$Tag-windows-x64-complete.zip"
$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("memhub-complete-" + [Guid]::NewGuid().ToString("N"))
$Archive = Join-Path $Temp $Asset
$Sums = Join-Path $Temp "SHA256SUMS.txt"
$Extract = Join-Path $Temp "extract"

try {
  New-Item -ItemType Directory -Force -Path $Temp,$Extract,$InstallRoot | Out-Null
  Write-Host "[memhub] complete release: $Tag"
  Write-Host "[memhub] downloading: $Asset"
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile $Archive
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $Sums
  $Line = Get-Content $Sums | Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s\s" + [Regex]::Escape($Asset) + "$") } | Select-Object -First 1
  if (-not $Line) { throw "Checksum entry missing for $Asset" }
  $Expected = ($Line -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $Archive).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "SHA-256 verification failed for $Asset" }

  Expand-Archive -Path $Archive -DestinationPath $Extract -Force
  $RootName = [IO.Path]::GetFileNameWithoutExtension($Asset)
  $Source = Join-Path $Extract $RootName
  if (-not (Test-Path (Join-Path $Source "runtime\node\node.exe"))) { throw "Complete archive is missing bundled Node.js" }
  $Target = Join-Path $InstallRoot "$Tag-complete"
  if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
  Move-Item -Path $Source -Destination $Target

  $Args = @{ Edition=$Edition; InstallRoot=$InstallRoot; StateRoot=$StateRoot; Username=$Username; Email=$Email; PublicHost=$PublicHost }
  if ($PrepareOnly) { $Args.PrepareOnly = $true }
  & (Join-Path $Target "install-complete.ps1") @Args
} finally {
  if (Test-Path $Temp) { Remove-Item -Recurse -Force $Temp }
}
