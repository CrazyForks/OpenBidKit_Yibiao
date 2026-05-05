import * as Tooltip from '@radix-ui/react-tooltip';
import { useState, type ComponentType, type ReactElement, type SVGProps } from 'react';
import { appMenuItems } from '../app/menuConfig';
import type { SectionId } from '../shared/types/navigation';
import SettingsDialog from './SettingsDialog';
import logoUrl from '../../assets/icon_256.png';

interface SidebarProps {
  activeSection: SectionId;
  onSectionChange: (section: SectionId) => void;
}

const navigationIcons: Record<SectionId, ComponentType<SVGProps<SVGSVGElement>>> = {
  'technical-plan': DocumentIcon,
  'knowledge-base': ArchiveIcon,
  'duplicate-check': CompareIcon,
  'rejection-check': ShieldIcon,
};

function Sidebar({ activeSection, onSectionChange }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-surface" />

      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          <img src={logoUrl} alt="" />
        </div>
        <div className="brand-copy">
          <span>易标</span>
          <strong>投标工具箱</strong>
        </div>
      </div>

      <button
        type="button"
        className="collapse-button"
        onClick={() => setCollapsed((value) => !value)}
        aria-label={collapsed ? '展开菜单' : '收起菜单'}
      >
        <ChevronIcon className={collapsed ? 'rotate-180' : ''} />
      </button>

      <nav className="sidebar-nav" aria-label="主菜单">
        {appMenuItems.map((item) => {
          const Icon = navigationIcons[item.id];
          const isActive = item.id === activeSection;
          const button = (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${isActive ? 'is-active' : ''}`}
              onClick={() => onSectionChange(item.id)}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="nav-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          );

          return collapsed ? wrapTooltip(item.label, button) : button;
        })}
      </nav>

      <div className="sidebar-footer">
        <SettingsDialog collapsed={collapsed} />
      </div>
    </aside>
  );
}

function wrapTooltip(label: string, child: ReactElement) {
  return (
    <Tooltip.Root key={label}>
      <Tooltip.Trigger asChild>{child}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" side="right" align="center" sideOffset={12}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function DocumentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 3.75h6.7L18 8.05v12.2H7z" />
      <path d="M13.5 4v4.35h4.25" />
      <path d="M9.5 12.2h5" />
      <path d="M9.5 15.7h4" />
    </svg>
  );
}

function ArchiveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M5 7.5h14v12H5z" />
      <path d="M4 4.5h16v3H4z" />
      <path d="M9 11.2h6" />
    </svg>
  );
}

function CompareIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 5.5h7.5" />
      <path d="M7 9h5.5" />
      <path d="M5 15.5h7.5" />
      <path d="M5 19h5.5" />
      <path d="M16.5 13.5l2 2 2-2" />
      <path d="M18.5 15.5V5" />
      <path d="M7.5 8.5l-2-2 2-2" />
      <path d="M5.5 6.5V17" />
    </svg>
  );
}

function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 3.5 18.5 6v5.4c0 4.25-2.55 7.55-6.5 9.1-3.95-1.55-6.5-4.85-6.5-9.1V6z" />
      <path d="m9 12.2 2 2 4-4.5" />
    </svg>
  );
}

function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="m14 7-5 5 5 5" />
    </svg>
  );
}

export default Sidebar;
