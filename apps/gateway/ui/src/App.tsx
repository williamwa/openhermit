import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import { AuthScreen } from './components/AuthScreen';
import { Topbar } from './components/Topbar';
import { AgentsPanel } from './components/AgentsPanel';
import { SkillsPanel } from './components/SkillsPanel';
import { McpServersPanel } from './components/McpServersPanel';
import { SchedulesPanel } from './components/SchedulesPanel';
import { StatsPanel } from './components/StatsPanel';
import { LogsPanel } from './components/LogsPanel';

type Tab = 'agents' | 'skills' | 'mcp-servers' | 'schedules' | 'stats' | 'logs';

export function App() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>('agents');

  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    api('/api/admin/stats')
      .then(() => setAuthed(true))
      .catch(() => setToken(''))
      .finally(() => setChecking(false));
  }, []);

  const handleSignIn = async (t: string) => {
    setToken(t);
    await api('/api/admin/stats');
    setAuthed(true);
  };

  const handleSignOut = () => {
    setToken('');
    setAuthed(false);
  };

  if (checking) return null;

  if (!authed) {
    return <AuthScreen onSignIn={handleSignIn} />;
  }

  return (
    <div className="shell">
      <Topbar tab={tab} onTabChange={setTab} onSignOut={handleSignOut} />
      {tab === 'agents' && <AgentsPanel />}
      {tab === 'skills' && <SkillsPanel />}
      {tab === 'mcp-servers' && <McpServersPanel />}
      {tab === 'schedules' && <SchedulesPanel />}
      {tab === 'stats' && <StatsPanel />}
      {tab === 'logs' && <LogsPanel />}
    </div>
  );
}
