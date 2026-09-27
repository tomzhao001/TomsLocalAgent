$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$EnvFile = Join-Path $ScriptDir "deploy.env"

if (-not (Test-Path $EnvFile)) {
  Write-Error "缺少 $EnvFile ，请先复制 scripts/deploy.env.example"
}

Get-Content -LiteralPath $EnvFile -Encoding UTF8 | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq "" -or $line.StartsWith("#")) { return }
  $parts = $line.Split("=", 2)
  if ($parts.Count -lt 2) { return }
  $name = $parts[0].Trim()
  $value = $parts[1].Trim().Trim('"').Trim("'")
  Set-Item -Path "Env:$name" -Value $value
}

foreach ($name in @("ACR_REGISTRY", "ACR_USERNAME", "ACR_PASSWORD", "ACR_IMAGE")) {
  if (-not (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value) {
    Write-Error "请在 deploy.env 中设置 $name"
  }
}

$tag = if ($env:ACR_TAG) { $env:ACR_TAG } else { "latest" }
if ($env:ACR_NAMESPACE) {
  $image = "$($env:ACR_REGISTRY)/$($env:ACR_NAMESPACE)/$($env:ACR_IMAGE):$tag"
} else {
  $image = "$($env:ACR_REGISTRY)/$($env:ACR_IMAGE):$tag"
}

Write-Host "登录 $($env:ACR_REGISTRY)"
$env:ACR_PASSWORD | docker login $env:ACR_REGISTRY --username $env:ACR_USERNAME --password-stdin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "构建 $image"
docker build -f (Join-Path $Root "docker\Dockerfile") -t $image $Root
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "推送 $image"
docker push $image
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "已推送 $image"
