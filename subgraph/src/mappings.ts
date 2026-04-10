import { BigInt, Bytes } from '@graphprotocol/graph-ts';

import {
  LoanCreated,
  LoanAccepted,
  LoanRepaid,
  LoanDefaulted,
  LoanCancelled,
  FeeCollected,
} from '../../generated/ClawStreetLoan/ClawStreetLoan';

import {
  OptionWritten,
  OptionBought,
  OptionExercised,
  OptionCancelled,
  UnderlyingReclaimed,
} from '../../generated/ClawStreetCallVault/ClawStreetCallVault';

import {
  BundleDeposited,
  BundleWithdrawn,
} from '../../generated/ClawStreetBundleVault/ClawStreetBundleVault';

import {
  Staked,
  Unstaked,
  RevenueClaimed,
} from '../../generated/ClawStreetStaking/ClawStreetStaking';

import {
  Loan,
  Option,
  Bundle,
  StakePosition,
  ProtocolStats,
} from '../../generated/schema';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreateProtocolStats(timestamp: BigInt): ProtocolStats {
  let stats = ProtocolStats.load('global');
  if (!stats) {
    stats = new ProtocolStats('global');
    stats.totalLoansCreated  = BigInt.fromI32(0);
    stats.totalLoansActive   = BigInt.fromI32(0);
    stats.totalVolumeUSDC    = BigInt.fromI32(0);
    stats.totalOptionsWritten = BigInt.fromI32(0);
    stats.totalOptionsActive = BigInt.fromI32(0);
    stats.totalStaked        = BigInt.fromI32(0);
    stats.totalFeesCollected = BigInt.fromI32(0);
    stats.lastUpdatedAt      = timestamp;
  }
  return stats;
}

// ─── ClawStreetLoan handlers ──────────────────────────────────────────────────

export function handleLoanCreated(event: LoanCreated): void {
  const id = event.params.loanId.toString();

  let loan = new Loan(id);
  loan.loanId          = event.params.loanId;
  loan.borrower        = event.params.borrower;
  loan.lender          = null;
  loan.nftContract     = Bytes.fromHexString('0x0000000000000000000000000000000000000000');
  loan.nftId           = BigInt.fromI32(0);
  loan.principal       = event.params.principal;
  loan.interest        = BigInt.fromI32(0);
  loan.duration        = BigInt.fromI32(0);
  loan.startTime       = null;
  loan.healthSnapshot  = event.params.health;
  loan.active          = true;
  loan.repaid          = false;
  loan.status          = 'OPEN';
  loan.createdAt       = event.block.timestamp;
  loan.createdAtBlock  = event.block.number;
  loan.acceptedAt      = null;
  loan.closedAt        = null;
  loan.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  stats.totalLoansCreated  = stats.totalLoansCreated.plus(BigInt.fromI32(1));
  stats.totalVolumeUSDC    = stats.totalVolumeUSDC.plus(event.params.principal);
  stats.lastUpdatedAt      = event.block.timestamp;
  stats.save();
}

export function handleLoanAccepted(event: LoanAccepted): void {
  const id = event.params.loanId.toString();
  let loan = Loan.load(id);
  if (!loan) return;

  loan.lender     = event.params.lender;
  loan.startTime  = event.block.timestamp;
  loan.status     = 'ACTIVE';
  loan.acceptedAt = event.block.timestamp;
  loan.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  stats.totalLoansActive = stats.totalLoansActive.plus(BigInt.fromI32(1));
  stats.lastUpdatedAt    = event.block.timestamp;
  stats.save();
}

export function handleLoanRepaid(event: LoanRepaid): void {
  const id = event.params.loanId.toString();
  let loan = Loan.load(id);
  if (!loan) return;

  loan.active   = false;
  loan.repaid   = true;
  loan.status   = 'REPAID';
  loan.closedAt = event.block.timestamp;
  loan.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  if (stats.totalLoansActive.gt(BigInt.fromI32(0))) {
    stats.totalLoansActive = stats.totalLoansActive.minus(BigInt.fromI32(1));
  }
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

export function handleLoanDefaulted(event: LoanDefaulted): void {
  const id = event.params.loanId.toString();
  let loan = Loan.load(id);
  if (!loan) return;

  loan.active   = false;
  loan.status   = 'DEFAULTED';
  loan.closedAt = event.block.timestamp;
  loan.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  if (stats.totalLoansActive.gt(BigInt.fromI32(0))) {
    stats.totalLoansActive = stats.totalLoansActive.minus(BigInt.fromI32(1));
  }
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

export function handleLoanCancelled(event: LoanCancelled): void {
  const id = event.params.loanId.toString();
  let loan = Loan.load(id);
  if (!loan) return;

  loan.active   = false;
  loan.status   = 'CANCELLED';
  loan.closedAt = event.block.timestamp;
  loan.save();
}

export function handleFeeCollected(event: FeeCollected): void {
  const stats = getOrCreateProtocolStats(event.block.timestamp);
  stats.totalFeesCollected = stats.totalFeesCollected.plus(event.params.amount);
  stats.lastUpdatedAt      = event.block.timestamp;
  stats.save();
}

// ─── ClawStreetCallVault handlers ─────────────────────────────────────────────

export function handleOptionWritten(event: OptionWritten): void {
  const id = event.params.optionId.toString();

  let opt = new Option(id);
  opt.optionId       = event.params.optionId;
  opt.writer         = event.params.writer;
  opt.buyer          = null;
  opt.underlying     = Bytes.fromHexString('0x0000000000000000000000000000000000000000');
  opt.amount         = event.params.amount;
  opt.strike         = event.params.strike;
  opt.expiry         = BigInt.fromI32(0); // not in event; query contract if needed
  opt.premium        = event.params.premium;
  opt.exercised      = false;
  opt.active         = true;
  opt.status         = 'OPEN';
  opt.createdAt      = event.block.timestamp;
  opt.createdAtBlock = event.block.number;
  opt.boughtAt       = null;
  opt.closedAt       = null;
  opt.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  stats.totalOptionsWritten = stats.totalOptionsWritten.plus(BigInt.fromI32(1));
  stats.totalOptionsActive  = stats.totalOptionsActive.plus(BigInt.fromI32(1));
  stats.lastUpdatedAt       = event.block.timestamp;
  stats.save();
}

export function handleOptionBought(event: OptionBought): void {
  const id = event.params.optionId.toString();
  let opt = Option.load(id);
  if (!opt) return;

  opt.buyer    = event.params.buyer;
  opt.status   = 'SOLD';
  opt.boughtAt = event.block.timestamp;
  opt.save();
}

export function handleOptionExercised(event: OptionExercised): void {
  const id = event.params.optionId.toString();
  let opt = Option.load(id);
  if (!opt) return;

  opt.exercised = true;
  opt.active    = false;
  opt.status    = 'EXERCISED';
  opt.closedAt  = event.block.timestamp;
  opt.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  if (stats.totalOptionsActive.gt(BigInt.fromI32(0))) {
    stats.totalOptionsActive = stats.totalOptionsActive.minus(BigInt.fromI32(1));
  }
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

export function handleOptionCancelled(event: OptionCancelled): void {
  const id = event.params.optionId.toString();
  let opt = Option.load(id);
  if (!opt) return;

  opt.active   = false;
  opt.status   = 'CANCELLED';
  opt.closedAt = event.block.timestamp;
  opt.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  if (stats.totalOptionsActive.gt(BigInt.fromI32(0))) {
    stats.totalOptionsActive = stats.totalOptionsActive.minus(BigInt.fromI32(1));
  }
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

export function handleUnderlyingReclaimed(event: UnderlyingReclaimed): void {
  const id = event.params.optionId.toString();
  let opt = Option.load(id);
  if (!opt) return;

  opt.active   = false;
  opt.status   = 'EXPIRED';
  opt.closedAt = event.block.timestamp;
  opt.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  if (stats.totalOptionsActive.gt(BigInt.fromI32(0))) {
    stats.totalOptionsActive = stats.totalOptionsActive.minus(BigInt.fromI32(1));
  }
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

// ─── ClawStreetBundleVault handlers ───────────────────────────────────────────

export function handleBundleDeposited(event: BundleDeposited): void {
  const id = event.params.tokenId.toString();

  let bundle = new Bundle(id);
  bundle.tokenId        = event.params.tokenId;
  bundle.owner          = event.params.owner;
  bundle.active         = true;
  bundle.createdAt      = event.block.timestamp;
  bundle.createdAtBlock = event.block.number;
  bundle.withdrawnAt    = null;
  bundle.save();
}

export function handleBundleWithdrawn(event: BundleWithdrawn): void {
  const id = event.params.tokenId.toString();
  let bundle = Bundle.load(id);
  if (!bundle) return;

  bundle.active      = false;
  bundle.withdrawnAt = event.block.timestamp;
  bundle.save();
}

// ─── ClawStreetStaking handlers ───────────────────────────────────────────────

export function handleStaked(event: Staked): void {
  const id = event.params.staker.toHexString();

  let pos = StakePosition.load(id);
  if (!pos) {
    pos = new StakePosition(id);
    pos.staker              = event.params.staker;
    pos.staked              = BigInt.fromI32(0);
    pos.stakedAt            = event.block.timestamp;
    pos.passId              = null;
    pos.hasPass             = false;
    pos.totalRevenueClaimed = BigInt.fromI32(0);
    pos.lastUpdatedAt       = event.block.timestamp;
  }

  pos.staked          = pos.staked.plus(event.params.amount);
  pos.stakedAt        = event.block.timestamp; // lock restarted
  pos.lastUpdatedAt   = event.block.timestamp;
  pos.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  stats.totalStaked   = event.params.totalStaked; // direct from event
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

export function handleUnstaked(event: Unstaked): void {
  const id = event.params.staker.toHexString();
  let pos = StakePosition.load(id);
  if (!pos) return;

  pos.staked        = BigInt.fromI32(0);
  pos.hasPass       = false;
  pos.passId        = null;
  pos.lastUpdatedAt = event.block.timestamp;
  pos.save();

  const stats = getOrCreateProtocolStats(event.block.timestamp);
  if (stats.totalStaked.gt(event.params.amount)) {
    stats.totalStaked = stats.totalStaked.minus(event.params.amount);
  } else {
    stats.totalStaked = BigInt.fromI32(0);
  }
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

export function handleRevenueClaimed(event: RevenueClaimed): void {
  const id = event.params.staker.toHexString();
  let pos = StakePosition.load(id);
  if (!pos) return;

  pos.totalRevenueClaimed = pos.totalRevenueClaimed.plus(event.params.amount);
  pos.lastUpdatedAt       = event.block.timestamp;
  pos.save();
}
