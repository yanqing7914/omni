# scripts/perf-audit-c/bench-ladder.ps1
# 解压成本归因梯：nullsink -> nopath -> noperms -> full，每级只加一件事。
# 相邻两级之差 = 那一层的真实成本；这不是估算，是同一份输入、同一段循环的实测差分。
param([int]$Runs = 3, [string]$Variants = 'nullsink,nopath,noperms,full')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# classpath：jvm\classes + 本机 gradle 缓存里的 commons-compress 1.28.0 与 xz 1.10 jar（按需替换）。
$cp = $env:PERF_AUDIT_CP
if (-not $cp) { throw '先设置 $env:PERF_AUDIT_CP（见上方注释）' }
$archive = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'app\src\main\assets\snapshot.tar.xz'
$tmp = Join-Path $env:TEMP 'dsh-perf-c-ladder'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out ('bench-ladder-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
'# ladder ' + (Get-Date -Format o) + ' archive=' + $archive | Tee-Object -FilePath $log
foreach ($v in $Variants.Split(',')) {
  for ($i = 1; $i -le $Runs; $i++) {
    $d = Join-Path $tmp ($v + '-' + $i)
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $line = (& java -Xmx384m -cp $cp ExtractBench $archive $v $d 2>&1) -join ' '
    $sw.Stop()
    $files = 0; $bytes = 0
    if ($v -ne 'nullsink') {
      $m = Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
      $files = $m.Count; $bytes = $m.Sum
    }
    $s = $line
    Write-Output $s
    Add-Content -Path $log -Value $s -Encoding UTF8
    $s2 = '  wall-ms=' + [int]$sw.Elapsed.TotalMilliseconds + ' ondisk-files=' + $files + ' ondisk-bytes=' + $bytes
    Write-Output $s2
    Add-Content -Path $log -Value $s2 -Encoding UTF8
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
  }
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
'# done ' + (Get-Date -Format o) | Tee-Object -FilePath $log -Append
Write-Output ('LOG=' + $log)
