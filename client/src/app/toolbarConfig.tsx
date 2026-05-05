import {
  ToolbarArrowLeftIcon,
  ToolbarArrowRightIcon,
  ToolbarDocumentIcon,
  ToolbarOutlineIcon,
} from '../shared/ui';
import type { FloatingToolbarGroup } from '../shared/ui';
import type { SectionId } from '../shared/types/navigation';
import { sectionOrder } from './menuConfig';

interface BuildToolbarGroupsOptions {
  activeSection: SectionId;
  onSectionChange: (section: SectionId) => void;
}

export function buildToolbarGroups({
  activeSection,
  onSectionChange,
}: BuildToolbarGroupsOptions): FloatingToolbarGroup[] {
  const activeIndex = sectionOrder.indexOf(activeSection);
  const goToSection = (offset: number) => {
    const nextSection = sectionOrder[activeIndex + offset];
    if (nextSection) {
      onSectionChange(nextSection);
    }
  };

  return [
    {
      id: 'page-navigation',
      actions: [
        {
          id: 'previous',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0,
          tooltip: activeIndex <= 0 ? '当前已经是第一个页面' : '切换到上一个页面',
          onClick: () => goToSection(-1),
        },
        {
          id: 'next',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          disabled: activeIndex >= sectionOrder.length - 1,
          tooltip: activeIndex >= sectionOrder.length - 1 ? '当前已经是最后一个页面' : '切换到下一个页面',
          onClick: () => goToSection(1),
        },
      ],
    },
    {
      id: 'technical-flow',
      actions: [
        {
          id: 'document-analysis',
          label: '标书解析',
          icon: <ToolbarDocumentIcon />,
          variant: activeSection === 'technical-plan' ? 'primary' : 'secondary',
          tooltip: '进入标书解析流程',
          onClick: () => onSectionChange('technical-plan'),
        },
        {
          id: 'outline-edit',
          label: '目录编辑',
          icon: <ToolbarOutlineIcon />,
          tooltip: '预留目录编辑入口，后续页面接入后可替换动作',
          onClick: () => onSectionChange('technical-plan'),
        },
      ],
    },
  ];
}
