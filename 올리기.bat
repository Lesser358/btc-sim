@echo off
chcp 65001 > nul
cd /d C:\Users\user\Desktop\btc-futures-sim
git add -A
git commit -m "Update"
git pull origin main --rebase
git push origin main
echo.
echo ���ε� �Ϸ�!
pause
