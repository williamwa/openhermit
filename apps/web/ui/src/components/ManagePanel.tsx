import { SkillsPanel } from './SkillsPanel';
import { McpPanel } from './McpPanel';
import { SchedulesPanel } from './SchedulesPanel';

export type ManageTab = 'skills' | 'mcp' | 'schedules';

const tabs: { id: ManageTab; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'schedules', label: 'Schedules' },
];

interface Props {
  tab: ManageTab;
  onTabChange: (tab: ManageTab) => void;
}

export function ManagePanel({ tab, onTabChange }: Props) {
  return (
    <div className="manage">
      <div className="manage__tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`manage__tab${tab === t.id ? ' active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="manage__content">
        {tab === 'skills' && <SkillsPanel />}
        {tab === 'mcp' && <McpPanel />}
        {tab === 'schedules' && <SchedulesPanel />}
      </div>
    </div>
  );
}
