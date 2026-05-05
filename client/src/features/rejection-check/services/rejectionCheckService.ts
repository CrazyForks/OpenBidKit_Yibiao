import { buildRejectionCheckMessages } from '../../../shared/prompts';
import { aiClient } from '../../../shared/ai';
import type { RejectionCheckReport } from '../types';

export async function requestRejectionCheck(bidContent: string, tenderContent?: string) {
  const messages = buildRejectionCheckMessages({ bidContent, tenderContent });
  return aiClient.requestJson<RejectionCheckReport>({ messages, schemaName: 'RejectionCheckReport' });
}
