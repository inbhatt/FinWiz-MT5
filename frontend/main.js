const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

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

    mainWindow.loadFile('frontend/index.html'); // Adjust path as needed

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

// --- START PYTHON BACKEND ---
function startBackend() {
    const isDev = !app.isPackaged;
    let backendPath;

    if (isDev) {
        backendPath = 'python';
        const args = ['backend/app.py'];
        backendProcess = spawn(backendPath, args);
    } else {
        backendPath = path.join(process.resourcesPath, 'finwiz-server.exe');
        backendProcess = spawn(backendPath);
    }

    // Handle Standard Output
    backendProcess.stdout.on('data', (data) => {
        console.log(`Backend: ${data}`);
    });

    // Handle "Errors" (and Flask Logs)
    backendProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();

        // FILTER: If it's a standard HTTP 200 success, just log it (don't scream ERROR)
        if (msg.includes('" 200 -') || msg.includes('" 304 -') || msg.includes('Running on http')) {

        }else {
            console.error(`Backend Log: ${msg}`);
        }
    });
}

// --- APP LIFECYCLE ---
app.on('ready', () => {
    startBackend();
    // Give Flask 2 seconds to start before showing window
    setTimeout(createWindow, 2000);
});

app.on('window-all-closed', function () {
    // Kill the python process when app closes
    if (backendProcess) backendProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
    if (backendProcess) backendProcess.kill();
});