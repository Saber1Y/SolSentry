import { Connection, PublicKey } from '@solana/web3.js'
import { SlotInfo, LeaderSchedule } from '../types.js'
import { logger } from '../utils/logger.js'
import { isJitoLeader } from './leader-schedule.js'

export class RealStreamClient {
  private listeners: ((info: SlotInfo) => void)[] = []
  private running = false
  private connection: Connection
  private slotMap: Map<number, string> = new Map()
  private scheduleRefreshInterval: ReturnType<typeof setInterval> | null = null
  private subId: number | null = null
  private knownValidators: Set<string> = new Set()
  private validatorRefreshInterval: ReturnType<typeof setInterval> | null = null

  constructor(rpcUrl: string, wsUrl: string) {
    this.connection = new Connection(rpcUrl, {
      wsEndpoint: wsUrl,
      commitment: 'confirmed',
    })
  }

  onSlotUpdate(cb: (info: SlotInfo) => void) {
    this.listeners.push(cb)
  }

  async start() {
    this.running = true
    logger.info('[RealStream] Connecting to Solana WebSocket...')

    try {
      await this.refreshValidators()
      await this.refreshLeaderSchedule()

      this.validatorRefreshInterval = setInterval(() => this.refreshValidators(), 3600000)
      this.scheduleRefreshInterval = setInterval(() => this.refreshLeaderSchedule(), 60000)

      this.subId = this.connection.onSlotChange((slotInfo) => {
        if (!this.running) return
        const slot = slotInfo.slot
        const leader = this.slotMap.get(slot) || 'unknown'

        const info: SlotInfo = {
          slot,
          leader,
          timestamp: Date.now(),
          isJitoLeader: isJitoLeader(leader),
        }

        for (const cb of this.listeners) cb(info)
      })

      logger.info('[RealStream] Streaming live slots')
    } catch (err) {
      logger.error('[RealStream] Failed to start:', err)
      this.running = false
    }
  }

  stop() {
    this.running = false
    if (this.subId !== null) {
      this.connection.removeSlotChangeListener(this.subId).catch(() => {})
    }
    if (this.scheduleRefreshInterval) clearInterval(this.scheduleRefreshInterval)
    if (this.validatorRefreshInterval) clearInterval(this.validatorRefreshInterval)
  }

  getConnection(): Connection {
    return this.connection
  }

  getLeaderSchedule(): LeaderSchedule {
    const leaders: { slot: number; leader: string; isJito: boolean }[] = []

    const entries = Array.from(this.slotMap.entries()).sort(([a], [b]) => a - b)
    for (const [slot, leader] of entries.slice(0, 20)) {
      leaders.push({ slot, leader, isJito: isJitoLeader(leader) })
    }

    return { currentSlot: leaders[0]?.slot ?? 0, leaders }
  }

  async getCurrentSlot(): Promise<number> {
    try {
      return await this.connection.getSlot('confirmed')
    } catch {
      return 0
    }
  }

  private async refreshValidators() {
    try {
      const voters = await this.connection.getVoteAccounts('confirmed')
      for (const v of voters.current) {
        this.knownValidators.add(v.votePubkey)
      }
      for (const v of voters.delinquent) {
        this.knownValidators.add(v.votePubkey)
      }
      logger.debug(`[RealStream] Known validators: ${this.knownValidators.size}`)
    } catch (err) {
      logger.warn('[RealStream] Failed to refresh validators:', err)
    }
  }

  private async refreshLeaderSchedule() {
    try {
      const currentSlot = await this.connection.getSlot('processed')
      const schedule = await this.connection.getLeaderSchedule()

      this.slotMap.clear()
      for (const [identity, slots] of Object.entries(schedule)) {
        if (!slots) continue
        for (const s of slots) {
          if (s >= currentSlot && s < currentSlot + 500) {
            this.slotMap.set(s, identity)
          }
        }
      }
      logger.info(`[RealStream] Leader schedule loaded: ${this.slotMap.size} slots mapped`)
    } catch (err) {
      logger.warn('[RealStream] Failed to refresh leader schedule:', err)
    }
  }
}
