import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

import App from './App.tsx';
import './index.css';
import { initTheme } from './lib/theme';

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({
          accentColor: '#ff5a00',
          accentColorForeground: 'white',
          borderRadius: 'medium',
        })}>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
