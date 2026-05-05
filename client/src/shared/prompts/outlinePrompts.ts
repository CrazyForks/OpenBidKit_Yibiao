import type { ChatMessage, OutlineItem, OutlineMode, TechnicalRequirementGroup } from '../types';
import { ClientNotImplementedError } from '../utils/errors';

export interface BuildOutlineMessagesInput {
  overview: string;
  requirements: string;
  mode?: OutlineMode;
  oldOutline?: string;
  suggestions?: string[];
}

export interface BuildChildrenOutlineMessagesInput extends BuildOutlineMessagesInput {
  parentItem: OutlineItem;
  requirementGroup?: TechnicalRequirementGroup;
}

export function buildOutlineMessages(_input: BuildOutlineMessagesInput): ChatMessage[] {
  throw new ClientNotImplementedError('目录生成提示词');
}

export function buildChildrenOutlineMessages(_input: BuildChildrenOutlineMessagesInput): ChatMessage[] {
  throw new ClientNotImplementedError('子目录生成提示词');
}

export function buildOutlineReviewMessages(_input: BuildOutlineMessagesInput): ChatMessage[] {
  throw new ClientNotImplementedError('目录审核提示词');
}
