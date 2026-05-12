@echo off
chcp 65001 >nul
echo Building index.html...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$shell = Get-Content -Path 'src\shell.html' -Encoding UTF8 -Raw;" ^
  "$sections = '';" ^
  "Get-ChildItem -Path 'sections' -Filter '*.html' | Sort-Object Name | ForEach-Object { $sections += Get-Content -Path $_.FullName -Encoding UTF8 -Raw };" ^
  "$output = $shell -replace '<!-- \{\{SECTIONS\}\} -->', $sections;" ^
  "[System.IO.File]::WriteAllText((Resolve-Path '.').Path + '\index.html', $output, [System.Text.Encoding]::UTF8);"

if %errorlevel% == 0 (
  echo index.html built successfully.
) else (
  echo ERROR: Build failed.
  exit /b 1
)
