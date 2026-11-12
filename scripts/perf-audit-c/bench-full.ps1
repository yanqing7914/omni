# scripts/perf-audit-c/bench-full.ps1
# full 变体：复刻 SnapshotExtractor.extractEntries 的全部逐文件 syscall
# (deleteIfExists / mkdirs / setReadable|Writable|Executable / resolveEntry canonicalPath)，真实落盘。
# 与 nullsink（只解码）之差 = 逐文件元数据 + 写盘成本。
param([int]$Runs = 3)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# classpath：jvm\classes + 本机 gradle 缓存里的 commons-compress 1.28.0 与 xz 1.10 jar（按需替换）。
$cp = $env:PERF_AUDIT_CP
if (-not $cp) { throw '先设置 $env:PERF_AUDIT_CP（见上方注释）' }
$archive = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'app\src\main\assets\snapshot.tar.xz'
$tmp = Join-Path $env:TEMP 'dsh-perf-c-full'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out ('bench-full-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
'# full-variant ' + (Get-Date -Format o) + ' archive=' + $archive | Tee-Object -FilePath $log
for ($i = 1; $i -le $Runs; $i++) {
  $d = Join-Path $tmp ('full-' + $i)
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  $line = (& java -Xmx384m -cp $cp ExtractBench $archive full $d 2>&1) -join ' '
  $files = (Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $bytes = (Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  Write-Output $line
  Add-Content -Path $log -Value $line -Encoding UTF8
  $s2 = '  ondisk-files=' + $files + ' ondisk-bytes=' + $bytes
  Write-Output $s2
  Add-Content -Path $log -Value $s2 -Encoding UTF8
  Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
'# done ' + (Get-Date -Format o) | Tee-Object -FilePath $log -Append
Write-Output ('LOG=' + $log)
