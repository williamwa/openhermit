import { useEffect, useState } from 'react';
import type { Tab } from '../router';

const tabs: { id: Tab; label: string }[] = [
  { id: 'fleet', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp-servers', label: 'MCP' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'channels', label: 'Channels' },
  { id: 'containers', label: 'Containers' },
  { id: 'users', label: 'Users' },
  { id: 'stats', label: 'Stats' },
  { id: 'logs', label: 'Logs' },
];

export function Topbar({
  tab,
  onTabChange,
  onSignOut,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onSignOut: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.topbar')) setMenuOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [menuOpen]);

  const pickTab = (id: Tab) => {
    onTabChange(id);
    setMenuOpen(false);
  };

  return (
    <nav className="topbar">
      <a
        className="topbar__brand"
        href="/admin/fleet"
        aria-label="OpenHermit"
        onClick={(e) => {
          e.preventDefault();
          pickTab('fleet');
        }}
      >
        <img className="topbar__logo" src="/admin/logo.svg" alt="" width="22" height="22" />
        <span className="topbar__brand-text">openhermit</span>
      </a>

      <button
        className="topbar__hamburger"
        aria-label="Toggle menu"
        aria-expanded={menuOpen}
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
      >
        <span /><span /><span />
      </button>

      <div className={`topbar__tabs${menuOpen ? ' topbar__tabs--open' : ''}`}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => pickTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button className="btn btn--ghost btn--sm topbar__signout" onClick={() => { setMenuOpen(false); onSignOut(); }}>
          Sign Out
        </button>
      </div>

      <button className="btn btn--ghost btn--sm topbar__signout-desktop" onClick={onSignOut}>
        Sign Out
      </button>
    </nav>
  );
}
