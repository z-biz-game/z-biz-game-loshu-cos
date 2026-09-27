// Electron shell. The game is a browser artefact first — this exists so the same files run
// as a desktop app without a bundler or a build step. Nothing about the rules lives here.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 880,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#070A12',
    title: '幻方 · LOSHU',
    webPreferences: {
      // The renderer gets no Node access at all: the desktop build must not be able to do
      // anything the browser build cannot, or verify.sh would be testing a different app.
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
