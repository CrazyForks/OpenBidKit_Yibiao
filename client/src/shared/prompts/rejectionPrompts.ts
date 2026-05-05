import type { ChatMessage } from '../types';
import { ClientNotImplementedError } from '../utils/errors';

export interface BuildRejectionCheckMessagesInput {
  bidContent: string;
  tenderContent?: string;
}

export function buildRejectionCheckMessages(_input: BuildRejectionCheckMessagesInput): ChatMessage[] {
  throw new ClientNotImplementedError('废标项检查提示词');
}
