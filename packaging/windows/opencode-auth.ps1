# 用包内的 OpenCode 登录模型服务商，凭据保存在当前用户的 OpenCode 数据目录。
. (Join-Path $PSScriptRoot "common.ps1")

Initialize-GatewayEnvironment
& $OpenCodeExe auth login
exit $LASTEXITCODE
