@echo off
title LocalShare - Universal PC ^& iOS File Transfer
color 0B
cls

echo ================================================================
echo               LOCALSHARE - LOCAL WI-FI FILE TRANSFER             
echo               Transfer Photos, 4K Videos ^& Files Instantly       
echo ================================================================
echo.

:: 1. Dynamic IP & Wi-Fi Detection (Works on ANY PC & Router)
echo [1/3] Detecting Local Wi-Fi Network...
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1]))' } | Select-Object -ExpandProperty IPAddress -First 1)"`) do set "PC_IP=%%i"

if "%PC_IP%"=="" (
    for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
        if "%PC_IP%"=="" set "PC_IP=%%a"
    )
)
:: Trim spaces
set "PC_IP=%PC_IP: =%"
if "%PC_IP%"=="" set "PC_IP=127.0.0.1"

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(netsh wlan show interfaces -ErrorAction SilentlyContinue | Select-String '^\s*SSID\s*:\s*(.+)$' | ForEach-Object { $_.Matches.Groups[1].Value.Trim() } | Select-Object -First 1)"`) do set "WIFI_NAME=%%i"
if "%WIFI_NAME%"=="" set "WIFI_NAME=Local Wi-Fi"

:: 2. Check Windows Firewall
netsh advfirewall firewall show rule name="LocalShare_8080" >nul 2>&1
if %errorlevel% neq 0 (
    echo [FIREWALL NOTICE] Port 8080 is not yet allowed in Windows Firewall.
    echo Mobile connect hone ke liye ek baar permission allow karni hogi.
    echo.
    echo Opening Firewall Fixer... Click "Yes" on the Windows UAC prompt.
    echo.
    if exist "%~dp0fix_firewall.bat" (
        start "" /wait "%~dp0fix_firewall.bat"
        cls
        echo ================================================================
        echo               LOCALSHARE - LOCAL WI-FI FILE TRANSFER             
        echo ================================================================
        echo.
    )
)

:: 3. Multi-Engine Runtime Detection (PHP, Node.js, Python)
echo [2/3] Checking available engine on this PC...
set RUNTIME=
set RUNTIME_CMD=

:: Check Node.js
where node >nul 2>&1
if %errorlevel% equ 0 (
    if exist "%~dp0local_server\server.js" (
        set RUNTIME=Node.js
        set RUNTIME_CMD=node "%~dp0local_server\server.js"
    ) else if exist "%~dp0server.js" (
        set RUNTIME=Node.js
        set RUNTIME_CMD=node "%~dp0server.js"
    )
)

:: Check PHP if Node not selected
if "%RUNTIME%"=="" (
    set PHP_BIN=C:\tools\php\php.exe
    if not exist "%PHP_BIN%" set PHP_BIN=php
    where %PHP_BIN% >nul 2>&1
    if %errorlevel% equ 0 (
        if exist "%~dp0local_server\share_server.php" (
            set RUNTIME=PHP
            set RUNTIME_CMD="%PHP_BIN%" -S 0.0.0.0:8080 -d upload_max_filesize=10G -d post_max_size=10G -d memory_limit=1G -d max_execution_time=3600 "%~dp0local_server\share_server.php"
        ) else if exist "%~dp0share_server.php" (
            set RUNTIME=PHP
            set RUNTIME_CMD="%PHP_BIN%" -S 0.0.0.0:8080 -d upload_max_filesize=10G -d post_max_size=10G -d memory_limit=1G -d max_execution_time=3600 "%~dp0share_server.php"
        )
    )
)

:: Check Python if PHP/Node not selected
if "%RUNTIME%"=="" (
    where python >nul 2>&1
    if %errorlevel% equ 0 (
        if exist "%~dp0local_server\server.py" (
            set RUNTIME=Python 3
            set RUNTIME_CMD=python "%~dp0local_server\server.py"
        ) else if exist "%~dp0server.py" (
            set RUNTIME=Python 3
            set RUNTIME_CMD=python "%~dp0server.py"
        )
    )
)

:: If no runtime found
if "%RUNTIME%"=="" (
    echo.
    echo [ERROR] No engine found on this PC!
    echo LocalShare chalane ke liye is PC me Node.js, Python ya PHP me se koi 1 hona chahiye.
    echo.
    echo Solution:
    echo  1. Node.js install karein (https://nodejs.org/) OR
    echo  2. Python install karein (https://python.org/) OR
    echo  3. Command Prompt me run karein: winget install OpenJS.NodeJS
    echo.
    pause
    exit /b 1
)

echo       [OK] Engine Detected: %RUNTIME%
echo.

echo [3/3] Network Information:
echo ----------------------------------------------------------------
echo   Wi-Fi Network Name : %WIFI_NAME%
echo   PC Local IP        : %PC_IP%
echo   Local Port         : 8080
echo.
echo   * Mobile Safari me ye URL open karein (Same Wi-Fi se connect hoke):
echo     --^> http://%PC_IP%:8080
echo ----------------------------------------------------------------
echo.
echo Opening PC Browser at http://localhost:8080 ...
start "" "http://localhost:8080"
echo.
echo Server is running live on http://0.0.0.0:8080
echo Press Ctrl+C in this window anytime to stop.
echo ================================================================
echo.

%RUNTIME_CMD%

pause
