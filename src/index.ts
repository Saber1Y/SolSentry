#!/usr/bin/env node

import { config } from 'dotenv'
config()

import { logger, LogLevel } from './utils/logger.js'
import { loadConfig } from './config.js'

logger.section('SolSentry')
logger.info('Smart Solana Transaction Ops')
logger.info('')

const cfg = loadConfig()
logger.info(`Mode:  ${cfg.mode}`)
logger.info(`RPC:   ${cfg.solanaRpcUrl}`)
logger.info(`Jito:  ${cfg.jitoBlockEngineUrl}`)
logger.info('')
logger.info('Run `npx solsentry --help` for available commands')
logger.info('Run `npx solsentry simulate` to start simulation')
