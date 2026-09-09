import WebSocket from 'ws';
import * as config from '../config.js';

export class PumpPortalStream {
    /**
     * @param {Object} handlers
     * @param {(coin: object) => Promise<void>|void} handlers.onNewToken
     * @param {(coin: object) => Promise<void>|void} handlers.onMigration
     * @param {(coin: object) => Promise<void>|void} handlers.onFinalStretch
     * @param {(coin: object) => Promise<void>|void} [handlers.onRug]
     */
    constructor({ onNewToken, onMigration, onFinalStretch, onRug }) {
        this.onNewToken = onNewToken;
        this.onMigration = onMigration;
        this.onFinalStretch = onFinalStretch;
        this.onRug = onRug;

        this.ws = null;
        this.tracked = new Map(); // mint -> { created_ts, market_cap_sol, peak_market_cap_sol, announced_stretch, rug_announced, coin }
        this.tradeTrackingEnabled = Boolean(config.PUMPPORTAL_API_KEY);
        this.warnedNoKey = false;
        this.isRunning = false;
    }

    async runForever() {
        this.isRunning = true;
        let url = config.PUMPPORTAL_WS_URL || 'wss://pumpportal.fun/api/data';
        if (config.PUMPPORTAL_API_KEY) {
            url = `${url}?api-key=${config.PUMPPORTAL_API_KEY}`;
        }

        while (this.isRunning) {
            try {
                await this.connectAndListen(url);
            } catch (err) {
                console.warn(`[PumpPortal] Connection error (${err.message}) — reconnecting in 5s...`);
            }
            this.ws = null;
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    connectAndListen(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            this.ws = ws;

            ws.on('open', () => {
                console.log('[PumpPortal] Connected — subscribing to new tokens & migrations');
                ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
                ws.send(JSON.stringify({ method: 'subscribeMigration' }));

                if (!this.tradeTrackingEnabled && !this.warnedNoKey) {
                    console.log('[PumpPortal] No PUMPPORTAL_API_KEY set — Final Stretch alerts via trades are disabled.');
                    this.warnedNoKey = true;
                }
            });

            ws.on('message', async (data) => {
                try {
                    const raw = data.toString('utf8');
                    const parsed = JSON.parse(raw);
                    await this.handleMessage(parsed);
                } catch (err) {
                    // Ignore parse error
                }
            });

            ws.on('error', (err) => {
                reject(err);
            });

            ws.on('close', () => {
                resolve();
            });
        });
    }

    async handleMessage(data) {
        if (!data || typeof data !== 'object') return;

        if (data.error || String(data.message || '').toLowerCase().startsWith('error')) {
            console.warn(`[PumpPortal] Server message: ${JSON.stringify(data)}`);
            if (this.tradeTrackingEnabled) {
                this.tradeTrackingEnabled = false;
            }
            return;
        }

        const txType = data.txType;
        if (txType === 'create') {
            await this.handleNewToken(data);
        } else if (txType === 'migrate' || txType === 'migration' || data.event === 'migration' || String(txType || '').toLowerCase().includes('migrat')) {
            await this.handleMigration(data);
        } else if (txType === 'buy' || txType === 'sell') {
            await this.handleTrade(data);
        }
    }

    async handleNewToken(data) {
        const mint = data.mint;
        if (!mint || this.tracked.has(mint)) return;

        let startMc = Number(data.marketCapSol || data.vSolInBondingCurve || 30.0);
        if (startMc <= 0) startMc = 30.0;

        const coin = {
            mint,
            name: data.name || '?',
            symbol: data.symbol || '?',
            creator: data.traderPublicKey,
            created_timestamp: Date.now(),
            market_cap_sol: startMc,
            uri: data.uri,
            initial_market_cap_sol: startMc,
            trades_count: 0,
        };

        this.tracked.set(mint, {
            created_ts: coin.created_timestamp,
            initial_market_cap_sol: startMc,
            market_cap_sol: startMc,
            peak_market_cap_sol: startMc,
            trades_count: 0,
            announced_stretch: false,
            rug_announced: false,
            coin,
        });

        if (this.tradeTrackingEnabled && this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
            } catch {}
        }

        this.observeAndFire(mint, coin);
    }

    async observeAndFire(mint, coin) {
        const checkDelay = config.NEW_PAIR_CHECK_DELAY_SECONDS || 0;
        if (checkDelay > 0) {
            await new Promise(r => setTimeout(r, checkDelay * 1000));
        }

        const entry = this.tracked.get(mint);
        if (!entry) return;

        const currMc = Number(entry.market_cap_sol || 30.0);
        const initMc = Number(entry.initial_market_cap_sol || 30.0);
        const peakMc = Math.max(Number(entry.peak_market_cap_sol || currMc), currMc);
        const trades = entry.trades_count;
        const mcDelta = currMc - initMc;

        let mcTrend = 'flat';
        if (mcDelta > 0.2 || trades >= 2) {
            mcTrend = 'up';
        } else if (mcDelta < -1.0) {
            mcTrend = 'down';
        }

        coin.market_cap_sol = currMc;
        coin.peak_market_cap_sol = peakMc;
        coin.trades_count = trades;
        coin.mc_trend = mcTrend;
        coin.mc_delta_sol = mcDelta;

        this.safeCall(this.onNewToken, coin);
    }

    async handleMigration(data) {
        const mint = data.mint;
        if (!mint) return;

        const entry = this.tracked.get(mint);
        this.tracked.delete(mint);

        const coin = entry ? entry.coin : {
            mint,
            name: data.name || '?',
            symbol: data.symbol || '?',
            creator: data.traderPublicKey,
            created_timestamp: Date.now(),
            market_cap_sol: Number(data.marketCapSol || 0),
            uri: data.uri,
        };

        if (entry) {
            coin.was_tracked = true;
        }

        this.safeCall(this.onMigration, coin);

        if (this.tradeTrackingEnabled && this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
            } catch {}
        }
    }

    async handleTrade(data) {
        const mint = data.mint;
        const entry = this.tracked.get(mint);
        if (!entry) return;

        entry.trades_count += 1;
        entry.coin.trades_count = entry.trades_count;

        const marketCapSol = Number(data.marketCapSol || entry.market_cap_sol);
        entry.market_cap_sol = marketCapSol;
        entry.coin.market_cap_sol = marketCapSol;

        if (marketCapSol > entry.peak_market_cap_sol) {
            entry.peak_market_cap_sol = marketCapSol;
        }

        // Rug detection: MC dropped 70%+ from peak
        if (this.onRug && !entry.rug_announced) {
            const peak = entry.peak_market_cap_sol;
            if (peak > 5 && marketCapSol < peak * 0.30) {
                entry.rug_announced = true;
                entry.coin.rug_drop_pct = Math.round((1 - marketCapSol / peak) * 1000) / 10;
                entry.coin.peak_market_cap_sol = peak;
                this.safeCall(this.onRug, entry.coin);
            }
        }

        if (entry.announced_stretch) return;

        const threshold = config.MIGRATION_MARKET_CAP_SOL * config.FINAL_STRETCH_THRESHOLD_PCT;
        if (marketCapSol >= threshold) {
            entry.announced_stretch = true;
            this.safeCall(this.onFinalStretch, entry.coin);
        }
    }

    safeCall(fn, arg) {
        if (!fn) return;
        try {
            const res = fn(arg);
            if (res && typeof res.catch === 'function') {
                res.catch(e => console.error(`[PumpPortal] callback error: ${e.message}`));
            }
        } catch (e) {
            console.error(`[PumpPortal] callback error: ${e.message}`);
        }
    }

    stop() {
        this.isRunning = false;
        if (this.ws) {
            try {
                this.ws.close();
            } catch {}
        }
    }
}
