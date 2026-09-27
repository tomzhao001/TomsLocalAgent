# 查看日志。加 -Errors 查看错误输出，加 -Follow 持续跟踪。
param([switch]$Errors, [switch]$Follow, [int]$Lines = 100)
. (Join-Path $PSScriptRoot "common.ps1")

if ($Errors) { $file = $ErrFile } else { $file = $LogFile }
if (-not (Test-Path -LiteralPath $file)) {
  Write-Host "还没有日志：$file"
  exit 0
}
if ($Follow) {
  Get-Content -LiteralPath $file -Encoding UTF8 -Tail $Lines -Wait
} else {
  Get-Content -LiteralPath $file -Encoding UTF8 -Tail $Lines
}
