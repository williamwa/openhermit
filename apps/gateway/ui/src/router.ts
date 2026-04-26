import { useEffect, useState, useCallback } from 'react';

export type Tab = 'fleet' | 'skills' | 'mcp-servers' | 'schedules' | 'containers' | 'users' | 'stats' | 'logs';

const VALID_TABS: readonly Tab[] = ['fleet', 'skills', 'mcp-servers', 'schedules', 'containers', 'users', 'stats', 'logs'];
const DEFAULT_TAB: Tab = 'fleet';

const tabFromPath = (pathname: string): Tab => {
  // Expected shape: /admin or /admin/ or /admin/<tab> (optionally with trailing slash)
  const m = pathname.match(/^\/admin\/?([^/]*)/);
  const slug = (m?.[1] ?? '').toLowerCase();
  if (!slug) return DEFAULT_TAB;
  if ((VALID_TABS as readonly string[]).includes(slug)) return slug as Tab;
  return DEFAULT_TAB;
};

const pathFromTab = (tab: Tab): string => `/admin/${tab}`;

/**
 * Tiny URL-backed tab router. Tab is sourced from window.location.pathname
 * and pushState'd on change. Handles browser back/forward via popstate.
 */
export const useTabRouter = (): [Tab, (tab: Tab) => void] => {
  const [tab, setTabState] = useState<Tab>(() => tabFromPath(window.location.pathname));

  useEffect(() => {
    // If the URL is the bare /admin or /admin/, normalize it to /admin/<default>
    // so refresh-on-default still produces a clean URL.
    const currentTab = tabFromPath(window.location.pathname);
    const expected = pathFromTab(currentTab);
    if (window.location.pathname !== expected) {
      window.history.replaceState(null, '', expected);
    }

    const onPop = () => setTabState(tabFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setTab = useCallback((next: Tab) => {
    if (next === tab) return;
    window.history.pushState(null, '', pathFromTab(next));
    setTabState(next);
  }, [tab]);

  return [tab, setTab];
};
