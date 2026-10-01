# 在 Windows 上打包 TomsGateway，输出 dist\TomsGateway-<版本>-win-x64\。
# 加上 -Zip 才额外生成同名 zip。-SkipInstall 跳过 pnpm install。
param([switch]$SkipInstall, [switch]$Zip)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Invoke-Step {
  param([string]$Title, [scriptblock]$Block)
  Write-Host "==> $Title"
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "失败：$Title" }
}

$NodeVersion = (Get-Content -LiteralPath "scripts\node-version.txt" -Raw).Trim()
$Version = (Get-Content -LiteralPath "apps\server\package.json" -Raw | ConvertFrom-Json).version
$Name = "TomsGateway-$Version-win-x64"
$Stage = Join-Path $Root "dist\$Name"
$Cache = Join-Path $Root "dist\cache"
New-Item -ItemType Directory -Force -Path $Cache | Out-Null

if (-not $SkipInstall) { Invoke-Step "安装依赖" { pnpm install --frozen-lockfile } }
Invoke-Step "构建 shared" { pnpm --filter @gateway/shared build }
Invoke-Step "构建 server" { pnpm --filter @gateway/server build }
Invoke-Step "构建 web" { pnpm --filter @gateway/web build }

if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
Invoke-Step "生成生产依赖" { pnpm --filter @gateway/server deploy --prod --config.node-linker=hoisted "dist/$Name/app" }

Get-ChildItem -LiteralPath (Join-Path $Stage "app\node_modules") -Directory -Filter "opencode-*" |
  Where-Object { $_.Name -ne "opencode-ai" } |
  Remove-Item -Recurse -Force
if (-not (Test-Path -LiteralPath (Join-Path $Stage "app\node_modules\opencode-ai\bin\opencode.exe"))) {
  throw "没有找到 OpenCode 可执行文件"
}
Copy-Item -LiteralPath (Join-Path $Root "apps\web\dist") -Destination (Join-Path $Stage "app\public") -Recurse

Write-Host "==> 准备 Node $NodeVersion"
$zipName = "node-v$NodeVersion-win-x64.zip"
$zipPath = Join-Path $Cache $zipName
$sumsPath = Join-Path $Cache "SHASUMS256-$NodeVersion.txt"
$base = "https://nodejs.org/dist/v$NodeVersion"
if (-not (Test-Path -LiteralPath $sumsPath)) { Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile $sumsPath -UseBasicParsing }
if (-not (Test-Path -LiteralPath $zipPath)) { Invoke-WebRequest -Uri "$base/$zipName" -OutFile $zipPath -UseBasicParsing }
$expected = (Select-String -LiteralPath $sumsPath -Pattern ([regex]::Escape($zipName)) | Select-Object -First 1).Line.Split(" ")[0]
$actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) {
  Remove-Item -LiteralPath $zipPath -Force
  throw "Node 压缩包校验失败，已删除缓存，请重试"
}
$unpack = Join-Path $Cache "node-unpack"
if (Test-Path -LiteralPath $unpack) { Remove-Item -LiteralPath $unpack -Recurse -Force }
Expand-Archive -LiteralPath $zipPath -DestinationPath $unpack
Move-Item -LiteralPath (Join-Path $unpack "node-v$NodeVersion-win-x64") -Destination (Join-Path $Stage "node")
Remove-Item -LiteralPath $unpack -Recurse -Force

Write-Host "==> 复制启动脚本"
Copy-Item -LiteralPath (Join-Path $Root "packaging\windows") -Destination (Join-Path $Stage "windows") -Recurse
$envSource = Join-Path $env:LOCALAPPDATA "TomsGateway\gateway.env"
if (-not (Test-Path -LiteralPath $envSource)) {
  throw "找不到配置文件：$envSource。请先在本机准备好 gateway.env，再重新打包。"
}
Copy-Item -LiteralPath $envSource -Destination (Join-Path $Stage "gateway.env")
$utf8Bom = New-Object System.Text.UTF8Encoding $true
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Stage "windows") -Filter "*.ps1") {
  $text = [System.IO.File]::ReadAllText($file.FullName)
  [System.IO.File]::WriteAllText($file.FullName, $text, $utf8Bom)
}

Write-Host "已生成：$Stage"
if ($Zip) {
  Write-Host "==> 压缩"
  $zipOut = Join-Path $Root "dist\$Name.zip"
  if (Test-Path -LiteralPath $zipOut) { Remove-Item -LiteralPath $zipOut -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($Stage, $zipOut, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $sizeMb = [math]::Round((Get-Item -LiteralPath $zipOut).Length / 1MB, 1)
  Write-Host "已生成：$zipOut（$sizeMb MB）"
}
