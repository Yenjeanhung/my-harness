@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   My-Harness 一键打包
echo   sidecar(PyInstaller) + 桌面端(electron-builder)
echo ============================================

set VER=
for /f %%v in ('node -p "require('./apps/desktop/package.json').version" 2^>nul') do set VER=%%v
if "%VER%"=="" (
  echo [错误] 读不到 apps\desktop\package.json 的版本号，确认 Node 已安装后在仓库根目录运行。
  exit /b 1
)
echo 目标版本: %VER%

echo.
echo [1/5] 关闭正在运行的 My-Harness / daemon / electron（名称+路径宽匹配，兼容改名版）...
taskkill /F /IM My-Harness.exe >nul 2>&1
taskkill /F /IM "Y Harness.exe" >nul 2>&1
taskkill /F /IM harness-server.exe >nul 2>&1
taskkill /F /IM electron.exe >nul 2>&1
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -Command "Get-Process | Where-Object { $_.Path -like '*my-harness*' -or $_.ProcessName -match 'harness|electron' } | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>&1
%SystemRoot%\System32\ping.exe -n 3 127.0.0.1 >nul
if exist "apps\desktop\dist\win-unpacked" rd /s /q "apps\desktop\dist\win-unpacked" >nul 2>&1

echo.
echo [2/5] 重建 Python sidecar（PyInstaller，约 3-4 分钟）...
pushd packaging
..\.venv\Scripts\pyinstaller.exe harness-server.spec --workpath build --distpath dist --noconfirm > pyinstaller.log 2>&1
if errorlevel 1 (
  echo [错误] PyInstaller 失败，详见 packaging\pyinstaller.log
  popd
  exit /b 1
)
popd
echo sidecar 构建完成。

echo.
echo [3/5] 验证 sidecar 产物（起临时实例检查 /health 版本，防半成品打包）...
start "" packaging\dist\harness-server.exe --port 8129 >nul 2>&1
set HEALTH=
for /l %%i in (1,1,6) do (
  if "!HEALTH!"=="" (
    %SystemRoot%\System32\ping.exe -n 6 127.0.0.1 >nul
    for /f "delims=" %%h in ('%SystemRoot%\System32\curl.exe -s http://127.0.0.1:8129/health 2^>nul') do set HEALTH=%%h
  )
)
taskkill /F /IM harness-server.exe >nul 2>&1
echo 健康检查返回: !HEALTH!
echo !HEALTH! | findstr /C:"\"version\":\"%VER%\"" >nul
if errorlevel 1 (
  echo [错误] sidecar /health 版本不是 %VER% 或未响应 —— 产物过期或损坏，中止打包。
  echo 修复：确认 src\harness\__init__.py 的 __version__ 与 package.json 一致后重跑本脚本。
  exit /b 1
)
echo sidecar 验证通过。

echo.
echo [4/5] 打包桌面端（esbuild + electron-builder，约 1-2 分钟）...
pushd apps\desktop
call node build.mjs
if errorlevel 1 (
  echo [错误] 前端构建失败
  popd
  exit /b 1
)
call node prepkg.cjs
if errorlevel 1 (
  echo [错误] sidecar 拷贝失败
  popd
  exit /b 1
)
call npx electron-builder --win
if errorlevel 1 (
  echo [错误] electron-builder 失败（多半是文件锁：关掉所有 My-Harness 实例后重跑）
  popd
  exit /b 1
)
popd

echo.
echo [5/5] 启动新版本...
set "APP_EXE="
for %%f in ("apps\desktop\dist\win-unpacked\*.exe") do set "APP_EXE=%%~ff"
if defined APP_EXE start "" "%APP_EXE%"

echo.
echo ============================================
echo   打包完成：
echo     便携版  %APP_EXE%
echo     安装包  apps\desktop\dist\Y Harness Setup %VER%.exe
echo ============================================
endlocal
