import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js'
import { BundleLifecycle, BundleSubmissionResult } from '../types.js'
import { logger } from '../utils/logger.js'
import { LifecycleTracker } from './lifecycle-tracker.js'
import { loadConfig } from '../config.js'

export class RealSubmitter {
  private connection: Connection
  private blockEngineUrl: string

  constructor() {
    const config = loadConfig()
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed')
    this.blockEngineUrl = config.jitoBlockEngineUrl
  }

  async submitBundle(
    transactions: Transaction[],
    tipTransaction: Transaction,
    lifecycle: BundleLifecycle,
    tracker: LifecycleTracker
  ): Promise<BundleSubmissionResult> {
    const bundleId = lifecycle.bundleId
    tracker.updateStatus(bundleId, 'submitted', { submittedAt: Date.now() })

    try {
      const allTxs = [...transactions, tipTransaction]
      const encoded = allTxs.map(tx => {
        const serialized = tx.serialize({ requireAllSignatures: false })
        return Buffer.from(serialized).toString('base64')
      })

      const result = await this.sendViaJitoRpc(encoded)

      if (result.accepted) {
        tracker.updateStatus(bundleId, 'processed', {
          processedAt: Date.now(),
          slot: result.slot,
        })

        const sigs = allTxs.map(tx => {
          const firstSig = tx.signatures[0]
          return firstSig ? firstSig.toString() : ''
        }).filter(Boolean)

        if (sigs.length > 0) {
          await this.pollBundleConfirmation(sigs[0], bundleId, tracker)
        }
      } else {
        tracker.updateStatus(bundleId, 'failed', {
          failureReason: 'Bundle rejected by Jito block engine',
          failureCategory: 'simulation_error',
        })
      }

      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      tracker.updateStatus(bundleId, 'failed', {
        failureReason: msg,
        failureCategory: 'unknown',
      })
      return { bundleId, accepted: false, slot: 0 }
    }
  }

  private async sendViaJitoRpc(transactions: string[]): Promise<BundleSubmissionResult> {
    const url = `${this.blockEngineUrl}/api/v1/bundles`
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [transactions],
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await resp.json() as { result?: string; error?: { message: string } }

    if (data.error) {
      logger.warn('[Jito] RPC error:', data.error.message)
      return { bundleId: '', accepted: false, slot: 0 }
    }

    const uuid = data.result || ''
    return {
      bundleId: uuid,
      accepted: true,
      slot: 0,
      uuid,
    }
  }

  private async pollBundleConfirmation(
    signature: string,
    bundleId: string,
    tracker: LifecycleTracker,
    maxAttempts = 30
  ) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        })

        if (!status?.value) {
          await sleep(2000)
          continue
        }

        const s = status.value

        if (s.confirmationStatus === 'processed') {
          tracker.updateStatus(bundleId, 'processed', { processedAt: Date.now() })
        } else if (s.confirmationStatus === 'confirmed') {
          tracker.updateStatus(bundleId, 'confirmed', { confirmedAt: Date.now() })
        } else if (s.confirmationStatus === 'finalized') {
          tracker.updateStatus(bundleId, 'finalized', { finalizedAt: Date.now() })
          return
        }

        if (s.err) {
          tracker.updateStatus(bundleId, 'failed', {
            failureReason: JSON.stringify(s.err),
            failureCategory: 'simulation_error',
          })
          return
        }
      } catch {
        // poll again
      }
      await sleep(2000)
    }

    logger.warn(`[Jito] Bundle ${bundleId} confirmation poll timed out`)
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
