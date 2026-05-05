import { ClientNotImplementedError } from '../utils/errors';

export interface JsonRepairIssue {
  path: string;
  message: string;
}

export async function repairJsonResponse(): Promise<never> {
  throw new ClientNotImplementedError('JSON 修复流程');
}
