param(
  [ValidateRange(1, 65535)][int]$SmtpPort = 1026,
  [ValidateRange(1, 65535)][int]$HttpPort = 8025
)

$ErrorActionPreference = 'Stop'
$repoPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mailpitPath = Join-Path $repoPath '.cache\mailpit'
$mailpitExe = Join-Path $mailpitPath 'mailpit.exe'
$version = 'v1.32.0'

if (-not (Test-Path -LiteralPath $mailpitExe)) {
  New-Item -ItemType Directory -Path $mailpitPath -Force | Out-Null
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/axllent/mailpit/releases/tags/$version" -TimeoutSec 30
  $asset = $release.assets | Where-Object { $_.name -eq 'mailpit-windows-amd64.zip' }
  if (-not $asset -or $asset.digest -notmatch '^sha256:([a-f0-9]{64})$') {
    throw 'The official Mailpit release did not include a SHA-256 digest.'
  }
  $expectedHash = $Matches[1]
  $archivePath = Join-Path $mailpitPath $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archivePath -TimeoutSec 120 -UseBasicParsing
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'Mailpit download checksum did not match the official release.'
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $mailpitPath -Force
}

$running = Get-Process -Name mailpit -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $mailpitExe }
if (-not $running) {
  $databasePath = Join-Path $mailpitPath 'messages.db'
  Start-Process -FilePath $mailpitExe -WorkingDirectory $repoPath -WindowStyle Hidden `
    -ArgumentList @('--smtp', "127.0.0.1:$SmtpPort", '--listen', "127.0.0.1:$HttpPort", '--database', "`"$databasePath`"") `
    -RedirectStandardOutput (Join-Path $mailpitPath 'stdout.log') `
    -RedirectStandardError (Join-Path $mailpitPath 'stderr.log') | Out-Null
}

Write-Output "Local email inbox: http://localhost:$HttpPort (SMTP: localhost:$SmtpPort)"
