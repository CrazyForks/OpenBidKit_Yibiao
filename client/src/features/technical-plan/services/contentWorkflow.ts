import { buildChapterContentMessages } from '../../../shared/prompts';
import { aiClient } from '../../../shared/ai';
import type { OutlineItem } from '../../../shared/types';

export async function requestChapterContent(options: {
  chapter: OutlineItem;
  parentChapters?: OutlineItem[];
  siblingChapters?: OutlineItem[];
  projectOverview?: string;
}) {
  const messages = buildChapterContentMessages(options);
  return aiClient.chat({ messages, temperature: 0.7 });
}
