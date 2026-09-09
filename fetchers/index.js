import * as config from '../config.js';
import { getOnchainMintSecurity, getOnchainTopHolders } from './solanaRpc.js';
import { getDexscreenerData, getPonsRobinhoodPairs } from './dexscreener.js';
import { getRugcheckReport, getPumpfunLivestreamInfo } from './rugcheck.js';
import { getInsightxMetrics, getInsightxAtlasUrl } from './insightx.js';
import { renderInsightXAtlas } from './visualizer.js';
import {
    getGmgnTokenInfo,
    getGmgnTokenSecurity,
    getGmgnTopHolders,
    getGmgnWalletHoldings,
    getGmgnPumpfunTrenches,
    getGmgnKolBoughtTokens,
    getGmgnTrendingTokens,
    getGmgnTokenPool,
    getGmgnKolSignal,
    getGmgnKolTrades,
    getGmgnKolHolders,
    getGmgnDevInfo,
    getGmgnPumpfunTrending,
    getGmgnDevCreatedTokens,
    getGmgnMigratedQuality,
    getGmgnSmartMoneyBuySignals,
    getGmgnNearCompletionTokens,
    getGmgnSmartMoneyExitSignals,
    getGmgnKolBoughtNewTokens,
} from './gmgn.js';
import { callAimlapi, aiEvaluateToken } from './aimlapi.js';
import { getTwitterUserInfo, getTwitterUserTweets, searchTwitter, getHotCryptoNews } from './open6551.js';

export {
    getOnchainMintSecurity,
    getOnchainTopHolders,
    getDexscreenerData,
    getPonsRobinhoodPairs,
    getRugcheckReport,
    getPumpfunLivestreamInfo,
    getInsightxMetrics,
    getInsightxAtlasUrl,
    renderInsightXAtlas,
    getGmgnTokenInfo,
    getGmgnTokenSecurity,
    getGmgnTopHolders,
    getGmgnWalletHoldings,
    getGmgnPumpfunTrenches,
    getGmgnKolBoughtTokens,
    getGmgnTrendingTokens,
    getGmgnTokenPool,
    getGmgnKolSignal,
    getGmgnKolTrades,
    getGmgnKolHolders,
    getGmgnDevInfo,
    getGmgnPumpfunTrending,
    getGmgnDevCreatedTokens,
    getGmgnMigratedQuality,
    getGmgnSmartMoneyBuySignals,
    getGmgnNearCompletionTokens,
    getGmgnSmartMoneyExitSignals,
    getGmgnKolBoughtNewTokens,
    callAimlapi,
    aiEvaluateToken,
    getTwitterUserInfo,
    getTwitterUserTweets,
    searchTwitter,
    getHotCryptoNews,
};

/**
 * Formats a numeric USD value into $XX.Xk or $X.XXM
 * @param {number} val
 * @returns {string}
 */
export function formatMcUsd(val) {
    const num = Number(val || 0);
    if (num >= 1_000_000) {
        return `$${(num / 1_000_000).toFixed(2)}M`;
    } else if (num >= 1_000) {
        return `$${(num / 1_000).toFixed(1)}k`;
    } else {
        return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    }
}

/**
 * Calculates real live market cap combining Dexscreener, GMGN, and Solana price.
 */
export function calculateRealMarketCap(coin, dexPair, gmgnMc = 0, solPrice = 180.0) {
    let mcUsd = 0;
    let priceUsd = 0;
    let source = 'calculated';

    if (dexPair) {
        mcUsd = Number(dexPair.market_cap_usd || dexPair.fdv || 0);
        priceUsd = Number(dexPair.price_usd || 0);
        if (mcUsd > 0) source = 'dexscreener';
    }

    if (mcUsd <= 0 && gmgnMc > 0) {
        mcUsd = gmgnMc;
        source = 'gmgn';
    }

    if (mcUsd <= 0 && coin?.market_cap_sol) {
        const mcSol = Number(coin.market_cap_sol || 0);
        mcUsd = mcSol * solPrice;
        source = 'bonding_curve_sol';
    }

    if (mcUsd <= 0) {
        mcUsd = 30 * solPrice; // default fallback ~ $5.4k
    }

    if (priceUsd <= 0 && mcUsd > 0) {
        priceUsd = mcUsd / 1_000_000_000;
    }

    return { mcUsd, priceUsd, source };
}

/**
 * Generates an algorithmic chart & momentum prediction.
 */
export function getChartPrediction(stats, dexPair) {
    const mc = Number(stats.market_cap_usd || 0);
    const pcM5 = Number(stats.price_change_m5 || 0);
    const buysM5 = Number(stats.buys_m5 || 0);
    const sellsM5 = Number(stats.sells_m5 || 0);
    const totalTxns = buysM5 + sellsM5;
    const buyPressure = totalTxns > 0 ? Math.round((buysM5 / totalTxns) * 100) : 50;

    let pattern = 'Steady Uptrend';
    let emoji = '📈';
    let targetMultiplier = 1.8;
    let confidence = 80;

    if (pcM5 > 15 && buyPressure >= 60) {
        pattern = 'Parabolic Breakout';
        emoji = '🚀';
        targetMultiplier = 2.5;
        confidence = 88;
    } else if (pcM5 > 5 && buyPressure >= 55) {
        pattern = 'Bullish Accumulation';
        emoji = '📈';
        targetMultiplier = 2.0;
        confidence = 82;
    } else if (pcM5 < -10) {
        pattern = 'Dip Retracement';
        emoji = '📉';
        targetMultiplier = 1.3;
        confidence = 65;
    }

    const targetMc = mc * targetMultiplier;
    const supportMc = mc * 0.75;

    return {
        pattern,
        emoji,
        target_mc_str: formatMcUsd(targetMc),
        support_mc_str: formatMcUsd(supportMc),
        confidence_pct: confidence,
        buy_pressure_pct: buyPressure,
    };
}

/**
 * Concurrently builds full stats profile for a token mint.
 * @param {object} coin
 * @param {string} stage
 * @returns {Promise<object|null>}
 */
export async function buildStats(coin, stage = 'Migrated', priority = false) {
    const mint = coin?.mint;
    if (!mint) return null;

    // Parallel fetch: RPC security, Dexscreener, Rugcheck, InsightX, GMGN, Livestream
    const [
        onchainSec,
        dexPair,
        rugcheck,
        liveInfo,
        gmgnData,
        gmgnSecurity,
        gmgnHoldersData,
        insightxData,
    ] = await Promise.all([
        getOnchainMintSecurity(mint).catch(() => null),
        getDexscreenerData(mint).catch(() => null),
        getRugcheckReport(mint).catch(() => null),
        getPumpfunLivestreamInfo(mint).catch(() => null),
        getGmgnTokenInfo(mint, 'sol', priority).catch(() => ({})),
        priority ? getGmgnTokenSecurity(mint, 'sol', true).catch(() => ({})) : Promise.resolve({}),
        priority ? getGmgnTopHolders(mint, 'sol', true).catch(() => ({})) : Promise.resolve({}),
        getInsightxMetrics(mint).catch(() => ({})),
    ]);

    // Top holders & Sybil cluster detection from on-chain RPC fallback if needed
    let topHolders = rugcheck?.top_holders || [];
    let realHolders = Number(rugcheck?.holders || 0);
    let top10Pct = Number(rugcheck?.top10_holders_pct || 0);
    let maxSingleHolderPct = 0;

    if (!topHolders || topHolders.length === 0) {
        if (gmgnHoldersData?.holders?.length > 0) {
            topHolders = gmgnHoldersData.holders.map(h => ({
                address: h.address,
                pct: Number(h.amount_percentage || 0) * 100,
                is_suspicious: Boolean(h.is_suspicious),
                is_new: Boolean(h.is_new),
                tags: h.tags || [],
                name: h.name || null,
            }));
            top10Pct = Number(gmgnHoldersData.top10_pct || 0);
        } else {
            const onchainHolders = await getOnchainTopHolders(mint).catch(() => []);
            if (onchainHolders && onchainHolders.length > 0) {
                topHolders = onchainHolders;
                top10Pct = onchainHolders.slice(0, 10).reduce((acc, h) => acc + (h.pct || 0), 0);
            }
        }
    }

    const poolAddr = String(dexPair?.pair_address || '').toLowerCase();
    if (topHolders && topHolders.length > 0) {
        for (const h of topHolders) {
            const hAddr = String(h.address || '').toLowerCase();
            if (poolAddr && hAddr === poolAddr) continue;
            const p = Number(h.pct || 0);
            if (p < 50.0 && p > maxSingleHolderPct) {
                maxSingleHolderPct = Math.round(p * 10) / 10;
            }
        }
    }

    // Dev wallet & holdings
    let devWallet = coin.creator || rugcheck?.creator || gmgnData?.gmgn_dev_wallet || '';
    let devHoldingsPct = 0.0;
    if (topHolders && devWallet) {
        for (const h of topHolders) {
            if (h.address === devWallet) {
                devHoldingsPct = Math.round(Number(h.pct || 0) * 10) / 10;
                break;
            }
        }
    }
    if (devHoldingsPct <= 0 && gmgnData.gmgn_dev_team_hold_rate) {
        devHoldingsPct = Number(gmgnData.gmgn_dev_team_hold_rate);
    }

    const isHoneypot = Boolean(
        onchainSec?.is_honeypot_risk ||
        (rugcheck?.freeze_authority && rugcheck.freeze_authority !== null) ||
        gmgnSecurity?.is_honeypot ||
        (gmgnSecurity?.renounced_freeze_account === false) ||
        (gmgnSecurity?.buy_tax > 0 || gmgnSecurity?.sell_tax > 0)
    );
    const isMintable = Boolean(
        onchainSec?.mintable ||
        (rugcheck?.mint_authority && rugcheck.mint_authority !== null) ||
        (gmgnSecurity?.renounced_mint === false)
    );

    const holders = Math.max(realHolders, Number(gmgnHoldersData?.holders?.length || 0), (dexPair ? 10 : 2));
    const lpBurned = stage === 'Migrated' ? true : Boolean(rugcheck?.lp_burned ?? true);

    // Resolve Name & Symbol
    let name = coin.name;
    if (!name || name === '?') {
        name = dexPair?.name || rugcheck?.name || 'Token';
    }
    let symbol = coin.symbol;
    if (!symbol || symbol === '?') {
        symbol = dexPair?.symbol || rugcheck?.symbol || 'SOL';
    }

    // Real Market Cap calculation
    const gmgnMc = Number(gmgnData.gmgn_mc || 0);
    const { mcUsd, priceUsd } = calculateRealMarketCap(coin, dexPair, gmgnMc, 180.0);
    const marketCapSol = mcUsd / 180.0;
    const fdvVal = Number(dexPair?.fdv || mcUsd);

    // Activity stats
    const activity = {
        price_change_m5: Number(dexPair?.price_change_m5 || 0),
        price_change_h1: Number(dexPair?.price_change_h1 || 0),
        price_change_h24: Number(dexPair?.price_change_h24 || 0),
        buys_m5: Number(dexPair?.buys_m5 || 0),
        sells_m5: Number(dexPair?.sells_m5 || 0),
        volume_m5: Number(dexPair?.volume_m5 || 0),
        volume_h1: Number(dexPair?.volume_h1 || 0),
        liquidity_usd: Number(dexPair?.liquidity_usd || 0),
    };

    // Socials
    const socials = {
        has_twitter: Boolean(dexPair?.twitter_url || rugcheck?.twitter_url),
        has_telegram: Boolean(dexPair?.telegram_url || rugcheck?.telegram_url),
        has_website: Boolean(dexPair?.website_url || rugcheck?.website_url),
        twitter_url: dexPair?.twitter_url || rugcheck?.twitter_url || '',
        telegram_url: dexPair?.telegram_url || rugcheck?.telegram_url || '',
        website_url: dexPair?.website_url || rugcheck?.website_url || '',
    };

    // Multi-source Cluster, Bundler, and Sybil Fan-out Detection
    const clusterPct = Math.max(Number(insightxData.cluster_pct || 0), Number(gmgnHoldersData?.suspicious_pct || 0));
    const bundlersPct = Math.max(Number(insightxData.bundlers_pct || 0), Number(gmgnData.gmgn_bundler_pct || 0));
    const snipersPct = Math.max(Number(insightxData.snipers_pct || 0), Number(gmgnData.gmgn_top70_sniper_pct || 0));
    const insidersPct = Math.max(Number(insightxData.insiders_pct || 0), Number(gmgnData.gmgn_insider_pct || 0), Number(rugcheck?.insiders_pct || 0));
    const bubblemapUrl = getInsightxAtlasUrl(mint);

    let isSybilCluster = false;
    let sybilReason = '';

    if (clusterPct >= 5.0) {
        isSybilCluster = true;
        sybilReason = `Connected bubblemap cluster holds ${clusterPct.toFixed(1)}% (max 5.0%)`;
    } else if (bundlersPct >= 5.0) {
        isSybilCluster = true;
        sybilReason = `Bundler ring holds ${bundlersPct.toFixed(1)}% (max 5.0%)`;
    } else if ((clusterPct + bundlersPct + insidersPct) >= 8.0) {
        isSybilCluster = true;
        sybilReason = `Combined spiderweb network holds ${(clusterPct + bundlersPct + insidersPct).toFixed(1)}% (max 8.0%)`;
    } else if (Number(gmgnData.gmgn_bundler_wallets_count || 0) >= 5) {
        isSybilCluster = true;
        sybilReason = `Coordinated bundler group (${gmgnData.gmgn_bundler_wallets_count} wallets)`;
    } else if (Number(gmgnHoldersData?.suspicious_count || 0) >= 3 && Number(gmgnHoldersData?.suspicious_pct || 0) >= 3.0) {
        isSybilCluster = true;
        sybilReason = `Multiple suspicious connected wallets (${gmgnHoldersData.suspicious_pct.toFixed(1)}%)`;
    }

    // Icon & Banner URL
    let iconUrl = dexPair?.icon_url || rugcheck?.icon_url || coin.icon_url || null;
    let bannerUrl = dexPair?.banner_url || rugcheck?.banner_url || coin.banner_url || null;

    if ((!iconUrl || !bannerUrl) && coin?.uri) {
        try {
            const ipfsUrl = String(coin.uri).replace('ipfs://', 'https://cf-ipfs.com/ipfs/');
            const resp = await fetch(ipfsUrl, { signal: AbortSignal.timeout(2500) });
            if (resp.ok) {
                const meta = await resp.json();
                if (!iconUrl && meta?.image) {
                    iconUrl = String(meta.image).replace('ipfs://', 'https://cf-ipfs.com/ipfs/');
                }
                if (!bannerUrl && (meta?.banner || meta?.header)) {
                    bannerUrl = String(meta.banner || meta.header).replace('ipfs://', 'https://cf-ipfs.com/ipfs/');
                }
            }
        } catch {}
    }

    // Resolve Chain and Launchpad
    let chainName = 'Solana';
    let chainIcon = '<:solana:1546954132424753182>';
    let launchpadName = 'Pump.fun';

    const dexIdStr = String(dexPair?.dex_id || '').toLowerCase();
    const sourceStr = String(coin.source || '').toLowerCase();

    if (dexIdStr.includes('robinhood') || sourceStr.includes('robinhood')) {
        chainName = 'Robinhood';
        chainIcon = '<:hood:1546954132424753182>';
        launchpadName = 'Robinhood';
    } else if (dexIdStr.includes('pons') || sourceStr.includes('pons')) {
        chainName = 'Solana';
        chainIcon = '<:solana:1546954132424753182>';
        launchpadName = 'Pons';
    } else if (dexIdStr.includes('launchlab')) {
        launchpadName = 'LaunchLab';
    } else if (dexIdStr.includes('moonshot')) {
        launchpadName = 'Moonshot';
    } else {
        launchpadName = 'Pump.fun';
    }

    const networkBadge = `${chainIcon} ${chainName} @ ${launchpadName}`;

    // Top holders percentage list (for embed display)
    const topHoldersPcts = topHolders.slice(0, 5).map(h => Number(h.pct || 0));

    const fullStats = {
        mint,
        name,
        symbol: symbol.toUpperCase(),
        dev_wallet: devWallet,
        price_usd: priceUsd,
        created_timestamp: coin.created_timestamp || (dexPair?.pair_created_at ? dexPair.pair_created_at : Date.now()),
        top_holders_pcts: topHoldersPcts,
        market_cap_sol: marketCapSol,
        market_cap_usd: mcUsd,
        fdv: fdvVal,
        initial_market_cap_sol: coin.initial_market_cap_sol || marketCapSol,
        peak_market_cap_sol: coin.peak_market_cap_sol || marketCapSol,
        mc_trend: coin.mc_trend || 'flat',
        mc_delta_sol: coin.mc_delta_sol || 0.0,
        trades_count: coin.trades_count || 0,
        market_cap_display: formatMcUsd(mcUsd),
        holders,
        top10_holders_pct: top10Pct,
        max_single_holder_pct: maxSingleHolderPct,
        lp_burned: lpBurned,
        dev_holdings_pct: devHoldingsPct,
        snipers_pct: snipersPct,
        insiders_pct: insidersPct,
        bundlers_pct: bundlersPct,
        cluster_pct: clusterPct,
        is_sybil_cluster: isSybilCluster,
        sybil_reason: sybilReason,
        traders_24h: holders,
        total_fees: 0.0,
        smart_traders: Number(gmgnData.gmgn_smart_wallets || 0),
        dex_paid: Boolean(dexPair?.dex_paid || false),
        icon_url: iconUrl,
        banner_url: bannerUrl,
        is_honeypot: isHoneypot,
        is_mintable: isMintable,
        danger_risks: rugcheck?.danger_risks || [],
        risk_score: rugcheck?.risk_score || 0,
        pro_traders: 'None Detected',
        pair_address: dexPair?.pair_address || null,
        dex_url: dexPair?.dex_url || `https://dexscreener.com/solana/${mint}`,
        bubblemap_url: bubblemapUrl,
        is_live: Boolean(liveInfo?.is_live || false),
        live_viewers: Number(liveInfo?.viewers || 0),
        has_good_viewers: Boolean(liveInfo?.has_good_viewers || false),
        chain_name: chainName,
        chain_icon: chainIcon,
        launchpad_name: launchpadName,
        network_badge: networkBadge,
        ...activity,
        ...socials,
        ...gmgnData,
        ...gmgnSecurity,
        gmgn_is_show_alert: Boolean(gmgnSecurity?.is_show_alert),
        gmgn_suspicious_pct: Number(gmgnHoldersData?.suspicious_pct || 0),
        gmgn_suspicious_count: Number(gmgnHoldersData?.suspicious_count || 0),
        gmgn_flags: gmgnSecurity?.flags || [],
        gmgn_top100_holders: gmgnHoldersData?.holders || [],
    };

    fullStats.chart_prediction = getChartPrediction(fullStats, dexPair);

    return fullStats;
}
