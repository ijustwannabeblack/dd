import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import * as config from '../config.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

/**
 * Resolves gmgn-cli executable path cross-platform (local node_modules, global, or container)
 */
function getGmgnCliPath() {
    if (process.env.GMGN_CLI_PATH && fs.existsSync(process.env.GMGN_CLI_PATH)) {
        return process.env.GMGN_CLI_PATH;
    }
    const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', isWin ? 'gmgn-cli.cmd' : 'gmgn-cli');
    if (fs.existsSync(localBin)) {
        return localBin;
    }
    const winGlobal = 'C:\\Users\\daa\\AppData\\Roaming\\npm\\gmgn-cli.cmd';
    if (isWin && fs.existsSync(winGlobal)) {
        return winGlobal;
    }
    return 'gmgn-cli';
}

async function execGmgn(args, timeout = 10000) {
    const cliPath = getGmgnCliPath();
    const apiKey = process.env.GMGN_API_KEY || config.GMGN_API_KEY || '';
    try {
        const { stdout } = await execFileAsync(cliPath, args, {
            timeout,
            shell: isWin,
            env: { ...process.env, GMGN_API_KEY: apiKey },
        });
        if (!stdout) return null;
        return JSON.parse(stdout.trim());
    } catch (err) {
        return null;
    }
}

/**
 * Skill: Token Basic Info
 * Queries GMGN API via gmgn-cli for deep token analytics
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

    const data = await execGmgn(['token', 'info', '--chain', chain, '--address', mint]);
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
}

/**
 * Skill: Token Security Check
 * Runs: gmgn-cli token security --chain sol --address <mint>
 */
export async function getGmgnTokenSecurity(mint, chain = 'sol') {
    const defaultRes = {
        is_show_alert: false,
        top_10_holder_rate: 0.0,
        burn_ratio: 0.0,
        burn_status: 'unknown',
        dev_token_burn_ratio: 0.0,
        renounced_freeze_account: true,
        renounced_mint: true,
        is_honeypot: false,
        buy_tax: 0.0,
        sell_tax: 0.0,
        flags: [],
        hide_risk: false,
        security_checked: false,
    };

    if (!mint) return defaultRes;

    const data = await execGmgn(['token', 'security', '--chain', chain, '--address', mint]);
    if (!data || typeof data !== 'object') return defaultRes;

    const top10Rate = Number(data.top_10_holder_rate || 0) * 100;
    const burnRatio = Number(data.burn_ratio || 0) * 100;
    const devBurn = Number(data.dev_token_burn_ratio || 0) * 100;
    const freezeRenounced = data.renounced_freeze_account === true || data.renounced_freeze_account === null;
    const mintRenounced = data.renounced_mint === true || data.renounced_mint === null;
    const isHoneypot = Boolean(data.is_honeypot || data.honeypot === 1);
    const buyTax = Number(data.buy_tax || 0);
    const sellTax = Number(data.sell_tax || 0);
    const flags = Array.isArray(data.flags) ? data.flags : [];

    return {
        is_show_alert: Boolean(data.is_show_alert),
        top_10_holder_rate: Number(top10Rate.toFixed(2)),
        burn_ratio: Number(burnRatio.toFixed(2)),
        burn_status: String(data.burn_status || 'unknown'),
        dev_token_burn_ratio: Number(devBurn.toFixed(2)),
        renounced_freeze_account: freezeRenounced,
        renounced_mint: mintRenounced,
        is_honeypot: isHoneypot,
        buy_tax: buyTax,
        sell_tax: sellTax,
        flags,
        hide_risk: Boolean(data.hide_risk),
        security_checked: true,
    };
}

/**
 * Skill: Top100 Holders Analysis
 * Runs: gmgn-cli token holders --chain sol --address <mint> --order-by amount_percentage --direction desc
 */
export async function getGmgnTopHolders(mint, chain = 'sol') {
    const defaultRes = {
        holders: [],
        top10_pct: 0.0,
        suspicious_count: 0,
        suspicious_pct: 0.0,
        new_wallets_pct: 0.0,
        holders_checked: false,
    };

    if (!mint) return defaultRes;

    const data = await execGmgn([
        'token', 'holders',
        '--chain', chain,
        '--address', mint,
        '--order-by', 'amount_percentage',
        '--direction', 'desc'
    ]);

    if (!data || !Array.isArray(data.list)) return defaultRes;

    const list = data.list;
    let top10Sum = 0;
    let suspiciousSum = 0;
    let suspiciousCount = 0;
    let newSum = 0;

    for (let i = 0; i < list.length; i++) {
        const h = list[i];
        const pct = Number(h.amount_percentage || 0) * 100;
        if (i < 10) top10Sum += pct;
        if (h.is_suspicious) {
            suspiciousSum += pct;
            suspiciousCount++;
        }
        if (h.is_new) {
            newSum += pct;
        }
    }

    return {
        holders: list.slice(0, 100),
        top10_pct: Number(top10Sum.toFixed(2)),
        suspicious_count: suspiciousCount,
        suspicious_pct: Number(suspiciousSum.toFixed(2)),
        new_wallets_pct: Number(newSum.toFixed(2)),
        holders_checked: true,
    };
}

/**
 * Skill: Wallet Holdings
 * Runs: gmgn-cli portfolio holdings --chain sol --wallet <wallet_address>
 */
export async function getGmgnWalletHoldings(wallet, chain = 'sol') {
    if (!wallet) return [];
    const data = await execGmgn(['portfolio', 'holdings', '--chain', chain, '--wallet', wallet]);
    if (!data) return [];
    return Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : []);
}

/**
 * Pump.fun Trenches Scanner with anti-rug & low bundle rate filters
 */
export async function getGmgnPumpfunTrenches(limit = 30) {
    const data = await execGmgn([
        'market', 'trenches',
        '--chain', 'sol',
        '--type', 'new_creation', 'near_completion',
        '--limit', String(limit),
        '--max-rug-ratio', '0.35',
        '--max-bundler-rate', '0.25',
        '--raw',
    ]);
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
}

/**
 * KOL-Bought New Tokens skill:
 * Queries newly created Solana tokens where at least `minRenownedCount` KOLs bought and market cap < `maxMarketCap`.
 */
export async function getGmgnKolBoughtTokens(minRenownedCount = 2, maxMarketCap = 100000) {
    const data = await execGmgn([
        'market', 'trenches',
        '--chain', 'sol',
        '--type', 'new_creation',
        '--min-renowned-count', String(minRenownedCount),
        '--max-marketcap', String(maxMarketCap),
        '--raw',
    ]);
    if (!data) return [];
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
}

/**
 * 5-Min / 1-Hour Trending Tokens skill:
 * Scans hottest actively traded tokens on Solana (e.g. Pump.fun platform).
 */
export async function getGmgnTrendingTokens(interval = '5m', platform = null) {
    const args = ['market', 'trending', '--chain', 'sol', '--interval', interval];
    if (platform) {
        args.push('--platform', platform);
    }
    const data = await execGmgn(args);
    if (!data) return [];
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
}
