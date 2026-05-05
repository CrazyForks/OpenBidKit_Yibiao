const { NotImplementedError } = require('../utils/errors.cjs');

function createAiService() {
  return {
    async chat() {
      throw new NotImplementedError('AI 聊天请求封装');
    },

    async requestJson() {
      throw new NotImplementedError('AI JSON 请求封装');
    },

    async listModels() {
      return {
        success: true,
        message: '模型列表接口已预留',
        models: [],
      };
    },
  };
}

module.exports = {
  createAiService,
};
