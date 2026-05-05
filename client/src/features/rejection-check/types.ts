export interface RejectionRiskItem {
  id: string;
  title: string;
  source: string;
  suggestion: string;
  severity: 'low' | 'medium' | 'high';
}

export interface RejectionCheckReport {
  passed: boolean;
  risks: RejectionRiskItem[];
}
