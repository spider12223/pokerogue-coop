# SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
#
# SPDX-License-Identifier: AGPL-3.0-only

# Builds the Windows pack (docs/coop/HOSTING.md, "Host from your own PC"): Start.bat, Node, the co-op server, the built
# game and cloudflared in one zip. Runs on PowerShell 7 (pwsh), on Windows or Linux.
#
#   pnpm build   (with VITE_SOURCE_URL set, and no VITE_COOP_RELAY_URL: the pack's game uses its own server's relay)
#   pwsh scripts/pack-windows.ps1                                 downloads Node and cloudflared, checks their SHA-256
#   pwsh scripts/pack-windows.ps1 -NodeExe C:\...\node.exe -CloudflaredExe C:\...\cloudflared.exe
#
# The zip lands in pack-out/ (not tracked).

param(
  [string]$Dist = "dist",
  [string]$Out = "pack-out",
  [string]$NodeExe,
  [string]$CloudflaredExe,
  [string]$NodeMajor = "24",
  [string]$SourceUrl = $env:VITE_SOURCE_URL,
  [switch]$NoZip
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Get-Checked([string]$url, [string]$file, [string]$sha256) {
  Write-Host "downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $file
  $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
  if ($actual -ne $sha256.ToLowerInvariant()) {
    throw "SHA-256 of $url is $actual, expected $sha256"
  }
}

if (-not (Test-Path (Join-Path $Dist "index.html"))) {
  throw "No build in ${Dist}: run pnpm build first (with VITE_SOURCE_URL set)."
}
if (Select-String -Path (Join-Path $Dist "assets/*.js") -Pattern "wss?://[^`"']+/coop" -Quiet) {
  Write-Warning "The build has a relay address built in (VITE_COOP_RELAY_URL): the pack's players would not use the pack's relay."
}

$name = "PokeRogue-Coop"
$pack = Join-Path $Out $name
$app = Join-Path $pack "app"
$downloads = Join-Path $Out "downloads"
if (Test-Path $pack) {
  Remove-Item -Recurse -Force $pack
}
New-Item -ItemType Directory -Force -Path $app, $downloads | Out-Null

# The launcher and the guide
Copy-Item "pack/windows/Start.bat" $pack
Copy-Item "pack/windows/README.txt" $pack
Copy-Item "pack/windows/start.ps1" $app

# The server: its sources and its one dependency, with pnpm's link resolved
$server = Join-Path $app "server"
New-Item -ItemType Directory -Force -Path (Join-Path $server "node_modules") | Out-Null
Copy-Item "coop-server/package.json" $server
Copy-Item -Recurse "coop-server/src" (Join-Path $server "src")
$ws = Get-Item "coop-server/node_modules/ws"
$wsTarget = $ws.ResolveLinkTarget($true)
Copy-Item -Recurse $(if ($null -ne $wsTarget) { $wsTarget.FullName } else { $ws.FullName }) (Join-Path $server "node_modules/ws")

# The game
Write-Host "copying the build ($Dist)"
Copy-Item -Recurse $Dist (Join-Path $app "game")

# Node
$licenses = Join-Path $pack "licenses"
New-Item -ItemType Directory -Force -Path $licenses | Out-Null
if ($NodeExe) {
  Copy-Item $NodeExe (Join-Path $app "node.exe")
  $nodeVersion = (& $NodeExe --version)
} else {
  $index = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $sums = (Invoke-WebRequest -Uri "$index/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v[\d.]+-win-x64\.zip$" } | Select-Object -First 1
  $sha, $file = $line -split "\s+"
  $zip = Join-Path $downloads $file
  Get-Checked "$index/$file" $zip $sha
  $unzipped = Join-Path $downloads "node"
  Expand-Archive -Force $zip $unzipped
  $folder = Get-ChildItem $unzipped -Directory | Select-Object -First 1
  Copy-Item (Join-Path $folder.FullName "node.exe") (Join-Path $app "node.exe")
  Copy-Item (Join-Path $folder.FullName "LICENSE") (Join-Path $licenses "node-LICENSE.txt")
  $nodeVersion = ($file -replace "^node-(v[\d.]+)-.*$", '$1')
}

# cloudflared
if ($CloudflaredExe) {
  Copy-Item $CloudflaredExe (Join-Path $app "cloudflared.exe")
  $cloudflaredVersion = "local copy"
} else {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
  $asset = $release.assets | Where-Object { $_.name -eq "cloudflared-windows-amd64.exe" } | Select-Object -First 1
  if ($null -eq $asset -or -not ("$($asset.digest)" -match "^sha256:([0-9a-f]{64})$")) {
    throw "cloudflared $($release.tag_name): no windows-amd64 asset with a SHA-256 digest"
  }
  Get-Checked $asset.browser_download_url (Join-Path $app "cloudflared.exe") $Matches[1]
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/cloudflare/cloudflared/$($release.tag_name)/LICENSE" `
    -OutFile (Join-Path $licenses "cloudflared-LICENSE.txt")
  $cloudflaredVersion = $release.tag_name
}

# Licences, and where the source of this pack is (the AGPL asks for it)
Copy-Item "LICENSE" (Join-Path $licenses "pokerogue-coop-LICENSE.txt")
Copy-Item -Recurse "LICENSES" (Join-Path $licenses "LICENSES")
$commit = $env:COOP_GIT_SHA
if (-not $commit) {
  $commit = (git rev-parse HEAD 2>$null)
}
@(
  "PokeRogue Co-op, Windows pack",
  "",
  "Source code: $SourceUrl",
  "Commit: $commit",
  "",
  "The game is licensed under the AGPL-3.0 (licenses/pokerogue-coop-LICENSE.txt); its documentation and assets as each",
  "file of the source says (licenses/LICENSES). Included programs:",
  "  node.exe         Node.js $nodeVersion, https://nodejs.org (licenses/node-LICENSE.txt)",
  "  cloudflared.exe  cloudflared $cloudflaredVersion, https://github.com/cloudflare/cloudflared, Apache-2.0 (licenses/cloudflared-LICENSE.txt)",
  "  app/server/node_modules/ws  https://github.com/websockets/ws, MIT"
) | Set-Content -Encoding utf8 (Join-Path $pack "SOURCE.txt")

if (-not $NoZip) {
  $zipPath = Join-Path $Out "$name-windows.zip"
  if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
  }
  Write-Host "zipping into $zipPath"
  if ($IsWindows) {
    tar.exe -a -c -f $zipPath -C $Out $name
  } else {
    Push-Location $Out
    zip -qr "$name-windows.zip" $name
    Pop-Location
  }
  if ($LASTEXITCODE -ne 0) {
    throw "zip failed"
  }
  $size = [math]::Round((Get-Item $zipPath).Length / 1MB)
  Write-Host "done: $zipPath ($size MB)"
}
