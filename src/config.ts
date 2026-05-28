import { Config } from './types.js'

export function loadConfig(): Config {
  return {
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    solanaWsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.io',
    jitoTipAccount: process.env.JITO_TIP_ACCOUNT || '96gYZGDn1bYYXKxWREiNtYfJfK3Dg9gXFDZmTVJBBj4N',
    yellowstoneGrpcUrl: process.env.YELLOWSTONE_GRPC_URL || '',
    yellowstoneGrpcToken: process.env.YELLOWSTONE_GRPC_TOKEN || '',
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    aiProvider: (process.env.AI_PROVIDER as Config['aiProvider']) || 'openrouter',
    aiModel: process.env.AI_MODEL || 'gpt-4o-mini',
    mode: (process.env.MODE as Config['mode']) || 'simulation',
  }
}
