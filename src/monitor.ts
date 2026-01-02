import { Connection, PublicKey, ParsedTransactionWithMeta, LAMPORTS_PER_SOL } from '@solana/web3.js';

export interface NewTokenInfo {
  tokenMint: string;
  poolAddress?: string;
  timestamp: number;
  liquidity?: number;
  source: 'pumpfun' | 'raydium' | 'other';
  totalSolRaised?: number;
  transactionCount?: number;
}

export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export interface MonitorOptions {
  checkIntervalMs?: number;
  minSolToTrack?: number;
  secondBlockDelayMs?: number;
  logger?: Logger;
}

type TokenListener = (tokenInfo: NewTokenInfo) => void;

interface TokenTracking {
  tokenMint: string;
  firstSeen: number;
  transactions: Array<{ signature: string; solAmount: number; timestamp: number }>;
  totalSol: number;
  lastChecked: number;
}

const defaultLogger: Logger = {
  debug: () => {},
  info: console.log,
  warn: console.warn,
  error: console.error,
};

export class TokenMonitor {
  private connection: Connection;
  private listeners: TokenListener[] = [];
  private isRunning = false;
  private subscriptionId: number | null = null;
  private trackedTokens: Map<string, TokenTracking> = new Map();
  private readonly MIN_SOL_TO_TRACK: number;
  private readonly SECOND_BLOCK_DELAY_MS: number;
  private readonly CHECK_INTERVAL_MS: number;
  private startTime: number = Date.now();
  private processedSignatures: Set<string> = new Set();
  private logger: Logger;

  // Known program IDs
  private readonly PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  private readonly PUMP_FUN_BONDING_CURVE = 'BondingCurve111111111111111111111111111111111';

  private monitorInterval: NodeJS.Timeout | null = null;
  private trackedTokensInterval: NodeJS.Timeout | null = null;

  constructor(connection: Connection, options: MonitorOptions = {}) {
    this.connection = connection;
    this.CHECK_INTERVAL_MS = options.checkIntervalMs || 100;
    this.MIN_SOL_TO_TRACK = options.minSolToTrack || 5;
    this.SECOND_BLOCK_DELAY_MS = options.secondBlockDelayMs || 2000;
    this.logger = options.logger || defaultLogger;
  }

  public onNewToken(listener: TokenListener): void {
    this.listeners.push(listener);
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Monitor is already running');
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();
    this.processedSignatures.clear();
    
    this.logger.info('Starting Pump.fun token monitor...');
    this.logger.info(`Tracking tokens with >${this.MIN_SOL_TO_TRACK} SOL raised`);
    this.logger.info(`Only processing transactions after: ${new Date(this.startTime).toISOString()}`);

    try {
      this.monitorPumpFunTransactions();
      this.monitorTrackedTokens();
    } catch (error) {
      this.logger.error('Failed to start monitor:', error);
      this.isRunning = false;
    }
  }

  private monitorPumpFunTransactions(): void {
    this.monitorInterval = setInterval(async () => {
      try {
        const signatures = await this.connection.getSignaturesForAddress(
          new PublicKey(this.PUMP_FUN_PROGRAM),
          { limit: 50 }
        );

        this.logger.debug(`[MONITOR] Found ${signatures.length} signatures, filtering by time...`);

        let newCount = 0;
        for (const sig of signatures) {
          const sigTime = sig.blockTime ? sig.blockTime * 1000 : 0;
          
          if (this.processedSignatures.has(sig.signature)) {
            continue;
          }
          
          if (sigTime > 0 && sigTime < this.startTime) {
            this.logger.debug(`[MONITOR] Skipping old transaction: ${sig.signature.substring(0, 8)}... (time: ${new Date(sigTime).toISOString()})`);
            continue;
          }
          
          this.processedSignatures.add(sig.signature);
          await this.processPumpFunTransaction(sig.signature);
          newCount++;
        }
        
        if (newCount > 0) {
          this.logger.debug(`[MONITOR] Processed ${newCount} new transactions`);
        }
      } catch (error) {
        this.logger.error('Error monitoring Pump.fun transactions:', error);
      }
    }, this.CHECK_INTERVAL_MS);
  }

  private monitorTrackedTokens(): void {
    this.trackedTokensInterval = setInterval(async () => {
      try {
        for (const [tokenMint, tracking] of this.trackedTokens.entries()) {
          if (tracking.totalSol >= this.MIN_SOL_TO_TRACK) {
            const timeSinceFirstSeen = Date.now() - tracking.firstSeen;
            
            if (timeSinceFirstSeen >= this.SECOND_BLOCK_DELAY_MS && tracking.transactions.length >= 2) {
              this.logger.info(`🚀 Token ${tokenMint.substring(0, 8)}... has ${tracking.totalSol.toFixed(2)} SOL, triggering buy on second block`);
              
              const tokenInfo: NewTokenInfo = {
                tokenMint,
                timestamp: Date.now(),
                source: 'pumpfun',
                liquidity: tracking.totalSol,
                totalSolRaised: tracking.totalSol,
                transactionCount: tracking.transactions.length,
              };
              
              this.notifyListeners(tokenInfo);
              this.trackedTokens.delete(tokenMint);
            }
          }
        }
      } catch (error) {
        this.logger.error('Error monitoring tracked tokens:', error);
      }
    }, 500);
  }

  private async processPumpFunTransaction(signature: string): Promise<void> {
    try {
      this.logger.debug(`[MONITOR] Processing transaction: ${signature.substring(0, 8)}...`);
      
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta) {
        this.logger.debug(`[MONITOR] Transaction ${signature.substring(0, 8)}... has no data or meta`);
        return;
      }

      const txTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
      if (txTime < this.startTime) {
        this.logger.debug(`[MONITOR] Skipping old transaction (time: ${new Date(txTime).toISOString()})`);
        return;
      }

      this.logger.debug(`[MONITOR] Transaction parsed successfully, extracting token mint...`);

      const tokenMint = this.extractPumpFunTokenMint(signature, tx);
      if (!tokenMint) {
        this.logger.debug(`[MONITOR] Could not extract token mint from transaction ${signature.substring(0, 8)}...`);
        return;
      }

      this.logger.info(`[MONITOR] ✅ Extracted token mint: ${tokenMint}`);

      const solAmount = this.calculateSolAmount(tx);
      this.logger.debug(`[MONITOR] Calculated SOL amount: ${solAmount.toFixed(4)} SOL`);
      
      if (!this.trackedTokens.has(tokenMint)) {
        this.trackedTokens.set(tokenMint, {
          tokenMint,
          firstSeen: Date.now(),
          transactions: [{ signature, solAmount, timestamp: Date.now() }],
          totalSol: solAmount,
          lastChecked: Date.now(),
        });
        this.logger.info(`📊 New Pump.fun token detected: ${tokenMint.substring(0, 8)}... (${solAmount.toFixed(4)} SOL)`);
      } else {
        const tracking = this.trackedTokens.get(tokenMint)!;
        tracking.transactions.push({ signature, solAmount, timestamp: Date.now() });
        tracking.totalSol += solAmount;
        tracking.lastChecked = Date.now();
        
        this.logger.debug(`📈 Token ${tokenMint.substring(0, 8)}... now has ${tracking.totalSol.toFixed(2)} SOL (${tracking.transactions.length} transactions)`);
      }
    } catch (error: any) {
      this.logger.error(`[MONITOR] Error processing Pump.fun transaction ${signature.substring(0, 8)}...: ${error.message}`);
    }
  }

  private extractPumpFunTokenMint(signature: string, tx: ParsedTransactionWithMeta): string | null {
    try {
      if (!tx.transaction) {
        return null;
      }

      if (tx.transaction.message.accountKeys) {
        const candidateIndices = [2, 1, 3, 4, 5, 6, 7, 8];
        
        for (const idx of candidateIndices) {
          if (tx.transaction.message.accountKeys[idx]) {
            const key = tx.transaction.message.accountKeys[idx];
            const address = typeof key === 'string' ? key : key.pubkey?.toString();
            if (address && address.length >= 32 && address.length <= 44) {
              try {
                const pubkey = new PublicKey(address);
                const addressStr = pubkey.toBase58();
                if (addressStr.length >= 32 && addressStr.length <= 44) {
                  this.logger.info(`✅ [EXTRACT] Extracted token mint from index ${idx}: ${addressStr}`);
                  return addressStr;
                }
              } catch (error: any) {
                // Continue
              }
            }
          }
        }
      }

      const instructions = tx.transaction.message.instructions;
      for (const ix of instructions) {
        if ('programId' in ix) {
          const programId = ix.programId.toString();
          if (programId === this.PUMP_FUN_PROGRAM) {
            const tokenMint = this.extractTokenMintFromInstruction(ix);
            if (tokenMint && tokenMint.length >= 32 && tokenMint.length <= 44) {
              try {
                const pubkey = new PublicKey(tokenMint);
                return pubkey.toBase58();
              } catch {
                // Continue
              }
            }
          }
        }
      }
    } catch (error) {
      this.logger.debug(`Error extracting token mint: ${error}`);
    }
    return null;
  }

  private calculateSolAmount(tx: ParsedTransactionWithMeta): number {
    try {
      if (!tx.meta) return 0;

      let totalSol = 0;
      
      if (tx.meta.preBalances && tx.meta.postBalances && tx.transaction) {
        const accountKeys = tx.transaction.message.accountKeys;
        
        for (let i = 0; i < Math.min(tx.meta.preBalances.length, tx.meta.postBalances.length); i++) {
          const preBalance = tx.meta.preBalances[i] || 0;
          const postBalance = tx.meta.postBalances[i] || 0;
          const change = postBalance - preBalance;
          
          if (change > 0 && accountKeys && accountKeys[i]) {
            const accountKey = typeof accountKeys[i] === 'string' 
              ? accountKeys[i] 
              : accountKeys[i].pubkey?.toString();
            
            if (accountKey && typeof accountKey === 'string' && 
                (accountKey === this.PUMP_FUN_PROGRAM || 
                 (accountKey.length >= 32 && accountKey.length <= 44))) {
              const solAmount = change / LAMPORTS_PER_SOL;
              if (solAmount > 0.001) {
                totalSol += solAmount;
              }
            }
          }
        }
      }

      if (totalSol === 0 && tx.meta.fee) {
        return 0.01;
      }

      return totalSol;
    } catch (error) {
      this.logger.debug(`Error calculating SOL amount: ${error}`);
      return 0;
    }
  }

  private extractTokenMintFromInstruction(ix: any): string | null {
    try {
      if (ix.accounts && ix.accounts.length > 0) {
        const candidateAccounts = [ix.accounts[2], ix.accounts[3], ix.accounts[8], ix.accounts[9], ix.accounts[0]];
        
        for (const account of candidateAccounts) {
          if (account) {
            const address = account.toString ? account.toString() : account;
            if (address && address.length >= 32 && address.length <= 44) {
              try {
                new PublicKey(address);
                return address;
              } catch {
                // Continue
              }
            }
          }
        }
        
        const firstAccount = ix.accounts[0]?.toString();
        if (firstAccount) {
          return firstAccount;
        }
      }
    } catch (error) {
      // Continue
    }
    return null;
  }

  private notifyListeners(tokenInfo: NewTokenInfo): void {
    for (const listener of this.listeners) {
      try {
        listener(tokenInfo);
      } catch (error) {
        this.logger.error('Error in token listener:', error);
      }
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    
    if (this.trackedTokensInterval) {
      clearInterval(this.trackedTokensInterval);
      this.trackedTokensInterval = null;
    }
    
    if (this.subscriptionId !== null) {
      await this.connection.removeProgramAccountChangeListener(this.subscriptionId);
      this.subscriptionId = null;
    }
    
    this.logger.info('Token monitor stopped');
  }
}
