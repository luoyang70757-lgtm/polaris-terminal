@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Polaris 发布目录整理:合并为一个 release
echo  (请在退出 Orca / Claude Code 会话后运行,
echo   否则 app.asar 被宿主进程占用,删不掉)
echo ============================================
echo.
echo [1/5] 删除旧版 release 目录 ...
for %%d in (release release2 release3 release4 release5 release6) do (
  if exist "%%d" (
    rmdir /s /q "%%d"
    if exist "%%d" (echo    %%d 删除失败(仍被占用,请先关闭 Orca)) else (echo    %%d 已删除)
  )
)
echo [2/5] 找出最新构建目录(会话内需用新目录编译,如 build-out2)...
set "NEWEST="
for /f "delims=" %%d in ('dir /b /ad /o-d build-out* 2^>nul') do (
  if not defined NEWEST set "NEWEST=%%d"
)
echo    最新构建目录: %NEWEST%
echo [3/5] 清理各 build-out* 里的中间产物(win-unpacked)...
for /d %%d in (build-out*) do (
  if exist "%%d\win-unpacked" (
    rmdir /s /q "%%d\win-unpacked"
    if exist "%%d\win-unpacked" (echo    %%d\win-unpacked 删除失败) else (echo    %%d\win-unpacked 已删除)
  )
)
echo [4/5] 删除旧 build-out* 目录(保留最新构建)...
for /d %%d in (build-out*) do (
  if /i not "%%d"=="%NEWEST%" (
    rmdir /s /q "%%d"
    if exist "%%d" (echo    %%d 删除失败(仍被占用,请先关闭 Orca)) else (echo    %%d 已删除)
  )
)
echo [5/5] 把最新构建 %NEWEST% 设为唯一 release 目录 ...
if defined NEWEST (
  if exist "%NEWEST%\Polaris 1.0.0.exe" (
    ren "%NEWEST%" release
    if exist "release" (echo    %NEWEST% -^> release 完成) else (echo    重命名失败)
  ) else (
    echo    %NEWEST% 里没有 Polaris 1.0.0.exe,跳过重命名
  )
)
echo.
echo 当前 release 目录内容:
if exist "release" (dir /b "release") else (echo    (无 release 目录,下次编译 npm run dist 自动重建))
echo.
echo 全部完成,可以关闭本窗口。
pause
