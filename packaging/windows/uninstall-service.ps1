# 停止并删除后台服务。配置、数据库和日志保留在用户数据目录。
. (Join-Path $PSScriptRoot "common.ps1")

& (Join-Path $PSScriptRoot "stop.ps1") -Quiet
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已删除后台服务 $TaskName。"
} else {
  Write-Host "后台服务 $TaskName 没有注册。"
}
Write-Host "数据保留在：$DataDir"
