# 注册登录后自动启动的后台服务，并立即启动。重复运行等于重启。
. (Join-Path $PSScriptRoot "common.ps1")

New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

if (-not (Test-Path -LiteralPath $EnvFile)) {
  $packaged = Join-Path $GatewayRoot "gateway.env"
  if (-not (Test-Path -LiteralPath $packaged)) {
    Write-Host "找不到配置文件：$packaged"
    exit 1
  }
  Copy-Item -LiteralPath $packaged -Destination $EnvFile
  Write-Host "已复制配置文件：$EnvFile"
}

$cfg = Read-GatewayEnv $EnvFile
if (-not $cfg["ADMIN_PASSWORD"] -or $cfg["ADMIN_PASSWORD"] -eq "change-me") {
  Write-Host "请先在 $EnvFile 中把 ADMIN_PASSWORD 改成你自己的密码。"
  exit 1
}

& (Join-Path $PSScriptRoot "stop.ps1") -Quiet
Start-Sleep -Seconds 1
Assert-PortsFree

$runner = Join-Path $PSScriptRoot "service-run.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" `
  -WorkingDirectory $GatewayRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "TomsGateway 本地 AI Gateway" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$port = Get-GatewayPort
for ($i = 0; $i -lt 30; $i++) {
  if (Test-GatewayHealth) {
    Write-Host "Gateway 已启动：http://127.0.0.1:$port"
    Write-Host "手机访问：在本机执行 tailscale serve --bg $port，然后打开 tailscale 给出的 https 地址。"
    exit 0
  }
  Start-Sleep -Seconds 1
}
Write-Host "服务已注册，但 30 秒内没有通过健康检查。运行 logs.ps1 -Errors 查看原因。"
exit 1
