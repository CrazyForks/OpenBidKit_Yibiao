const { ipcMain } = require('electron');

function registerConfigIpc({ configStore, aiService }) {
  ipcMain.handle('config:load', () => configStore.load());
  ipcMain.handle('config:save', (_event, config) => configStore.save(config));
  ipcMain.handle('config:list-models', () => aiService.listModels());
}

module.exports = {
  registerConfigIpc,
};
