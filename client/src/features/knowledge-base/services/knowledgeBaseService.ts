import { ClientNotImplementedError } from '../../../shared/utils/errors';

export async function listKnowledgeItems(): Promise<never> {
  throw new ClientNotImplementedError('知识库数据服务');
}
