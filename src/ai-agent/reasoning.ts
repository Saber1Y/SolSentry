import { AIDecision, TipData, FailureCategory } from '../types.js'
import { logger } from '../utils/logger.js'

export class ReasoningEngine {
  async llmReason(
    failure: FailureCategory,
    reason: string,
    tipData: TipData,
    context: { currentSlot: number; nextJitoSlot: number | null; recentFailures: number },
    history: AIDecision[]
  ): Promise<AIDecision> {
    try {
      const { default: OpenAI } = await import('openai')
      const { loadConfig } = await import('../config.js')
      const config = loadConfig()
      const openai = new OpenAI({ apiKey: config.openaiApiKey })

      const prompt = `You are a Solana transaction ops agent. Analyze this failure and decide next action.

Failure: ${failure}
Reason: ${reason}
Current slot: ${context.currentSlot}
Next Jito slot: ${context.nextJitoSlot ?? 'none'}
Recent failures: ${context.recentFailures}
Tip data: P50=${tipData.percentile50}, P75=${tipData.percentile75}, P95=${tipData.percentile95}, recommended=${tipData.recommendedTip}
Prior decisions: ${history.length > 0 ? history.map(h => `${h.type}: ${h.action}`).join(' | ') : 'none'}

Respond with JSON:
{
  "type": "retry" | "tip_adjustment" | "timing" | "blockhash_refresh" | "abort",
  "reasoning": ["step1", "step2", ...],
  "action": "description of what to do",
  "confidence": 0.0-1.0
}`

      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      })

      const parsed = JSON.parse(resp.choices[0]?.message?.content || '{}')

      return {
        timestamp: Date.now(),
        type: parsed.type || 'retry',
        reasoning: parsed.reasoning || ['LLM reasoning unavailable'],
        action: parsed.action || 'Retry with fresh state',
        confidence: parsed.confidence || 0.5,
        data: { failure, reason, tipData, context },
      }
    } catch (err) {
      logger.warn('[AI] LLM reasoning failed, falling back to rule-based:', err)
      return this.ruleBasedReason(failure, reason, tipData, context, history)
    }
  }

  ruleBasedReason(
    failure: FailureCategory,
    reason: string,
    tipData: TipData,
    context: { currentSlot: number; nextJitoSlot: number | null; recentFailures: number },
    history: AIDecision[]
  ): AIDecision {
    const recentRetries = history.filter(h => h.type === 'retry').length
    const recentAdjustments = history.filter(h => h.type === 'tip_adjustment').length

    switch (failure) {
      case 'blockhash_expired': {
        const shouldRetry = recentRetries < 3
        return {
          timestamp: Date.now(),
          type: shouldRetry ? 'blockhash_refresh' : 'abort',
          reasoning: [
            `Detected blockhash expiry: ${reason}`,
            `Transaction used a blockhash that is no longer valid for the current slot ${context.currentSlot}.`,
            `The network's lastValidBlockHeight advanced past the transaction's blockhash validity window.`,
            shouldRetry
              ? `Retry #${recentRetries + 1}/3: will fetch fresh blockhash, recalculate tip, and rebuild bundle.`
              : `Exceeded max retries (${recentRetries}). Aborting.`,
          ],
          action: shouldRetry
            ? 'Fetch fresh blockhash with confirmed commitment, recalculate tip, rebuild and resubmit'
            : 'Abort: max retries exceeded',
          confidence: shouldRetry ? 0.9 : 0.95,
          data: { failure, reason, context, retryCount: recentRetries },
        }
      }

      case 'leader_skip': {
        const nextSlot = context.nextJitoSlot
        if (!nextSlot) {
          return {
            timestamp: Date.now(),
            type: 'timing',
            reasoning: [
              `Jito leader skipped slot. No upcoming Jito leader detected.`,
              `Reason: ${reason}`,
              `Holding until next Jito leader window appears.`,
            ],
            action: 'Wait for next Jito leader window',
            confidence: 0.6,
            data: { failure, reason, context },
          }
        }
        return {
          timestamp: Date.now(),
          type: 'timing',
          reasoning: [
            `Jito leader skipped slot ${context.currentSlot}.`,
            `Next Jito leader at slot ${nextSlot} (${nextSlot - context.currentSlot} slots away).`,
            'Will wait and resubmit to the next Jito window with a fresh blockhash.',
          ],
          action: `Wait ${(nextSlot - context.currentSlot) * 0.4}s then resubmit to slot ${nextSlot}`,
          confidence: 0.8,
          data: { failure, reason, context, nextJitoSlot: nextSlot },
        }
      }

      case 'tip_too_low': {
        const increasedTip = Math.floor(tipData.percentile95 * 1.2)
        return {
          timestamp: Date.now(),
          type: 'tip_adjustment',
          reasoning: [
            `Bundle rejected: tip too low to be included.`,
            `Previously used ${tipData.recommendedTip} lamports (P75).`,
            `Increasing to ${increasedTip} lamports (P95 × 1.2) for next submission.`,
          ],
          action: `Increase tip from ${tipData.recommendedTip} to ${increasedTip} lamports`,
          confidence: 0.75,
          data: { failure, reason, previousTip: tipData.recommendedTip, newTip: increasedTip },
        }
      }

      case 'duplicate': {
        return {
          timestamp: Date.now(),
          type: 'abort',
          reasoning: [
            `Duplicate bundle detected: ${reason}.`,
            'Same transaction already included on-chain.',
            'No retry needed.',
          ],
          action: 'Abort: bundle already landed',
          confidence: 1.0,
          data: { failure, reason },
        }
      }

      case 'simulation_error':
      case 'unknown':
      default: {
        if (recentRetries >= 3 || recentAdjustments >= 2) {
          return {
            timestamp: Date.now(),
            type: 'abort',
            reasoning: [
              `Unhandled failure after ${recentRetries} retries: ${reason}`,
              'Escalating — no automated recovery path.',
            ],
            action: 'Abort and report',
            confidence: 0.7,
            data: { failure, reason, retryCount: recentRetries },
          }
        }
        return {
          timestamp: Date.now(),
          type: 'retry',
          reasoning: [
            `Unclassified failure: ${reason}`,
            'Will retry with increased tip and fresh blockhash.',
          ],
          action: 'Increase tip, refresh blockhash, retry',
          confidence: 0.5,
          data: { failure, reason },
        }
      }
    }
  }
}
