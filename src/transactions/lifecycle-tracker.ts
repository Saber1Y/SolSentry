import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Connection, PublicKey, TransactionSignature } from '@solana/web3.js'
import { BundleLifecycle, BundleStatus } from '../types.js'
import { loadConfig } from '../config.js'
import { logger } from '../utils/logger.js'

export class LifecycleTracker {
  private connection: Connection
  private records: Map<string, BundleLifecycle> = new Map()
  private completedLogs: BundleLifecycle[] = []

  constructor() {
    const config = loadConfig()
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed')
  }

  createRecord(bundleId: string, slot: number, tipAmount: number, blockhash: string): BundleLifecycle {
    const record: BundleLifecycle = {
      bundleId,
      status: 'preparing',
      slot,
      tipAmount,
      tipMarks: Math.floor(tipAmount / 10000),
      blockhash,
      submittedAt: Date.now(),
      processedAt: null,
      confirmedAt: null,
      finalizedAt: null,
      failureReason: null,
      failureCategory: null,
      retryCount: 0,
      decisionHistory: [],
    }
    this.records.set(bundleId, record)
    return record
  }

  updateStatus(bundleId: string, status: BundleStatus, details?: Partial<BundleLifecycle>) {
    const record = this.records.get(bundleId)
    if (!record) return
    Object.assign(record, { status, ...details })

    if (['confirmed', 'finalized', 'failed'].includes(status)) {
      this.completedLogs.push({ ...record })
      this.exportLogs()
    }

    logger.info(
      `[Lifecycle] ${bundleId}: ${status}` +
        (details?.failureReason ? ` — ${details.failureReason}` : '')
    )
  }

  getRecord(bundleId: string): BundleLifecycle | undefined {
    return this.records.get(bundleId)
  }

  getAllRecords(): BundleLifecycle[] {
    return Array.from(this.records.values())
  }

  getCompletedRecords(): BundleLifecycle[] {
    return this.completedLogs
  }

  async pollForConfirmation(bundleId: string, signature: TransactionSignature, maxWaitMs = 30000) {
    const record = this.records.get(bundleId)
    if (!record) return

    const startTime = Date.now()
    const pollInterval = 2000

    record.status = 'submitted'
    record.processedAt = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const result = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        })

        if (result?.value?.confirmationStatus) {
          const status = result.value.confirmationStatus

          if (status === 'processed' || status === 'confirmed' || status === 'finalized') {
            record.status = status as BundleStatus
          }
          if (status === 'processed' && !record.processedAt) {
            record.processedAt = Date.now()
          }
          if (status === 'confirmed' && !record.confirmedAt) {
            record.confirmedAt = Date.now()
          }
          if (status === 'finalized' && !record.finalizedAt) {
            record.finalizedAt = Date.now()
            this.completedLogs.push({ ...record })
            this.exportLogs()
            logger.info(`[Lifecycle] ${bundleId}: finalized at slot ${record.slot}`)
            return
          }
        }

        if (result?.value?.err) {
          record.status = 'failed'
          record.failureReason = JSON.stringify(result.value.err)
          record.failureCategory = 'simulation_error'
          this.completedLogs.push({ ...record })
          this.exportLogs()
          logger.warn(`[Lifecycle] ${bundleId}: failed — ${record.failureReason}`)
          return
        }
      } catch {
        // continue polling
      }
      await sleep(pollInterval)
    }

    logger.warn(`[Lifecycle] ${bundleId}: poll timeout after ${maxWaitMs}ms`)
  }

  private exportLogs() {
    try {
      const logsDir = join(process.cwd(), 'logs')
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true })
      }
      writeFileSync(
        join(logsDir, 'lifecycle_logs.json'),
        JSON.stringify(this.completedLogs, null, 2)
      )
    } catch {
      // skip file write in constrained environments
    }
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
