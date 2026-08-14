$log = 'C:\Users\admin\orca\workspaces\Polaris\elevated-cleanup.log'
function W { param($m) try { $m | Out-File -FilePath $log -Append -Encoding utf8 } catch {} ; Write-Output $m }

"=== START $(Get-Date) user=$([Environment]::UserName) ===" | Out-File -FilePath $log -Append -Encoding utf8
W '--[0] script started --'

$h = "$env:TEMP\hnd\handle64.exe"
if (-not (Test-Path $h)) { $h = "$env:TEMP\hnd\handle.exe" }
W '--[1] handle64(elevated) searching app.asar holders --'
$hd = & $h -accepteula -nobanner -a 'app.asar' 2>&1
$hd | Out-File -FilePath $log -Append -Encoding utf8
$mpEng = ($hd | Out-String) -match 'MsMpEng'

if ($mpEng) {
    W '--[2] MsMpEng holds files. pausing real-time protection --'
    try {
        Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction Stop
        W '    paused. waiting 4s...'
        Start-Sleep -Seconds 4
    } catch {
        W ("    pause failed: " + $_.Exception.Message)
    }
} else {
    W '--[2] no MsMpEng holder detected --'
}

foreach ($d in @('release2','release3','release4','release5','release6')) {
    $p = Join-Path $PSScriptRoot $d
    if (-not (Test-Path $p)) { W ("    " + $d + " missing, skip"); continue }
    try {
        Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
        W ("    " + $d + " DELETED")
    } catch {
        W ("    " + $d + " FAILED: " + $_.Exception.Message)
    }
}

# 最新构建目录(会话内需用新目录编译,如 build-out2)
$newest = Get-ChildItem -Path $PSScriptRoot -Directory -Filter 'build-out*' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

$all = Get-ChildItem -Path $PSScriptRoot -Directory -Filter 'build-out*'
if ($all) {
    W ("--[3] cleaning win-unpacked across build-out* (newest=" + $newest.Name + ") --")
    foreach ($d in $all) {
        $bu = Join-Path $d.FullName 'win-unpacked'
        if (Test-Path $bu) {
            try {
                Remove-Item -LiteralPath $bu -Recurse -Force -ErrorAction Stop
                W ("    " + $d.Name + "\win-unpacked DELETED")
            } catch {
                W ("    " + $d.Name + "\win-unpacked FAILED: " + $_.Exception.Message)
            }
        } else {
            W ("    " + $d.Name + "\win-unpacked missing")
        }
        # 删除非最新的旧 build-out* 目录
        if ($newest -and $d.FullName -ne $newest.FullName) {
            try {
                Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop
                W ("    " + $d.Name + " DELETED (stale build dir)")
            } catch {
                W ("    " + $d.Name + " FAILED: " + $_.Exception.Message)
            }
        }
    }
} else {
    W '--[3] no build-out* dirs --'
}

if ($mpEng) {
    W '--[4] restoring real-time protection --'
    try {
        Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction Stop
        W '    protection restored'
    } catch {
        W ("    restore failed: " + $_.Exception.Message)
    }
}
W '=== DONE ==='
