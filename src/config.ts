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
    mode: (process.env.MODE as Config['mode']) || 'simulation',
  }
}
