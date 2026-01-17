@echo off
TITLE FinWiz Builder
CLS

ECHO ========================================================
ECHO          FinWiz Automated Build Script
ECHO ========================================================
ECHO.

:: --- 1. CLEANUP ---
ECHO [1/5] Cleaning previous builds...
IF EXIST "dist" rmdir /s /q "dist"
IF EXIST "finwiz-server.exe" del "finwiz-server.exe"

:: --- 2. BUILD PYTHON BACKEND ---
ECHO.
ECHO [2/5] Compiling Python Backend (freezing app.py)...
ECHO       Including: serviceAccountKey.json
ECHO       Forcing Import: flask_cors

:: ADDED --hidden-import FLAG BELOW
python -m PyInstaller --noconfirm --onefile --windowed ^
 --name "finwiz-server" ^
 --hidden-import "flask_cors" ^
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
 --extra-resource=finwiz-server.exe

:: --- 5. CREATE INSTALLER (INNO SETUP) ---
ECHO.
ECHO [5/5] Compressing into Installer (FinWiz_Setup.exe)...

SET "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

IF NOT EXIST "%ISCC%" (
    ECHO.
    ECHO [WARNING] Inno Setup compiler not found.
    ECHO portable folder created in dist\FinWiz-win32-x64
    PAUSE
    EXIT /B
)

"%ISCC%" setup.iss

ECHO.
ECHO ========================================================
ECHO [SUCCESS] Build Complete!
ECHO ========================================================
PAUSE