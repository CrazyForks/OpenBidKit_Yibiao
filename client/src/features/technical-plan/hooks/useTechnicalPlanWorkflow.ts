import { useState } from 'react';
import type { TechnicalPlanState } from '../types';

const initialState: TechnicalPlanState = {
  step: 'document-analysis',
  fileContent: '',
  projectOverview: '',
  techRequirements: '',
  outlineData: null,
};

export function useTechnicalPlanWorkflow() {
  const [state, setState] = useState<TechnicalPlanState>(initialState);

  return {
    state,
    setState,
  };
}
