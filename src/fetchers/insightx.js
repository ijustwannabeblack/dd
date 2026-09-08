import * as config from '../config.js';

class InsightXKeyManager {
    constructor() {
        this.keys = [...config.INSIGHTX_API_KEYS];
        this.currentIndex = 0;
        this.cooldowns = new Map();
    }

    getCurrentKey() {
        if (!this.keys.length) return null;
        const now = Date.now();
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            const k = this.keys[idx];
            if ((this.cooldowns.get(k) || 0) <= now) {
                this.currentIndex = idx;
                return k;
            }
        }
        // If all on cooldown, return the one that expires soonest
        let earliestKey = this.keys[0];
        let minExp = Infinity;
        for (const k of this.keys) {
            const exp = this.cooldowns.get(k) || 0;
            if (exp < minExp) {
                minExp = exp;
                earliestKey = k;
            }
        }
        return earliestKey;
    }

    rotateKey(failedKey, cooldownSecs = 30) {
        if (!this.keys.length) return '';
        const now = Date.now();
        if (failedKey) {
            this.cooldowns.set(failedKey, now + (cooldownSecs * 1000));
        }

        for (let i = 1; i <= this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            const k = this.keys[idx];
            if ((this.cooldowns.get(k) || 0) <= now) {
                this.currentIndex = idx;
                return k;
            }
        }

        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
        return this.keys[this.currentIndex];
    }

    get totalKeys() {
        return this.keys.length;
    }
}

const keyMgr = new InsightXKeyManager();
const cache = new Map(); // mint -> { timestamp, data }

export async function getInsightxMetrics(mint) {
    const defaultRes = {
        cluster_pct: 0.0,
        bundlers_pct: 0.0,
        insiders_pct: 0.0,
        top10_pct: 0.0,
        dev_pct: 0.0,
        snipers_pct: 0.0,
        clusters_count: 0,
        bundler_wallets_count: 0,
        nakamoto: 10,
        hhi: 0.0,
        bubblemap_url: `https://embed.insightx.network/atlas/sol/${mint}`,
        embed_url: `https://embed.insightx.network/atlas/sol/${mint}`,
        insightx_checked: false,
    };

    if (!mint || keyMgr.totalKeys === 0) return defaultRes;

    const now = Date.now();
    const cached = cache.get(mint);
    if (cached && (now - cached.timestamp < 60000)) {
        return cached.data;
    }

    const maxAttempts = Math.min(keyMgr.totalKeys, 4);
    const url = `https://api.insightx.network/dex-metrics/v1/sol/${mint}`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const currentKey = keyMgr.getCurrentKey();
        if (!currentKey) break;

        try {
            const resp = await fetch(url, {
                headers: {
                    'x-api-key': currentKey,
                    'Accept': 'application/json',
                },
                signal: AbortSignal.timeout(4500),
            });

            if (resp.status === 429) {
                const retryAfter = Number(resp.headers.get('Retry-After') || 60);
                keyMgr.rotateKey(currentKey, retryAfter);
                continue;
            }

            if (resp.status === 401 || resp.status === 403) {
                keyMgr.rotateKey(currentKey, 300);
                continue;
            }

            if (resp.status === 404) {
                cache.set(mint, { timestamp: now, data: defaultRes });
                return defaultRes;
            }

            if (resp.ok) {
                const raw = await resp.json();
                const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;

                if (data && typeof data === 'object') {
                    const clPct = Number(data.cluster_pct || 0);
                    const buPct = Number(data.bundlers_pct || 0);
                    const inPct = Number(data.insiders_pct || 0);
                    const dvPct = Number(data.dev_pct || 0);
                    const snPct = Number(data.snipers_pct || 0);
                    const t10Pct = Number(data.top10_pct || 0);

                    const res = {
                        cluster_pct: Number(clPct.toFixed(2)),
                        bundlers_pct: Number(buPct.toFixed(2)),
                        insiders_pct: Number(inPct.toFixed(2)),
                        top10_pct: Number(t10Pct.toFixed(2)),
                        dev_pct: Number(dvPct.toFixed(2)),
                        snipers_pct: Number(snPct.toFixed(2)),
                        clusters_count: clPct > 0 ? 1 : 0,
                        bundler_wallets_count: buPct > 0 ? 1 : 0,
                        nakamoto: 10,
                        hhi: 0.0,
                        bubblemap_url: `https://embed.insightx.network/atlas/sol/${mint}`,
                        embed_url: `https://embed.insightx.network/atlas/sol/${mint}`,
                        insightx_checked: true,
                    };

                    cache.set(mint, { timestamp: now, data: res });
                    return res;
                }
            }
        } catch (err) {
            // timeout or network fail
        }
    }

    cache.set(mint, { timestamp: now, data: defaultRes });
    return defaultRes;
}

export function getInsightxAtlasUrl(mint) {
    return `https://embed.insightx.network/atlas/sol/${mint}`;
}
