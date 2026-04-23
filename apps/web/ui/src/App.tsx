import { useEffect, useState } from 'react';
import {
  loadConnection,
  saveConnection,
  clearConnection,
  setConnection,
  initJwt,
  exchangeToken,
  getDisplayName,
  type Connection,
} from './api';
import { ConnectScreen } from './components/ConnectScreen';
import { SetupScreen } from './components/SetupScreen';
import { ChatShell } from './components/ChatShell';

type Screen = 'loading' | 'setup' | 'connect' | 'chat';

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [connection, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const displayName = getDisplayName();
    if (!displayName) {
      setScreen('setup');
      return;
    }

    const saved = loadConnection();
    if (saved?.gatewayUrl && saved?.agentId) {
      setConn(saved);
      setConnection(saved);
      initJwt();

      (async () => {
        try {
          await exchangeToken(displayName);
          setScreen('chat');
        } catch {
          setScreen('connect');
        }
      })();
    } else {
      setScreen('connect');
    }
  }, []);

  const handleSetupComplete = () => {
    const saved = loadConnection();
    if (saved?.gatewayUrl && saved?.agentId) {
      setConn(saved);
      setConnection(saved);
      initJwt();

      (async () => {
        try {
          await exchangeToken(getDisplayName());
          setScreen('chat');
        } catch {
          setScreen('connect');
        }
      })();
    } else {
      setScreen('connect');
    }
  };

  const handleConnect = async (conn: Connection) => {
    setConnection(conn);
    initJwt();
    await exchangeToken(getDisplayName());
    saveConnection(conn);
    setConn(conn);
    setScreen('chat');
  };

  const handleDisconnect = () => {
    clearConnection();
    setConn(null);
    setScreen('connect');
  };

  if (screen === 'loading') return null;

  if (screen === 'setup') {
    return <SetupScreen onComplete={handleSetupComplete} />;
  }

  if (screen === 'connect') {
    const saved = loadConnection();
    return (
      <ConnectScreen
        defaultGatewayUrl={saved?.gatewayUrl || window.location.origin}
        defaultAgentId={saved?.agentId || 'one'}
        defaultToken={saved?.token || ''}
        error={error}
        onConnect={async (conn) => {
          setError('');
          try {
            await handleConnect(conn);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
    );
  }

  return (
    <ChatShell
      connection={connection!}
      onDisconnect={handleDisconnect}
    />
  );
}
