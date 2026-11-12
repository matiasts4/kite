import React from 'react';
import {
  BotIcon,
  BrainIcon,
  BrowserIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  ListChecksIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
} from './ChatIcons';
import { activityIconKind, type ActivityIconKind, type ActivityItem } from './activityPresentation';

const GLYPHS: Record<ActivityIconKind, React.FC<{ size?: number }>> = {
  read: EyeIcon,
  edit: SquarePenIcon,
  shell: TerminalIcon,
  web: GlobeIcon,
  'code-search': SearchIcon,
  browser: BrowserIcon,
  mcp: HammerIcon,
  subagent: BotIcon,
  plan: ListChecksIcon,
  reasoning: BrainIcon,
  tool: WrenchIcon,
};

/** One 16px icon set for thread rows and the agent shell. */
export function ActivityGlyph({ item, size = 16 }: { item: ActivityItem; size?: number }) {
  const Glyph = GLYPHS[activityIconKind(item)];
  return <Glyph size={size} />;
}
