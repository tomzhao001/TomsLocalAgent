# 在前台运行 Gateway，用于调试。Ctrl+C 退出。
. (Join-Path $PSScriptRoot "common.ps1")

if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Host "找不到 $EnvFile 。先运行 install-service.ps1 生成配置，或设置 GATEWAY_ENV_FILE。"
  exit 1
}
Assert-PortsFree
Initialize-GatewayEnvironment
& $NodeExe --disable-warning=ExperimentalWarning $AppEntry
exit $LASTEXITCODE
