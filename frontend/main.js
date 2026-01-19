const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
// We import exec ONLY for the shutdown command
const { spawn, exec } = require('child_process');

let mainWindow;
let backendProcess;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.removeMenu();
    mainWindow.loadFile('frontend/index.html');

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

// --- IPC HANDLERS ---
ipcMain.handle('show-alert', async (event, title, message) => {
    if (!mainWindow) return;
    await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: title,
        message: message,
        buttons: ['OK']
    });
});

// --- START PYTHON BACKEND (YOUR ORIGINAL CODE) ---
function startBackend() {
    if (backendProcess) {
        console.log("Backend is already running. Skipping new spawn.");
        return;
    }
    const isDev = !app.isPackaged;
    let backendPath;
    let args = [];

    if (isDev) {
        // Run python script directly in dev mode
        backendPath = 'python';
        args = ['backend/app.py'];
        console.log('Starting Backend in DEV Mode...');
        backendProcess = spawn(backendPath, args);
    } else {
        // Run the compiled executable in production
        backendPath = path.join(process.resourcesPath, 'finwiz-server.exe');
        console.log('Starting Backend in PROD Mode...');
        backendProcess = spawn(backendPath);
    }

    if (backendProcess) {
        backendProcess.stdout.on('data', (data) => {
            console.log(`Backend: ${data}`);
        });
        backendProcess.stderr.on('data', (data) => {
            console.error(`Backend Error: ${data}`);
        });
    }
}

// --- APP LIFECYCLE ---
app.on('ready', () => {
    // We do NOT run cleanup here to avoid killing the process we are about to start
    startBackend();
    
    // Give Flask 2 seconds to initialize
    setTimeout(createWindow, 2000);
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// --- THE FIX: ROBUST SHUTDOWN ---
app.on('will-quit', () => {
    if (backendProcess) {
        console.log("Stopping Backend...");
        
        if (process.platform === 'win32') {
            // Windows Force Kill: This kills the process tree (Python + Scripts)
            // /F = Force, /T = Tree (Child processes), /PID = Process ID
            exec(`taskkill /pid ${backendProcess.pid} /f /t`, (err) => {
                if (err) console.error("Taskkill failed:", err);
            });
        } else {
            // Mac/Linux Standard Kill
            backendProcess.kill();
        }
        
        backendProcess = null;
    }
});