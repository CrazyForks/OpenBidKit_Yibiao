import type { SectionId } from '../shared/types/navigation';
import DuplicateCheckPage from '../features/duplicate-check/pages/DuplicateCheckPage';
import KnowledgeBasePage from '../features/knowledge-base/pages/KnowledgeBasePage';
import RejectionCheckPage from '../features/rejection-check/pages/RejectionCheckPage';
import TechnicalPlanHome from '../features/technical-plan/pages/TechnicalPlanHome';

interface AppRouterProps {
  activeSection: SectionId;
}

function AppRouter({ activeSection }: AppRouterProps) {
  switch (activeSection) {
    case 'technical-plan':
      return <TechnicalPlanHome />;
    case 'knowledge-base':
      return <KnowledgeBasePage />;
    case 'duplicate-check':
      return <DuplicateCheckPage />;
    case 'rejection-check':
      return <RejectionCheckPage />;
    default:
      return null;
  }
}

export default AppRouter;
