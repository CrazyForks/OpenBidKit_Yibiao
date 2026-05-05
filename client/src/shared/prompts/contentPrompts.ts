import type { ChatMessage, OutlineItem } from '../types';
import { ClientNotImplementedError } from '../utils/errors';

export interface BuildChapterContentMessagesInput {
  chapter: OutlineItem;
  parentChapters?: OutlineItem[];
  siblingChapters?: OutlineItem[];
  projectOverview?: string;
}

export function buildChapterContentMessages(_input: BuildChapterContentMessagesInput): ChatMessage[] {
  throw new ClientNotImplementedError('正文生成提示词');
}
