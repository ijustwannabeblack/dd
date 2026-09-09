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
    // Try common Windows global npm paths (auto-detect username)
    if (isWin) {
        const username = process.env.USERNAME || process.env.USERPROFILE?.split('\\').pop() || 'asa';
        const winGlobal = `C:\\Users\\${username}\\AppData\\Roaming\\npm\\gmgn-cli.cmd`;
        if (fs.existsSync(winGlobal)) return winGlobal;
        // Absolute fallback hardcoded
        const fallback = 'C:\\Users\\asa\\AppData\\Roaming\\npm\\gmgn-cli.cmd';
        if (fs.existsSync(fallback)) return fallback;
    }
    return 'gmgn-cli';
}

// ── GMGN Serial Call Queue ────────────────────────────────────────────────────
// All GMGN CLI calls go through this queue — strictly one-at-a-time with a
// 2.0s gap between each, so we never trigger IP rate-limits from parallel calls.
let _gmgnRateLimitUntil = 0;
let _gmgnQueuePromise = Promise.resolve();
const GMGN_MIN_CALL_GAP_MS = 2000;
let _gmgnRateLimitLogged = false;

function enqueueGmgn(fn) {
    const result = _gmgnQueuePromise.then(() => fn());
    _gmgnQueuePromise = result.catch(() => {});
    return result;
}

/**
 * Execute a GMGN CLI command.
 * @param {string[]} args
 * @param {number} timeout
 * @param {boolean} _isRetry
 * @param {boolean} priority  — if true, skips the serial queue (for user commands)
 */
async function execGmgn(args, timeout = 15000, _isRetry = false, priority = false) {
    if (priority) {
        return _execGmgnRaw(args, timeout, _isRetry, true);
    }
    return enqueueGmgn(() => _execGmgnRaw(args, timeout, _isRetry, false));
}

async function _execGmgnRaw(args, timeout = 15000, _isRetry = false, priority = false) {
    // Check active IP ban
    const banWait = _gmgnRateLimitUntil - Date.now();
    if (banWait > 0) {
        if (!_gmgnRateLimitLogged) {
            console.warn(`[GMGN] ⚠️ Rate-limited — cooling down for ${Math.ceil(banWait / 1000)}s (calls will resume automatically)`);
            _gmgnRateLimitLogged = true;
        }
        // If banned, background calls skip GMGN so bot stays lightning fast
        if (!priority) return null;
        if (banWait > 5000) return null;
        await new Promise(r => setTimeout(r, banWait + 500));
        _gmgnRateLimitLogged = false;
    }

    // Minimum gap between consecutive calls
    await new Promise(r => setTimeout(r, GMGN_MIN_CALL_GAP_MS));

    const cliPath = getGmgnCliPath();
    const apiKey = process.env.GMGN_API_KEY || config.GMGN_API_KEY || '';

    let stdout = '', stderr = '';
    try {
        const res = await execFileAsync(cliPath, args, {
            timeout,
            shell: isWin,
            env: { ...process.env, GMGN_API_KEY: apiKey },
        });
        stdout = res.stdout || '';
        stderr = res.stderr || '';
    } catch (err) {
        stdout = err.stdout || '';
        stderr = err.stderr || '';
        const combined = (stdout + stderr).toString();

        if (combined.includes('RATE_LIMIT_BANNED') || combined.includes('429')) {
            const secMatch = combined.match(/~(\d+)s remaining/);
            const banSecs = secMatch ? parseInt(secMatch[1], 10) + 5 : 65;
            _gmgnRateLimitUntil = Date.now() + banSecs * 1000;
            console.warn(`[GMGN] ⚠️ IP ban detected — cooling down for ${banSecs}s`);
            return null;
        }

        if (err.code === 'ENOENT') {
            console.warn(`[GMGN] gmgn-cli not found — run: npm install -g gmgn-cli`);
        } else if (err.killed) {
            console.warn(`[GMGN] Timeout: gmgn-cli ${args.slice(0, 3).join(' ')}`);
        } else {
            const msg = combined.trim().slice(0, 200);
            if (msg) console.warn(`[GMGN] Error [${args.slice(0, 3).join(' ')}]: ${msg}`);
        }
        return null;
    }

    if (!stdout || !stdout.trim()) return null;
    try {
        return JSON.parse(stdout.trim());
    } catch {
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────


/**
 * Skill: Token Basic Info
 * Queries GMGN API via gmgn-cli for deep token analytics
 */
export async function getGmgnTokenInfo(mint, chain = 'sol', priority = false) {
    const defaultRes = {
        gmgn_price: 0.0, gmgn_mc: 0.0, gmgn_liquidity: 0.0,
        gmgn_rat_pct: 0.0, gmgn_bundler_pct: 0.0, gmgn_top10_rate: 0.0,
        gmgn_smart_wallets: 0, gmgn_renowned_wallets: 0, gmgn_sniper_wallets: 0,
        gmgn_dev_team_hold_rate: 0.0, gmgn_cto_flag: 0, gmgn_checked: false,
    };
    if (!mint) return defaultRes;

    const data = await execGmgn(['token', 'info', '--chain', chain, '--address', mint], 15000, false, priority);
    if (!data || typeof data !== 'object') return defaultRes;

    const stat = data.stat || {};
    const wt = data.wallet_tags_stat || {};
    const dev = data.dev || {};

    return {
        gmgn_price: Number((data.price || {}).price || 0),
        gmgn_mc: Number((Number(data.migration_market_cap || 0)).toFixed(2)),
        gmgn_liquidity: Number(Number(data.liquidity || 0).toFixed(2)),
        gmgn_rat_pct: Number((Number(stat.top_rat_trader_percentage || 0) * 100).toFixed(2)),
        gmgn_bundler_pct: Number((Number(stat.top_bundler_trader_percentage || 0) * 100).toFixed(2)),
        gmgn_insider_pct: Number((Number(stat.suspected_insider_hold_rate || 0) * 100).toFixed(2)),
        gmgn_fresh_wallet_pct: Number((Number(stat.fresh_wallet_rate || 0) * 100).toFixed(2)),
        gmgn_top10_rate: Number((Number(stat.top_10_holder_rate || 0) * 100).toFixed(2)),
        gmgn_smart_wallets: Number(wt.smart_wallets || 0),
        gmgn_renowned_wallets: Number(wt.renowned_wallets || 0),
        gmgn_sniper_wallets: Number(wt.sniper_wallets || 0),
        gmgn_bundler_wallets_count: Number(wt.bundler_wallets || stat.bundler_wallets || 0),
        gmgn_rat_wallets_count: Number(wt.rat_trader_wallets || stat.rat_trader_wallets || 0),
        gmgn_dev_team_hold_rate: Number((Number(stat.dev_team_hold_rate || 0) * 100).toFixed(2)),
        gmgn_dev_wallet: dev.creator_address || dev.creator || dev.address || '',
        gmgn_cto_flag: Number(dev.cto_flag || 0),
        gmgn_checked: true,
    };
}

/**
 * Skill: Token Security Check
 */
export async function getGmgnTokenSecurity(mint, chain = 'sol', priority = false) {
    const defaultRes = {
        is_show_alert: false, top_10_holder_rate: 0.0, burn_ratio: 0.0,
        burn_status: 'unknown', dev_token_burn_ratio: 0.0,
        renounced_freeze_account: true, renounced_mint: true,
        is_honeypot: false, buy_tax: 0.0, sell_tax: 0.0,
        flags: [], hide_risk: false, security_checked: false,
    };
    if (!mint) return defaultRes;

    const data = await execGmgn(['token', 'security', '--chain', chain, '--address', mint], 15000, false, priority);
    if (!data || typeof data !== 'object') return defaultRes;

    return {
        is_show_alert: Boolean(data.is_show_alert),
        top_10_holder_rate: Number((Number(data.top_10_holder_rate || 0) * 100).toFixed(2)),
        burn_ratio: Number((Number(data.burn_ratio || 0) * 100).toFixed(2)),
        burn_status: String(data.burn_status || 'unknown'),
        dev_token_burn_ratio: Number((Number(data.dev_token_burn_ratio || 0) * 100).toFixed(2)),
        renounced_freeze_account: data.renounced_freeze_account === true || data.renounced_freeze_account === null,
        renounced_mint: data.renounced_mint === true || data.renounced_mint === null,
        is_honeypot: Boolean(data.is_honeypot || data.honeypot === 1),
        buy_tax: Number(data.buy_tax || 0),
        sell_tax: Number(data.sell_tax || 0),
        flags: Array.isArray(data.flags) ? data.flags : [],
        hide_risk: Boolean(data.hide_risk),
        security_checked: true,
    };
}

/**
 * Skill: Top100 Holders Analysis
 * Runs: gmgn-cli token holders --chain sol --address <mint> --order-by amount_percentage --direction desc
 */
export async function getGmgnTopHolders(mint, chain = 'sol', priority = false) {
    const defaultRes = { holders: [], top10_pct: 0.0, suspicious_count: 0, suspicious_pct: 0.0, new_wallets_pct: 0.0, holders_checked: false };
    if (!mint) return defaultRes;
    const data = await execGmgn(['token', 'holders', '--chain', chain, '--address', mint, '--order-by', 'amount_percentage', '--direction', 'desc'], 15000, false, priority);
    if (!data || !Array.isArray(data.list)) return defaultRes;
    const list = data.list;
    let top10Sum = 0, suspiciousSum = 0, suspiciousCount = 0, newSum = 0;
    for (let i = 0; i < list.length; i++) {
        const h = list[i];
        const pct = Number(h.amount_percentage || 0) * 100;
        if (i < 10) top10Sum += pct;
        if (h.is_suspicious) { suspiciousSum += pct; suspiciousCount++; }
        if (h.is_new) newSum += pct;
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
 */
export async function getGmgnWalletHoldings(wallet, chain = 'sol', priority = false) {
    if (!wallet) return [];
    const data = await execGmgn(['portfolio', 'holdings', '--chain', chain, '--wallet', wallet], 15000, false, priority);
    if (!data) return [];
    return Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : []);
}

/**
 * Pump.fun Trenches Scanner — background only, no priority bypass
 */
export async function getGmgnPumpfunTrenches(limit = 30) {
    const data = await execGmgn([
        'market', 'trenches', '--chain', 'sol',
        '--type', 'new_creation', 'near_completion',
        '--limit', String(limit),
        '--max-rug-ratio', '0.35', '--max-bundler-rate', '0.25', '--raw',
    ]);
    if (!data || typeof data !== 'object') return [];
    const tokens = [];
    for (const cat of ['new_creation', 'near_completion', 'completed']) {
        for (const item of (data[cat] || [])) {
            if (!item || typeof item !== 'object') continue;
            const launchpad = String(item.launchpad || item.launchpad_platform || '').toLowerCase();
            if (!launchpad.includes('pump') && !String(item.address || '').endsWith('pump')) continue;
            const mint = item.address;
            if (!mint) continue;
            const mc = Number(item.market_cap || 0);
            tokens.push({
                mint, name: item.name || 'Token', symbol: item.symbol || 'TOKEN',
                created_timestamp: Number(item.created_timestamp || Math.floor(Date.now() / 1000)),
                market_cap_sol: mc / 180.0, market_cap_usd: mc,
                liquidity_usd: Number(item.liquidity || 0),
                source: 'gmgn_pumpfun_trenches', uri: null, icon_url: item.logo || null, description: null,
                smart_degen_count: Number(item.smart_degen_count || 0),
                renowned_count: Number(item.renowned_count || 0),
            });
        }
    }
    return tokens;
}

/**
 * KOL-Bought New Tokens — background or on-demand
 */
export async function getGmgnKolBoughtTokens(minRenownedCount = 2, maxMarketCap = 100000, priority = false) {
    const data = await execGmgn([
        'market', 'trenches', '--chain', 'sol', '--type', 'new_creation',
        '--min-renowned-count', String(minRenownedCount),
        '--max-marketcap', String(maxMarketCap), '--raw',
    ], 15000, false, priority);
    if (!data) return [];
    return (data?.new_creation || []).map(item => ({
        mint: item.address, name: item.name, symbol: item.symbol,
        created_timestamp: Number(item.created_timestamp || Math.floor(Date.now() / 1000)),
        market_cap_sol: Number(item.market_cap || 0) / 180.0,
        market_cap_usd: Number(item.market_cap || 0),
        liquidity_usd: Number(item.liquidity || 0),
        source: 'gmgn_kol_bought', icon_url: item.logo || null,
        smart_degen_count: Number(item.smart_degen_count || 0),
        renowned_count: Number(item.renowned_count || 0),
    }));
}

/**
 * Skill: 5-Min / 1-Hour Trending Tokens
 */
export async function getGmgnTrendingTokens(interval = '5m', platform = null, priority = false) {
    const args = ['market', 'trending', '--chain', 'sol', '--interval', interval];
    if (platform) args.push('--platform', platform);
    const data = await execGmgn(args, 15000, false, priority);
    if (!data) return [];
    const list = data?.data?.list || data?.list || [];
    return list.map(item => ({
        mint: item.address, name: item.name, symbol: item.symbol,
        price_usd: Number(item.price || 0),
        market_cap_usd: Number(item.market_cap || 0),
        volume_usd: Number(item.volume || item.volume_usd || 0),
        liquidity_usd: Number(item.liquidity || 0),
        price_change_pct: Number(item.price_change_percent || item.price_change || 0),
        icon_url: item.logo || null,
        renowned_count: Number(item.renowned_count || 0),
        smart_degen_count: Number(item.smart_degen_count || 0),
        source: `gmgn_trending_${interval}`,
    }));
}

/**
 * Skill: Liquidity Pool Analysis
 */
export async function getGmgnTokenPool(mint, chain = 'sol', priority = false) {
    const defaultRes = { pools: [], total_liquidity_usd: 0, main_dex: 'Unknown', pool_checked: false };
    if (!mint) return defaultRes;
    const data = await execGmgn(['token', 'pool', '--chain', chain, '--address', mint], 15000, false, priority);
    if (!data) return defaultRes;
    const poolList = Array.isArray(data) ? data : (data.list || data.pools || (data.pool_address || data.address ? [data] : []));
    let totalLiq = 0;
    const pools = poolList.map(p => {
        const liq = Number(p.liquidity || p.liquidity_usd || 0);
        totalLiq += liq;
        return {
            dex: p.exchange || p.dex_id || p.dex || 'Unknown',
            address: p.pool_address || p.address || '',
            liquidity_usd: liq,
            volume_24h: Number(p.volume_24h || 0),
            price: Number(p.price || 0)
        };
    });
    const mainPool = pools[0] || null;
    return { pools, total_liquidity_usd: Number(totalLiq.toFixed(2)), main_dex: mainPool?.dex || 'Unknown', main_pool_address: mainPool?.address || '', pool_checked: pools.length > 0 };
}

/**
 * Skill: KOL Call Signal
 */
export async function getGmgnKolSignal(chain = 'sol', priority = false) {
    const data = await execGmgn(['market', 'signal', '--chain', chain, '--signal-type', '13'], 15000, false, priority);
    if (!data) return [];
    const list = Array.isArray(data) ? data : (data.list || data.data?.list || []);
    return list.map(item => {
        const d = item.data || {};
        const call = d.call_details?.[0] || {};
        return {
            mint: item.token_address || d.address || item.address || '',
            name: d.name || item.name || 'Token',
            symbol: d.symbol || item.symbol || 'TOKEN',
            signal_type: item.signal_type || 13,
            kol_wallet: item.wallet || call.account || '',
            kol_name: call.account || item.trader_name || item.name || 'KOL Call',
            price_usd: Number(d.price || item.price || 0),
            market_cap_usd: Number(item.market_cap || item.trigger_mc || d.market_cap || 0),
            buy_amount_usd: Number(item.buy_amount_usd || item.amount_usd || 0),
            timestamp: item.trigger_at || item.timestamp || Date.now(),
            icon_url: d.logo || item.logo || null,
            source: 'gmgn_kol_signal',
        };
    });
}

/**
 * Skill: KOL Trades
 */
export async function getGmgnKolTrades(chain = 'sol', side = null, priority = false) {
    const args = ['track', 'kol', '--chain', chain];
    if (side) args.push('--side', side);
    const data = await execGmgn(args, 20000, false, priority);
    if (!data) return [];
    const list = data?.data?.list || data?.list || (Array.isArray(data) ? data : []);
    return list.map(item => {
        const baseToken = item.base_token || {};
        const makerInfo = item.maker_info || {};
        return {
            mint: item.base_address || item.token_address || item.address || '',
            name: baseToken.symbol || item.token_name || item.name || 'Token',
            symbol: baseToken.symbol || item.token_symbol || item.symbol || 'TOKEN',
            kol_wallet: item.maker || item.wallet || '',
            kol_name: makerInfo.twitter_name || makerInfo.twitter_username || makerInfo.name || item.trader_name || 'KOL',
            kol_tag: Array.isArray(makerInfo.tags) ? makerInfo.tags.join(', ') : (item.wallet_tag || ''),
            side: item.side || item.tx_type || 'buy',
            amount_usd: Number(item.amount_usd || item.quote_amount || item.cost_usd || 0),
            price_usd: Number(item.price_usd || item.price || 0),
            market_cap_usd: Number(item.market_cap || 0),
            timestamp: item.timestamp || item.block_time || Date.now(),
            icon_url: baseToken.logo || item.logo || null,
            source: 'gmgn_kol_trades',
        };
    });
}

/**
 * Skill: KOL Holders Analysis
 */
export async function getGmgnKolHolders(mint, chain = 'sol', priority = false) {
    const defaultRes = { kol_holders: [], kol_count: 0, kol_total_pct: 0, kol_holders_checked: false };
    if (!mint) return defaultRes;
    const data = await execGmgn(['token', 'holders', '--chain', chain, '--address', mint, '--tag', 'renowned', '--order-by', 'profit'], 15000, false, priority);
    if (!data || !Array.isArray(data.list)) return defaultRes;
    let totalPct = 0;
    const kols = data.list.map(h => {
        const pct = Number(h.amount_percentage || 0) * 100;
        totalPct += pct;
        return {
            address: h.address || '', name: h.name || h.wallet_tag_v2 || 'KOL', tag: h.wallet_tag_v2 || '',
            holding_pct: Number(pct.toFixed(2)), usd_value: Number(h.usd_value || 0),
            realized_profit: Number(h.realized_profit || 0), unrealized_profit: Number(h.unrealized_profit || 0),
            sell_volume: Number(h.sell_volume_cur || 0),
        };
    });
    return { kol_holders: kols, kol_count: kols.length, kol_total_pct: Number(totalPct.toFixed(2)), kol_holders_checked: true };
}

/**
 * Skill: Dev Info Analysis
 */
export async function getGmgnDevInfo(mint, chain = 'sol', priority = false) {
    const defaultRes = { dev_wallet: '', dev_hold_pct: 0, dev_team_hold_pct: 0, cto_flag: 0, dev_sol_balance: 0, dev_token_balance: 0, dev_checked: false };
    if (!mint) return defaultRes;
    const data = await execGmgn(['token', 'info', '--chain', chain, '--address', mint], 15000, false, priority);
    if (!data || typeof data !== 'object') return defaultRes;
    const dev = data.dev || {}, stat = data.stat || {};
    const devWallet = dev.creator_address || dev.creator || dev.address || '';
    const devHoldPct = Number(stat.creator_hold_rate || dev.hold_rate || dev.holding_rate || 0) * 100;
    const devTeamHoldPct = Number(stat.dev_team_hold_rate || 0) * 100;
    const ctoFlag = Number(dev.cto_flag || 0);
    const devSolBal = Number(dev.sol_balance || 0);
    const devTokenBal = Number(dev.creator_token_balance || dev.token_balance || 0);
    return {
        dev_wallet: devWallet,
        dev_hold_pct: Number(devHoldPct.toFixed(2)),
        dev_team_hold_pct: Number(devTeamHoldPct.toFixed(2)),
        cto_flag: ctoFlag,
        dev_sol_balance: Number(devSolBal.toFixed(4)),
        dev_token_balance: devTokenBal,
        dev_checked: true,
    };
}

/**
 * Skill: Pump.fun Trending Tokens
 */
export async function getGmgnPumpfunTrending(interval = '1h', platform = 'Pump.fun', priority = false) {
    return getGmgnTrendingTokens(interval, platform, priority);
}

/**
 * Skill: Dev Created Tokens Analysis
 * Queries dev's historical launches, migration rate, and highest ATH.
 */
export async function getGmgnDevCreatedTokens(devWallet, chain = 'sol', priority = false) {
    const defaultRes = { tokens: [], total_created: 0, open_count: 0, migration_rate: 0, highest_ath_mc: 0, is_serial_rugger: false, checked: false };
    if (!devWallet) return defaultRes;
    const data = await execGmgn(['portfolio', 'created-tokens', '--chain', chain, '--wallet', devWallet, '--order-by', 'token_ath_mc'], 15000, false, priority);
    if (!data || typeof data !== 'object') return defaultRes;

    const openCount = Number(data.creator_created_open_count ?? data.open_count ?? 0);
    const totalCreated = Number(data.creator_created_count ?? data.inner_count ?? tokensList.length ?? 0);
    const migrationRate = totalCreated > 0 ? (openCount / totalCreated) : Number(data.creator_created_open_ratio ?? data.open_ratio ?? 0);
    const highestAth = Number(data.creator_ath_info?.ath_mc || tokensList[0]?.token_ath_mc || 0);
    const isSerialRugger = totalCreated >= 4 && openCount === 0;

    return {
        tokens: tokensList.slice(0, 10),
        total_created: totalCreated,
        open_count: openCount,
        migration_rate: Number((migrationRate * 100).toFixed(1)),
        highest_ath_mc: highestAth,
        best_token: data.creator_ath_info?.ath_token || tokensList[0]?.symbol || '',
        is_serial_rugger: isSerialRugger,
        checked: true
    };
}

/**
 * Skill: Migrated Token Quality Screener
 * Scans migrated trench tokens with pre-built server-side quality filters.
 */
export async function getGmgnMigratedQuality(chain = 'sol', options = {}, priority = false) {
    const minMc = options.min_mc || 50000;
    const maxMc = options.max_mc || 250000;
    const minLiq = options.min_liq || 10000;
    const maxTop10 = options.max_top10 || 0.2;
    const maxBundle = options.max_bundle || 0.2;
    const maxFresh = options.max_fresh || 0.2;

    const args = [
        'market', 'trenches',
        '--chain', chain,
        '--type', 'completed',
        '--min-marketcap', String(minMc),
        '--max-marketcap', String(maxMc),
        '--min-liquidity', String(minLiq),
        '--max-top-holder-rate', String(maxTop10),
        '--max-bundler-rate', String(maxBundle),
        '--max-fresh-wallet-rate', String(maxFresh)
    ];

    const data = await execGmgn(args, 20000, false, priority);
    if (!data) return [];
    if (Array.isArray(data.completed)) return data.completed;
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data)) return data;
    return [];
}

/**
 * Skill: Smart Money Buy Signals
 * Captures signals where multiple smart money wallets cluster-buy the same token.
 */
export async function getGmgnSmartMoneyBuySignals(chain = 'sol', priority = false) {
    const data = await execGmgn(['market', 'signal', '--chain', chain, '--signal-type', '12'], 20000, false, priority);
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.list)) return data.list;
    return [];
}

/**
 * Skill: Near Completion Tokens
 * Scans Pump.fun tokens near curve completion (80%-95%) with smart money accumulators.
 */
export async function getGmgnNearCompletionTokens(chain = 'sol', minSmartMoney = 2, priority = false) {
    const args = ['market', 'trenches', '--chain', chain, '--type', 'near_completion', '--min-smart-degen-count', String(minSmartMoney)];
    const data = await execGmgn(args, 20000, false, priority);
    if (!data) return [];
    if (Array.isArray(data.near_completion)) return data.near_completion;
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data)) return data;
    return [];
}

/**
 * Skill: Smart Money Exit Signals
 * Tracks smart money sells and large-scale exit dumping across tracked tokens.
 */
export async function getGmgnSmartMoneyExitSignals(chain = 'sol', priority = false) {
    const data = await execGmgn(['track', 'smartmoney', '--chain', chain, '--side', 'sell'], 20000, false, priority);
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.list)) return data.list;
    return [];
}

/**
 * Skill: KOL-Bought New Tokens
 * Filters newly created tokens where verified KOLs have bought in.
 */
export async function getGmgnKolBoughtNewTokens(chain = 'sol', minKol = 2, maxMc = 100000, priority = false) {
    const args = ['market', 'trenches', '--chain', chain, '--type', 'new_creation', '--min-renowned-count', String(minKol), '--max-marketcap', String(maxMc)];
    const data = await execGmgn(args, 20000, false, priority);
    if (!data) return [];
    if (Array.isArray(data.new_creation)) return data.new_creation;
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data)) return data;
    return [];
}


