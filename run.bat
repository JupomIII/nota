@echo off
setlocal EnableExtensions EnableDelayedExpansion
title NOTA
cd /d "%~dp0"

set "VENV_PY=backend\.venv\Scripts\python.exe"
set "CERT=backend\storage\certs\server-cert.pem"
set "TOKEN_FILE=backend\storage\pairing-token.txt"
REM Both are filled in below from the server's own plain-HTTP door: the laptop
REM never installs or trusts a certificate, that is the iPad's business.
set "APP_URL=http://localhost:8080/"
set "PAIR_URL=http://localhost:8080/pair"

echo.
echo   NOTA
echo   -----------
echo.

REM A trusted public address (tunnel) replaces the certificate entirely.
call :detect_tunnel

REM Setup is needed when the Python environment, the pairing token or the
REM trust profile is missing; without them the iPad cannot connect.
set "NEED_SETUP="
if not exist "%VENV_PY%" set "NEED_SETUP=1"
if not exist "%TOKEN_FILE%" set "NEED_SETUP=1"
if not exist "%CERT%" if not defined TUNNEL set "NEED_SETUP=1"

if defined NEED_SETUP (
    echo   First run - installing the server, pairing token and trust profile.
    echo   This may take a few minutes.
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-windows.ps1"
    if errorlevel 1 (
        echo.
        echo   Installation failed. Run scripts\install-windows.ps1 directly to see the error.
        pause
        exit /b 1
    )
    call :detect_tunnel
)

if not exist "%VENV_PY%" (
    echo   Server is not installed: %VENV_PY% is missing.
    pause
    exit /b 1
)

if not exist "%CERT%" if not defined TUNNEL (
    echo   No certificate in %CERT% and no trusted address configured.
    echo   Run scripts\install-windows.ps1 to create the token and certificate,
    echo   or start the server with -PublicUrl if a tunnel fronts it.
    pause
    exit /b 1
)

REM The iPad loads the app from this server, not from a months-old published
REM copy, so the bundle has to exist before the server starts telling it where
REM to go. First run with Node installed builds it here.
if not exist "frontend\dist\index.html" (
    where npm >nul 2>nul
    if errorlevel 1 (
        echo   The app has not been built and Node.js is missing.
        echo   Install Node.js, then run this script again: the iPad opens the app
        echo   from this laptop instead of an old published copy.
    ) else (
        echo   Building the app the iPad loads from this laptop...
        pushd frontend
        if not exist "node_modules" call npm install --no-audit --no-fund
        call npm run build
        popd
    )
)

REM The laptop opens this server's plain-HTTP door, on the loopback interface:
REM Browsers treat http://localhost as a secure context, so the app works there
REM with no profile to install and no warning to click through. Ask the server
REM itself which address that is, so a tunnel or a custom port still matches.
set "LAPTOP_APP="
"%VENV_PY%" -c "import sys; sys.path.insert(0, r'backend'); from app.config import settings; print(settings.laptop_app_url)" > "%TEMP%\thoth-laptop-app.flag" 2>nul
set /p LAPTOP_APP=<"%TEMP%\thoth-laptop-app.flag"
del "%TEMP%\thoth-laptop-app.flag" 2>nul
if not defined LAPTOP_APP set "LAPTOP_APP=http://localhost:8080"
set "APP_URL=%LAPTOP_APP%/"
set "PAIR_URL=%LAPTOP_APP%/pair"

REM --- One server at a time: reuse, replace, or refuse ----------------------
REM Starting a second copy used to look successful: the readiness poll passed
REM because of the *old* process while the new one died on "address already in
REM use" in a minimised window nobody reads. Ask the ports first.
REM Through a temp file, not for /f: cmd /c strips the outer quotes of a command
REM line that starts with a quote, which silently emptied the probe and made a
REM running server look like a free port.
set "STATE="
if exist "%VENV_PY%" "%VENV_PY%" "scripts\server-state.py" > "%TEMP%\nota-state.flag" 2>nul
if exist "%TEMP%\nota-state.flag" set /p STATE=<"%TEMP%\nota-state.flag"
del "%TEMP%\nota-state.flag" 2>nul
if not defined STATE set "STATE=free"

if /i "!STATE!"=="ready" goto :reuse_running
if /i "!STATE!"=="stale" goto :replace_running
if /i "!STATE!"=="free" goto :start_server
goto :port_taken

:reuse_running
echo   A NOTA server is already running and serves the current build: reusing it.
echo   No second server was started, so one process owns 8080 and 8443.
goto :open_page

:replace_running
echo   A NOTA server is already running, but it cannot serve the app at /:
echo   it was started before the build existed. Starting a second one would fail
echo   to bind, so this instance is stopped and a fresh one takes its place.
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 8443 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }" >nul 2>nul
powershell -NoProfile -Command "$end=(Get-Date).AddSeconds(20); while((Get-Date) -lt $end){ if (-not (Get-NetTCPConnection -LocalPort 8443 -State Listen -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Milliseconds 300 }; exit 1" >nul 2>nul
if errorlevel 1 (
    echo   That server did not stop: close its NOTA server window by hand, then
    echo   run this script again.
    call :hold
    exit /b 1
)
echo   Old instance stopped; starting the server that serves this build.
goto :start_server

:port_taken
echo   Port conflict (!STATE!): another program already answers there.
echo   NOTA will not start a server it cannot control, because the page would
echo   then come from the wrong instance. Close that program, or change "port"
echo   and "laptop_port" in backend\storage\config.json, then run this again.
call :hold
exit /b 1

:start_server
REM Start the server minimised: the pairing page in the browser is the interface.
echo   Starting the sync server...
start "NOTA server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-server.ps1"

REM Wait for the server itself to answer, not for the port to accept: a stale
REM listener would satisfy a port check and hide a server that never started.
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(45); while((Get-Date) -lt $deadline){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {} Start-Sleep -Milliseconds 400 }; exit 1" >nul 2>nul
if errorlevel 1 (
    echo   The server did not answer on http://127.0.0.1:8080/api/health.
    echo   Look at the NOTA server window for the reason, then run this again.
    call :hold
    exit /b 1
)

:open_page
start "" "%PAIR_URL%"

echo.
echo   Pairing page : %PAIR_URL%  ^(opened in your browser^)
echo   First time on the iPad: open the setup page printed in the server window,
echo   install the profile, then tap Open NOTA on that page to pair. The app is
 echo   served by this laptop, so no published copy is involved.
echo   The server runs in the minimised "NOTA server" window.
echo   Lost the code? powershell -ExecutionPolicy Bypass -File scripts\pair.ps1
echo.
REM ping, not timeout: a Git Bash PATH puts coreutils' timeout first, which
REM rejects /t and ends the script with an error line.
ping -n 9 127.0.0.1 >nul
endlocal
exit /b 0

:hold
REM A countdown, never pause: pause waits for a key, which hangs any automated
REM run of this script, while a countdown still leaves the message readable when
REM the file is double-clicked.
echo.
echo   This window closes in 20 seconds.
ping -n 21 127.0.0.1 >nul
goto :eof

:detect_tunnel
REM Asks the server itself, so an address it refuses (plain http://, a path)
REM counts as no tunnel at all: the certificate steps then stay in place.
set "TUNNEL="
if not exist "%VENV_PY%" goto :eof
    "%VENV_PY%" -c "import sys; sys.path.insert(0, r'backend'); from app.config import settings; print(1 if settings.tunneled else 0)" > "%TEMP%\thoth-tunnel.flag" 2>nul
    set /p TUNNEL=<"%TEMP%\thoth-tunnel.flag"
    if not "!TUNNEL!"=="1" set "TUNNEL="
    del "%TEMP%\thoth-tunnel.flag" 2>nul
goto :eof
