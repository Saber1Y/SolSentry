import { BundleLifecycle, AIDecision, TipData } from '../types.js'
import { loadConfig } from '../config.js'
import { logger } from '../utils/logger.js'
import { ReasoningEngine } from './reasoning.js'

export class BundleAgent {
  private reasoning: ReasoningEngine
  private decisionHistory: AIDecision[] = []

  constructor() {
    this.reasoning = new ReasoningEngine()
  }

  async decideAfterFailure(
    lifecycle: BundleLifecycle,
    tipData: TipData,
    context: {
      currentSlot: number
      nextJitoSlot: number | null
      recentFailures: number
    }
  ): Promise<AIDecision> {
    const config = loadConfig()
    const failure = lifecycle.failureCategory || 'unknown'
    const reason = lifecycle.failureReason || 'Unknown error'

    const llmKey = config.aiProvider === 'openrouter' ? config.openrouterApiKey : config.openaiApiKey
    const useLLM = !!(llmKey && config.mode === 'real')

    let decision: AIDecision

    if (useLLM) {
      decision = await this.reasoning.llmReason(failure, reason, tipData, context, this.decisionHistory)
    } else {
      decision = this.reasoning.ruleBasedReason(failure, reason, tipData, context, this.decisionHistory)
    }

    this.decisionHistory.push(decision)

    logger.section('AI Agent Decision')
    logger.info(`Type:       ${decision.type}`)
    logger.info(`Confidence: ${(decision.confidence * 100).toFixed(0)}%`)
    logger.info(`Action:     ${decision.action}`)
    logger.info('Reasoning:')
    for (const step of decision.reasoning) {
      logger.info(`  • ${step}`)
    }

    return decision
  }

  async decideTip(
    tipData: TipData,
    urgency: 'low' | 'medium' | 'high'
  ): Promise<AIDecision> {
    const decision: AIDecision = {
      timestamp: Date.now(),
      type: 'tip_adjustment',
      reasoning: [
        `Network congestion: ${tipData.recentTips.length} recent data points analyzed`,
        `P50 tip: ${tipData.percentile50} lamports`,
        `P75 tip: ${tipData.percentile75} lamports`,
        `P95 tip: ${tipData.percentile95} lamports`,
        `Urgency requested: ${urgency}`,
        `Selecting P75 × urgency multiplier as optimal balance of cost vs inclusion`,
      ],
      action: `Set bundle tip to ${tipData.recommendedTip} lamports (p75 for ${urgency} urgency)`,
      confidence: 0.85,
      data: { ...tipData, urgency },
    }
    return decision
  }

  async decideTiming(
    currentSlot: number,
    nextJitoSlot: number | null,
    bundleCount: number
  ): Promise<AIDecision> {
    if (!nextJitoSlot) {
      return {
        timestamp: Date.now(),
        type: 'timing',
        reasoning: ['No Jito leader window detected. Holding submission.'],
        action: 'Wait for next Jito leader window',
        confidence: 0.5,
        data: { currentSlot, nextJitoSlot },
      }
    }

    const slotsAway = nextJitoSlot - currentSlot
    const shouldWait = slotsAway > 3

    return {
      timestamp: Date.now(),
      type: 'timing',
      reasoning: [
        `Current slot: ${currentSlot}`,
        `Next Jito leader slot: ${nextJitoSlot} (${slotsAway} slots away)`,
        shouldWait
          ? `Sufficient buffer (${slotsAway} slots). Waiting for optimal window.`
          : `Leader window imminent (${slotsAway} slots). Preparing submission.`,
        `Bundle queue depth: ${bundleCount}`,
      ],
      action: shouldWait
        ? `Wait ${slotsAway * 0.4}s for Jito leader slot ${nextJitoSlot}`
        : `Prepare bundle for immediate submission to slot ${nextJitoSlot}`,
      confidence: shouldWait ? 0.9 : 0.75,
      data: { currentSlot, nextJitoSlot, slotsAway, bundleCount },
    }
  }

  getDecisionHistory(): AIDecision[] {
    return this.decisionHistory
  }
}
