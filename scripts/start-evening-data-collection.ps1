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
    'https://www.jiuyangongshe.com/',
    'https://www.iwencai.com/screener'
  )
  Start-Process -FilePath $browser -ArgumentList $browserArgs -WindowStyle Normal | Out-Null
  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 2 | Out-Null
      $debugReady = $true
      break
    } catch {
      $debugReady = $false
    }
  }
  if (-not $debugReady) {
    throw "专用浏览器调试端口 $DebugPort 未启动，请关闭已占用的浏览器窗口后重试。"
  }
} else {
  Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$DebugPort/json/new?https%3A%2F%2Fwww.jiuyangongshe.com%2F" -TimeoutSec 3 | Out-Null
  Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$DebugPort/json/new?https%3A%2F%2Fwww.iwencai.com%2Fscreener" -TimeoutSec 3 | Out-Null
}

Write-Host ''
Write-Host '盘后数据专用浏览器已经打开。' -ForegroundColor Green
Write-Host '请分别确认韭研公社和同花顺问财已经登录，然后回到本窗口按回车。' -ForegroundColor Yellow
Write-Host '程序不会读取或保存账号密码，只使用当前浏览器登录会话读取页面。' -ForegroundColor DarkGray
Read-Host | Out-Null

Write-Host ''
Write-Host "准备 $TradeDate 的统一数据缓存……" -ForegroundColor Cyan
& $node.Source 'scripts/prepare-data-cache.mjs' '--date' $TradeDate '--debug-port' $DebugPort
if ($LASTEXITCODE -ne 0) {
  throw "数据采集异常退出，退出码：$LASTEXITCODE"
}

Write-Host ''
Write-Host '数据缓存准备完成。可关闭本窗口；浏览器可保留供盘中监控使用。' -ForegroundColor Green
Read-Host | Out-Null
