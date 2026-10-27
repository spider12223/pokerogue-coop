# SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
#
# SPDX-License-Identifier: AGPL-3.0-only

# Hosts a co-op game on this PC (Start.bat runs this): the game and its relay on http://127.0.0.1:<port>, and a Cloudflare
# quick tunnel that gives your friend an https link to the same server. Written for Windows PowerShell 5.1 (built into
# Windows), so no PowerShell 7 syntax.
#
#   Start.bat              host, with a link for your friend
#   Start.bat -NoTunnel    only this PC (and nobody else)
#   Start.bat -NoBrowser   do not open the game in the browser

param(
  [switch]$NoTunnel,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$app = $PSScriptRoot
$root = Split-Path -Parent $app
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$node = Join-Path $app "node.exe"
$cloudflared = Join-Path $app "cloudflared.exe"
$server = Join-Path $app "server\src\main.ts"
$game = Join-Path $app "game"

function Say([string]$text, [string]$color = "Gray") {
  Write-Host $text -ForegroundColor $color
}

function Test-PortFree([int]$port) {
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Wait-Http([string]$url, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

foreach ($file in @($node, $server, (Join-Path $game "index.html"))) {
  if (-not (Test-Path $file)) {
    Say "Missing $file. Unzip the whole pack again (all folders), then run Start.bat." "Red"
    exit 1
  }
}

# The host's browser keeps the accounts and the saved run per address: the same port every time keeps the same saves
$port = 8080
if (-not (Test-PortFree $port)) {
  $port = (8081..8099 | Where-Object { Test-PortFree $_ } | Select-Object -First 1)
  if ($null -eq $port) {
    Say "Ports 8080 to 8099 are all in use. Close the program that uses them and try again." "Red"
    exit 1
  }
  Say "Port 8080 is in use, so this game runs on ${port}: your saves from port 8080 are not here this time." "Yellow"
}
$local = "http://127.0.0.1:$port"

$env:PORT = "$port"
$env:HOST = "127.0.0.1"
$env:STATIC_DIR = $game
$env:NODE_ENV = "production"

Say "Starting the game server..."
$serverProcess = Start-Process -FilePath $node -ArgumentList "`"$server`"" -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $logs "server.log") -RedirectStandardError (Join-Path $logs "server-errors.log")
$tunnelProcess = $null

try {
  if (-not (Wait-Http "$local/healthz" 20)) {
    Say "The game server did not start. See logs\server-errors.log." "Red"
    exit 1
  }

  $link = $null
  if (-not $NoTunnel) {
    if (-not (Test-Path $cloudflared)) {
      Say "cloudflared.exe is missing, so there is no link for your friend (only this PC can play)." "Yellow"
    } else {
      Say "Opening a link for your friend (Cloudflare quick tunnel)..."
      $tunnelLog = Join-Path $logs "tunnel.log"
      if (Test-Path $tunnelLog) {
        Remove-Item $tunnelLog -Force
      }
      $tunnelProcess = Start-Process -FilePath $cloudflared `
        -ArgumentList @("tunnel", "--no-autoupdate", "--url", $local) -NoNewWindow -PassThru `
        -RedirectStandardOutput (Join-Path $logs "tunnel-out.log") -RedirectStandardError $tunnelLog
      $deadline = (Get-Date).AddSeconds(60)
      while ($null -eq $link -and (Get-Date) -lt $deadline -and -not $tunnelProcess.HasExited) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $tunnelLog) {
          # The tunnel's own address; not api.trycloudflare.com, which cloudflared names in its errors
          $found = Select-String -Path $tunnelLog -Pattern "https://(?!api\.)[-a-z0-9]+\.trycloudflare\.com" | Select-Object -First 1
          if ($null -ne $found) {
            $link = $found.Matches[0].Value
          }
        }
      }
      if ($null -eq $link) {
        Say "Cloudflare did not give a link (no internet, or a firewall blocks it). See logs\tunnel.log." "Yellow"
        Say "You can still play here, but your friend cannot join." "Yellow"
      } elseif (-not (Wait-Http "$link/healthz" 45)) {
        Say "The link is not reachable yet; it may need a minute: $link" "Yellow"
      }
    }
  }

  Write-Host ""
  Say "  ==========================================================" "Cyan"
  Say "    PokeRogue Co-op is running" "Cyan"
  Write-Host ""
  if ($NoBrowser) {
    Say "    You play here:        $local" "White"
  } else {
    Say "    You play here:        $local   (opening in your browser)" "White"
  }
  if ($null -ne $link) {
    Say "    Send your friend:     $link" "Green"
    try {
      Set-Clipboard -Value $link
      Say "                          (copied: paste it into your chat)" "Green"
    } catch {
      # no clipboard: the link is on screen
    }
  }
  Write-Host ""
  Say "    Then: Co-op > Host a game, and send the code to your friend." "White"
  Say "    Your friend opens the link and chooses Co-op > Join a game." "White"
  Write-Host ""
  Say "    Keep this window open while you play. Close it to stop." "Yellow"
  Say "  ==========================================================" "Cyan"
  Write-Host ""

  if (-not $NoBrowser) {
    Start-Process $local
  }

  while (-not $serverProcess.HasExited) {
    if ($null -ne $tunnelProcess -and $tunnelProcess.HasExited) {
      Say "The link for your friend stopped working (Cloudflare closed it). Close this window and run Start.bat again." "Yellow"
      $tunnelProcess = $null
    }
    Start-Sleep -Seconds 2
  }
  Say "The game server stopped. See logs\server-errors.log." "Red"
  exit 1
} finally {
  foreach ($process in @($tunnelProcess, $serverProcess)) {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
