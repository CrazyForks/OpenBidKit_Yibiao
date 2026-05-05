import type { BidProjectDraft } from '../types';
import { safeJsonParse } from '../utils/json';

const DRAFT_KEY = 'yibiao:client:draft:v1';
const CONTENT_BY_ID_KEY = 'yibiao:client:contentById:v1';

export type DraftState = Partial<BidProjectDraft>;
export type ContentById = Record<string, string>;

export const draftStorage = {
  loadDraft(): DraftState | null {
    return safeJsonParse<DraftState>(localStorage.getItem(DRAFT_KEY));
  },

  saveDraft(partial: DraftState) {
    const prev = draftStorage.loadDraft() || {};
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...prev, ...partial }));
  },

  loadContentById(): ContentById {
    return safeJsonParse<ContentById>(localStorage.getItem(CONTENT_BY_ID_KEY)) || {};
  },

  saveContentById(contentById: ContentById) {
    localStorage.setItem(CONTENT_BY_ID_KEY, JSON.stringify(contentById));
  },

  clearAll() {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(CONTENT_BY_ID_KEY);
  },
};
