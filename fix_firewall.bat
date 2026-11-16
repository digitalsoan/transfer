@echo off
title LocalShare - Windows Firewall Fix
color 0A
cls

:: Check for Administrator privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ================================================================
    echo Requesting Administrator privileges to allow LocalShare port 8080...
    echo Click "Yes" on the Windows UAC prompt.
    echo ================================================================
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ================================================================
echo            ALLOWING LOCALSHARE THROUGH WINDOWS FIREWALL
echo ================================================================
echo.

echo [1/2] Adding inbound firewall rule for Port 8080 (TCP)...
netsh advfirewall firewall delete rule name="LocalShare_8080" >nul 2>&1
netsh advfirewall firewall add rule name="LocalShare_8080" dir=in action=allow protocol=TCP localport=8080 profile=any >nul
if %errorlevel% equ 0 (
    echo       [OK] Port 8080 is now allowed on all network profiles!
) else (
    echo       [WARNING] Could not add firewall rule via netsh.
)

echo.
echo [2/2] Switching Ethernet network from Public to Private...
powershell -NoProfile -Command "Set-NetConnectionProfile -InterfaceAlias 'Ethernet' -NetworkCategory Private -ErrorAction SilentlyContinue; Set-NetConnectionProfile -Name 'Airtel_DGson' -NetworkCategory Private -ErrorAction SilentlyContinue" >nul 2>&1
echo       [OK] Network profile set to Private (allows local device communication).

echo.
echo ================================================================
echo   SUCCESS! Everything is configured.
echo   Ab aapke iPhone me http://192.168.1.4:8080 turant open ho jayega!
echo ================================================================
echo.
pause
