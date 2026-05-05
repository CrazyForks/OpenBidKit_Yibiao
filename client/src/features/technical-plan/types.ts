import type { OutlineData } from '../../shared/types';

export type TechnicalPlanStep = 'document-analysis' | 'outline-edit' | 'content-edit';

export interface TechnicalPlanState {
  step: TechnicalPlanStep;
  fileContent: string;
  projectOverview: string;
  techRequirements: string;
  outlineData: OutlineData | null;
}
