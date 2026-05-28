import { SlotInfo, LeaderSchedule, BundleLifecycle, FailureCategory, BundleStatus, AIDecision } from '../types.js'
import { logger } from '../utils/logger.js'

const JITO_LEADERS = [
  'Dkg9oVtF8NLL9YQXmdQVu3GjgdE2YDTKk8CkA9G8kGqv',
  '66RwRMFdSJqnQBq5zKPMQBs6iQMJqoVVL4K7SUQWFMpT',
  '6yP62UGchU2bGsTGNVR7JzQE5GAPJLKxbPWfx4VUNS25',
  'Cy6TBrRxH3B6TJLwQ5HJPjBw7J9jKFLyXxQ7JHyQVyVx',
  'B1Z4BNLMnYiP5xntB3kHZKYtuXy7KjPmLjGZ7qKHFdfr',
]

const OTHER_LEADERS = [
  '7XmAYj3MdHWS2eM7LQaGY2G8Jy3eJqQULH7NkSVfHyzP',
  'F1Z7qKJ5xntB3kHZKYtuXy7KjPmLjGZ7qKHFdfrB1Z4',
  'A9G8kGqvDkg9oVtF8NLL9YQXmdQVu3GjgdE2YDTKk8Ck',
  'H3B6TJLwQ5HJPjBw7J9jKFLyXxQ7JHyQVyVxCy6TBrRx',
]

const FAUCET_WALLETS = [
  'B1Z4BNLMnYiP5xntB3kHZKYtuXy7KjPmLjGZ7qKHFdfr',
  '66RwRMFdSJqnQBq5zKPMQBs6iQMJqoVVL4K7SUQWFMpT',
  'F1Z7qKJ5xntB3kHZKYtuXy7KjPmLjGZ7qKHFdfrB1Z4',
]

export class SimulationEngine {
  private currentSlot = 0
  private running = false
  private listeners: ((info: SlotInfo) => void)[] = []
  private slotCounter = 0
  private baseTimestamp = Date.now()
  private leaderIndex = 0
  private failureScenario: 'none' | 'blockhash_expiry' | 'leader_skip' | 'tip_too_low' = 'none'

  constructor() {
    this.currentSlot = 342910000
    this.leaderIndex = Math.floor(Math.random() * JITO_LEADERS.length)
  }

  onSlotUpdate(cb: (info: SlotInfo) => void) {
    this.listeners.push(cb)
  }

  setFailureScenario(scenario: typeof this.failureScenario) {
    this.failureScenario = scenario
    logger.info(`[Simulation] Failure scenario set to: ${scenario}`)
  }

  async start() {
    this.running = true
    logger.info('[Simulation] Starting slot stream (simulated)')
    this.emitSlots()
  }

  stop() {
    this.running = false
  }

  getLeaderSchedule(): LeaderSchedule {
    const leaders = []
    for (let i = 0; i < 20; i++) {
      const slot = this.currentSlot + i
      const isJito = (this.leaderIndex + i) % 5 === 0
      const leader = isJito
        ? JITO_LEADERS[(this.leaderIndex + Math.floor(i / 5)) % JITO_LEADERS.length]
        : OTHER_LEADERS[(this.leaderIndex + i) % OTHER_LEADERS.length]
      leaders.push({ slot, leader, isJito })
    }
    return { currentSlot: this.currentSlot, leaders }
  }

  getCurrentTipRange(): { min: number; max: number; recommended: number } {
    const base = 5000 + Math.random() * 20000
    return {
      min: Math.floor(base * 0.5),
      max: Math.floor(base * 2),
      recommended: Math.floor(base * 1.2),
    }
  }

  simulateBundleSubmission(bundleId: string, tipAmount: number): {
    accepted: boolean
    slot: number
    lifecycle: BundleLifecycle
  } {
    const slot = this.currentSlot + 2
    const now = Date.now()

    const lifecycle: BundleLifecycle = {
      bundleId,
      status: 'submitted',
      slot,
      tipAmount,
      tipMarks: Math.floor(tipAmount / 10000),
      blockhash: `sim${this.slotCounter.toString(16).padStart(8, '0')}${Math.random().toString(16).slice(2, 10)}`,
      submittedAt: now,
      processedAt: null,
      confirmedAt: null,
      finalizedAt: null,
      failureReason: null,
      failureCategory: null,
      retryCount: 0,
      decisionHistory: [],
    }

    const accept = this.slotCounter > 3 || Math.random() > 0.3

    if (!accept) {
      lifecycle.status = 'failed'
      lifecycle.processedAt = now + 200 + Math.random() * 300
      lifecycle.failureReason = 'Simulation error: bundle rejected by block engine'
      lifecycle.failureCategory = 'simulation_error'
    }

    if (this.failureScenario === 'blockhash_expiry' && this.slotCounter % 4 === 0) {
      lifecycle.status = 'failed'
      lifecycle.processedAt = now + 100 + Math.random() * 200
      lifecycle.failureReason = 'Blockhash expired. Expected slot 0, got slot 1.'
      lifecycle.failureCategory = 'blockhash_expired'
    }

    if (this.failureScenario === 'leader_skip' && this.slotCounter % 4 === 1) {
      lifecycle.status = 'failed'
      lifecycle.failureReason = 'Jito leader skipped their slot. Bundle not included.'
      lifecycle.failureCategory = 'leader_skip'
    }

    this.slotCounter++

    return { accepted: !lifecycle.status.includes('failed'), slot, lifecycle }
  }

  simulateLifecycleProgression(lifecycle: BundleLifecycle): BundleLifecycle {
    const lc = { ...lifecycle }
    const delay = 400 + Math.random() * 600

    lc.status = 'processed'
    lc.processedAt = lc.submittedAt + delay

    if (lc.failureCategory === 'blockhash_expired') {
      lc.status = 'failed'
      return lc
    }

    if (lc.failureCategory === 'leader_skip') {
      lc.status = 'failed'
      return lc
    }

    lc.status = 'confirmed'
    lc.confirmedAt = lc.processedAt! + 1000 + Math.random() * 2000

    lc.status = 'finalized'
    lc.finalizedAt = lc.confirmedAt! + 3000 + Math.random() * 2000

    lc.status = 'finalized'
    return lc
  }

  getCurrentSlot(): number {
    return this.currentSlot
  }

  getRandomWallet(): string {
    return FAUCET_WALLETS[Math.floor(Math.random() * FAUCET_WALLETS.length)]
  }

  private async emitSlots() {
    while (this.running) {
      this.currentSlot++
      const isJito = (this.leaderIndex + this.currentSlot) % 5 === 0
      const leader = isJito
        ? JITO_LEADERS[this.leaderIndex % JITO_LEADERS.length]
        : OTHER_LEADERS[this.currentSlot % OTHER_LEADERS.length]

      const info: SlotInfo = {
        slot: this.currentSlot,
        leader,
        timestamp: this.baseTimestamp + (this.currentSlot - 342910000) * 400,
        isJitoLeader: isJito,
      }

      for (const cb of this.listeners) cb(info)
      await sleep(isJito ? 200 : 400)
    }
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
