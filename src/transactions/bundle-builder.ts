import {
  Connection,
  Transaction,
  SystemProgram,
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { TipData } from '../types.js'
import { logger } from '../utils/logger.js'
import { loadConfig } from '../config.js'

export interface BuiltBundle {
  transactions: Transaction[]
  tipTransaction: Transaction
  blockhash: string
  lastValidBlockHeight: number
}

export class BundleBuilder {
  private connection: Connection
  private wallet: Keypair | null = null
  private tipAccount: PublicKey

  constructor() {
    const config = loadConfig()
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed')
    this.tipAccount = new PublicKey(config.jitoTipAccount)
    if (config.walletPrivateKey) {
      try {
        const keypair = Keypair.fromSecretKey(
          new Uint8Array(Buffer.from(config.walletPrivateKey, 'base64'))
        )
        this.wallet = keypair
      } catch {
        logger.warn('[BundleBuilder] Invalid wallet key. Using ephemeral keypair.')
        this.wallet = Keypair.generate()
      }
    } else {
      this.wallet = Keypair.generate()
      logger.info('[BundleBuilder] No wallet configured. Generated ephemeral keypair for testing.')
    }
  }

  async buildBundle(tipData: TipData, destination?: string): Promise<BuiltBundle> {
    const sender = this.wallet!.publicKey
    const dest = destination
      ? new PublicKey(destination)
      : sender

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed')

    const tx = new Transaction()
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: tipData.recommendedTip }),
      SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: dest,
        lamports: 1000,
      })
    )
    tx.feePayer = sender
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight

    const tipTx = new Transaction()
    tipTx.add(
      SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: this.tipAccount,
        lamports: tipData.recommendedTip,
      })
    )
    tipTx.feePayer = sender
    tipTx.recentBlockhash = blockhash
    tipTx.lastValidBlockHeight = lastValidBlockHeight

    if (this.wallet) {
      tx.sign(this.wallet)
      tipTx.sign(this.wallet)
    }

    return {
      transactions: [tx],
      tipTransaction: tipTx,
      blockhash,
      lastValidBlockHeight,
    }
  }

  signBundle(bundle: BuiltBundle): BuiltBundle {
    if (!this.wallet) return bundle
    const pk = this.wallet.publicKey
    bundle.transactions.forEach(tx => {
      const alreadySigned = tx.signatures.some(sig => sig.publicKey.equals(pk))
      if (!alreadySigned) {
        tx.sign(this.wallet!)
      }
    })
    const tipSigned = bundle.tipTransaction.signatures.some(sig => sig.publicKey.equals(pk))
    if (!tipSigned) {
      bundle.tipTransaction.sign(this.wallet!)
    }
    return bundle
  }

  getWalletAddress(): string {
    return this.wallet!.publicKey.toBase58()
  }
}
