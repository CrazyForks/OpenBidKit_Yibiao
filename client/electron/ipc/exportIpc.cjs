const { ipcMain } = require('electron');

function registerExportIpc({ exportService }) {
  ipcMain.handle('export:word', (_event, payload) => exportService.exportWord(payload));
}

module.exports = {
  registerExportIpc,
};
