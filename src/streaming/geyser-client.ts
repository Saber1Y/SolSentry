import { SlotInfo } from '../types.js'
import { logger } from '../utils/logger.js'

export interface GeyserStreamClient {
  start(): Promise<void>
  stop(): void
  onSlotUpdate(cb: (info: SlotInfo) => void): void
}

export class YellowstoneGeyserClient implements GeyserStreamClient {
  private listeners: ((info: SlotInfo) => void)[] = []
  private running = false
  private grpcUrl: string
  private grpcToken: string

  constructor(grpcUrl: string, grpcToken: string) {
    this.grpcUrl = grpcUrl
    this.grpcToken = grpcToken
  }

  onSlotUpdate(cb: (info: SlotInfo) => void) {
    this.listeners.push(cb)
  }

  async start() {
    if (!this.grpcUrl) {
      logger.warn('[Yellowstone] No gRPC URL configured. Streaming unavailable.')
      return
    }
    this.running = true
    logger.info(`[Yellowstone] Connecting to gRPC stream: ${this.grpcUrl}`)
    try {
      const mod: any = await import('@triton-one/yellowstone-grpc')
      const ClientClass = mod.Client || mod.default
      const client: any = new ClientClass(this.grpcUrl, this.grpcToken, {})
      await client.connect()
      const stream = client.subscribe()

      stream.on('data', (data: { slot?: { slot: number; leader: string } }) => {
        if (!data.slot) return
        const info: SlotInfo = {
          slot: data.slot.slot,
          leader: data.slot.leader,
          timestamp: Date.now(),
          isJitoLeader: false,
        }
        for (const cb of this.listeners) cb(info)
      })

      stream.on('error', (err: Error) => {
        logger.error('[Yellowstone] Stream error:', err.message)
      })

      stream.on('end', () => {
        logger.warn('[Yellowstone] Stream ended')
        this.running = false
      })
    } catch (err) {
      logger.error('[Yellowstone] Failed to connect:', err)
    }
  }

  stop() {
    this.running = false
  }
}
