/**
 * Narrative & On-Chain Anti-Rug Security Evaluator (Node.js).
 * Screens and verifies tokens across New Pairs, Final Stretch, and Migrated stages.
 */

import * as config from './config.js';

const GENERIC_SLOP_TICKERS = new Set([
    'test', 'pump', 'anon', 'coin', 'token', 'rug', 'dev',
    'null', 'undefined', 'sample', 'airdrop', 'scam', 'dump'
]);

const GENERIC_SLOP_DESCRIPTIONS = [
    'test token', 'test coin', 'first coin', 'first token', 'buy or cry', 'to the moon',
    'dev sold', '100x gem', '100x', 'pump it up', 'pump it', 'hold to rich', 'cto soon',
    'welcome to the revolutionary', 'community take over', 'solana meme', 'good coin'
];

export function isSlopToken(stats) {
    const name = String(stats.name || '').trim();
    const symbol = String(stats.symbol || '').trim();
    const desc = String(stats.description || '').trim().toLowerCase();

    if (!name || ['?', 'None', 'Token'].includes(name) || !symbol || ['?', 'None', 'TOKEN'].includes(symbol)) {
        return [true, 'Missing or generic token identity'];
    }

    const symClean = symbol.toLowerCase().replace(/\$/g, '').trim();
    const nameClean = name.toLowerCase().trim();

    if (GENERIC_SLOP_TICKERS.has(symClean) && nameClean.split(/\s+/).length <= 1) {
        return [true, `Generic slop ticker: $${symbol}`];
    }

    if (/[bcdfghjklmnpqrstvwxyz]{6,}/i.test(symClean)) {
        return [true, `Gibberish consonant mash symbol: $${symbol}`];
    }

    if (symClean.length >= 4 && new Set(symClean.split('')).size <= 1) {
        return [true, `Single repetitive character symbol: $${symbol}`];
    }

    const keyboardMashes = ['asdf', 'qwerty', 'zxcv', '12345', 'hjkl'];
    if (keyboardMashes.some(k => symClean.includes(k) || nameClean.includes(k))) {
        return [true, `Keyboard mash slop: $${symbol} (${name})`];
    }

    if (desc) {
        if (desc.length < 15 && ['test', 'coin', 'buy', 'moon', 'dev sold', 'cto', 'pump'].some(p => desc.includes(p))) {
            return [true, `Low-effort placeholder description: '${desc}'`];
        }
        for (const generic of GENERIC_SLOP_DESCRIPTIONS) {
            if (desc.includes(generic) && desc.length < 60) {
                return [true, `Copycat template description slop: '${desc}'`];
            }
        }
    }

    const tw = String(stats.twitter_url || '').toLowerCase();
    if (tw && (tw.includes('pump.fun') || tw.includes('x.com/pumpdotfun') || tw.includes('x.com/search'))) {
        return [true, 'Fake/circular Twitter link pointing to pump.fun platform'];
    }

    return [false, ''];
}

export function isStaircaseChartRug(stats) {
    const buysM5 = Number(stats.buys_m5 || 0);
    const sellsM5 = Number(stats.sells_m5 || 0);
    const holders = Number(stats.holders || 0);
    const clusterPct = Number(stats.cluster_pct || 0);
    const bundlersPct = Number(stats.bundlers_pct || 0);
    const createdTs = Number(stats.created_timestamp || 0);
    const tsSec = createdTs > 1e11 ? createdTs / 1000 : createdTs;
    const ageSec = tsSec > 0 ? (Date.now() / 1000) - tsSec : 999;

    if (ageSec < 120) return [false, ''];

    if (buysM5 >= 15 && sellsM5 === 0 && (clusterPct > 20 || bundlersPct > 20)) {
        return [true, `Staircase Bundle Manipulation: ${buysM5} buys with 0 sells & ${clusterPct.toFixed(1)}% cluster / ${bundlersPct.toFixed(1)}% bundlers`];
    }

    if (ageSec > 180 && buysM5 >= 20 && sellsM5 === 0 && holders < 10) {
        return [true, `Staircase Chart Rug: ${buysM5} automated buys with 0 sells & low holders (${holders})`];
    }

    return [false, ''];
}

export function isInstantSpikeDumpRug(stats) {
    const mcUsd = Number(stats.market_cap_usd || 0);
    const devPct = Number(stats.dev_holdings_pct || 0);
    const holders = Number(stats.holders || 0);
    const top10Pct = Number(stats.top10_holders_pct || 0);
    const clusterPct = Number(stats.cluster_pct || 0);
    const bundlersPct = Number(stats.bundlers_pct || 0);
    const buysM5 = Number(stats.buys_m5 || 0);
    const sellsM5 = Number(stats.sells_m5 || 0);
    const priceChg5m = Number(stats.price_change_m5 || 0);
    const smartW = Number(stats.gmgn_smart_wallets || stats.smart_traders || 0);
    const renownedW = Number(stats.gmgn_renowned_wallets || 0);

    // Image 2 Pattern: Pumped to $45k-$120k MC, dev dumped (devPct <= 0),
    // supply concentrated in clusters/bundlers, and sells matching/exceeding buys with barcode bleed
    if (mcUsd >= 40000 && mcUsd <= 130000) {
        if (devPct <= 0.05 && (clusterPct > 8.0 || bundlersPct > 8.0) && sellsM5 >= buysM5 && smartW === 0 && renownedW === 0) {
            return [true, `Instant Migration Dump & Bleed: Dev dumped (0% dev), ${clusterPct.toFixed(1)}% clusters, sell pressure ${sellsM5} sells vs ${buysM5} buys`];
        }
        if (holders < 40 && top10Pct > 40.0) {
            return [true, `Artificial Migration Spike: Only ${holders} holders at $${Math.round(mcUsd / 1000)}k MC with ${top10Pct.toFixed(1)}% Top-10 concentration`];
        }
        if (priceChg5m < -4.0 && sellsM5 >= (buysM5 * 1.5)) {
            return [true, `Post-Migration Selloff: 5m change ${priceChg5m.toFixed(1)}% with heavy exit sells (${sellsM5} sells vs ${buysM5} buys)`];
        }
    }

    return [false, ''];
}

export function isSybilClusterRug(stats) {
    const clusterPct = Number(stats.cluster_pct || 0);
    const bundlersPct = Number(stats.bundlers_pct || 0);
    const insidersPct = Number(stats.insiders_pct || 0);
    const totalClusterRisk = clusterPct + bundlersPct + insidersPct;
    const suspPct = Number(stats.gmgn_suspicious_pct || 0);

    // Image 1 Pattern: 2 interconnected distributor nodes funding dozens of child wallets
    if (clusterPct >= 14.0 && bundlersPct >= 12.0) {
        return [true, `Connected Sybil Hub Network: InsightX shows ${clusterPct.toFixed(1)}% cluster + ${bundlersPct.toFixed(1)}% bundlers (Interconnected distributor nodes)`];
    }
    if (totalClusterRisk >= 22.0) {
        return [true, `High Sybil Concentration: Combined cluster, bundlers & insiders control ${totalClusterRisk.toFixed(1)}% (max 22.0%)`];
    }
    if (suspPct > 8.0) {
        return [true, `GMGN Suspicious Wallets: ${suspPct.toFixed(1)}% held by suspicious wallets (max 8.0%)`];
    }
    return [false, ''];
}

export function evaluateCoin(stats, stage = 'New Pair') {
    const reasons = [];

    let name = String(stats.name || '').trim();
    let symbol = String(stats.symbol || '').trim();
    const mcUsd = Number(stats.market_cap_usd || 0);
    const holders = Number(stats.holders || 0);
    const devPct = Number(stats.dev_holdings_pct || 0);
    const top10Pct = Number(stats.top10_holders_pct || 0);
    const singlePct = Number(stats.max_single_holder_pct || 0);
    const bundlersPct = Number(stats.bundlers_pct || 0);
    const insidersPct = Number(stats.insiders_pct || 0);
    const snipersPct = Number(stats.snipers_pct || 0);
    const clusterPct = Number(stats.cluster_pct || 0);
    const dangerRisks = stats.danger_risks || [];
    const lpBurned = Boolean(stats.lp_burned);
    const lpLockedPct = Number(stats.lp_locked_pct || 0);
    const liqUsd = Number(stats.liquidity_usd || 0);

    if (!name || ['?', 'None', ''].includes(name)) {
        name = symbol && !['?', 'None', ''].includes(symbol) ? symbol : 'Token';
    }
    if (!symbol || ['?', 'None', ''].includes(symbol)) {
        symbol = name ? name.slice(0, 6).toUpperCase() : 'TOKEN';
    }

    // Slop Detection Gate
    const [isSlop, slopReason] = isSlopToken(stats);
    if (isSlop) {
        return [false, [`❌ Slop Detected: ${slopReason}`], 'rejected'];
    }

    // GMGN Alert Gate
    if (stats.gmgn_is_show_alert) {
        return [false, ['❌ GMGN Direct Security Alert: Token flagged as rug / high risk by GMGN'], 'rejected'];
    }

    // Fatal On-Chain Checks
    if (stats.is_honeypot) {
        return [false, ['❌ Honeypot / Freeze Authority is active (Buyers cannot sell)'], 'rejected'];
    }
    if (stats.is_mintable) {
        return [false, ['❌ Mintable supply risk (Dev can print infinite tokens)'], 'rejected'];
    }

    const [isStaircase, staircaseMsg] = isStaircaseChartRug(stats);
    if (isStaircase) {
        return [false, [`❌ ${staircaseMsg}`], 'rejected'];
    }

    const [isInstantSpike, instantSpikeMsg] = isInstantSpikeDumpRug(stats);
    if (isInstantSpike) {
        return [false, [`❌ ${instantSpikeMsg}`], 'rejected'];
    }

    const [isSybil, sybilMsg] = isSybilClusterRug(stats);
    if (isSybil) {
        return [false, [`❌ ${sybilMsg}`], 'rejected'];
    }

    // LP Lock/Burn check for pump.fun Migrated
    if (stage === 'Migrated' && !lpBurned && lpLockedPct < 85.0) {
        return [false, [`❌ Liquidity Pool Unlocked on DEX: Only ${lpLockedPct.toFixed(1)}% locked/burned (High Rug Pull Risk)`], 'rejected'];
    }

    if (dangerRisks.length >= 1) {
        return [false, [`❌ RugCheck Critical Security Risk: ${dangerRisks[0]}`], 'rejected'];
    }

    const isLive = Boolean(stats.is_live);
    const liveViewers = Number(stats.live_viewers || 0);
    const hasGoodViewers = Boolean(stats.has_good_viewers) || (isLive && liveViewers >= config.PUMPFUN_MIN_GOOD_VIEWERS);

    // Strict Anti-Rug Dynamic thresholds (blocks bubblemap clusters, spiderwebs & dev dumps)
    const devLimit = hasGoodViewers ? 8.0 : 6.0;
    const devInsiderLimit = hasGoodViewers ? 12.0 : 10.0;
    const singleLimit = hasGoodViewers ? 8.0 : 6.0;
    const top10Limit = hasGoodViewers ? 30.0 : 25.0;
    const bundlerLimit = 5.0;
    const sniperLimit = 6.0;
    const clusterLimit = 5.0;
    const spiderwebLimit = 8.0;
    const minHolders = 10;

    // Gate 0: Min MC Check ($20k+ as requested by user, no upper ceiling)
    const minCallMc = config.MIN_CALL_MC_USD || 20000;
    if (mcUsd < minCallMc) {
        return [false, [`❌ Market Cap below $20k threshold ($${Math.round(mcUsd).toLocaleString()} < $${Math.round(minCallMc).toLocaleString()})`], 'rejected'];
    }

    // Gate A: Dev Launch History (Anti-Serial Rugger)
    if (stats.is_serial_rugger) {
        return [false, [`❌ Serial Rugger Dev: Dev launched ${stats.dev_created_count || 0} tokens with 0 migrations`], 'rejected'];
    }

    // Gate B: Dev Holdings
    if (devPct > devLimit) {
        return [false, [`❌ High Dev Dump Risk: Dev holds ${devPct.toFixed(1)}% (max ${devLimit.toFixed(1)}%)`], 'rejected'];
    }
    if ((devPct + insidersPct) > devInsiderLimit) {
        return [false, [`❌ Dev + Insider Concentration: Combined dev & insiders hold ${(devPct + insidersPct).toFixed(1)}% (max ${devInsiderLimit.toFixed(1)}%)`], 'rejected'];
    }

    // Gate C: Single Whale
    if (singlePct > singleLimit) {
        return [false, [`❌ Whale Dump Risk: Top non-pool holder holds ${singlePct.toFixed(1)}% (max ${singleLimit.toFixed(1)}%)`], 'rejected'];
    }

    // Gate D: Top 10
    if (top10Pct > top10Limit) {
        return [false, [`❌ High Top-10 Concentration: Top 10 hold ${top10Pct.toFixed(1)}% (max ${top10Limit.toFixed(1)}%)`], 'rejected'];
    }

    // Gate E: Holder Count
    if (holders < minHolders) {
        return [false, [`❌ Low Holder Count: Only ${holders} holders (min ${minHolders})`], 'rejected'];
    }

    // Gate F: Bundlers & Snipers
    if (bundlersPct > bundlerLimit) {
        return [false, [`❌ Coordinated Jito Bundler Ring: Bundlers hold ${bundlersPct.toFixed(1)}% (max ${bundlerLimit.toFixed(1)}%)`], 'rejected'];
    }
    if (snipersPct > sniperLimit) {
        return [false, [`❌ Slot 0 / Block 0 Sniping: Snipers hold ${snipersPct.toFixed(1)}% (max ${sniperLimit.toFixed(1)}%)`], 'rejected'];
    }

    // Gate H: Momentum
    const priceChg5m = Number(stats.price_change_m5 || 0);
    const buysM5 = Number(stats.buys_m5 || 0);
    const sellsM5 = Number(stats.sells_m5 || 0);
    const volM5 = Number(stats.volume_m5 || 0);
    const smartW = Number(stats.gmgn_smart_wallets || stats.smart_traders || 0);
    const renownedW = Number(stats.gmgn_renowned_wallets || 0);

    if (priceChg5m < -18.0) {
        return [false, [`❌ Active Selloff / Dump: 5m price change ${priceChg5m.toFixed(1)}%`], 'rejected'];
    }
    if ((buysM5 + sellsM5) >= 10 && sellsM5 > (buysM5 * 2.5)) {
        return [false, [`❌ Heavy Sell Pressure: ${sellsM5} sells vs ${buysM5} buys in 5m`], 'rejected'];
    }

    if (stage === 'New Pair') {
        if (priceChg5m < 0 && smartW === 0 && renownedW === 0 && !hasGoodViewers) {
            return [false, [`❌ Negative Momentum on New Pair: 5m change ${priceChg5m > 0 ? '+' : ''}${priceChg5m.toFixed(1)}% with no KOL/Smart Money`], 'rejected'];
        }
    }

    const isMovingUp = (priceChg5m >= 0) ||
        (buysM5 > sellsM5 && volM5 >= 150) ||
        (smartW >= 1 || renownedW >= 1) ||
        hasGoodViewers ||
        (['Migrated', 'Pons', 'Robinhood'].includes(stage) && priceChg5m >= -8.0);

    if (!isMovingUp) {
        return [false, [`❌ Stagnant / Flat Coin: 5m Change ${priceChg5m.toFixed(1)}%, Vol $${Math.round(volM5)} (No clear upward trend)`], 'rejected'];
    }

    // Gate J: InsightX Cluster & Spiderweb Evaluation
    if (stats.is_sybil_cluster) {
        return [false, [`❌ Bubblemap Sybil Fan-out Cluster: ${stats.sybil_reason || 'Connected bot network'}`], 'rejected'];
    }
    if (clusterPct > clusterLimit) {
        return [false, [`❌ Connected Bubblemap Cluster: ${clusterPct.toFixed(1)}% held in connected cluster (max ${clusterLimit.toFixed(1)}%)`], 'rejected'];
    }

    const totalClusterRisk = clusterPct + bundlersPct + insidersPct;
    if (totalClusterRisk > spiderwebLimit) {
        return [false, [`❌ Multi-Cluster Spiderweb Ring: Combined clusters hold ${totalClusterRisk.toFixed(1)}% (max ${spiderwebLimit.toFixed(1)}%)`], 'rejected'];
    }

    // GMGN Checks
    const gmgnRat = Number(stats.gmgn_rat_pct || 0);
    if (gmgnRat > 2.0) {
        return [false, [`❌ GMGN Rat Trader Risk: ${gmgnRat.toFixed(1)}% held by rat wallets (max 2.0%)`], 'rejected'];
    }
    const gmgnBundler = Number(stats.gmgn_bundler_pct || 0);
    if (gmgnBundler > 5.0) {
        return [false, [`❌ GMGN Bundler Ring: ${gmgnBundler.toFixed(1)}% bundled at launch (max 5.0%)`], 'rejected'];
    }
    const gmgnSusp = Number(stats.gmgn_suspicious_pct || 0);
    if (gmgnSusp > 3.0) {
        return [false, [`❌ GMGN Suspicious Wallets: ${gmgnSusp.toFixed(1)}% held by suspicious wallets (max 3.0%)`], 'rejected'];
    }
    const gmgnDevTeam = Number(stats.gmgn_dev_team_hold_rate || 0);
    if (gmgnDevTeam > 5.0) {
        return [false, [`❌ GMGN Dev Team Holdings: ${gmgnDevTeam.toFixed(1)}% held by dev team (max 5.0%)`], 'rejected'];
    }

    // Stage label
    const stageLabels = {
        'New Pair': '🟢 Early Runner',
        'Final Stretch': '⚡ About to Migrate (85%+ Curve)',
        'Migrated': '🚀 Raydium Migration',
        'Pons': '🅿 Pons Launch',
        'Robinhood': '🤝 Robinhood Token',
    };
    const label = stageLabels[stage] || `⚡ ${stage}`;
    const liveNote = isLive ? ` | 🔴 Live (${liveViewers} viewers)` : '';
    reasons.push(
        `✅ ${label}: $${symbol} | MC $${Math.round(mcUsd).toLocaleString()} | ${holders} holders | Dev ${devPct}% | Top10 ${top10Pct}%${liveNote}`
    );

    return [true, reasons, 'confirmed'];
}
