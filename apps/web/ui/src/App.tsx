import { useEffect, useState } from 'react';
import {
  loadConnection,
  loadGatewayUrl,
  saveConnection,
  clearConnection,
  setConnection,
  setGateway,
  initJwt,
  exchangeToken,
  getDisplayName,
  listMyAgents,
  type Connection,
} from './api';
import { PickAgentScreen } from './components/PickAgentScreen';
import { SetupScreen } from './components/SetupScreen';
import { ChatShell } from './components/ChatShell';

type Screen = 'loading' | 'setup' | 'pick-agent' | 'chat';

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [connection, setConn] = useState<Connection | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState<string>('');

  useEffect(() => {
    initJwt();

    // Need both display name AND a remembered gateway URL to skip setup.
    const displayName = getDisplayName();
    const savedGateway = loadGatewayUrl();
    if (!displayName || !savedGateway) {
      setScreen('setup');
      return;
    }
    setGateway(savedGateway);
    setGatewayUrl(savedGateway);

    // Try to refresh the JWT silently. If the device key is still valid
    // for this gateway we go straight to agent picker / last chat.
    (async () => {
      try {
        await exchangeToken(displayName);
      } catch {
        setScreen('setup');
        return;
      }

      const saved = loadConnection();
      if (saved?.agentId) {
        // Refresh role from server — it may have changed since last visit.
        let role = saved.role;
        try {
          const memberships = await listMyAgents();
          const m = memberships.find((x) => x.agentId === saved.agentId);
          if (!m) {
            setScreen('pick-agent');
            return;
          }
          role = m.role;
        } catch {
          // fall through with stored role
        }
        const fresh: Connection = { ...saved, ...(role ? { role } : {}) };
        setConn(fresh);
        setConnection(fresh);
        saveConnection(fresh);
        setScreen('chat');
      } else {
        setScreen('pick-agent');
      }
    })();
  }, []);

  const handleSetupComplete = (): void => {
    const url = loadGatewayUrl();
    if (url) setGatewayUrl(url);
    setScreen('pick-agent');
  };

  const handlePickAgent = async (conn: Connection): Promise<void> => {
    setConnection(conn);
    saveConnection(conn);
    setConn(conn);
    setScreen('chat');
  };

  const handleDisconnect = (): void => {
    clearConnection();
    setConn(null);
    setScreen('pick-agent');
  };

  const handleSignOut = (): void => {
    clearConnection();
    localStorage.removeItem('openhermit_jwt');
    localStorage.removeItem('openhermit_gateway_url');
    setConn(null);
    setScreen('setup');
  };

  if (screen === 'loading') return null;

  if (screen === 'setup') {
    return <SetupScreen onComplete={handleSetupComplete} />;
  }

  if (screen === 'pick-agent') {
    return (
      <PickAgentScreen
        gatewayUrl={gatewayUrl}
        onPick={handlePickAgent}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <ChatShell
      connection={connection!}
      role={connection?.role ?? null}
      onDisconnect={handleDisconnect}
    />
  );
}
