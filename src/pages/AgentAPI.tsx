import { useState } from 'react';
import { Terminal, Code, Key, Shield, Zap, BookOpen, ChevronRight, Copy, CheckCircle2, ShieldCheck } from 'lucide-react';

type Endpoint = {
  id: string;
  method: string;
  path: string;
  title: string;
  description: string;
  params: { name: string; type: string; required: boolean; desc: string }[];
  reqExample: string;
  resExample: string;
};

const ENDPOINTS: Endpoint[] = [
  {
    id: 'create-loan',
    method: 'POST',
    path: '/api/skills/createLoanOffer',
    title: 'Create Loan Offer',
    description: 'Encodes a transaction for an agent to create a new P2P NFT loan offer. The agent must sign and broadcast the returned transaction data.',
    params: [
      { name: 'nftContract', type: 'string', required: true, desc: 'Address of the NFT contract to use as collateral.' },
      { name: 'nftId', type: 'string', required: true, desc: 'Token ID of the NFT.' },
      { name: 'principal', type: 'number', required: true, desc: 'Amount of USDC requested.' },
      { name: 'interest', type: 'number', required: true, desc: 'Total interest to be paid in USDC.' },
      { name: 'durationDays', type: 'number', required: true, desc: 'Duration of the loan in days.' }
    ],
    reqExample: `{
  "nftContract": "0x1234567890abcdef1234567890abcdef12345678",
  "nftId": "42",
  "principal": 1000,
  "interest": 50,
  "durationDays": 30
}`,
    resExample: `{
  "success": true,
  "transaction": {
    "to": "0x1111111111111111111111111111111111111111",
    "data": "0x8a9b...",
    "value": "0"
  }
}`
  },
  {
    id: 'hedge-call',
    method: 'POST',
    path: '/api/skills/hedgeCall',
    title: 'Write Covered Call',
    description: 'Encodes a transaction to write a covered call option. The agent locks the underlying asset in the vault and sets the strike price and premium.',
    params: [
      { name: 'underlying', type: 'string', required: true, desc: 'Address of the underlying ERC-20 token.' },
      { name: 'amount', type: 'string', required: true, desc: 'Amount of underlying tokens to lock.' },
      { name: 'strike', type: 'number', required: true, desc: 'Strike price in USDC.' },
      { name: 'expiryDays', type: 'number', required: true, desc: 'Days until the option expires.' },
      { name: 'premium', type: 'number', required: true, desc: 'Cost of the option premium in USDC.' }
    ],
    reqExample: `{
  "underlying": "0x4200000000000000000000000000000000000006",
  "amount": "1.5",
  "strike": 3800,
  "expiryDays": 7,
  "premium": 150
}`,
    resExample: `{
  "success": true,
  "transaction": {
    "to": "0x2222222222222222222222222222222222222222",
    "data": "0xabcdef...",
    "value": "0"
  }
}`
  },
  {
    id: 'discover',
    method: 'GET',
    path: '/api/skills/discoverOpportunity',
    title: 'Discover Opportunities',
    description: 'Queries the ClawStreet subgraph to find profitable loan funding or option buying opportunities based on the agent\'s risk profile.',
    params: [
      { name: 'type', type: 'string', required: true, desc: '"loan" or "option"' },
      { name: 'minYield', type: 'number', required: false, desc: 'Minimum acceptable APY/Yield.' }
    ],
    reqExample: `// GET /api/skills/discoverOpportunity?type=loan&minYield=10`,
    resExample: `{
  "success": true,
  "opportunities": [
    {
      "id": "12",
      "type": "loan",
      "principal": 500,
      "interest": 25,
      "healthScore": 85,
      "actionUrl": "/api/skills/acceptLoan?id=12"
    }
  ]
}`
  }
];

export default function AgentAPI() {
  const [activeTab, setActiveTab] = useState<string>('intro');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(text);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const activeEndpoint = ENDPOINTS.find(e => e.id === activeTab);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex flex-col md:flex-row gap-8">
      {/* Sidebar Navigation */}
      <div className="w-full md:w-64 shrink-0 space-y-6">
        <div>
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 px-3">Getting Started</h3>
          <ul className="space-y-1">
            <li>
              <button 
                onClick={() => setActiveTab('intro')}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'intro' ? 'bg-base-blue/10 text-base-blue' : 'text-gray-400 hover:text-white hover:bg-cyber-surface'}`}
              >
                <div className="flex items-center space-x-2">
                  <BookOpen size={16} />
                  <span>Introduction</span>
                </div>
              </button>
            </li>
            <li>
              <button 
                onClick={() => setActiveTab('auth')}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'auth' ? 'bg-base-blue/10 text-base-blue' : 'text-gray-400 hover:text-white hover:bg-cyber-surface'}`}
              >
                <div className="flex items-center space-x-2">
                  <Key size={16} />
                  <span>Authentication & Signing</span>
                </div>
              </button>
            </li>
            <li>
              <button 
                onClick={() => setActiveTab('reputation')}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'reputation' ? 'bg-base-blue/10 text-base-blue' : 'text-gray-400 hover:text-white hover:bg-cyber-surface'}`}
              >
                <div className="flex items-center space-x-2">
                  <ShieldCheck size={16} />
                  <span>Agent Reputation (x402)</span>
                </div>
              </button>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 px-3">Endpoints</h3>
          <ul className="space-y-1">
            {ENDPOINTS.map(endpoint => (
              <li key={endpoint.id}>
                <button 
                  onClick={() => setActiveTab(endpoint.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-between ${activeTab === endpoint.id ? 'bg-base-blue/10 text-base-blue' : 'text-gray-400 hover:text-white hover:bg-cyber-surface'}`}
                >
                  <span className="truncate">{endpoint.title}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${endpoint.method === 'POST' ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>
                    {endpoint.method}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0">
        {activeTab === 'intro' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div>
              <h1 className="text-4xl font-bold text-white mb-4">Agent API Documentation</h1>
              <p className="text-lg text-gray-400 leading-relaxed">
                ClawStreet is designed from the ground up for the AI economy. The Agent API allows autonomous AI agents (like OpenClaw) to interact with our DeFi protocols programmatically.
              </p>
            </div>
            
            <div className="grid sm:grid-cols-2 gap-4 mt-8">
              <div className="bg-cyber-surface p-6 rounded-xl border border-cyber-border">
                <Terminal className="text-base-blue mb-4" size={24} />
                <h3 className="text-white font-bold mb-2">Transaction Encoding</h3>
                <p className="text-sm text-gray-400">Endpoints do not execute transactions. They return ABI-encoded payloads for your agent to sign locally, ensuring private keys never leave your secure enclave.</p>
              </div>
              <div className="bg-cyber-surface p-6 rounded-xl border border-cyber-border">
                <Zap className="text-lobster-orange mb-4" size={24} />
                <h3 className="text-white font-bold mb-2">Real-Time Discovery</h3>
                <p className="text-sm text-gray-400">Agents can query the protocol to find arbitrage, yield, and hedging opportunities based on their specific risk parameters.</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'auth' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h1 className="text-3xl font-bold text-white mb-4">Authentication & Signing</h1>
            <p className="text-gray-400 mb-6">
              ClawStreet APIs are public for reading and encoding. However, to execute the returned transactions on the Base blockchain, your agent must possess a funded wallet and sign the transactions locally.
            </p>

            <div className="bg-cyber-surface border border-cyber-border rounded-xl overflow-hidden">
              <div className="bg-cyber-bg px-4 py-3 border-b border-cyber-border flex items-center space-x-2">
                <Shield size={16} className="text-gray-400" />
                <span className="text-sm font-medium text-gray-300">Recommended: Coinbase Developer Platform (CDP) SDK</span>
              </div>
              <div className="p-6 space-y-4">
                <p className="text-sm text-gray-400">
                  We recommend using the CDP SDK for secure, programmatic wallet management for your AI agents.
                </p>
                <div className="relative group">
                  <pre className="bg-black p-4 rounded-lg text-sm text-gray-300 overflow-x-auto font-mono">
{`import { Wallet } from "@coinbase/coinbase-sdk";

// 1. Fetch encoded transaction from ClawStreet
const response = await fetch('https://clawstreet.base/api/skills/createLoanOffer', { ... });
const { transaction } = await response.json();

// 2. Agent signs and broadcasts using its CDP Wallet
const agentWallet = await Wallet.fetch(AGENT_WALLET_ID);
const tx = await agentWallet.invokeContract({
  contractAddress: transaction.to,
  method: "createLoanOffer", // Or use raw data if supported
  args: {...} 
});

console.log("Transaction broadcasted:", tx.transactionHash);`}
                  </pre>
                  <button 
                    onClick={() => handleCopy('cdp-code')}
                    className="absolute top-3 right-3 p-2 bg-white/10 hover:bg-white/20 rounded-md text-gray-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
                  >
                    {copiedCode === 'cdp-code' ? <CheckCircle2 size={16} className="text-green-400" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'reputation' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h1 className="text-3xl font-bold text-white mb-4">Agent Reputation & x402</h1>
            <p className="text-gray-400 mb-6 leading-relaxed">
              ClawStreet integrates with the <strong>x402 standard</strong> (Payment Required for Agentic Commerce) to evaluate the on-chain creditworthiness of AI agents. An agent's transaction history, successful settlements, and default rates directly impact its borrowing power and liquidation thresholds.
            </p>

            <div className="grid sm:grid-cols-3 gap-4 mb-8">
              <div className="bg-cyber-surface p-5 rounded-xl border border-cyber-border">
                <div className="text-green-400 font-bold mb-1">Tier 1 (Score &gt; 800)</div>
                <div className="text-2xl font-bold text-white mb-2">1.10x</div>
                <p className="text-xs text-gray-500">Health Score Multiplier. Agents enjoy lower liquidation risk and can sustain higher LTVs.</p>
              </div>
              <div className="bg-cyber-surface p-5 rounded-xl border border-cyber-border">
                <div className="text-base-blue font-bold mb-1">Tier 2 (Score 500-800)</div>
                <div className="text-2xl font-bold text-white mb-2">1.00x</div>
                <p className="text-xs text-gray-500">Standard Health Score Multiplier. Normal liquidation parameters apply.</p>
              </div>
              <div className="bg-cyber-surface p-5 rounded-xl border border-cyber-border">
                <div className="text-red-400 font-bold mb-1">Tier 3 (Score &lt; 500)</div>
                <div className="text-2xl font-bold text-white mb-2">0.90x</div>
                <p className="text-xs text-gray-500">Penalty Multiplier. Unknown or risky agents face stricter liquidation thresholds.</p>
              </div>
            </div>

            <div className="bg-cyber-surface border border-cyber-border rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-3">How to Improve Your Agent's Score</h3>
              <ul className="list-disc list-inside space-y-2 text-sm text-gray-400">
                <li><strong>Consistent Repayment:</strong> Successfully repaying ClawStreet loans before expiry significantly boosts your on-chain credit profile.</li>
                <li><strong>x402 Ecosystem:</strong> Paying for API calls and services across the broader x402 ecosystem builds a verifiable history of reliability.</li>
                <li><strong>Avoid Defaults:</strong> Liquidations on ClawStreet or other integrated DeFi protocols will severely penalize your agent's score.</li>
              </ul>
            </div>
          </div>
        )}

        {activeEndpoint && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div>
              <div className="flex items-center space-x-3 mb-2">
                <span className={`text-xs font-bold px-2 py-1 rounded uppercase tracking-wider ${activeEndpoint.method === 'POST' ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>
                  {activeEndpoint.method}
                </span>
                <span className="font-mono text-gray-300">{activeEndpoint.path}</span>
              </div>
              <h1 className="text-3xl font-bold text-white mb-4">{activeEndpoint.title}</h1>
              <p className="text-gray-400">{activeEndpoint.description}</p>
            </div>

            <div className="grid xl:grid-cols-2 gap-8">
              {/* Parameters */}
              <div className="space-y-6">
                <h3 className="text-lg font-semibold text-white border-b border-cyber-border pb-2">Parameters</h3>
                <ul className="space-y-4">
                  {activeEndpoint.params.map((param, idx) => (
                    <li key={idx} className="bg-cyber-surface p-4 rounded-lg border border-cyber-border">
                      <div className="flex items-center space-x-2 mb-1">
                        <span className="font-mono text-sm text-base-blue font-bold">{param.name}</span>
                        <span className="text-xs text-gray-500">{param.type}</span>
                        {param.required && <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded uppercase font-bold">Required</span>}
                      </div>
                      <p className="text-sm text-gray-400">{param.desc}</p>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Code Examples */}
              <div className="space-y-6">
                <div className="bg-[#0d1117] rounded-xl border border-cyber-border overflow-hidden">
                  <div className="bg-white/5 px-4 py-2 border-b border-cyber-border flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-400">Request Example</span>
                    <button onClick={() => handleCopy(activeEndpoint.reqExample)} className="text-gray-500 hover:text-white">
                      {copiedCode === activeEndpoint.reqExample ? <CheckCircle2 size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                  <pre className="p-4 text-sm font-mono text-gray-300 overflow-x-auto">
                    {activeEndpoint.reqExample}
                  </pre>
                </div>

                <div className="bg-[#0d1117] rounded-xl border border-cyber-border overflow-hidden">
                  <div className="bg-white/5 px-4 py-2 border-b border-cyber-border flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-400">Response Example</span>
                    <button onClick={() => handleCopy(activeEndpoint.resExample)} className="text-gray-500 hover:text-white">
                      {copiedCode === activeEndpoint.resExample ? <CheckCircle2 size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                  <pre className="p-4 text-sm font-mono text-green-400 overflow-x-auto">
                    {activeEndpoint.resExample}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
