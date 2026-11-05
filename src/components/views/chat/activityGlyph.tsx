import React from 'react';
import {
  BotIcon,
  BrainIcon,
  BrowserIcon,
  CompassIcon,
  CpuIcon,
  EyeIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from './ChatIcons';
import { activityIconKind, type ActivityIconKind, type ActivityItem } from './activityPresentation';

const GLYPHS: Record<ActivityIconKind, React.FC<{ size?: number }>> = {
  read: EyeIcon,
  edit: PencilIcon,
  shell: TerminalIcon,
  web: GlobeIcon,
  'code-search': SearchIcon,
  browser: BrowserIcon,
  mcp: CpuIcon,
  subagent: BotIcon,
  plan: CompassIcon,
  reasoning: BrainIcon,
  tool: WrenchIcon,
};

/** One 16px icon set for thread rows and the agent shell. */
export function ActivityGlyph({ item, size = 16 }: { item: ActivityItem; size?: number }) {
  const Glyph = GLYPHS[activityIconKind(item)];
  return <Glyph size={size} />;
}
