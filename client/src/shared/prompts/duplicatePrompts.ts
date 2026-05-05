import type { ChatMessage } from '../types';
import { ClientNotImplementedError } from '../utils/errors';

export interface BuildDuplicateCheckMessagesInput {
  documentContent: string;
  referenceContents?: string[];
}

export function buildDuplicateCheckMessages(_input: BuildDuplicateCheckMessagesInput): ChatMessage[] {
  throw new ClientNotImplementedError('标书查重提示词');
}
