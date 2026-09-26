# Used by both Windows editions. Memory Core may rewrite JSON-compatible
# memory-config.yaml as YAML on first launch; never assume it remains JSON.
function Resolve-MemhubMemoryToken {
  param([string]$ConfigPath, [string]$MemoryDir)
  if (-not (Test-Path $ConfigPath)) {
    if (Test-Path (Join-Path $MemoryDir "memory.sqlite")) {
      throw "Existing Memory database has no config; refusing credential reset"
    }
    return $null
  }
  try {
    $source = Get-Content -Raw $ConfigPath
    if ([string]::IsNullOrWhiteSpace($source)) { throw "empty config" }
    $trimmed = $source.TrimStart([char]0xFEFF).TrimStart()
    $token = $null
    if ($trimmed.StartsWith("{")) {
      $json = $trimmed | ConvertFrom-Json
      $token = [string]$json.memmyMemory.storage.token
    } else {
      $memoryIndent = -1
      $storageIndent = -1
      $inMemory = $false
      $inStorage = $false
      foreach ($line in ($trimmed -split "\r?\n")) {
        if ($line -match '^[ \t]*(?:#|$)') { continue }
        $entry = [regex]::Match($line, '^(?<indent>[ \t]*)(?<key>[A-Za-z_][A-Za-z0-9_-]*):[ \t]*(?<value>.*)$')
        if (-not $entry.Success) { continue }
        $indent = $entry.Groups["indent"].Value.Length
        $key = $entry.Groups["key"].Value
        if ($inStorage -and $indent -le $storageIndent) { $inStorage = $false }
        if ($inMemory -and $indent -le $memoryIndent) { $inMemory = $false }
        if (-not $inMemory -and $indent -eq 0 -and $key -eq "memmyMemory") {
          $inMemory = $true
          $memoryIndent = $indent
        } elseif ($inMemory -and -not $inStorage -and $indent -gt $memoryIndent -and $key -eq "storage") {
          $inStorage = $true
          $storageIndent = $indent
        } elseif ($inStorage -and $indent -gt $storageIndent -and $key -eq "token") {
          if ($null -ne $token) { throw "ambiguous storage token" }
          $token = $entry.Groups["value"].Value.Trim().Trim('"', "'")
        }
      }
    }
    # The installers generate a cryptographically random 32-byte hex token.
    # Reject any ambiguous YAML expression or mismatched token rather than
    # rotating credentials of an already initialized database.
    if ($token -notmatch '^[a-fA-F0-9]{64}$') { throw "invalid storage token" }
    return $token
  } catch {
    throw "Existing Memory config is unreadable or missing its storage token; refusing unsafe reinstall"
  }
}

function New-MemhubMemoryToken {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [System.BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
}
