import type { AppMenuItem, SectionId } from '../shared/types/navigation';

export const appMenuItems: AppMenuItem[] = [
  {
    id: 'technical-plan',
    label: '技术方案',
    description: '方案生成与正文编排',
  },
  {
    id: 'knowledge-base',
    label: '知识库',
    description: '素材、模板和案例资产',
  },
  {
    id: 'duplicate-check',
    label: '标书查重',
    description: '相似度与重复表达检测',
  },
  {
    id: 'rejection-check',
    label: '废标项检查',
    description: '硬性条款与响应完整性',
  },
];

export const sectionOrder: SectionId[] = appMenuItems.map((item) => item.id);
