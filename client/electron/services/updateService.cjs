const { dialog, shell } = require('electron');

function formatReleaseNotes(releaseNotes) {
  if (!releaseNotes) {
    return '';
  }

  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((item) => item?.note || item?.version || '')
      .filter(Boolean)
      .join('\n\n');
  }

  return String(releaseNotes);
}

let autoUpdaterInstance = null;

function triggerUpdateDownload({ mainWindow, onProgress, onDownloaded, onError }) {
  if (!autoUpdaterInstance) {
    shell.openExternal('https://github.com/FB208/OpenBidKit_Yibiao/releases/latest');
    return;
  }

  autoUpdaterInstance.removeAllListeners('download-progress');
  autoUpdaterInstance.removeAllListeners('update-downloaded');
  autoUpdaterInstance.removeAllListeners('error');

  autoUpdaterInstance.on('download-progress', (progress) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
    }
    onProgress?.(progress.percent);
  });

  autoUpdaterInstance.on('update-downloaded', (info) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    onDownloaded?.(info.version);
  });

  autoUpdaterInstance.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    onError?.(error instanceof Error ? error.message : String(error));
  });

  autoUpdaterInstance.downloadUpdate().catch((error) => {
    onError?.(error instanceof Error ? error.message : String(error));
  });
}

function quitAndInstall() {
  if (autoUpdaterInstance) {
    autoUpdaterInstance.quitAndInstall(false, true);
  }
}

function setupAutoUpdate({ app, mainWindow }) {
  if (!app.isPackaged) {
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdaterInstance = autoUpdater;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', async (info) => {
    const releaseNotes = formatReleaseNotes(info.releaseNotes);
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: `发现新版本 ${info.version}`,
      detail: releaseNotes || '是否现在下载更新？',
      noLink: true,
    });

    if (result.response !== 0) {
      return;
    }

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        buttons: ['知道了'],
        title: '更新下载失败',
        message: '更新下载失败',
        detail: error instanceof Error ? error.message : String(error),
        noLink: true,
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已下载',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '是否立即重启应用并安装更新？',
      noLink: true,
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    console.warn('自动更新检查失败', error);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      console.warn('启动自动更新检查失败', error);
    });
  }, 3000);
}

module.exports = { setupAutoUpdate, triggerUpdateDownload, quitAndInstall };
