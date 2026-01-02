# solana-token-monitor

Real-time token monitoring and detection for Solana blockchain. Monitors Pump.fun and Raydium programs for new token launches.

## Features

- Pump.fun token detection
- Real-time transaction monitoring
- Event-based architecture
- Configurable monitoring intervals
- Token tracking with SOL accumulation
- TypeScript support

## Installation

```bash
npm install solana-token-monitor
```

## Configuration

This package requires a Solana RPC endpoint with WebSocket support. You can use:
- Public RPC: `https://api.mainnet-beta.solana.com` (rate limited, may not support WebSocket subscriptions)
- Private RPC: Your own RPC endpoint (recommended for production, must support WebSocket)
- Free RPC services: Helius, QuickNode, etc.

**Important:** Always use environment variables for RPC URLs:

```bash
# .env file
RPC_URL=https://api.mainnet-beta.solana.com
# Or use a private RPC:
# RPC_URL=https://your-rpc-endpoint.com
```

```typescript
import dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL);
```

## Usage

```typescript
import { Connection } from '@solana/web3.js';
import { TokenMonitor } from 'solana-token-monitor';
import dotenv from 'dotenv';

dotenv.config();

// Use environment variable for RPC URL
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL);

const monitor = new TokenMonitor(connection, {
  checkIntervalMs: 100, // Check every 100ms
  minSolToTrack: 5, // Track tokens with >5 SOL
  secondBlockDelayMs: 2000, // Wait 2 seconds before triggering
});

// Listen for new tokens
monitor.onNewToken((tokenInfo) => {
  console.log('New token detected:', tokenInfo.tokenMint);
  console.log('Total SOL raised:', tokenInfo.totalSolRaised);
  console.log('Source:', tokenInfo.source);
});

// Start monitoring
await monitor.start();

// Stop monitoring (when done)
await monitor.stop();
```

## API

### `TokenMonitor`

#### Constructor

```typescript
new TokenMonitor(
  connection: Connection,
  options?: MonitorOptions
)
```

**Parameters:**
- `connection`: Solana Connection instance
- `options`: Optional configuration
  - `checkIntervalMs?: number` - Interval between checks (default: 100ms)
  - `minSolToTrack?: number` - Minimum SOL to track tokens (default: 5)
  - `secondBlockDelayMs?: number` - Delay before triggering buy (default: 2000ms)
  - `logger?: Logger` - Custom logger (optional)

#### Methods

##### `onNewToken(listener: (tokenInfo: NewTokenInfo) => void): void`

Register a listener for new token events.

##### `start(): Promise<void>`

Start monitoring for new tokens.

##### `stop(): Promise<void>`

Stop monitoring.

### `NewTokenInfo`

```typescript
interface NewTokenInfo {
  tokenMint: string;
  poolAddress?: string;
  timestamp: number;
  liquidity?: number;
  source: 'pumpfun' | 'raydium' | 'other';
  totalSolRaised?: number;
  transactionCount?: number;
}
```

## How It Works

1. Monitors Pump.fun program transactions
2. Extracts token mint addresses from transactions
3. Tracks SOL accumulation per token
4. Triggers event when token reaches threshold (e.g., >5 SOL)
5. Implements "second block" strategy (waits for confirmation)

## License

MIT
