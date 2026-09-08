import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as config from '../config.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';
const GMGN_CLI_PATH = process.env.GMGN_CLI_PATH || (isWin ? 'C:\\Users\\daa\\AppData\\Roaming\\npm\\gmgn-cli.cmd' : 'gmgn-cli');

/**
 * Token Basic Info skill:
 * Queries GMGN API via gmgn-cli for deep token analytics:
 * - rat trader % & wallets count
 * - bundler trader % & wallets count
 * - smart wallets count
 * - sniper wallets count
 * - top 10 holder rate
 * - dev team hold rate
 * - cto flag & twitter delete history
 */
export async function getGmgnTokenInfo(mint, chain = 'sol') {
    const defaultRes = {
        gmgn_price: 0.0,
        gmgn_mc: 0.0,
        gmgn_liquidity: 0.0,
        gmgn_rat_pct: 0.0,
        gmgn_bundler_pct: 0.0,
        gmgn_top10_rate: 0.0,
        gmgn_smart_wallets: 0,
        gmgn_renowned_wallets: 0,
        gmgn_sniper_wallets: 0,
        gmgn_dev_team_hold_rate: 0.0,
        gmgn_cto_flag: 0,
        gmgn_checked: false,
    };

    if (!mint) return defaultRes;

    try {
        const { stdout } = await execFileAsync(GMGN_CLI_PATH, ['token', 'info', '--chain', chain, '--address', mint], {
            timeout: 7000,
            env: { ...process.env, GMGN_API_KEY: config.GMGN_API_KEY },
        });

        if (!stdout) return defaultRes;
        const data = JSON.parse(stdout.trim());
        if (!data || typeof data !== 'object') return defaultRes;

        const stat = data.stat || {};
        const wt = data.wallet_tags_stat || {};
        const dev = data.dev || {};

        const ratPct = Number(stat.top_rat_trader_percentage || 0) * 100;
        const bundlerPct = Number(stat.top_bundler_trader_percentage || 0) * 100;
        const top10Rate = Number(stat.top_10_holder_rate || 0) * 100;
        const devTeamHold = Number(stat.dev_team_hold_rate || 0) * 100;
        const smartW = Number(wt.smart_wallets || 0);
        const renownedW = Number(wt.renowned_wallets || 0);
        const sniperW = Number(wt.sniper_wallets || 0);
        const cto = Number(dev.cto_flag || 0);

        const priceObj = data.price || {};
        const gmgnPrice = Number(priceObj.price || 0);
        const gmgnLiq = Number(data.liquidity || 0);

        const totalSup = Number(data.total_supply || data.circulating_supply || 1_000_000_000);
        let gmgnMc = Number(data.migration_market_cap || 0);
        if (gmgnMc <= 0 && gmgnPrice > 0 && totalSup > 0) {
            const decimals = Number(data.decimals || 6);
            const normSup = totalSup > 1e12 && decimals > 0 ? totalSup / (10 ** decimals) : totalSup;
            gmgnMc = gmgnPrice * normSup;
        }

        return {
            gmgn_price: gmgnPrice,
            gmgn_mc: Number(gmgnMc.toFixed(2)),
            gmgn_liquidity: Number(gmgnLiq.toFixed(2)),
            gmgn_rat_pct: Number(ratPct.toFixed(2)),
            gmgn_bundler_pct: Number(bundlerPct.toFixed(2)),
            gmgn_top10_rate: Number(top10Rate.toFixed(2)),
            gmgn_smart_wallets: smartW,
            gmgn_renowned_wallets: renownedW,
            gmgn_sniper_wallets: sniperW,
            gmgn_dev_team_hold_rate: Number(devTeamHold.toFixed(2)),
            gmgn_cto_flag: cto,
            gmgn_checked: true,
        };
    } catch (err) {
        return defaultRes;
    }
}

/**
 * Pump.fun Trenches Scanner with anti-rug & low bundle rate filters
 */
export async function getGmgnPumpfunTrenches(limit = 30) {
    try {
        const { stdout } = await execFileAsync(GMGN_CLI_PATH, [
            'market', 'trenches',
            '--chain', 'sol',
            '--type', 'new_creation', 'near_completion',
            '--limit', String(limit),
            '--max-rug-ratio', '0.35',
            '--max-bundler-rate', '0.25',
            '--raw',
        ], {
            timeout: 9000,
            env: { ...process.env, GMGN_API_KEY: config.GMGN_API_KEY },
        });

        if (!stdout) return [];
        const data = JSON.parse(stdout.trim());
        if (!data || typeof data !== 'object') return [];

        const tokens = [];
        for (const cat of ['new_creation', 'near_completion', 'completed']) {
            const items = data[cat] || [];
            for (const item of items) {
                if (!item || typeof item !== 'object') continue;
                const launchpad = String(item.launchpad || item.launchpad_platform || '').toLowerCase();
                if (!launchpad.includes('pump') && !String(item.address || '').endsWith('pump')) continue;

                const mint = item.address;
                if (!mint) continue;

                const mc = Number(item.market_cap || 0);
                const liq = Number(item.liquidity || 0);
                tokens.push({
                    mint,
                    name: item.name || 'Token',
                    symbol: item.symbol || 'TOKEN',
                    created_timestamp: Number(item.created_timestamp || Math.floor(Date.now() / 1000)),
                    market_cap_sol: mc / 180.0,
                    market_cap_usd: mc,
                    liquidity_usd: liq,
                    source: 'gmgn_pumpfun_trenches',
                    uri: null,
                    icon_url: item.logo || null,
                    description: null,
                    smart_degen_count: Number(item.smart_degen_count || 0),
                    renowned_count: Number(item.renowned_count || 0),
                });
            }
        }
        return tokens;
    } catch (err) {
        return [];
    }
}

/**
 * KOL-Bought New Tokens skill:
 * Queries newly created Solana tokens where at least `minRenownedCount` KOLs bought and market cap < `maxMarketCap`.
 */
export async function getGmgnKolBoughtTokens(minRenownedCount = 2, maxMarketCap = 100000) {
    try {
        const { stdout } = await execFileAsync(GMGN_CLI_PATH, [
            'market', 'trenches',
            '--chain', 'sol',
            '--type', 'new_creation',
            '--min-renowned-count', String(minRenownedCount),
            '--max-marketcap', String(maxMarketCap),
            '--raw',
        ], {
            timeout: 9000,
            env: { ...process.env, GMGN_API_KEY: config.GMGN_API_KEY },
        });

        if (!stdout) return [];
        const data = JSON.parse(stdout.trim());
        const items = data?.new_creation || [];
        return items.map(item => ({
            mint: item.address,
            name: item.name,
            symbol: item.symbol,
            created_timestamp: Number(item.created_timestamp || Math.floor(Date.now() / 1000)),
            market_cap_sol: Number(item.market_cap || 0) / 180.0,
            market_cap_usd: Number(item.market_cap || 0),
            liquidity_usd: Number(item.liquidity || 0),
            source: 'gmgn_kol_bought',
            icon_url: item.logo || null,
            smart_degen_count: Number(item.smart_degen_count || 0),
            renowned_count: Number(item.renowned_count || 0),
        }));
    } catch {
        return [];
    }
}

/**
 * 5-Min / 1-Hour Trending Tokens skill:
 * Scans hottest actively traded tokens on Solana (e.g. Pump.fun platform).
 */
export async function getGmgnTrendingTokens(interval = '5m', platform = null) {
    try {
        const args = ['market', 'trending', '--chain', 'sol', '--interval', interval];
        if (platform) {
            args.push('--platform', platform);
        }
        const { stdout } = await execFileAsync(GMGN_CLI_PATH, args, {
            timeout: 9000,
            env: { ...process.env, GMGN_API_KEY: config.GMGN_API_KEY },
        });
        if (!stdout) return [];
        const data = JSON.parse(stdout.trim());
        const list = data?.data?.list || data?.list || [];
        return list.map(item => ({
            mint: item.address,
            name: item.name,
            symbol: item.symbol,
            price_usd: Number(item.price || 0),
            market_cap_usd: Number(item.market_cap || 0),
            liquidity_usd: Number(item.liquidity || 0),
            icon_url: item.logo || null,
            renowned_count: Number(item.renowned_count || 0),
            smart_degen_count: Number(item.smart_degen_count || 0),
            source: `gmgn_trending_${interval}`,
        }));
    } catch {
        return [];
    }
}
