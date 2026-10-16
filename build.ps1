# 뉴스 원본 편집기 빌드 (MSYS2 UCRT64 + Qt6 + MLT)
# 사용: powershell -ExecutionPolicy Bypass -File build.ps1 [-Configure]
param([switch]$Configure)
$ErrorActionPreference = 'Stop'
$env:PATH = "C:\msys64\ucrt64\bin;C:\msys64\usr\bin;" + $env:PATH
$env:PKG_CONFIG_PATH = "C:/msys64/ucrt64/lib/pkgconfig"
$src = Join-Path $PSScriptRoot 'shotcut'
$build = Join-Path $src 'build\release'

if ($Configure -or -not (Test-Path (Join-Path $build 'build.ninja'))) {
    cmake -S $src -B $build -G Ninja `
        -DCMAKE_BUILD_TYPE=Release `
        -DCMAKE_PREFIX_PATH=C:/msys64/ucrt64 `
        -DCMAKE_INSTALL_PREFIX="$PSScriptRoot/dist" `
        -DCLANG_FORMAT=OFF
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
cmake --build $build -j 6
exit $LASTEXITCODE
