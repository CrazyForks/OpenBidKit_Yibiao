import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export type FloatingToolbarActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface FloatingToolbarAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tooltip?: string;
  disabled?: boolean;
  variant?: FloatingToolbarActionVariant;
  onClick: () => void;
}

export interface FloatingToolbarGroup {
  id: string;
  actions: FloatingToolbarAction[];
}

interface FloatingToolbarProps {
  groups: FloatingToolbarGroup[];
  label?: string;
}

function FloatingToolbar({ groups, label = '页面工具条' }: FloatingToolbarProps) {
  const visibleGroups = groups.filter((group) => group.actions.length > 0);

  if (visibleGroups.length === 0) {
    return null;
  }

  return (
    <div className="floating-toolbar" role="toolbar" aria-label={label}>
      {visibleGroups.map((group, groupIndex) => (
        <div className="floating-toolbar-group" key={group.id}>
          {group.actions.map((action) => (
            <ToolbarButton action={action} key={action.id} />
          ))}
          {groupIndex < visibleGroups.length - 1 && <span className="floating-toolbar-separator" />}
        </div>
      ))}
    </div>
  );
}

function ToolbarButton({ action }: { action: FloatingToolbarAction }) {
  const button = (
    <button
      type="button"
      className={`floating-toolbar-button is-${action.variant || 'secondary'}`}
      onClick={action.onClick}
      disabled={action.disabled}
    >
      {action.icon && <span className="floating-toolbar-icon" aria-hidden="true">{action.icon}</span>}
      <span>{action.label}</span>
    </button>
  );

  if (!action.tooltip) {
    return button;
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" side="top" align="center" sideOffset={10}>
          {action.tooltip}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function ToolbarArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M15 18 9 12l6-6" />
    </svg>
  );
}

export function ToolbarArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function ToolbarDocumentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 3.75h6.7L18 8.05v12.2H7z" />
      <path d="M13.5 4v4.35h4.25" />
      <path d="M9.5 12.2h5" />
      <path d="M9.5 15.7h4" />
    </svg>
  );
}

export function ToolbarOutlineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6.5 7h11" />
      <path d="M6.5 12h11" />
      <path d="M6.5 17h7" />
      <path d="M3.75 7h.01" />
      <path d="M3.75 12h.01" />
      <path d="M3.75 17h.01" />
    </svg>
  );
}

export default FloatingToolbar;
