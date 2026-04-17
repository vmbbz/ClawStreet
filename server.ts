import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodeFunctionData, parseUnits } from 'viem';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { spawn } from 'child_process';

// ─── Faucet rate-limit (in-memory) ────────────────────────────────────────────
// Maps lowercase address → timestamp of last claim
const faucetClaims = new Map<string, number>();
const FAUCET_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CTP Cycle state ──────────────────────────────────────────────────────────

const STATUS_FILE  = path.join(__dirname, 'logs/status.json');
const LATEST_FILE  = path.join(__dirname, 'logs/latest.json');
const REPORTS_DIR  = path.join(__dirname, 'logs/reports');

function readStatusFile() {
  try {
    if (existsSync(STATUS_FILE)) return JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
  } catch {}
  return { state: 'idle', cycleId: null, scenario: null, openDeals: [], transactions: [], nextScheduledAt: null, ethBudget: {} };
}

function listReports() {
  try {
    if (!existsSync(REPORTS_DIR)) return [];
    return readdirSync(REPORTS_DIR)
      .filter(f => f.startsWith('cycle-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 50);
  } catch { return []; }
}

function readReport(filename: string) {
  try {
    const p = path.join(REPORTS_DIR, filename);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {}
  return null;
}

// Optional in-process scheduler triggered by CYCLE_INTERVAL_SECONDS env var
// The runner is designed to be a separate process (npm run runner), but this
// allows 'npm run dev' alone to auto-cycle if the env var is set.
let cycleRunning = false;

function triggerCycle(): { started: boolean; reason?: string } {
  if (cycleRunning) return { started: false, reason: 'cycle already running' };
  cycleRunning = true;

  const openWin = process.env.CYCLE_OPEN_WINDOW_SECONDS ?? '1800'; // 30 min default — gives humans time to participate
  try {
    const child = spawn('npx', ['tsx', 'scripts/agent-runner.ts', '--once', '--open-window', openWin], {
      // ignore stdin so the child doesn't accidentally block on input;
      // inherit stdout/stderr so runner logs appear in the dev console
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: true,
    });

    child.on('error', (err) => {
      console.error('[CTP] Failed to start runner:', err.message);
      cycleRunning = false;
    });

    child.on('close', (code) => {
      console.log(`[CTP] Cycle finished (exit code ${code ?? 'unknown'})`);
      cycleRunning = false;
    });

    return { started: true };
  } catch (err) {
    cycleRunning = false;
    throw err;
  }
}

// Auto-scheduler
const CYCLE_INTERVAL = Number(process.env.CYCLE_INTERVAL_SECONDS ?? 0);
if (CYCLE_INTERVAL > 0) {
  console.log(`[CTP] Auto-cycle every ${CYCLE_INTERVAL}s (set CYCLE_INTERVAL_SECONDS=0 to disable)`);
  setTimeout(() => {
    try { triggerCycle(); } catch (e) { console.error('[CTP] Auto-cycle error:', e); }
    setInterval(() => {
      try { triggerCycle(); } catch (e) { console.error('[CTP] Auto-cycle error:', e); }
    }, CYCLE_INTERVAL * 1000);
  }, 5000); // 5s delay on startup
}

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

  // ─── CTP Cycle API ────────────────────────────────────────────────────────

  // GET /api/cycle/status — current runner state (reads logs/status.json)
  app.get('/api/cycle/status', (_req, res) => {
    res.json(readStatusFile());
  });

  // POST /api/cycle/trigger — kick off one cycle (non-blocking, returns immediately)
  app.post('/api/cycle/trigger', (_req, res) => {
    try {
      const result = triggerCycle();
      if (result.started) {
        res.status(202).json({ success: true, message: 'Cycle started' });
      } else {
        res.status(409).json({ success: false, message: result.reason });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: String(e) });
    }
  });

  // GET /api/cycle/reports — list of cycle report metadata (newest first, max 50)
  app.get('/api/cycle/reports', (_req, res) => {
    const files = listReports();
    const reports = files.map(filename => {
      const r = readReport(filename);
      if (!r) return null;
      return {
        filename,
        cycleId:               r.cycleId,
        scenario:              r.scenario,
        status:                r.status,
        durationSeconds:       r.durationSeconds,
        txCount:               r.transactions?.length ?? 0,
        dealCount:             r.deals?.length ?? 0,
        organicParticipants:   r.organicParticipants,
        automatedParticipants: r.automatedParticipants,
        totalEthSpent:         r.totalEthSpent,
        usdcVolume:            r.usdcVolume,
        nextScheduledAt:       r.nextScheduledAt,
      };
    }).filter(Boolean);
    res.json(reports);
  });

  // GET /api/cycle/reports/latest — most recent full report
  app.get('/api/cycle/reports/latest', (_req, res) => {
    try {
      if (existsSync(LATEST_FILE)) {
        return res.json(JSON.parse(readFileSync(LATEST_FILE, 'utf-8')));
      }
    } catch {}
    res.status(404).json({ error: 'No reports yet' });
  });

  // GET /api/cycle/reports/:filename — specific report by filename
  app.get('/api/cycle/reports/:filename', (req, res) => {
    const r = readReport(req.params.filename);
    if (r) return res.json(r);
    res.status(404).json({ error: 'Report not found' });
  });

  // ─── Faucet API ───────────────────────────────────────────────────────────

  // POST /api/faucet/usdc — mint 1000 MockUSDC to requesting address (rate-limited)
  app.post('/api/faucet/usdc', (req, res) => {
    const { address } = req.body as { address?: string };
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ success: false, error: 'Invalid address' });
    }
    const key = address.toLowerCase();
    const lastClaim = faucetClaims.get(key) ?? 0;
    const now = Date.now();
    const cooldownRemaining = FAUCET_COOLDOWN_MS - (now - lastClaim);
    if (cooldownRemaining > 0) {
      const minutesLeft = Math.ceil(cooldownRemaining / 60000);
      return res.status(429).json({ success: false, error: `Rate limited — try again in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}` });
    }

    faucetClaims.set(key, now);

    const child = spawn('npx', ['tsx', 'scripts/faucet.ts', '--to', address], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });

    child.on('close', (code) => {
      try {
        const result = JSON.parse(output.trim().split('\n').pop() ?? '{}');
        if (result.success) {
          res.status(202).json(result);
        } else {
          faucetClaims.delete(key); // refund rate limit on failure
          res.status(500).json({ success: false, error: result.error ?? 'Mint failed' });
        }
      } catch {
        faucetClaims.delete(key);
        res.status(500).json({ success: false, error: `Faucet script error (exit ${code})` });
      }
    });

    child.on('error', (err) => {
      faucetClaims.delete(key);
      res.status(500).json({ success: false, error: err.message });
    });
  });

  // ─── Agent API Routes ──────────────────────────────────────────────────────

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
