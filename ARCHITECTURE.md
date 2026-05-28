# SolSentry Architecture

> Copy this to a public Notion/Google Doc for the bounty submission.

## Overview

SolSentry is a smart Solana transaction infrastructure stack that:
1. Streams live slot/leader data via Yellowstone gRPC
2. Detects optimal Jito leader windows for bundle submission
3. Calculates dynamic bundle tips from recent network data
4. Builds and submits Jito bundles with tip transactions
5. Tracks full lifecycle (submitted → processed → confirmed → finalized)
6. Uses an AI agent to classify failures and decide retry/timing/tip strategies

## System Design

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SolSentry System                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │  Yellowstone     │    │  Leader Schedule  │                    │
│  │  gRPC Client     │───→│  Detector         │                    │
│  │  (slot stream)   │    │  (Jito windows)   │                    │
│  └─────────────────┘    └────────┬─────────┘                    │
│                                  │                               │
│                                  ▼                               │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │  Tip Calculator  │    │  Bundle Builder   │                    │
│  │  (P50/P75/P95)   │───→│  (tx + tip tx)    │                    │
│  └─────────────────┘    └────────┬─────────┘                    │
│                                  │                               │
│                                  ▼                               │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │  Jito Block      │←───│  Bundle           │                    │
│  │  Engine          │    │  Submitter        │                    │
│  └─────────────────┘    └────────┬─────────┘                    │
│                                  │                               │
│                                  ▼                               │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │  Lifecycle       │    │  AI Agent         │                    │
│  │  Tracker         │───→│  (failure/retry)  │                    │
│  └─────────────────┘    └──────────────────┘                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Slot Ingestion**: Yellowstone gRPC streams SubscribeUpdate events containing new slot notifications with slot number, leader identity, and timestamp.

2. **Leader Analysis**: The leader schedule is analyzed to identify Jito validators. A Jito leader window is defined as 3 slots before the leader's slot.

3. **Tip Computation**: Recent tip data is collected from Jito's tip_stream API (or historical data in simulation mode). Percentiles (P50, P75, P95) are calculated and a tip is selected based on urgency level.

4. **Bundle Construction**: A simple SOL transfer transaction is built with:
   - Compute budget instruction (prioritization fee)
   - Transfer instruction
   - A separate tip transaction to the Jito tip account
   - Both signed with the wallet keypair

5. **Submission**: The bundle is sent to Jito's block engine via JSON-RPC (sendBundle).

6. **Lifecycle Tracking**: After submission, the system polls the Solana RPC at each commitment level:
   - `processed` — leader has accepted the transaction
   - `confirmed` — supermajority vote achieved
   - `finalized` — maximum lockout reached

7. **Failure Handling**: On failure, the AI agent:
   - Classifies the failure (blockhash expiry, leader skip, tip too low, etc.)
   - Produces structured reasoning
   - Decides next action (retry, adjust tip, wait, or abort)
   - If retrying: fetches fresh blockhash, recalculates tip, rebuilds bundle

8. **Logging**: Every submission and decision is written to lifecycle_logs.json with slot numbers, timestamps, tip amounts, and failure classifications.

### Infrastructure Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Node.js + TypeScript | Fast prototyping, wide library support |
| Blockchain | Solana (mainnet/devnet) | Target network |
| Streaming | Yellowstone gRPC (Triton) | Industry standard for Solana data streaming |
| Bundle Submission | Jito JSON-RPC API | Direct block engine access |
| AI Agent | OpenAI GPT-4o-mini (optional) / Rule-based | LLM for advanced reasoning, rule-based for deterministic fallback |
| CLI | Commander.js | Standard Node.js CLI framework |
| Wallet | @solana/web3.js Keypair | Native Solana key management |

### Failure Scenarios Handled

1. **Blockhash Expiry**: Transaction's lastValidBlockHeight exceeded. Agent fetches fresh blockhash with `confirmed` commitment and rebuilds.

2. **Leader Skip**: Jito validator misses their slot. Agent waits for next Jito window and resubmits.

3. **Insufficient Tip**: Bundle rejected due to low tip. Agent increases to P95 × 1.2 multiplier.

4. **Duplicate Bundle**: Transaction already on-chain. Agent aborts (no action needed).

5. **Unknown Errors**: Agent retries up to 3 times with escalating tips.

### AI Agent Reasoning

The AI agent produces visible reasoning for every decision. Example:

```
Decision Type: blockhash_refresh
Confidence: 90%
Reasoning:
  • Detected blockhash expiry: Expected slot 0, got slot 1
  • Transaction used a blockhash no longer valid for current slot
  • Network's lastValidBlockHeight advanced past validity window
  • Retry #1/3: fetching fresh blockhash with confirmed commitment
Action: Fetch fresh blockhash, recalculate tip, rebuild and resubmit
```

The agent can run in two modes:
- **LLM mode** (requires OpenAI key): GPT-4o-mini analyzes failure context and produces decisions
- **Rule-based mode** (default): Deterministic decision tree with complete reasoning trace

Both modes produce the same structured output format.

## Setup & Deployment

See README.md for setup instructions.

## Testing

Run `solsentry simulate` for a full pipeline test with simulated data.
Run `solsentry simulate --fault blockhash_expiry` to test specific failure handling.

## License

MIT
