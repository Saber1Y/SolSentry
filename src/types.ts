export type BundleStatus = 'preparing' | 'submitted' | 'processed' | 'confirmed' | 'finalized' | 'failed'
export type FailureCategory = 'blockhash_expired' | 'leader_skip' | 'tip_too_low' | 'simulation_error' | 'duplicate' | 'unknown'
export type AIDecisionType = 'retry' | 'tip_adjustment' | 'timing' | 'blockhash_refresh' | 'abort'

export interface SlotInfo {
  slot: number
  leader: string
  timestamp: number
  isJitoLeader: boolean
}

export interface LeaderSchedule {
  currentSlot: number
  leaders: { slot: number; leader: string; isJito: boolean }[]
}

export interface BundleLifecycle {
  bundleId: string
  status: BundleStatus
  slot: number
  tipAmount: number
  tipMarks: number
  blockhash: string
  submittedAt: number
  processedAt: number | null
  confirmedAt: number | null
  finalizedAt: number | null
  failureReason: string | null
  failureCategory: FailureCategory | null
  retryCount: number
  decisionHistory: AIDecision[]
}

export interface AIDecision {
  timestamp: number
  type: AIDecisionType
  reasoning: string[]
  action: string
  confidence: number
  data: Record<string, unknown>
}

export interface BundleSubmissionResult {
  bundleId: string
  accepted: boolean
  slot: number
  uuid?: string
}

export interface TipData {
  currentTip: number
  recentTips: number[]
  percentile50: number
  percentile75: number
  percentile95: number
  recommendedTip: number
  source: 'jito_api' | 'historical' | 'simulated'
}

export interface Config {
  solanaRpcUrl: string
  solanaWsUrl: string
  jitoBlockEngineUrl: string
  jitoTipAccount: string
  yellowstoneGrpcUrl: string
  yellowstoneGrpcToken: string
  walletPrivateKey: string
  openaiApiKey: string
  mode: 'real' | 'simulation'
}

export interface LifecycleLog {
  submission: BundleLifecycle
  decisions: AIDecision[]
  timestamp: string
}
