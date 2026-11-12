import type { CompareView } from '../../frame';
import { RealHeaderSidebarScenes } from './RealHeaderSidebarScenes';
import { TabsSection } from './TabsSection';
import { SidebarSection } from './SidebarSection';
import { MenusSection } from './MenusSection';
import { PaletteSection } from './PaletteSection';
import { DisclosureSection } from './DisclosureSection';
import { DockSection } from './DockSection';
import './navigation.css';

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function NavigationPage({ view }: { view: CompareView }) {
  return (
    <div className="p2-page" data-page="02" data-view={view}>
      <RealHeaderSidebarScenes view={view} />
      <TabsSection view={view} />
      <SidebarSection view={view} />
      <MenusSection view={view} />
      <PaletteSection view={view} />
      <DisclosureSection view={view} />
      <DockSection view={view} />
    </div>
  );
}

// Re-exports for convenience and backwards compatibility
export { TabsPane, TabsSection } from './TabsSection';
export type { HTabId, VTabId, TabsPaneProps } from './TabsSection';
export { SidebarPane, SidebarSection } from './SidebarSection';
export type { SidebarPaneProps, SidebarItemId, NestedThreadId, FavoriteId } from './SidebarSection';
export { MenusPane, MenusSection } from './MenusSection';
export type { MenusPaneProps, MenubarId } from './MenusSection';
export { MenuSurface, Submenu, MenuPanel } from './MenuSurface';
export type { MenuEntry, MenuSurfaceProps, MenuPanelProps } from './MenuSurface';
export { PalettePane, PaletteSection } from './PaletteSection';
export type { PalettePaneProps, PaletteCommand } from './PaletteSection';
export { DisclosurePane, DisclosureSection, Disclosure, TooltipBubble } from './DisclosureSection';
export type { DisclosurePaneProps } from './DisclosureSection';
export { DockPane, DockSection } from './DockSection';
export type { DockPaneProps } from './DockSection';
export { clamp, useCanHover, useMenuAutoFocus, focusFirstIn } from './shared';
export type { Direction } from './shared';
