$ErrorActionPreference = "Stop"

$GatewayRoot = Split-Path -Parent $PSScriptRoot
$NodeExe = Join-Path $GatewayRoot "node\node.exe"
$AppEntry = Join-Path $GatewayRoot "app\dist\index.js"
$OpenCodeExe = Join-Path $GatewayRoot "app\node_modules\opencode-ai\bin\opencode.exe"
$DataDir = Join-Path $env:LOCALAPPDATA "TomsGateway"
if ($env:GATEWAY_ENV_FILE) { $EnvFile = $env:GATEWAY_ENV_FILE } else { $EnvFile = Join-Path $DataDir "gateway.env" }
$LogDir = Join-Path $DataDir "logs"
$LogFile = Join-Path $LogDir "gateway.log"
$ErrFile = Join-Path $LogDir "gateway.err.log"
$PidFile = Join-Path $DataDir "gateway.pid"
$StopFlag = Join-Path $DataDir "gateway.stop"
$TaskName = "TomsGateway"

function Read-GatewayEnv {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $text = $line.Trim()
    if ($text -eq "" -or $text.StartsWith("#")) { continue }
    $index = $text.IndexOf("=")
    if ($index -lt 1) { continue }
    $map[$text.Substring(0, $index).Trim()] = $text.Substring($index + 1).Trim().Trim('"').Trim("'")
  }
  return $map
}

function Get-GatewaySetting {
  param([string]$Name, [string]$Default)
  if ([Environment]::GetEnvironmentVariable($Name)) { return [Environment]::GetEnvironmentVariable($Name) }
  $cfg = Read-GatewayEnv $EnvFile
  if ($cfg[$Name]) { return $cfg[$Name] }
  return $Default
}

function Get-GatewayPort { [int](Get-GatewaySetting "PORT" "3701") }
function Get-OpenCodePort { [int](Get-GatewaySetting "OPENCODE_PORT" "3702") }
function Test-OpenCodeEnabled { (Get-GatewaySetting "OPENCODE_ENABLE" "false") -eq "true" }

function Initialize-GatewayEnvironment {
  $env:GATEWAY_ENV_FILE = $EnvFile
  $bins = @(
    (Join-Path $GatewayRoot "app\node_modules\opencode-ai\bin"),
    (Join-Path $GatewayRoot "app\node_modules\.bin"),
    (Join-Path $GatewayRoot "node"),
    (Join-Path $env:LOCALAPPDATA "cursor-agent")
  )
  $env:PATH = ($bins -join ";") + ";" + $env:PATH
}

function Test-PortInUse {
  param([int]$Port)
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Assert-PortsFree {
  $port = Get-GatewayPort
  if (Test-PortInUse $port) {
    Write-Host "端口 $port 已被占用。先运行 status.ps1 查看，或运行 stop.ps1 停掉旧进程。"
    exit 1
  }
  if (Test-OpenCodeEnabled) {
    $ocPort = Get-OpenCodePort
    if (Test-PortInUse $ocPort) {
      Write-Host "OpenCode 端口 $ocPort 已被占用。先运行 status.ps1 查看，或运行 stop.ps1 停掉旧进程。"
      exit 1
    }
  }
}

function Get-GatewayProcess {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if (-not $raw) { return $null }
  return Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq "node" }
}

function Test-GatewayHealth {
  $port = Get-GatewayPort
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}
