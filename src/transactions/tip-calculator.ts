import { TipData } from '../types.js'
import { logger } from '../utils/logger.js'

const HISTORICAL_TIPS: number[] = [
  8500, 9200, 10100, 7800, 11200, 9500, 8800, 12400, 7600, 10500,
  9800, 11500, 8200, 10700, 9300, 11900, 8900, 9900, 10800, 8500,
]

export class TipCalculator {
  private recentTips: number[] = [...HISTORICAL_TIPS]
  private lastFetchTime = 0

  async calculateTip(
    mode: 'real' | 'simulation' = 'simulation',
    urgency: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<TipData> {
    if (mode === 'real') {
      return this.fetchRealTips(urgency)
    }
    return this.simulateTips(urgency)
  }

  private async fetchRealTips(urgency: string): Promise<TipData> {
    try {
      const resp = await fetch('https://bundles.jito.io/api/v1/bundles/tip_stream')
      const data = await resp.json()
      if (Array.isArray(data)) {
        this.recentTips = data.map((t: { tip: number }) => t.tip).slice(0, 100)
      }
    } catch {
      logger.warn('[TipCalc] Failed to fetch live tips, using historical')
    }
    return this.computeFromData(urgency)
  }

  private simulateTips(urgency: string): TipData {
    const noise = () => (Math.random() - 0.5) * 4000
    this.recentTips = HISTORICAL_TIPS.map(t => t + noise())
    return this.computeFromData(urgency)
  }

  private computeFromData(urgency: string): TipData {
    const sorted = [...this.recentTips].sort((a, b) => a - b)
    const len = sorted.length

    const percentile = (p: number) => sorted[Math.floor(len * p)]
    const currentTip = sorted[len - 1] + (Math.random() - 0.5) * 2000

    const p50 = percentile(0.5)
    const p75 = percentile(0.75)
    const p95 = percentile(0.95)

    const urgencyMultiplier = urgency === 'low' ? 0.8 : urgency === 'high' ? 1.5 : 1.0
    const recommendedTip = Math.floor(p75 * urgencyMultiplier)

    return {
      currentTip: Math.floor(currentTip),
      recentTips: this.recentTips,
      percentile50: Math.floor(p50),
      percentile75: Math.floor(p75),
      percentile95: Math.floor(p95),
      recommendedTip: Math.max(5000, Math.min(recommendedTip, 100000)),
      source: 'simulated',
    }
  }
}
