@echo off
TITLE FinWiz Builder
CLS

ECHO ========================================================
ECHO          FinWiz Automated Build Script
ECHO ========================================================
ECHO.

:: --- 0. ENVIRONMENT CHECK ---
ECHO [0/5] Setting up Python Environment...

:: Try to activate .venv if it exists
IF EXIST ".venv\Scripts\activate.bat" (
    ECHO       Found .venv! Activating...
    CALL .venv\Scripts\activate.bat
) ELSE (
    ECHO       [WARNING] No .venv found. Using system Python.
)

:: 1. Check for Flask (Core Framework)
python -c "import flask" 2>NUL
IF %ERRORLEVEL% NEQ 0 (
    ECHO [INSTALL] Installing flask...
    pip install flask
)

:: 2. Check for Flask-CORS
python -c "import flask_cors" 2>NUL
IF %ERRORLEVEL% NEQ 0 (
    ECHO [INSTALL] Installing flask-cors...
    pip install flask-cors
)

:: 3. Check for MetaTrader5 & Numpy (MT5 needs Numpy)
python -c "import MetaTrader5" 2>NUL
IF %ERRORLEVEL% NEQ 0 (
    ECHO [INSTALL] Installing MetaTrader5...
    pip install MetaTrader5
)
python -c "import numpy" 2>NUL
IF %ERRORLEVEL% NEQ 0 (
    ECHO [INSTALL] Installing numpy...
    pip install numpy
)

:: 4. Check for Firebase & Google Libs
python -c "import firebase_admin" 2>NUL
IF %ERRORLEVEL% NEQ 0 (
    ECHO [INSTALL] Installing firebase-admin...
    pip install firebase-admin
)

:: --- 1. CLEANUP ---
ECHO.
ECHO [1/5] Cleaning previous builds...
IF EXIST "dist" rmdir /s /q "dist"
IF EXIST "build" rmdir /s /q "build"
IF EXIST "finwiz-server.exe" del "finwiz-server.exe"
IF EXIST "finwiz-server.spec" del "finwiz-server.spec"

:: --- 2. BUILD PYTHON BACKEND ---
ECHO.
ECHO [2/5] Compiling Python Backend (freezing app.py)...
ECHO       Including: serviceAccountKey.json
ECHO       Forcing Imports: flask, firebase, mt5, google.api

:: ADDED: Hidden imports for google.api, numpy, and explicit flask
python -m PyInstaller --noconfirm --onefile --windowed ^
 --name "finwiz-server" ^
 --hidden-import "flask" ^
 --hidden-import "flask_cors" ^
 --hidden-import "firebase_admin" ^
 --hidden-import "google.cloud.firestore" ^
 --hidden-import "google.api" ^
 --hidden-import "grpc" ^
 --hidden-import "MetaTrader5" ^
 --hidden-import "numpy" ^
 --add-data "backend/serviceAccountKey.json;." ^
 backend/app.py

IF NOT EXIST "dist\finwiz-server.exe" (
    ECHO.
    ECHO [ERROR] Python build failed.
    PAUSE
    EXIT /B
)

move "dist\finwiz-server.exe" .

:: --- 3. INSTALL BUILD TOOLS ---
ECHO.
ECHO [3/5] Ensuring build tools are installed...
call npm install electron-packager --save-dev

:: --- 4. PACKAGE ELECTRON APP ---
ECHO.
ECHO [4/5] Packaging Electron App...
ECHO       Platform: Windows (x64)

call npx electron-packager . FinWiz ^
 --platform=win32 ^
 --arch=x64 ^
 --out=dist ^
 --icon=frontend/icon.ico ^
 --overwrite ^
 --extra-resource=finwiz-server.exe ^
 --ignore="^/backend" ^
 --ignore="^/build.bat" ^
 --ignore="^/finwiz-server.spec" ^
 --ignore="^/.vscode" ^
 --ignore="^/.idea"

:: --- 5. CREATE INSTALLER (INNO SETUP) ---
ECHO.
ECHO [5/5] Compressing into Installer (FinWiz_Setup.exe)...

SET "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

IF NOT EXIST "%ISCC%" (
    ECHO.
    ECHO [WARNING] Inno Setup compiler not found.
    ECHO Portable build is available in: dist\FinWiz-win32-x64
    PAUSE
    EXIT /B
)

IF EXIST "setup.iss" (
    "%ISCC%" setup.iss
) ELSE (
    ECHO.
    ECHO [WARNING] setup.iss file not found. Skipping installer creation.
)

ECHO.
ECHO ========================================================
ECHO [SUCCESS] Build Complete!
ECHO ========================================================
PAUSE