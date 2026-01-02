import { Connection } from '@solana/web3.js';
import { TokenMonitor, NewTokenInfo } from './src/index.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Example usage
async function main() {
  // Use environment variable for RPC URL, fallback to public RPC
  const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(RPC_URL);
  
  console.log('Using RPC:', RPC_URL);
  console.log('Note: Public RPC may have rate limits. Use a private RPC for production.\n');
  
  const monitor = new TokenMonitor(connection, {
    checkIntervalMs: 1000, // Check every 1 second
    minSolToTrack: 5,
    secondBlockDelayMs: 2000,
  });
  
  monitor.onNewToken((tokenInfo: NewTokenInfo) => {
    console.log('\nNew token detected!');
    console.log('Token Mint:', tokenInfo.tokenMint);
    console.log('Total SOL Raised:', tokenInfo.totalSolRaised);
    console.log('Source:', tokenInfo.source);
  });
  
  console.log('Starting token monitor...');
  console.log('Press Ctrl+C to stop\n');
  
  await monitor.start();
  
  // Keep running
  process.on('SIGINT', async () => {
    console.log('\nStopping monitor...');
    await monitor.stop();
    process.exit(0);
  });
}

main().catch(console.error);
