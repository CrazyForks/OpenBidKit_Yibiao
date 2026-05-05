import { safeJsonParse } from '../utils/json';

const WORKSPACE_KEY = 'yibiao:client:workspace:v1';

export interface WorkspaceState {
  activeSection?: string;
  activeProjectId?: string;
  updatedAt?: string;
}

export const workspaceStorage = {
  load(): WorkspaceState | null {
    return safeJsonParse<WorkspaceState>(localStorage.getItem(WORKSPACE_KEY));
  },

  save(partial: WorkspaceState) {
    const prev = workspaceStorage.load() || {};
    localStorage.setItem(
      WORKSPACE_KEY,
      JSON.stringify({ ...prev, ...partial, updatedAt: new Date().toISOString() })
    );
  },
};
