# Pellet Plant Supervisory Dashboard - Jindal Steel

A robust, production-ready, read-only supervisory control-room dashboard for Pellet Plant 2, Jindal Steel. Built to run 24/7 on high-resolution control-room screens and local workstations.

---

## 1. Architecture & Design Principles

```
Historian SQL Server 10.37.32.102:1433 / HistorianDb / view dbo.L1_VW_PP_TagData (SELECT-only)
   │  pyodbc, 5s query timeout, TRY_CONVERT(float, tag_value)
   ▼
Flask 3.0.x + Waitress (0.0.0.0:5001)
   │  Single daemon poller thread (every 3s) -> thread-safe in-memory cache
   │  Writes 30s snapshots to local SQLite (data/history.db) with 90-day retention
   ▼
Browser Client: Vanilla JS + Custom CSS + Native SVG Charts
   │  Zero external CDNs or cloud dependencies (100% offline capable)
   │  Strictly 1 SQL query per 3s regardless of the number of connected browsers
```

---

## 2. Commissioning Checklist

Perform these verification steps prior to handing over to control-room operations:

1. **Network Connectivity Verification:**
   - Source node (dashboard host e.g., `10.36.25.36` or supervisory PC) to SQL Historian (`10.37.32.102:1433`).
   - Run PowerShell command:
     ```powershell
     Test-NetConnection -ComputerName 10.37.32.102 -Port 1433
     ```
   - Ensure `TcpTestSucceeded : True`.

2. **ODBC Driver Verification:**
   - Ensure **ODBC Driver 18 for SQL Server** or **ODBC Driver 17 for SQL Server** is installed on the host.
   - Test in command prompt:
     ```cmd
     powershell "Get-OdbcDriver -Name '*SQL Server*'"
     ```

3. **Database Credentials & Privileges:**
   - The dashboard requires **SELECT-only** permission on `dbo.L1_VW_PP_TagData`.
   - Never use `sa` or DDL-capable accounts.

4. **One-Week Parallel Run:**
   - Execute the dashboard alongside existing monitoring systems for 7 consecutive days.
   - Verify that tag values match control room displays.
   - Monitor `logs/dashboard.log` for any intermittent disconnections.

5. **Rollback Procedure:**
   - If maintenance or rollback is required, stop the service:
     ```cmd
     nssm.exe stop PelletPlantDashboard
     ```
   - No database cleanup is necessary because the application performs zero SQL write operations.

---

## 3. Directory Structure

```
pellet_plant_dashboard/
├── app.py                  # Single-file backend (config, poller, cache, auth, routes)
├── tags.json               # Tag registry, descriptions, units, and ranges
├── thresholds.json         # Target & alarm limits (editable via Admin UI)
├── requirements.txt        # Pinned Python dependencies
├── .env.example            # Environment variables template
├── setup_and_run.bat       # First-run automated setup & server launcher
├── install_service.bat     # NSSM Windows 24/7 background service installer
├── README.md               # Operations & maintenance documentation
├── logs/                   # Auto-created rotating log directory
├── data/                   # Auto-created SQLite trend database (history.db)
├── templates/
│   └── index.html          # Dashboard user interface
└── static/
    ├── jspl_logo.jpg       # [User Supplies] JSPL corporate logo
    ├── fonts/              # [User Supplies] Offline Poppins woff2 font files
    ├── css/
    │   └── dashboard.css   # Full dashboard styling (dark/light themes)
    └── js/
        └── dashboard.js    # Client state, SVG rendering, polling, admin modal
```

---

## 4. Setup & Quickstart

### Prerequisites
- Windows 10/11 or Windows Server 2016+
- Python 3.10 or higher installed with `Add python.exe to PATH` checked
- Microsoft ODBC Driver 17 or 18 for SQL Server

### Step 1: Assets Placement
1. **Logo:** Copy your JSPL logo to `static/jspl_logo.jpg` (a fallback "JSPL" text tile will show if absent).
2. **Fonts:** Download Poppins woff2 files and place them in `static/fonts/`:
   - `poppins-v20-latin-regular.woff2`
   - `poppins-v20-latin-600.woff2`
   - `poppins-v20-latin-700.woff2`
   *(If omitted, the UI gracefully falls back to system UI fonts).*

### Step 2: Automated Installation & First Run
Double-click or run from CMD:
```cmd
setup_and_run.bat
```
- Creates `.venv` and installs dependencies.
- Prompts for a secure **Admin Password** on first run, hashes it with Werkzeug, and writes to `.env`.
- Starts the production Waitress server on `http://0.0.0.0:5001`.

Open `http://localhost:5001` in any browser.

---

## 5. 24/7 Service Installation (NSSM)

To ensure the dashboard starts automatically upon Windows boot and auto-restarts on any unexpected fault:

1. Download **NSSM (Non-Sucking Service Manager)** from `https://nssm.cc/download`.
2. Extract `nssm.exe` (from the `win64` directory) directly into the `pellet_plant_dashboard/` folder.
3. Right-click `install_service.bat` and select **Run as Administrator**.
4. The service `PelletPlantDashboard` will be installed, set to auto-start with a 5-second restart delay, and started immediately.

---

## 6. Windows Firewall Configuration

To allow operator workstations across the plant control network to access the dashboard, run this command in an elevated Administrator CMD:

```cmd
netsh advfirewall firewall add rule name="Pellet Plant Dashboard (Port 5001)" dir=in action=allow protocol=TCP localport=5001 remoteip=<PLANT_SUBNET>
```
*(Replace `<PLANT_SUBNET>` with your plant network CIDR, e.g., `10.36.0.0/16` or `10.36.25.0/24`).*

---

## 7. Configuration Files

### `.env` File
Contains sensitive credentials and server keys:
- `PP_SQL_HOST`: IP address of the historian server (`10.37.32.102`).
- `PP_SQL_PORT`: Historian port (`1433`).
- `PP_SQL_DATABASE`: Historian database name (`HistorianDb`).
- `PP_SQL_USERNAME`: Database read-only username (`gateway_user`).
- `PP_SQL_PASSWORD`: Database password.
- `ADMIN_PASSWORD_HASH`: Werkzeug scrypt/pbkdf2 hash of the admin config password.
- `FLASK_SECRET_KEY`: Cryptographic signing key for session cookies.

### `thresholds.json`
Can be modified directly or via the in-browser **Admin Config** modal:
- `day_production_target_mt`: Daily production target (default: 16000 MT).
- `gp3_setpoint_tph`: Expected primary feed setpoint (default: 440 TPH).
- `moisture_green_max`: Upper limit for normal moisture (default: 10.0%).
- `moisture_yellow_max`: Upper limit for warning moisture (default: 11.5%).
- `bin_starvation_pct`: Bin starvation critical threshold (default: 15.0%).
- `bin_low_pct`: Bin low warning threshold (default: 25.0%).
- `bin_overfeed_pct`: Bin overfeed critical threshold (default: 80.0%).
- `variance_green_tph`: Normal feed variance range (default: ±5.0 TPH).
- `stale_after_seconds`: Threshold after which tags are tagged as STALE (default: 60s).

---

## 8. Troubleshooting

| Symptom | Root Cause | Resolution |
|---|---|---|
| Status shows `STANDBY` | `PP_SQL_PASSWORD` is empty in `.env`. | Open Admin Config (lock icon) or edit `.env` with valid DB credentials. |
| Status shows `DATA UNAVAILABLE` | Historian network disconnected or firewall blocking port 1433. | Check `Test-NetConnection -ComputerName 10.37.32.102 -Port 1433`. Review `logs/dashboard.log`. |
| Tags show `STALE` | Historian view has not received updates for >60s. | Check PLC/SCADA gateway pushing data into `HistorianDb`. |
| Admin login fails | Incorrect password entered. | To reset, delete `ADMIN_PASSWORD_HASH` line from `.env` and rerun `setup_and_run.bat`. |
| Port 5001 already in use | Another instance or application is bound to 5001. | Check `netstat -ano \| findstr :5001` and terminate old process. |
