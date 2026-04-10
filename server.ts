import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodeFunctionData, parseUnits } from 'viem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal ABIs for encoding
const loanAbi = [{
  "inputs": [
    { "internalType": "address", "name": "nftContract", "type": "address" },
    { "internalType": "uint256", "name": "nftId", "type": "uint256" },
    { "internalType": "uint256", "name": "principal", "type": "uint256" },
    { "internalType": "uint256", "name": "interest", "type": "uint256" },
    { "internalType": "uint256", "name": "duration", "type": "uint256" }
  ],
  "name": "createLoanOffer",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
}];

const callVaultAbi = [{
  "inputs": [
    { "internalType": "address", "name": "underlying", "type": "address" },
    { "internalType": "uint256", "name": "amount",     "type": "uint256" },
    { "internalType": "uint256", "name": "strike",     "type": "uint256" },
    { "internalType": "uint256", "name": "expiry",     "type": "uint256" },
    { "internalType": "uint256", "name": "premium",    "type": "uint256" }
  ],
  "name": "writeCoveredCall",
  "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
  "stateMutability": "nonpayable",
  "type": "function"
}];

const CONTRACT_ADDRESSES = {
  LOAN_ENGINE: '0x1111111111111111111111111111111111111111',
  CALL_VAULT: '0x2222222222222222222222222222222222222222',
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Agent API Routes
  app.post('/api/skills/discoverOpportunity', (req, res) => {
    // In production, this would query a subgraph or on-chain state
    res.json({
      success: true,
      opportunities: [
        { type: 'loan', nftContract: '0x123...', nftId: '1', suggestedPrincipal: '1000 USDC', healthScore: 85 },
        { type: 'call', underlying: '0x456...', strike: '1.5', premium: '50 USDC' }
      ]
    });
  });

  app.post('/api/skills/createLoanOffer', (req, res) => {
    try {
      const { nftContract, nftId, principal, interest, durationDays } = req.body;
      
      const data = encodeFunctionData({
        abi: loanAbi,
        functionName: 'createLoanOffer',
        args: [
          nftContract as `0x${string}`,
          BigInt(nftId),
          parseUnits(principal.toString(), 6),
          parseUnits(interest.toString(), 6),
          BigInt(Number(durationDays) * 86400)
        ]
      });

      res.json({
        success: true,
        transaction: {
          to: CONTRACT_ADDRESSES.LOAN_ENGINE,
          data,
          value: '0'
        }
      });
    } catch (error) {
      res.status(400).json({ success: false, error: String(error) });
    }
  });

  app.post('/api/skills/hedgeCall', (req, res) => {
    try {
      const { underlying, amount, strike, expiryDays, premium } = req.body;

      const data = encodeFunctionData({
        abi: callVaultAbi,
        functionName: 'writeCoveredCall',
        args: [
          underlying as `0x${string}`,
          parseUnits(amount.toString(), 18),                                     // underlying amount (18 dec)
          parseUnits(strike.toString(), 6),                                      // strike in USDC (6 dec)
          BigInt(Math.floor(Date.now() / 1000) + Number(expiryDays) * 86400),   // expiry timestamp
          parseUnits(premium.toString(), 6)                                      // premium in USDC (6 dec)
        ]
      });

      res.json({
        success: true,
        transaction: {
          to: CONTRACT_ADDRESSES.CALL_VAULT,
          data,
          value: '0'
        }
      });
    } catch (error) {
      res.status(400).json({ success: false, error: String(error) });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
