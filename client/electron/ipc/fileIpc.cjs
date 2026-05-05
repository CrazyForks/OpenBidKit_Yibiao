const { ipcMain } = require('electron');

function registerFileIpc({ fileService }) {
  ipcMain.handle('file:import-document', () => fileService.importDocument());
}

module.exports = {
  registerFileIpc,
};
