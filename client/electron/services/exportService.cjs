const { NotImplementedError } = require('../utils/errors.cjs');

function createExportService() {
  return {
    async exportWord() {
      throw new NotImplementedError('Word 导出');
    },
  };
}

module.exports = {
  createExportService,
};
