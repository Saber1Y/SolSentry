import { SlotInfo, LeaderSchedule } from '../types.js'
import { logger } from '../utils/logger.js'

const JITO_VALIDATORS = new Set([
  'Dkg9oVtF8NLL9YQXmdQVu3GjgdE2YDTKk8CkA9G8kGqv',
  '66RwRMFdSJqnQBq5zKPMQBs6iQMJqoVVL4K7SUQWFMpT',
  '6yP62UGchU2bGsTGNVR7JzQE5GAPJLKxbPWfx4VUNS25',
  'Cy6TBrRxH3B6TJLwQ5HJPjBw7J9jKFLyXxQ7JHyQVyVx',
  'B1Z4BNLMnYiP5xntB3kHZKYtuXy7KjPmLjGZ7qKHFdfr',
])

export function isJitoLeader(identity: string): boolean {
  return JITO_VALIDATORS.has(identity)
}

export function secondsUntilLeaderSlot(currentSlot: number, targetSlot: number): number {
  const slotsRemaining = targetSlot - currentSlot
  return Math.max(0, slotsRemaining * 0.4)
}

export function findNextJitoLeaders(schedule: LeaderSchedule, count: number = 3): typeof schedule.leaders {
  return schedule.leaders.filter(l => l.isJito).slice(0, count)
}

export function shouldSubmitInWindow(
  currentSlot: number,
  leaderSlot: number,
  windowSlots: number = 3
): boolean {
  const diff = leaderSlot - currentSlot
  return diff >= 0 && diff <= windowSlots
}

export function estimateNextJitoWindow(currentSlot: number, schedule: LeaderSchedule): {
  leaderSlot: number
  secondsUntil: number
  windowOpen: boolean
} | null {
  const jitoLeaders = findNextJitoLeaders(schedule, 1)
  if (jitoLeaders.length === 0) return null
  const leaderSlot = jitoLeaders[0].slot
  return {
    leaderSlot,
    secondsUntil: secondsUntilLeaderSlot(currentSlot, leaderSlot),
    windowOpen: shouldSubmitInWindow(currentSlot, leaderSlot),
  }
}
