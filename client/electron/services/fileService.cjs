const { NotImplementedError } = require('../utils/errors.cjs');

function createFileService() {
  return {
    async importDocument() {
      throw new NotImplementedError('本地文档导入与解析');
    },
  };
}

module.exports = {
  createFileService,
};
