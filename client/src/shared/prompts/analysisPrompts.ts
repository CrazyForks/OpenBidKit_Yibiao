import type { AnalysisType, ChatMessage } from '../types';
import { ClientNotImplementedError } from '../utils/errors';

export interface BuildAnalysisMessagesInput {
  fileContent: string;
  analysisType: AnalysisType;
}

export function buildAnalysisMessages(_input: BuildAnalysisMessagesInput): ChatMessage[] {
  throw new ClientNotImplementedError('标书解析提示词');
}
