# 由任务计划程序调用。进程意外退出时 10 秒后重新拉起，运行 stop.ps1 后才真正退出。
. (Join-Path $PSScriptRoot "common.ps1")

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Remove-Item -LiteralPath $StopFlag -ErrorAction SilentlyContinue
Initialize-GatewayEnvironment

while ($true) {
  foreach ($file in @($LogFile, $ErrFile)) {
    if (Test-Path -LiteralPath $file) { Move-Item -LiteralPath $file -Destination "$file.1" -Force }
  }
  $proc = Start-Process -FilePath $NodeExe `
    -ArgumentList @("--disable-warning=ExperimentalWarning", "`"$AppEntry`"") `
    -WorkingDirectory $GatewayRoot `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrFile `
    -WindowStyle Hidden `
    -PassThru
  $null = $proc.Handle
  Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ASCII
  $proc.WaitForExit()
  Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $StopFlag) { break }
  Start-Sleep -Seconds 10
  if (Test-Path -LiteralPath $StopFlag) { break }
}
exit 0
