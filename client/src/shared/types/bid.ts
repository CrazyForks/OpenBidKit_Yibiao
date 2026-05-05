import type { OutlineData } from './outline';

export type AnalysisType = 'overview' | 'requirements';

export interface BidProjectDraft {
  currentStep: number;
  fileContent: string;
  projectOverview: string;
  techRequirements: string;
  outlineData: OutlineData | null;
}

export interface FileImportResult {
  success: boolean;
  message: string;
  file_content?: string;
  old_outline?: string;
}

export interface ChapterContentContext {
  project_overview: string;
}
