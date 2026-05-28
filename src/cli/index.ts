#!/usr/bin/env node

import { Command } from 'commander'
import { config } from 'dotenv'
import { logger, LogLevel } from '../utils/logger.js'
import { SimulationEngine } from '../simulation/index.js'
import { TipCalculator } from '../transactions/tip-calculator.js'
import { LifecycleTracker } from '../transactions/lifecycle-tracker.js'
import { BundleAgent } from '../ai-agent/agent.js'
import { BundleBuilder } from '../transactions/bundle-builder.js'
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
  .command('start')
  .description('Run pipeline in configured mode (real or simulation)')
  .option('-c, --count <number>', 'Number of bundles to submit', '12')
  .option('-d, --destination <address>', 'Destination wallet for SOL transfer')
  .action(async (opts) => {
    const cfg = loadConfig()

    if (cfg.mode === 'simulation') {
      process.env.MODE = 'simulation'
      const sim = new SimulationEngine()
      const tipCalc = new TipCalculator()
      const tracker = new LifecycleTracker()
      const agent = new BundleAgent()
      let submitted = 0
      const target = parseInt(opts.count) || 12
      let recentFailures = 0
      const allLogs: any[] = []

      logger.section('SolSentry — Simulation Mode')
      logger.info(`Target: ${target} bundle submissions`)

      sim.onSlotUpdate(async (slotInfo) => {
        const schedule = sim.getLeaderSchedule()
        const jitoWindow = estimateNextJitoWindow(slotInfo.slot, schedule)
        if (!jitoWindow || !jitoWindow.windowOpen) return
        if (submitted >= target) return

        submitted++
        const bundleId = `bundle-${slotInfo.slot}-${submitted}`
        logger.section(`Submission ${submitted}/${target}`)
        logger.info(`Slot: ${slotInfo.slot} | Leader: ${slotInfo.leader}`)

        const tipData = await tipCalc.calculateTip('simulation', 'medium')
        await agent.decideTip(tipData, 'medium')
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
            logger.info(`[Agent] ${aiDecision.action}`)
            const retryTipData = await tipCalc.calculateTip('simulation', 'high')
            const retryResult = sim.simulateBundleSubmission(
              `${bundleId}-retry-${lifecycle.retryCount + 1}`, retryTipData.recommendedTip
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

        if (submitted >= target) {
          logger.section('Simulation Complete')
          logger.info(`Total: ${submitted} | Failures: ${recentFailures}`)
          await writeLogs(allLogs, agent)
          sim.stop()
          process.exit(0)
        }
      })

      await sim.start()
      return
    }

    // ── real mode ──
    const missing: string[] = []
    if (!cfg.walletPrivateKey) missing.push('WALLET_PRIVATE_KEY')
    if (!cfg.openrouterApiKey && !cfg.openaiApiKey) missing.push('OPENROUTER_API_KEY or OPENAI_API_KEY')
    if (cfg.solanaRpcUrl === 'https://api.mainnet-beta.solana.com' && !process.env.SOLANA_RPC_URL) {
      missing.push('custom SOLANA_RPC_URL (using default may be rate-limited)')
    }
    if (missing.length > 0) {
      logger.warn(`Missing config: ${missing.join(', ')}`)
      logger.warn('Falling back to simulation mode. Set these in .env for real mode.')
      const sim = new SimulationEngine()
      const tipCalc = new TipCalculator()
      const tracker = new LifecycleTracker()
      const agent = new BundleAgent()
      let submitted = 0
      const target = parseInt(opts.count) || 12
      let recentFailures = 0
      const allLogs: any[] = []

      logger.section('SolSentry — Simulation (fallback)')

      sim.onSlotUpdate(async (slotInfo) => {
        const schedule = sim.getLeaderSchedule()
        const jitoWindow = estimateNextJitoWindow(slotInfo.slot, schedule)
        if (!jitoWindow || !jitoWindow.windowOpen) return
        if (submitted >= target) return

        submitted++
        const bundleId = `bundle-${slotInfo.slot}-${submitted}`
        logger.section(`Submission ${submitted}/${target}`)
        const tipData = await tipCalc.calculateTip('simulation', 'medium')
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
            currentSlot: slotInfo.slot, nextJitoSlot: jitoWindow.leaderSlot, recentFailures,
          })
          lifecycle.decisionHistory.push(aiDecision)
          if (aiDecision.type !== 'abort') {
            const retryTipData = await tipCalc.calculateTip('simulation', 'high')
            const retryResult = sim.simulateBundleSubmission(
              `${bundleId}-retry-${lifecycle.retryCount + 1}`, retryTipData.recommendedTip
            )
            const retryLifecycle = retryResult.lifecycle
            retryLifecycle.retryCount = lifecycle.retryCount + 1
            retryLifecycle.decisionHistory = lifecycle.decisionHistory
            finalLifecycle = sim.simulateLifecycleProgression(retryLifecycle)
            tracker.updateStatus(finalLifecycle.bundleId, finalLifecycle.status, {
              processedAt: finalLifecycle.processedAt, confirmedAt: finalLifecycle.confirmedAt, finalizedAt: finalLifecycle.finalizedAt,
            })
          }
        } else {
          finalLifecycle = sim.simulateLifecycleProgression(lifecycle)
          tracker.updateStatus(finalLifecycle.bundleId, finalLifecycle.status, {
            processedAt: finalLifecycle.processedAt, confirmedAt: finalLifecycle.confirmedAt, finalizedAt: finalLifecycle.finalizedAt,
          })
        }

        allLogs.push({ submission: finalLifecycle, decisions: agent.getDecisionHistory(), timestamp: new Date().toISOString() })
        logger.info(`[Done] ${finalLifecycle.bundleId}: ${finalLifecycle.status}`)

        if (submitted >= target) {
          logger.section('Simulation Complete')
          logger.info(`Total: ${submitted} | Failures: ${recentFailures}`)
          await writeLogs(allLogs, agent)
          sim.stop()
          process.exit(0)
        }
      })

      await sim.start()
      return
    }

    // Real streaming pipeline
    const { RealStreamClient } = await import('../streaming/real-stream-client.js')
    const { RealSubmitter } = await import('../transactions/real-submitter.js')

    const stream = new RealStreamClient(cfg.solanaRpcUrl, cfg.solanaWsUrl)
    const submitter = new RealSubmitter()
    const builder = new BundleBuilder()
    const tipCalc = new TipCalculator()
    const tracker = new LifecycleTracker()
    const agent = new BundleAgent()
    let submitted = 0
    const target = parseInt(opts.count) || 12
    let recentFailures = 0
    const allLogs: any[] = []
    const dest = opts.destination

    logger.section('SolSentry — Real Mode')
    logger.info(`RPC:       ${cfg.solanaRpcUrl}`)
    logger.info(`Jito:      ${cfg.jitoBlockEngineUrl}`)
    logger.info(`AI:        ${cfg.aiProvider} (${cfg.aiModel})`)
    logger.info(`Wallet:    ${builder.getWalletAddress()}`)
    logger.info(`Target:    ${target} bundles`)

    stream.onSlotUpdate(async (slotInfo) => {
      if (submitted >= target) return
      const schedule = stream.getLeaderSchedule()
      const jitoWindow = estimateNextJitoWindow(slotInfo.slot, schedule)
      if (!jitoWindow || !jitoWindow.windowOpen) return

      submitted++
      const bundleId = `bundle-${slotInfo.slot}-${Date.now()}`

      logger.section(`Submission ${submitted}/${target}`)
      logger.info(`Slot: ${slotInfo.slot} | Leader: ${slotInfo.leader} | Jito: ${jitoWindow.leaderSlot}`)

      const urgency = recentFailures > 2 ? 'high' : 'medium'
      const tipData = await tipCalc.calculateTip('jito_api', urgency)
      await agent.decideTip(tipData, urgency)

      try {
        const built = await builder.buildBundle(tipData, dest)
        const record = tracker.createRecord(bundleId, slotInfo.slot, tipData.recommendedTip, built.blockhash)

        const result = await submitter.submitBundle(
          built.transactions,
          built.tipTransaction,
          record,
          tracker,
        )

        if (!result.accepted) {
          record.status = 'failed'
          record.failureReason = 'Jito rejected bundle'
          record.failureCategory = 'unknown'
          recentFailures++

          const aiDecision = await agent.decideAfterFailure(record, tipData, {
            currentSlot: slotInfo.slot,
            nextJitoSlot: jitoWindow.leaderSlot,
            recentFailures,
          })
          record.decisionHistory.push(aiDecision)

          if (aiDecision.type !== 'abort') {
            logger.info(`[Agent] ${aiDecision.action}`)
            const retryTip = await tipCalc.calculateTip('jito_api', 'high')
            const retryBundle = await builder.buildBundle(retryTip, dest)
            const retryRecord = tracker.createRecord(`${bundleId}-retry`, slotInfo.slot, retryTip.recommendedTip, retryBundle.blockhash)
            retryRecord.retryCount = record.retryCount + 1
            retryRecord.decisionHistory = record.decisionHistory
            const retryResult = await submitter.submitBundle(
              retryBundle.transactions, retryBundle.tipTransaction, retryRecord, tracker,
            )
            if (retryResult.accepted) {
              logger.info(`[Retry] Bundle accepted: ${retryRecord.bundleId}`)
            }
          }
        } else {
          logger.info(`[Jito] Bundle accepted: ${result.bundleId || result.uuid || 'ok'}`)
          tracker.updateStatus(bundleId, 'processed', { processedAt: Date.now() })
        }

        allLogs.push({
          submission: record,
          decisions: agent.getDecisionHistory(),
          timestamp: new Date().toISOString(),
        })
      } catch (err) {
        logger.error('[Start] Submission error:', err)
      }

      if (submitted >= target) {
        logger.section('Real Mode Complete')
        logger.info(`Total: ${submitted} | Failures: ${recentFailures}`)
        await writeLogs(allLogs, agent)
        stream.stop()
        process.exit(0)
      }
    })

    await stream.start()
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

async function writeLogs(allLogs: any[], agent: BundleAgent) {
  try {
    const fs = await import('fs')
    const path = await import('path')
    const logsDir = path.join(process.cwd(), 'logs')
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(path.join(logsDir, 'lifecycle_logs.json'), JSON.stringify(allLogs, null, 2))
    fs.writeFileSync(path.join(logsDir, 'decisions.json'), JSON.stringify(agent.getDecisionHistory(), null, 2))
    logger.info(`Logs written to: logs/lifecycle_logs.json`)
  } catch {}
}

program.parse(process.argv)
