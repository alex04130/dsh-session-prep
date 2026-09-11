@echo off
REM 一键整理会话记录（在 WSL 里跑）。不碰正在用的 ~/.dsh。
REM 双击本文件，或在 cmd 里运行。
setlocal
if "%PREP_OUT%"=="" set PREP_OUT=/home/alex/.dsh/tmp-session-prep
echo 输出目录: %PREP_OUT%
echo 不会写正在用的 ~/.dsh/sessions。
wsl -e bash /home/alex/.dsh/community-plugins/dsh-session-prep/scripts/prepare.sh %PREP_OUT%
if errorlevel 1 (
  echo 失败。看上面的报错。
  pause
  exit /b 1
)
echo.
echo 完成。
echo 清单: \\wsl$\Ubuntu\home\alex\.dsh\tmp-session-prep\会话清单.md
echo 升级: \\wsl$\Ubuntu\home\alex\.dsh\tmp-session-prep\重启升级.md
pause
