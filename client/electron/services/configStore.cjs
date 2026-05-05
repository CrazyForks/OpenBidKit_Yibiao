const fs = require('node:fs');
const path = require('node:path');
const { getConfigFilePath } = require('../utils/paths.cjs');

const defaultConfig = {
  api_key: '',
  base_url: '',
  model_name: 'gpt-3.5-turbo',
};

function createConfigStore(app) {
  const configFile = getConfigFilePath(app);

  return {
    load() {
      if (!fs.existsSync(configFile)) {
        return defaultConfig;
      }

      try {
        const raw = fs.readFileSync(configFile, 'utf-8');
        return { ...defaultConfig, ...JSON.parse(raw) };
      } catch {
        return defaultConfig;
      }
    },

    save(config) {
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true, message: '配置已保存' };
    },
  };
}

module.exports = {
  createConfigStore,
};
