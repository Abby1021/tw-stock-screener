# 台股條件選股器 本機伺服器（Windows 內建 PowerShell，不需要安裝任何東西）
# 直接開 index.html 時瀏覽器會擋下對交易所的連線（CORS）；這個腳本在本機開一個網頁伺服器並轉接資料。
# 用法：雙擊 start.bat

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$allowed = @('openapi.twse.com.tw', 'www.twse.com.tw', 'www.tpex.org.tw', 'mis.twse.com.tw', 'ess.api.cnyes.com')
$cookies = New-Object System.Net.CookieContainer
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
}

$listener = $null
$port = 8765
while ($null -eq $listener) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$port/")
    $l.Start()
    $listener = $l
  } catch {
    $port++
    if ($port -gt 8785) { Write-Host '找不到可用的連接埠，請關掉其他程式後再試。'; Read-Host '按 Enter 結束'; exit 1 }
  }
}

$url = "http://localhost:$port/index.html"
Write-Host '台股條件選股器已啟動'
Write-Host "網址：$url"
Write-Host '使用期間請不要關掉這個視窗；要結束時直接關閉視窗。'
if ($env:NO_BROWSER -ne '1') { Start-Process $url }

function Send-Reply($ctx, [int]$status, [byte[]]$body, [string]$ctype) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $ctype
  $res.Headers.Add('Cache-Control', 'no-store')
  $res.ContentLength64 = $body.Length
  $res.OutputStream.Write($body, 0, $body.Length)
  $res.OutputStream.Close()
}
function Text-Bytes([string]$s) { return [Text.Encoding]::UTF8.GetBytes($s) }

# ---- 自動更新：從 GitHub 公開 repository 下載新版檔案（update.json 設定來源） ----
$updFiles = @('index.html', 'style.css', 'app.js', 'server.ps1', 'server.py', 'start.bat', 'README.txt', 'version.json')
$rawBase = if ($env:UPDATE_BASE) { $env:UPDATE_BASE } else { 'https://raw.githubusercontent.com' }
function Get-UpdCfg {
  $p = Join-Path $root 'update.json'
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  try { $c = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return $null }
  if (-not ($c.repo -match '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')) { return $null }
  if (-not $c.branch) { $c | Add-Member -NotePropertyName branch -NotePropertyValue 'main' -Force }
  return $c
}
function Get-Bytes([string]$address) {
  $wr = [System.Net.HttpWebRequest]::Create($address)
  $wr.UserAgent = $ua
  $wr.Timeout = 30000
  $wr.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
  $resp = $wr.GetResponse()
  $ms = New-Object System.IO.MemoryStream
  $resp.GetResponseStream().CopyTo($ms)
  $resp.Close()
  return ,$ms.ToArray()
}
function Raw-Url($cfg, [string]$name) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  return "$rawBase/$($cfg.repo)/$($cfg.branch)/$($name)?t=$t"
}
function Send-Json($ctx, [int]$status, $obj) {
  Send-Reply $ctx $status (Text-Bytes ($obj | ConvertTo-Json -Compress -Depth 5)) 'application/json; charset=utf-8'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)

    if ($path -eq '/proxy') {
      $target = $ctx.Request.QueryString['url']
      $u = $null
      $ok = [Uri]::TryCreate($target, [UriKind]::Absolute, [ref]$u)
      if (-not $ok -or $u.Scheme -ne 'https' -or ($allowed -notcontains $u.Host)) {
        Send-Reply $ctx 403 (Text-Bytes 'host not allowed') 'text/plain; charset=utf-8'
        continue
      }
      try {
        $wr = [System.Net.HttpWebRequest]::Create($u)
        $wr.UserAgent = $ua
        $wr.Accept = 'application/json, text/plain, */*'
        $wr.Referer = "https://$($u.Host)/"
        $wr.Timeout = 30000
        $wr.CookieContainer = $cookies
        $wr.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
        $wr.Headers.Add('Accept-Language', 'zh-TW,zh;q=0.9')
        $resp = $wr.GetResponse()
        $ms = New-Object System.IO.MemoryStream
        $resp.GetResponseStream().CopyTo($ms)
        $ct = $resp.ContentType
        $resp.Close()
        if (-not $ct) { $ct = 'application/json; charset=utf-8' }
        Send-Reply $ctx 200 $ms.ToArray() $ct
      } catch {
        $code = 502
        $ex = $_.Exception
        while ($ex.InnerException -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
        if ($ex -is [System.Net.WebException] -and $ex.Response) { $code = [int]$ex.Response.StatusCode }
        Write-Host "[轉接失敗] $code $($ex.Message)  $target"
        Send-Reply $ctx $code (Text-Bytes "upstream error: $($ex.Message)") 'text/plain; charset=utf-8'
      }
      continue
    }

    if ($path -eq '/update/check') {
      $cfg = Get-UpdCfg
      if (-not $cfg) { Send-Json $ctx 200 @{ configured = $false }; continue }
      try {
        $b = Get-Bytes (Raw-Url $cfg 'version.json')
        Send-Reply $ctx 200 $b 'application/json; charset=utf-8'
      } catch {
        Write-Host "[檢查更新失敗] $($_.Exception.Message)"
        Send-Json $ctx 502 @{ error = $_.Exception.Message }
      }
      continue
    }

    if ($path -eq '/update/apply') {
      if ($ctx.Request.HttpMethod -ne 'POST') { Send-Json $ctx 405 @{ error = 'POST only' }; continue }
      $cfg = Get-UpdCfg
      if (-not $cfg) { Send-Json $ctx 400 @{ error = 'update.json 沒有設定 repo' }; continue }
      try {
        $verBytes = Get-Bytes (Raw-Url $cfg 'version.json')
        $ver = [Text.Encoding]::UTF8.GetString($verBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
        $names = @(@($ver.files) | Where-Object { $updFiles -contains $_ })
        if ($names -notcontains 'version.json') { $names += 'version.json' }
        $got = @{}
        foreach ($n in $names) { $got[$n] = if ($n -eq 'version.json') { $verBytes } else { Get-Bytes (Raw-Url $cfg $n) } }
        $changed = @()
        $restart = $false
        foreach ($n in $names) {
          $dest = Join-Path $root $n
          $same = $false
          if (Test-Path -LiteralPath $dest) {
            $old = [IO.File]::ReadAllBytes($dest)
            $same = ($old.Length -eq $got[$n].Length) -and ([Convert]::ToBase64String($old) -eq [Convert]::ToBase64String($got[$n]))
          }
          if (-not $same) {
            [IO.File]::WriteAllBytes("$dest.new", $got[$n])
            $changed += $n
            if ($n -eq 'server.ps1' -or $n -eq 'start.bat') { $restart = $true }
          }
        }
        foreach ($n in $changed) { Move-Item -LiteralPath (Join-Path $root "$n.new") -Destination (Join-Path $root $n) -Force }
        Write-Host "[已更新] v$($ver.version)：$($changed -join ', ')"
        Send-Json $ctx 200 @{ ok = $true; version = $ver.version; changed = @($changed); restart = $restart }
      } catch {
        Write-Host "[更新失敗] $($_.Exception.Message)"
        Send-Json $ctx 502 @{ error = $_.Exception.Message }
      }
      continue
    }

    if ($path -eq '/') { $path = '/index.html' }
    $rel = $path.TrimStart('/')
    $file = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine([string[]](@($root) + $rel.Split('/'))))
    if (-not $file.StartsWith($root) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      Send-Reply $ctx 404 (Text-Bytes 'not found') 'text/plain; charset=utf-8'
      continue
    }
    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    $ct = $types[$ext]
    if (-not $ct) { $ct = 'application/octet-stream' }
    Send-Reply $ctx 200 ([System.IO.File]::ReadAllBytes($file)) $ct
  } catch {
    Write-Host "[錯誤] $($_.Exception.Message)"
    try { $ctx.Response.Abort() } catch {}
  }
}
