. (Join-Path $PSScriptRoot "common.ps1")

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) { Write-Host "后台服务：已注册（$($task.State)）" } else { Write-Host "后台服务：未注册" }

$proc = Get-GatewayProcess
if ($proc) { Write-Host "进程：运行中（$($proc.Id)）" } else { Write-Host "进程：未运行" }

$port = Get-GatewayPort
if (Test-GatewayHealth) { Write-Host "健康检查：正常 http://127.0.0.1:$port" } else { Write-Host "健康检查：无响应（端口 $port）" }

Write-Host "配置文件：$EnvFile"
Write-Host "日志：$LogFile"
