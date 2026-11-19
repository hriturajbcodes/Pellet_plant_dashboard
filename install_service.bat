@echo off
setlocal

echo ===================================================
echo  Installing Pellet Plant 2 Dashboard Windows Service
echo ===================================================

:: Check for administrative privileges
net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Please run this batch script as Administrator.
    pause
    exit /b 1
)

:: Check for nssm.exe
set NSSM_CMD=nssm.exe
where nssm.exe >nul 2>&1
if errorlevel 1 (
    if not exist "%~dp0nssm.exe" (
        echo.
        echo [ERROR] nssm.exe was not found in PATH or in the current folder!
        echo Please download NSSM from https://nssm.cc/download
        echo Extract nssm.exe (win64 version) and place it directly into:
        echo %~dp0
        echo.
        pause
        exit /b 1
    ) else (
        set NSSM_CMD=%~dp0nssm.exe
    )
)

set SERVICE_NAME=PelletPlantDashboard
set APP_DIR=%~dp0
if "%APP_DIR:~-1%"=="\" set APP_DIR=%APP_DIR:~0,-1%

if not exist "%APP_DIR%\.venv\Scripts\waitress-serve.exe" (
    echo [ERROR] Virtual environment not found. Please run setup_and_run.bat first.
    pause
    exit /b 1
)

echo [*] Configuring service %SERVICE_NAME%...
"%NSSM_CMD%" stop %SERVICE_NAME% >nul 2>&1
"%NSSM_CMD%" remove %SERVICE_NAME% confirm >nul 2>&1

"%NSSM_CMD%" install %SERVICE_NAME% "%APP_DIR%\.venv\Scripts\waitress-serve.exe" "--listen=0.0.0.0:5001 --threads=8 app:app"
"%NSSM_CMD%" set %SERVICE_NAME% AppDirectory "%APP_DIR%"
"%NSSM_CMD%" set %SERVICE_NAME% DisplayName "Jindal Steel Pellet Plant 2 Dashboard"
"%NSSM_CMD%" set %SERVICE_NAME% Description "Supervisory control-room monitoring dashboard for Pellet Plant 2"
"%NSSM_CMD%" set %SERVICE_NAME% Start SERVICE_AUTO_START
"%NSSM_CMD%" set %SERVICE_NAME% AppRestartDelay 5000
"%NSSM_CMD%" set %SERVICE_NAME% AppStdout "%APP_DIR%\logs\service_out.log"
"%NSSM_CMD%" set %SERVICE_NAME% AppStderr "%APP_DIR%\logs\service_err.log"

echo [*] Starting service %SERVICE_NAME%...
"%NSSM_CMD%" start %SERVICE_NAME%

echo.
echo [OK] Service installed and started successfully!
echo Status can be monitored in Windows Services (services.msc) or logs\service_*.log.
pause
