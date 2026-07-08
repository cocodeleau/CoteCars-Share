@echo off
cd /d "%~dp0"
echo Pulling latest changes from claude/cotecars-claude...
git pull origin claude/cotecars-claude
echo.
echo Done.
pause
