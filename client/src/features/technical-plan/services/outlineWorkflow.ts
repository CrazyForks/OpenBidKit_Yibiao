import { buildOutlineMessages } from '../../../shared/prompts';
import { aiClient } from '../../../shared/ai';
import type { OutlineData, OutlineMode } from '../../../shared/types';

export async function requestOutlineGeneration(options: {
  overview: string;
  requirements: string;
  mode?: OutlineMode;
}) {
  const messages = buildOutlineMessages(options);
  return aiClient.requestJson<OutlineData>({ messages, schemaName: 'OutlineData', temperature: 0.3 });
}
