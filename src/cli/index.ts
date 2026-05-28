#!/usr/bin/env node

import { Command } from 'commander'
import { config } from 'dotenv'
import { logger, LogLevel } from '../utils/logger.js'
import { SimulationEngine } from '../simulation/index.js'
import { TipCalculator } from '../transactions/tip-calculator.js'
import { LifecycleTracker } from '../transactions/lifecycle-tracker.js'
import { BundleAgent } from '../ai-agent/agent.js'
import { loadConfig } from '../config.js'
import {
  findNextJitoLeaders,
  shouldSubmitInWindow,
  estimateNextJitoWindow,
} from '../streaming/leader-schedule.js'

config()

const program = new Command()
program
  .name('solsentry')
  .description('SolSentry — Smart Solana Transaction Ops')
  .version('1.0.0')

program
  .command('simulate')
  .description('Run full pipeline in simulation mode')
  .option('-f, --fault <type>', 'Fault scenario to inject (blockhash_expiry | leader_skip | tip_too_low)')
  .option('-c, --count <number>', 'Number of bundles to submit', '12')
  .action(async (opts) => {
    process.env.MODE = 'simulation'
    const cfg = loadConfig()
    const sim = new SimulationEngine()
    const tipCalc = new TipCalculator()
    const tracker = new LifecycleTracker()
    const agent = new BundleAgent()
    let submitted = 0
    const target = parseInt(opts.count) || 12
    let recentFailures = 0
    const allLogs: any[] = []

    if (opts.fault) {
      sim.setFailureScenario(opts.fault)
    }

    logger.section('SolSentry Simulation')
    logger.info(`Target: ${target} bundle submissions`)
    logger.info(`Mode:   simulation`)
    logger.info(`Fault:  ${opts.fault || 'none (random failures)'}`)
    logger.info('')

    sim.onSlotUpdate(async (slotInfo) => {
      const schedule = sim.getLeaderSchedule()
      const jitoWindow = estimateNextJitoWindow(slotInfo.slot, schedule)

      if (!jitoWindow || !jitoWindow.windowOpen) return
      if (submitted >= target) return

      submitted++
      const bundleId = `bundle-${slotInfo.slot}-${submitted}`

      logger.section(`Submission ${submitted}/${target}`)
      logger.info(`Slot:        ${slotInfo.slot}`)
      logger.info(`Leader:      ${slotInfo.leader}`)
      logger.info(`Jito window: slot ${jitoWindow.leaderSlot}`)

      const tipData = await tipCalc.calculateTip('simulation', 'medium')

      const tipDecision = await agent.decideTip(tipData, 'medium')

      const result = sim.simulateBundleSubmission(bundleId, tipData.recommendedTip)

      const lifecycle = result.lifecycle
      tracker.updateStatus(bundleId, lifecycle.status, {
        processedAt: lifecycle.processedAt,
        failureReason: lifecycle.failureReason,
        failureCategory: lifecycle.failureCategory,
      })

      let finalLifecycle = lifecycle

      if (lifecycle.status === 'failed') {
        recentFailures++

        const aiDecision = await agent.decideAfterFailure(lifecycle, tipData, {
          currentSlot: slotInfo.slot,
          nextJitoSlot: jitoWindow.leaderSlot,
          recentFailures,
        })

        lifecycle.decisionHistory.push(aiDecision)

        if (aiDecision.type !== 'abort') {
          logger.info(`[Agent] Executing: ${aiDecision.action}`)
          const retryTipData = await tipCalc.calculateTip('simulation', 'high')
          const retryResult = sim.simulateBundleSubmission(
            `${bundleId}-retry-${lifecycle.retryCount + 1}`,
            retryTipData.recommendedTip
          )
          const retryLifecycle = retryResult.lifecycle
          retryLifecycle.retryCount = lifecycle.retryCount + 1
          retryLifecycle.decisionHistory = lifecycle.decisionHistory
          finalLifecycle = sim.simulateLifecycleProgression(retryLifecycle)
          tracker.updateStatus(finalLifecycle.bundleId, finalLifecycle.status, {
            processedAt: finalLifecycle.processedAt,
            confirmedAt: finalLifecycle.confirmedAt,
            finalizedAt: finalLifecycle.finalizedAt,
          })
          logger.info(`[Retry] ${finalLifecycle.status} at slot ${finalLifecycle.slot}`)
        }
      } else {
        finalLifecycle = sim.simulateLifecycleProgression(lifecycle)
        tracker.updateStatus(finalLifecycle.bundleId, finalLifecycle.status, {
          processedAt: finalLifecycle.processedAt,
          confirmedAt: finalLifecycle.confirmedAt,
          finalizedAt: finalLifecycle.finalizedAt,
        })
      }

      allLogs.push({
        submission: finalLifecycle,
        decisions: agent.getDecisionHistory(),
        timestamp: new Date().toISOString(),
      })

      logger.info(`[Done] ${finalLifecycle.bundleId}: ${finalLifecycle.status}`)

      if (finalLifecycle.confirmedAt && finalLifecycle.processedAt) {
        const procToConf = finalLifecycle.confirmedAt - finalLifecycle.processedAt
        logger.info(`[Timing] processed→confirmed: ${procToConf}ms`)
      }
      if (finalLifecycle.finalizedAt && finalLifecycle.confirmedAt) {
        const confToFinal = finalLifecycle.finalizedAt - finalLifecycle.confirmedAt
        logger.info(`[Timing] confirmed→finalized: ${confToFinal}ms`)
      }

      if (submitted >= target) {
        logger.section('Simulation Complete')
        logger.info(`Total submissions: ${submitted}`)
        logger.info(`Failures: ${recentFailures}`)
        logger.info(`Logs written to: logs/lifecycle_logs.json`)

        try {
          const fs = await import('fs')
          const path = await import('path')
          const logsDir = path.join(process.cwd(), 'logs')
          if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })
          fs.writeFileSync(
            path.join(logsDir, 'lifecycle_logs.json'),
            JSON.stringify(allLogs, null, 2)
          )
          fs.writeFileSync(
            path.join(logsDir, 'decisions.json'),
            JSON.stringify(agent.getDecisionHistory(), null, 2)
          )
        } catch {}
        sim.stop()
        process.exit(0)
      }
    })

    await sim.start()
  })

program
  .command('submit')
  .description('Submit a single test bundle')
  .option('-d, --destination <address>', 'Destination wallet address')
  .option('-t, --tip <lamports>', 'Fixed tip amount in lamports')
  .action(async (opts) => {
    const cfg = loadConfig()
    if (cfg.mode === 'simulation') {
      const sim = new SimulationEngine()
      const tipCalc = new TipCalculator()
      const tracker = new LifecycleTracker()
      const agent = new BundleAgent()

      const tipData = await tipCalc.calculateTip('simulation', 'medium')
      if (opts.tip) {
        tipData.recommendedTip = parseInt(opts.tip)
      }

      const bundleId = `manual-${Date.now()}`
      const result = sim.simulateBundleSubmission(bundleId, tipData.recommendedTip)
      const lifecycle = sim.simulateLifecycleProgression(result.lifecycle)

      tracker.updateStatus(bundleId, lifecycle.status, {
        processedAt: lifecycle.processedAt,
        confirmedAt: lifecycle.confirmedAt,
        finalizedAt: lifecycle.finalizedAt,
      })

      logger.section('Submission Result')
      logger.info(`Bundle ID:    ${bundleId}`)
      logger.info(`Status:       ${lifecycle.status}`)
      logger.info(`Slot:         ${lifecycle.slot}`)
      logger.info(`Tip:          ${lifecycle.tipAmount} lamports`)
      logger.info(`Landed:       ${lifecycle.finalizedAt ? 'Yes' : 'No'}`)

      if (lifecycle.processedAt && lifecycle.confirmedAt) {
        logger.info(`Confirmation gap: ${lifecycle.confirmedAt - lifecycle.processedAt}ms`)
      }
    } else {
      logger.info('[Submit] Live submission mode not yet implemented in this version')
    }
  })

program
  .command('logs')
  .description('Show lifecycle logs')
  .action(async () => {
    try {
      const fs = await import('fs')
      const path = await import('path')
      const logsPath = path.join(process.cwd(), 'logs', 'lifecycle_logs.json')
      if (!fs.existsSync(logsPath)) {
        logger.info('No logs found. Run `solsentry simulate` first.')
        return
      }
      const logs = JSON.parse(fs.readFileSync(logsPath, 'utf-8'))
      logger.section('Lifecycle Logs')
      for (const log of logs) {
        const s = log.submission || log
        const status = s.status === 'finalized' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
        console.log(
          `${status} ${s.bundleId} | slot ${s.slot} | ${s.status} | tip ${s.tipAmount} lamports` +
            (s.failureReason ? ` | fail: ${s.failureReason}` : '')
        )
      }
      console.log(`\nTotal: ${logs.length} submissions`)
    } catch (err) {
      logger.error('Failed to read logs:', err)
    }
  })

program
  .command('inject-fault')
  .description('Trigger a fault scenario for testing')
  .argument('<type>', 'blockhash_expiry | leader_skip | tip_too_low')
  .action(async (type) => {
    logger.info(`[Fault] Injecting fault: ${type}`)
    const sim = new SimulationEngine()
    sim.setFailureScenario(type)
    logger.info(`[Fault] ${type} will trigger on the next eligible submission`)
  })

program.parse(process.argv)
