param(
  [string]$Username = "owner",
  [string]$Email = "",
  [string]$PublicHost = "",
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub",
  [switch]$SkipBuild
)
$Common = Join-Path $PSScriptRoot "..\..\common\windows\install.ps1"
& $Common -Username $Username -Email $Email -PublicHost $PublicHost -StateRoot $StateRoot -SkipBuild:$SkipBuild
if ($LASTEXITCODE) { exit $LASTEXITCODE }
