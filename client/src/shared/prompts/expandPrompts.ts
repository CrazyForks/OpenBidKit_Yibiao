import type { ChatMessage } from '../types';
import { ClientNotImplementedError } from '../utils/errors';

export interface BuildExpandOutlineMessagesInput {
  fileContent: string;
}

export function buildExpandOutlineMessages(_input: BuildExpandOutlineMessagesInput): ChatMessage[] {
  throw new ClientNotImplementedError('旧方案扩写提示词');
}
