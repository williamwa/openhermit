type Tab = 'agents' | 'skills' | 'mcp-servers' | 'schedules' | 'stats' | 'logs';

const tabs: { id: Tab; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp-servers', label: 'MCP' },
  { id: 'schedules', label: 'Schedules' },
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
  return (
    <nav className="topbar">
      <span className="topbar__brand">OpenHermit Gateway</span>
      <div className="topbar__tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <button className="btn btn--ghost btn--sm" onClick={onSignOut}>
        Sign Out
      </button>
    </nav>
  );
}
