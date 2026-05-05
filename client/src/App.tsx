import { useState } from 'react';
import AppRouter from './app/AppRouter';
import { buildToolbarGroups } from './app/toolbarConfig';
import AppShell from './components/AppShell';
import { FloatingToolbar } from './shared/ui';
import type { SectionId } from './shared/types/navigation';

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('technical-plan');
  const toolbarGroups = buildToolbarGroups({ activeSection, onSectionChange: setActiveSection });

  return (
    <AppShell
      activeSection={activeSection}
      toolbar={<FloatingToolbar groups={toolbarGroups} />}
      onSectionChange={setActiveSection}
    >
      <AppRouter activeSection={activeSection} />
    </AppShell>
  );
}

export default App;
