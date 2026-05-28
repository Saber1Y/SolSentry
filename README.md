# SolSentry

> Smart Solana transaction ops — Jito bundles, Yellowstone streaming, AI agent for retry/tip decisions, and full lifecycle tracking.

**SolSentry** watches the Solana network live, decides the best moment and price to submit a transaction bundle, submits it through Jito, tracks whether it lands, handles failures, and uses an AI agent to make real operational decisions.

Built for the Superteam Nigeria Advanced Infrastructure Challenge.

## Architecture

```
                    ┌─────────────────────┐
                    │   Yellowstone gRPC   │
                    │   (slot/leader stream)│
                    └──────────┬──────────┘
                               │ slot updates
                               ▼
┌──────────────────────────────────────────────────────┐
│                   SolSentry Core                      │
│                                                       │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Slot     │→ │  Leader      │→ │  Tip         │  │
│  │   Watcher  │  │  Window      │  │  Calculator  │  │
│  │            │  │  Detector    │  │              │  │
│  └────────────┘  └──────┬───────┘  └──────┬───────┘  │
│                          │                 │          │
│                          ▼                 ▼          │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Bundle    │← │  Lifecycle   │← │  AI Agent    │  │
│  │  Builder   │  │  Tracker     │  │  (decisions)  │  │
│  │  + Jito    │  │              │  │              │  │
│  │  Submitter │  │              │  │              │  │
│  └────────────┘  └──────────────┘  └──────────────┘  │
│                         │                             │
└─────────────────────────┼─────────────────────────────┘
                          │ lifecycle logs
                          ▼
              ┌──────────────────────┐
              │   lifecycle_logs.json │
              │   (exportable)       │
              └──────────────────────┘
```

### Components

**Slot Watcher** — Connects to Yellowstone gRPC (or simulation mode) to stream live slot updates and leader schedule data.

**Leader Window Detector** — Analyzes the leader schedule to find upcoming Jito validator slots and determines the optimal submission window for bundle inclusion.

**Tip Calculator** — Computes dynamic bundle tips using recent on-chain tip data. Supports percentile-based calculation (P50, P75, P95) with urgency multipliers.

**Bundle Builder** — Constructs Solana transactions and wraps them into Jito bundles with tip transactions routed to the Jito tip account.

**Lifecycle Tracker** — Monitors each bundle through `submitted → processed → confirmed → finalized` and records timing, slot numbers, and failure data.

**AI Agent** — Makes one meaningful operational decision per failure cycle: fault classification, retry strategy, tip adjustment, or abort. Can use either LLM-powered reasoning (OpenAI) or deterministic rule-based reasoning with full trace output.

### Data Flow

1. Yellowstone gRPC streams slot updates → Slot Watcher
2. Leader Window Detector identifies next Jito leader slot
3. Tip Calculator computes optimal tip from recent data
4. Bundle Builder creates signed transactions + tip tx
5. Bundle submitted to Jito block engine
6. Lifecycle Tracker polls RPC at each commitment level
7. On failure: AI Agent classifies fault and decides next action
8. If retry: fresh blockhash fetched, tip recalculated, bundle rebuilt
9. All decisions + lifecycle data logged to JSON





```

### CLI Commands

| Command | Description |
|---------|-------------|
| `solsentry simulate` | Run full pipeline in simulation mode |
| `solsentry submit` | Submit a single test bundle |
| `solsentry logs` | Show lifecycle logs |
| `solsentry inject-fault` | Trigger a fault scenario (blockhash expiry / leader skip) |
| `solsentry start` | Start continuous streaming + submission |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `JITO_BLOCK_ENGINE_URL` | `https://mainnet.block-engine.jito.io` | Jito block engine |
| `YELLOWSTONE_GRPC_URL` | — | Yellowstone gRPC endpoint |
| `OPENAI_API_KEY` | — | For LLM-powered AI agent |
| `MODE` | `simulation` | `real` or `simulation` |

## Lifecycle Logs

Each bundle submission produces a record with:

```json
{
  "bundleId": "bundle-1718000001",
  "status": "finalized",
  "slot": 342910003,
  "tipAmount": 11400,
  "tipMarks": 1,
  "blockhash": "sim...",
  "submittedAt": 1718000001000,
  "processedAt": 1718000001420,
  "confirmedAt": 1718000002500,
  "finalizedAt": 1718000005800,
  "failureReason": null,
  "failureCategory": null,
  "retryCount": 0
}
```

Logs are written to `logs/lifecycle_logs.json` after each completion.

## Infrastructure Q&A

### What does the time gap between `processed_at` and `confirmed_at` say about network health?

The `processed_at → confirmed_at` gap represents how long a transaction waits between being accepted by the leader (processed at the current slot) and receiving a supermajority vote from validators (confirmation at a later slot).

- **< 1 second**: Healthy network, low congestion, fast validator voting
- **1–4 seconds**: Normal conditions; validators are voting within expected timeframes
- **> 4 seconds**: Congestion or instability. Possible causes include:
  - High block propagation latency
  - Validators lagging in vote submission
  - Fork competition delaying finalization
  - Leader schedule gaps

Consistently high gaps suggest the network is under load and you should increase tip amounts to prioritize inclusion, or wait for lower-traffic periods.

### Why shouldn't you fetch a blockhash using finalized commitment for time-sensitive transactions?

Using `finalized` commitment to fetch a blockhash introduces **2–3 slots of unnecessary delay** (approximately 1–2 seconds). A blockhash at finalized commitment may already be 32+ confirmations old, meaning the transaction's `lastValidBlockHeight` will expire sooner.

For time-sensitive operations (landing in a specific leader slot, arbitrage, or MEV), use `confirmed` or `processed` commitment instead. The trade-off:
- **Finalized** — safest but slowest; the blockhash has been fully settled by supermajority vote, but may expire before your transaction lands
- **Confirmed** — recommended for Jito bundles; the blockhash is recent enough to remain valid through the bundle window, and the risk of rollback is negligible in practice
- **Processed** — fastest but riskiest; the blockhash comes from a block that may still be forked out

For Jito bundles specifically, fetching with `confirmed` commitment gives you the best balance: the blockhash is fresh enough to remain valid through the 1–3 slot window, and the bundle is atomically executed or not at all.

### What happens to your bundle if the Jito leader skips their slot?

A Jito leader skipping their slot means:
1. The bundle is **not processed** at that slot
2. The block engine will attempt to include it in the *next* Jito leader's slot (provided the bundle's `lastValidBlockHeight` hasn't expired)
3. If no subsequent Jito leader includes it before expiration, the bundle is **dropped**
4. You receive no explicit rejection — the bundle simply never lands

SolSentry handles this by:
1. Detecting the failure (lifecycle stuck at `submitted` with no progression)
2. Classifying it as `leader_skip`
3. The AI agent decides to: fetch a fresh blockhash, recalculate the tip, wait for the *next* Jito leader window, and resubmit

## License

MIT
