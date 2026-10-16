# DeepFilterNet3 명령줄 도구(음성 복구)를 공식 GitHub 릴리스에서 받아 SHA-256을 검증한다.
# 사용: powershell -ExecutionPolicy Bypass -File tools\get-deep-filter.ps1
$ErrorActionPreference = 'Stop'
$url = 'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe'
$sha = '75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915'
$out = Join-Path $PSScriptRoot '..\app\bin\deep-filter.exe'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
Invoke-WebRequest -Uri $url -OutFile $out
$got = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
if ($got -ne $sha) { Remove-Item $out; throw "해시 불일치: $got" }
Write-Host "deep-filter.exe 준비 완료 ($out)"
