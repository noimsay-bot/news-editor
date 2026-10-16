# 빌드 결과를 dist 폴더로 모으고 실행 파일(뉴스 원본 편집기.bat)을 만든다.
# 사용: powershell -ExecutionPolicy Bypass -File deploy.ps1
$ErrorActionPreference = 'Stop'
$env:PATH = "C:\msys64\ucrt64\bin;C:\msys64\usr\bin;" + $env:PATH
$root = $PSScriptRoot
$build = Join-Path $root 'shotcut\build\release'
$dist = Join-Path $root 'dist'

cmake --install $build --prefix $dist
if ($LASTEXITCODE) { exit $LASTEXITCODE }
foreach ($exe in 'melt.exe', 'ffmpeg.exe', 'ffprobe.exe') {
    Copy-Item "C:\msys64\ucrt64\bin\$exe" $dist -Force
}

$launcher = @'
@echo off
rem 뉴스 원본 편집기 실행 (MSYS2 UCRT64 런타임 사용)
set "PATH=C:\msys64\ucrt64\bin;%PATH%"
set "MLT_REPOSITORY=C:\msys64\ucrt64\lib\mlt"
set "MLT_DATA=C:\msys64\ucrt64\share\mlt"
set "MLT_PROFILES_PATH=C:\msys64\ucrt64\share\mlt\profiles"
set "MLT_PRESETS_PATH=C:\msys64\ucrt64\share\mlt\presets"
set "FREI0R_PATH=C:\msys64\ucrt64\lib\frei0r-1"
start "" "%~dp0shotcut.exe" %*
'@
# cmd는 UTF-8 BOM 없는 ANSI를 기대하므로 주석은 영문 대체 없이 CP949로 저장
[System.IO.File]::WriteAllText((Join-Path $dist '뉴스 원본 편집기.bat'), $launcher, [System.Text.Encoding]::GetEncoding(949))
Write-Host "배포 완료: $dist"
