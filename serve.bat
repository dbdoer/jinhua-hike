@echo off
chcp 65001 >nul
cd /d %~dp0
echo 服务地址 http://127.0.0.1:8012/  (Ctrl+C 停止)
start "" http://127.0.0.1:8012/
python -m http.server 8012
