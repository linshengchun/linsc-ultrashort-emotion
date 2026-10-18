param(
  [string]$TradeDate = (Get-Date).ToString('yyyy-MM-dd'),
  [int]$DebugPort = 9223
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$node = Get-Command node -ErrorAction Stop
$browserCandidates = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
)
$browser = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browser) {
  throw '未找到Google Chrome或Microsoft Edge。'
}

$profileDir = Join-Path $projectRoot '.local\jiuyangongshe-browser'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$debugReady = $false
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 2 | Out-Null
  $debugReady = $true
} catch {
  $debugReady = $false
}

if (-not $debugReady) {
  $browserArgs = @(
    "--remote-debugging-port=$DebugPort",
    '--remote-debugging-address=127.0.0.1',
    "--user-data-dir=$profileDir",
    '--new-window',
    'https://www.jiuyangongshe.com/'
  )
  Start-Process -FilePath $browser -ArgumentList $browserArgs -WindowStyle Normal | Out-Null
  Start-Sleep -Seconds 4
}

Write-Host ''
Write-Host '韭研公社专用浏览器已经打开。' -ForegroundColor Green
Write-Host '请确认已经登录韭研公社，然后回到本窗口按回车启动盘中监控。' -ForegroundColor Yellow
Read-Host | Out-Null

Write-Host ''
Write-Host "启动 $TradeDate 盘中持续监控采集……" -ForegroundColor Cyan
Write-Host '需要停止时，请在本窗口按 Ctrl+C。' -ForegroundColor DarkGray
& $node.Source 'scripts/watch-limit-up-narratives.mjs' '--date' $TradeDate '--debug-port' $DebugPort
if ($LASTEXITCODE -ne 0) {
  throw "盘中监控异常退出，退出码：$LASTEXITCODE"
}
