@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo ===================================================
echo  Jindal Steel - Pellet Plant 2 Dashboard Setup
echo ===================================================
echo.

REM ===================================================
REM 1. Check Python installation
REM ===================================================

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not available in PATH.
    echo Please install Python 3.10 or higher.
    goto ON_ERROR
)

python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 (
    for /f "tokens=2" %%v in ('python --version 2^>^&1') do set "PY_VER=%%v"
    echo [ERROR] Python 3.10 or higher is required.
    echo Detected Python version: !PY_VER!
    goto ON_ERROR
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set "PY_VER=%%v"
echo [OK] Python version: !PY_VER!


REM ===================================================
REM 2. Create virtual environment
REM ===================================================

if not exist ".venv\Scripts\python.exe" (
    echo.
    echo [*] Creating virtual environment...
    python -m venv .venv

    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        goto ON_ERROR
    )

    echo [OK] Virtual environment created.
) else (
    echo [OK] Existing virtual environment found.
)


REM ===================================================
REM 3. Activate virtual environment
REM ===================================================

call ".venv\Scripts\activate.bat"

if errorlevel 1 (
    echo [ERROR] Failed to activate virtual environment.
    goto ON_ERROR
)

echo [OK] Virtual environment activated.


REM ===================================================
REM 4. Upgrade pip
REM ===================================================

echo.
echo [*] Checking pip...

python -m pip install --upgrade pip --quiet

if errorlevel 1 (
    echo [WARNING] pip upgrade failed. Continuing with existing pip.
)


REM ===================================================
REM 5. Install dependencies
REM ===================================================

if not exist "requirements.txt" (
    echo [ERROR] requirements.txt was not found.
    goto ON_ERROR
)

echo [*] Installing dependencies from requirements.txt...

python -m pip install -r requirements.txt

if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    goto ON_ERROR
)

echo [OK] Dependencies installed.


REM ===================================================
REM 6. Create .env if missing
REM ===================================================

if not exist ".env" (
    if exist ".env.example" (
        echo.
        echo [*] Creating .env from .env.example...
        copy /Y ".env.example" ".env" >nul

        if errorlevel 1 (
            echo [ERROR] Failed to create .env.
            goto ON_ERROR
        )

        echo [OK] .env created.
    ) else (
        echo.
        echo [WARNING] .env.example was not found.
        echo [*] Creating empty .env...
        type nul > ".env"
    )
)


REM ===================================================
REM 7. Check whether admin password already exists
REM ===================================================

python -c "import os; from dotenv import load_dotenv; load_dotenv('.env'); raise SystemExit(0 if os.getenv('ADMIN_PASSWORD_HASH','').strip() else 1)" >nul 2>&1

if not errorlevel 1 (
    echo [OK] Admin password already configured.
    goto SKIP_PASSWORD_SETUP
)


REM ===================================================
REM 8. First-time admin password setup
REM ===================================================

echo.
echo ===================================================
echo  FIRST-TIME CONFIGURATION
echo ===================================================
echo.
echo Configure the dashboard administrator password.
echo.

set "ADMIN_PASS="
set /p "ADMIN_PASS=Enter Admin Password: "

if not defined ADMIN_PASS (
    echo.
    echo [ERROR] Password cannot be blank.
    goto ON_ERROR
)

REM Pass password to Python through environment
set "ADMIN_RAW_PASS=!ADMIN_PASS!"

python -c "import os,secrets; from pathlib import Path; from werkzeug.security import generate_password_hash; p=os.environ.get('ADMIN_RAW_PASS',''); env=Path('.env'); lines=env.read_text(encoding='utf-8').splitlines() if env.exists() else []; lines=[x for x in lines if not x.startswith('ADMIN_PASSWORD_HASH=') and not x.startswith('FLASK_SECRET_KEY=')]; lines.append('ADMIN_PASSWORD_HASH='+generate_password_hash(p)); lines.append('FLASK_SECRET_KEY='+secrets.token_hex(32)); env.write_text('\n'.join(lines)+'\n',encoding='utf-8'); print('[OK] Admin password configured successfully.')"

if errorlevel 1 (
    set "ADMIN_RAW_PASS="
    set "ADMIN_PASS="
    echo [ERROR] Failed to configure admin password.
    goto ON_ERROR
)

REM Clear password variables
set "ADMIN_RAW_PASS="
set "ADMIN_PASS="


:SKIP_PASSWORD_SETUP


REM ===================================================
REM 9. Create required directories
REM ===================================================

echo.
echo [*] Checking application directories...

if not exist "logs" mkdir "logs"
if not exist "data" mkdir "data"
if not exist "static" mkdir "static"
if not exist "static\fonts" mkdir "static\fonts"

echo [OK] Application directories ready.


REM ===================================================
REM 10. Check application file
REM ===================================================

if not exist "app.py" (
    echo.
    echo [ERROR] app.py was not found.
    goto ON_ERROR
)


REM ===================================================
REM 11. Verify Waitress
REM ===================================================

python -c "import waitress" >nul 2>&1

if errorlevel 1 (
    echo.
    echo [ERROR] Waitress is not installed.
    echo Make sure 'waitress' exists in requirements.txt.
    goto ON_ERROR
)

echo [OK] Waitress available.


REM ===================================================
REM 12. Start server
REM ===================================================

echo.
echo ===================================================
echo  Jindal Steel - Pellet Plant 2 Dashboard
echo ===================================================
echo.
echo  Status : STARTING
echo  Port   : 5001
echo.
echo  Local Access:
echo  http://localhost:5001
echo.
echo  Network Access:
echo  http://THIS-PC-IP:5001
echo.
echo  Press CTRL+C to stop the server.
echo.
echo ===================================================
echo.

python -m waitress ^
    --listen=0.0.0.0:5001 ^
    --threads=8 ^
    app:app


REM ===================================================
REM Server stopped
REM ===================================================

echo.
echo ===================================================
echo  Dashboard server has stopped.
echo ===================================================
echo.

pause
exit /b 0


REM ===================================================
REM Error handler
REM ===================================================

:ON_ERROR

echo.
echo ===================================================
echo  SETUP FAILED
echo ===================================================
echo.
echo Inspect the error message above.
echo.

pause
exit /b 1