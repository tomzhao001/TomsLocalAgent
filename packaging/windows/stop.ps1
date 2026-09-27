# 停止后台服务。服务仍然注册着，下次登录会自动启动；立即重新启动请运行 install-service.ps1。
param([switch]$Quiet)
. (Join-Path $PSScriptRoot "common.ps1")

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType File -Force -Path $StopFlag | Out-Null

$proc = Get-GatewayProcess
if ($proc) {
  & taskkill.exe /PID $proc.Id /T /F | Out-Null
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue

if (-not $Quiet) {
  if ($proc) { Write-Host "已停止 Gateway（进程 $($proc.Id)）。" } else { Write-Host "Gateway 没有在运行。" }
}
