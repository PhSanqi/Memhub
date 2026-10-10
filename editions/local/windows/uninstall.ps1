param([switch]$PurgeData, [string]$StateRoot = "$env:LOCALAPPDATA\Memhub")
$Common = Join-Path $PSScriptRoot "..\..\common\windows\uninstall.ps1"
& $Common -PurgeData:$PurgeData -StateRoot $StateRoot
if ($LASTEXITCODE) { exit $LASTEXITCODE }
