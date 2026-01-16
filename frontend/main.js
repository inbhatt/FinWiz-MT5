const { app, BrowserWindow, ipcMain, dialog } = require('electron'); // Import ipcMain & dialog
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 850,
        backgroundColor: '#0b0e1c',
        webPreferences: {
            nodeIntegration: true, // Allows using require() in HTML
            contextIsolation: false
        },
        autoHideMenuBar: true,
        darkTheme: true
    });

    win.loadFile('frontend/index.html');
}

app.whenReady().then(createWindow);

// --- NEW: LISTEN FOR DIALOG REQUESTS ---
ipcMain.handle('show-alert', async (event, title, message) => {
    // Shows a native system message box
    const options = {
        type: 'info', // Can be 'error', 'info', 'question'
        buttons: ['OK'],
        defaultId: 0,
        title: title,
        message: title,
        detail: message, // The actual error text goes here
    };

    await dialog.showMessageBox(null, options);
});