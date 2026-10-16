@echo off
cd /d "%~dp0"
if exist "src-tauri\target\release\shdw.exe" (
  start "" "src-tauri\target\release\shdw.exe" %*
) else (
  if not exist node_modules call npm install
  call npx tauri dev
)
