import { StrictMode, useState, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

import App from './App.tsx';
import './index.css';
import { initTheme, getTheme } from './lib/theme';
import type { Theme } from './lib/theme';

// Apply persisted theme before first paint (avoids flash)
initTheme();

// Use env-var RPC URL if set (Alchemy/QuickNode recommended to avoid rate-limits).
// Add VITE_BASE_SEPOLIA_RPC= to .env with your key for reliable reads.
const SEPOLIA_RPC = import.meta.env.VITE_BASE_SEPOLIA_RPC || 'https://sepolia.base.org';

const config = createConfig({
  chains: [baseSepolia],
  transports: {
    [baseSepolia.id]: http(SEPOLIA_RPC),
  },
});

const queryClient = new QueryClient();

const RK_OPTIONS = { accentColor: '#ff5a00', accentColorForeground: 'white', borderRadius: 'medium' } as const;

// Reactive RainbowKit provider — switches between darkTheme/lightTheme on toggle
function ThemedRainbowKit({ children }: { children: ReactNode }) {
  const [appTheme, setAppTheme] = useState<Theme>(getTheme());
  useEffect(() => {
    const handler = (e: Event) => setAppTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener('cs-theme-change', handler);
    return () => window.removeEventListener('cs-theme-change', handler);
  }, []);
  const rkTheme = appTheme === 'light'
    ? lightTheme(RK_OPTIONS)
    : darkTheme(RK_OPTIONS);
  return <RainbowKitProvider theme={rkTheme}>{children}</RainbowKitProvider>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ThemedRainbowKit>
          <App />
        </ThemedRainbowKit>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
