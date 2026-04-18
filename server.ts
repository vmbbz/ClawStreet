import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodeFunctionData, parseUnits } from 'viem';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import {
  verifyAndRegister, verifyAndDeregister, listAgents, getAgent, registerInternalAgent,
} from './scripts/lib/agent-registry.js';
import {
  submitOffer, respondToOffer, getOffersForDeal, getOffersForAddress,
} from './scripts/lib/negotiation-store.js';
import { notifyAgent } from './scripts/lib/contact-notifier.js';
import { getAddressStats } from './scripts/lib/stats-calculator.js';
import {
  relayDeal, autoExecuteAcceptedOffer, isInternalAgent, buildRelayIntentMessage,
} from './scripts/lib/deal-relay.js';

// ─── Rate limits (in-memory) ──────────────────────────────────────────────────
// Maps lowercase address → timestamp of last claim
const faucetClaims    = new Map<string, number>();
const FAUCET_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Maps lowercase address → { count, windowStart }
const announceCounts  = new Map<string, { count: number; windowStart: number }>();
const negotiateCounts = new Map<string, { count: number; windowStart: number }>();
const relayCounts     = new Map<string, { count: number; windowStart: number }>();
const ANNOUNCE_LIMIT  = 5;   // max 5 announces per address per 10 minutes
const NEGOTIATE_LIMIT = 10;  // max 10 offers per address per 10 minutes
const RELAY_LIMIT     = 3;   // max 3 relay txs per address per hour
const RATE_WINDOW_MS  = 10 * 60 * 1000; // 10-minute sliding window
const RELAY_WINDOW_MS = 60 * 60 * 1000; // 1-hour window for relay

function checkRateLimit(
  map: Map<string, { count: number; windowStart: number }>,
  key: string,
  limit: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now  = Date.now();
  const rec  = map.get(key);
  if (!rec || now - rec.windowStart > RATE_WINDOW_MS) {
    map.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (rec.count >= limit) {
    const retryAfterSeconds = Math.ceil((RATE_WINDOW_MS - (now - rec.windowStart)) / 1000);
    return { allowed: false, retryAfterSeconds };
  }
  rec.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

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
  LOAN_ENGINE: '0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c',
  CALL_VAULT:  '0x69730728a0B19b844bc18888d2317987Bc528baE',
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

  // ─── Gas Relay API ────────────────────────────────────────────────────────

  // POST /api/agents/deals/relay — broadcast a deal tx on behalf of an external agent
  // The agent signs an EIP-191 intent; the server relayer wallet pays gas.
  app.post('/api/agents/deals/relay', async (req, res) => {
    const { from, type, params, timestamp, signature } = req.body ?? {};
    if (!from || !type || !params || !timestamp || !signature) {
      return res.status(400).json({ success: false, error: 'Missing required fields: from, type, params, timestamp, signature' });
    }
    const validTypes = ['buy_option', 'accept_loan', 'covered_call', 'loan_offer'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ success: false, error: `type must be one of: ${validTypes.join(', ')}` });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
      return res.status(400).json({ success: false, error: 'Invalid from address' });
    }
    // Rate limit: 3 relay requests per address per hour
    const rl = checkRateLimit(relayCounts, (from as string).toLowerCase(), RELAY_LIMIT);
    if (!rl.allowed) {
      return res.status(429).json({ success: false, error: `Rate limited — try again in ${rl.retryAfterSeconds}s` });
    }

    try {
      const result = await relayDeal({ from, type, params, timestamp: Number(timestamp), signature });
      if (!result.success) return res.status(400).json(result);
      console.log(`[relay] ${type} for ${from} → tx ${result.txHash} deal #${result.dealId}`);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: String(e) });
    }
  });

  // GET /api/agents/deals/relay/intent — helper: returns the canonical message to sign
  app.get('/api/agents/deals/relay/intent', (req, res) => {
    const { type, params, timestamp } = req.query as Record<string, string>;
    if (!type || !params || !timestamp) {
      return res.status(400).json({ error: 'Query params required: type, params (JSON), timestamp' });
    }
    try {
      const parsed = JSON.parse(params);
      const message = buildRelayIntentMessage({ type, params: parsed, timestamp: Number(timestamp) });
      res.json({ message });
    } catch {
      res.status(400).json({ error: 'params must be valid JSON' });
    }
  });

  // ─── Bootstrap internal dev agents in registry ──────────────────────────
  // These are always present — no signature needed, never expire.

  const DEV_AGENTS = [
    { address: '0xD1E84c88734013613230678B8E000dE53e4957dC', name: 'LiquidityAgent_Alpha',  role: 'Market Maker'   },
    { address: '0xBaf9d5E05d82bEA9B971B54AD148904ae25876b2', name: 'ArbitrageAgent_Beta',   role: 'Arbitrageur'    },
    { address: '0x37D57004FdeBd029d9fcB1Cc88e275fEafA89353', name: 'LendingAgent_Gamma',    role: 'Lender'         },
    { address: '0x5159345B9944Ab14D05c18853923070D3EBF60ad', name: 'BorrowerAgent_Delta',   role: 'Borrower'       },
    { address: '0x4EED792404bbC7bC98648EbE653E38995B8e3DfB', name: 'HedgeAgent_Epsilon',    role: 'Options Writer' },
  ];
  for (const a of DEV_AGENTS) registerInternalAgent(a);

  // ─── Agent Registry API ───────────────────────────────────────────────────

  // GET /api/agents — list all announced agents (internal + external)
  app.get('/api/agents', (_req, res) => {
    res.json(listAgents());
  });

  // GET /api/agents/:address — single agent entry
  app.get('/api/agents/:address', (req, res) => {
    const entry = getAgent(req.params.address);
    if (entry) return res.json(entry);
    res.status(404).json({ error: 'Agent not found' });
  });

  // GET /api/agents/:address/stats — on-chain performance stats (cached 60s)
  app.get('/api/agents/:address/stats', async (req, res) => {
    const { address } = req.params;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }
    try {
      const stats = await getAddressStats(address);
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/agents/announce — register or update (signed EIP-191 message)
  app.post('/api/agents/announce', async (req, res) => {
    const { address, name, contact, role, participantType, timestamp, signature } = req.body ?? {};
    if (!address || !name || !role || !participantType || !timestamp || !signature) {
      return res.status(400).json({ success: false, error: 'Missing required fields: address, name, role, participantType, timestamp, signature' });
    }
    const rl = checkRateLimit(announceCounts, (address as string).toLowerCase(), ANNOUNCE_LIMIT);
    if (!rl.allowed) {
      return res.status(429).json({ success: false, error: `Rate limited — try again in ${rl.retryAfterSeconds}s` });
    }
    const result = await verifyAndRegister({ address, name, contact: contact ?? '', role, participantType, timestamp, signature });
    if (result.success) return res.json({ success: true, entry: getAgent(address) });
    res.status(400).json(result);
  });

  // DELETE /api/agents/announce — sign out (signed EIP-191 message)
  app.delete('/api/agents/announce', async (req, res) => {
    const { address, timestamp, signature } = req.body ?? {};
    if (!address || !timestamp || !signature) {
      return res.status(400).json({ success: false, error: 'Missing required fields: address, timestamp, signature' });
    }
    const result = await verifyAndDeregister({ address, timestamp, signature });
    if (result.success) return res.json({ success: true });
    res.status(400).json(result);
  });

  // ─── Negotiation / Bargaining API ─────────────────────────────────────────

  // GET /api/negotiate/deals/:type/:id — all offers on a specific deal
  app.get('/api/negotiate/deals/:type/:id', (req, res) => {
    const { type, id } = req.params;
    if (type !== 'loan' && type !== 'option') {
      return res.status(400).json({ error: 'type must be loan or option' });
    }
    const dealId = Number(id);
    if (isNaN(dealId)) return res.status(400).json({ error: 'Invalid deal id' });
    res.json(getOffersForDeal(type, dealId));
  });

  // GET /api/negotiate/my?address=0x... — all offers for an address
  app.get('/api/negotiate/my', (req, res) => {
    const { address } = req.query as { address?: string };
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Invalid or missing address query param' });
    }
    res.json(getOffersForAddress(address));
  });

  // POST /api/negotiate/offer — propose new terms on a deal
  app.post('/api/negotiate/offer', async (req, res) => {
    const { from, to, dealType, dealId, proposedTerms, timestamp, signature } = req.body ?? {};
    if (!from || !to || !dealType || dealId === undefined || !proposedTerms || !timestamp || !signature) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const rl = checkRateLimit(negotiateCounts, (from as string).toLowerCase(), NEGOTIATE_LIMIT);
    if (!rl.allowed) {
      return res.status(429).json({ success: false, error: `Rate limited — try again in ${rl.retryAfterSeconds}s` });
    }
    const result = await submitOffer({ from, to, dealType, dealId: Number(dealId), proposedTerms, timestamp, signature });
    if (!result.success) return res.status(400).json(result);

    // Notify the deal owner if they have a contact URL
    const ownerEntry = getAgent(to);
    if (ownerEntry?.contact) {
      notifyAgent(ownerEntry.contact, {
        type: 'negotiation_offer',
        offerId: result.offerId!,
        dealType,
        dealId: Number(dealId),
        from,
        proposedTerms,
        message: proposedTerms.message,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }

    res.json(result);
  });

  // POST /api/negotiate/respond — accept / decline / counter
  app.post('/api/negotiate/respond', async (req, res) => {
    const { respondingAddress, offerId, response, counterTerms, timestamp, signature } = req.body ?? {};
    if (!respondingAddress || !offerId || !response || !timestamp || !signature) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!['accept', 'decline', 'counter'].includes(response)) {
      return res.status(400).json({ success: false, error: 'response must be accept, decline, or counter' });
    }
    const result = await respondToOffer({ respondingAddress, offerId, response, counterTerms, timestamp, signature });
    if (!result.success) return res.status(400).json(result);

    // Find the original offer for notifications + auto-execute
    const offers = getOffersForAddress(respondingAddress);
    const originalOffer = offers.find(o => o.id === offerId);

    // ── Layer 3: Auto-execute on acceptance by an internal agent ──────────────
    let autoExecResult: { newDealId?: number; txHash?: string } | null = null;
    if (response === 'accept' && originalOffer && isInternalAgent(respondingAddress)) {
      autoExecuteAcceptedOffer({
        acceptingAgentAddress: respondingAddress,
        dealType: originalOffer.dealType,
        agreedTerms: originalOffer.proposedTerms as any,
      }).then(execResult => {
        if (execResult.success && originalOffer) {
          autoExecResult = execResult;
          // Notify proposer with the new deal ID so they can fill it
          const proposerEntry = getAgent(originalOffer.from);
          if (proposerEntry?.contact) {
            notifyAgent(proposerEntry.contact, {
              type: 'offer_accepted',
              offerId,
              dealType: originalOffer.dealType,
              dealId: execResult.newDealId ?? originalOffer.dealId,
              from: respondingAddress,
              proposedTerms: { ...originalOffer.proposedTerms, newDealId: execResult.newDealId },
              timestamp: Math.floor(Date.now() / 1000),
            });
          }
          console.log(`[auto-exec] ${originalOffer.dealType} #${execResult.newDealId} created after offer ${offerId} accepted`);
        } else {
          console.warn(`[auto-exec] Failed for offer ${offerId}:`, execResult.error);
          // Fall through — still notify proposer of acceptance even without auto-exec
          const proposerEntry = getAgent(originalOffer!.from);
          if (proposerEntry?.contact) {
            notifyAgent(proposerEntry.contact, {
              type: 'offer_accepted',
              offerId,
              dealType: originalOffer!.dealType,
              dealId: originalOffer!.dealId,
              from: respondingAddress,
              proposedTerms: originalOffer!.proposedTerms,
              timestamp: Math.floor(Date.now() / 1000),
            });
          }
        }
      }).catch(e => console.error('[auto-exec] Error:', e));
    } else if (originalOffer) {
      // Non-accept or external agent responding — standard webhook notification
      const proposerEntry = getAgent(originalOffer.from);
      if (proposerEntry?.contact) {
        const notifyType = response === 'accept' ? 'offer_accepted'
          : response === 'decline' ? 'offer_declined'
          : 'offer_countered';
        notifyAgent(proposerEntry.contact, {
          type: notifyType,
          offerId,
          dealType: originalOffer.dealType,
          dealId: originalOffer.dealId,
          from: respondingAddress,
          proposedTerms: counterTerms,
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
    }

    res.json(result);
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
