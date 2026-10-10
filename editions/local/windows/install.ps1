param(
  [string]$StateRoot = "$env:LOCALAPPDATA\Memhub",
  [switch]$SkipBuild
)
$Common = Join-Path $PSScriptRoot "..\..\common\windows\install.ps1"
& $Common -Username "local" -StateRoot $StateRoot -SkipBuild:$SkipBuild
if ($LASTEXITCODE) { exit $LASTEXITCODE }
