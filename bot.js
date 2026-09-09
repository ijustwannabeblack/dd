import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as config from './config.js';
import {
    buildStats,
    formatMcUsd,
    callAimlapi,
    aiEvaluateToken,
    renderInsightXAtlas,
    getInsightxAtlasUrl,
    getPonsRobinhoodPairs,
    getGmgnPumpfunTrenches,
    getGmgnKolBoughtTokens,
    getGmgnTrendingTokens,
    getGmgnTokenSecurity,
    getGmgnTopHolders,
    getGmgnWalletHoldings,
    getGmgnTokenPool,
    getGmgnKolSignal,
    getGmgnKolTrades,
    getGmgnKolHolders,
    getGmgnDevInfo,
    getGmgnPumpfunTrending,
    getTwitterUserInfo,
    getHotCryptoNews,
    getDexscreenerData,
} from './fetchers/index.js';
import { evaluateCoin } from './filters.js';
import { PumpPortalStream } from './streams/pumpportal.js';

// ─── Global Crash Guards ──────────────────────────────────────────────────────
// Prevent stray async errors / rejected promises from killing the bot process
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[CRASH GUARD] Unhandled Rejection:`, reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error(`[CRASH GUARD] Uncaught Exception:`, err?.message || err);
    // Don't exit — log and keep running
});
// ─────────────────────────────────────────────────────────────────────────────

const AUTHORIZED_DISCORD_USER_ID = '1415022792214052915';
const SEEN_FILE = path.resolve(process.cwd(), 'seen_mints.json');
const TRACKERS_FILE = path.resolve(process.cwd(), 'active_trackers.json');

// Memory state
let seen = new Set();
let queued = new Set();
let activeTrackers = new Map();
let lastCaFetchTs = new Map();

function loadSeen() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            const raw = fs.readFileSync(SEEN_FILE, 'utf8');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                seen = new Set(arr);
            }
        }
    } catch (e) {
        console.warn(`[Bot] Could not load seen_mints.json: ${e.message}`);
    }
}

function saveSeen() {
    try {
        const arr = Array.from(seen).slice(-500);
        seen = new Set(arr);
        fs.writeFileSync(SEEN_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
        console.warn(`[Bot] Could not save seen_mints.json: ${e.message}`);
    }
}

// Low-memory container maintenance (cleans stale caches every 3 mins)
setInterval(() => {
    if (seen.size > 600) {
        seen = new Set(Array.from(seen).slice(-400));
    }
    const now = Date.now();
    for (const [k, v] of lastCaFetchTs.entries()) {
        if (now - v > 60000) lastCaFetchTs.delete(k);
    }
    if (global.gc) {
        try { global.gc(); } catch {}
    }
}, 180000);

function loadTrackers() {
    try {
        if (fs.existsSync(TRACKERS_FILE)) {
            const raw = fs.readFileSync(TRACKERS_FILE, 'utf8');
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object') {
                activeTrackers = new Map(Object.entries(obj));
            }
        }
    } catch (e) {
        console.warn(`[Bot] Could not load active_trackers.json: ${e.message}`);
    }
}

function saveTrackers() {
    try {
        const obj = Object.fromEntries(activeTrackers);
        fs.writeFileSync(TRACKERS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.warn(`[Bot] Could not save active_trackers.json: ${e.message}`);
    }
}

const PREMIUM_FILE = path.resolve(process.cwd(), 'premium_users.json');
let premiumUsers = new Set();

function loadPremiumUsers() {
    try {
        if (fs.existsSync(PREMIUM_FILE)) {
            const raw = fs.readFileSync(PREMIUM_FILE, 'utf8');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                premiumUsers = new Set(arr);
            }
        }
    } catch (e) {
        console.warn(`[Bot] Could not load premium_users.json: ${e.message}`);
    }
    if (process.env.PREMIUM_USER_IDS) {
        process.env.PREMIUM_USER_IDS.split(',').forEach(id => {
            const clean = id.trim();
            if (clean) premiumUsers.add(clean);
        });
    }
}

function savePremiumUsers() {
    try {
        const arr = Array.from(premiumUsers);
        fs.writeFileSync(PREMIUM_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
        console.warn(`[Bot] Could not save premium_users.json: ${e.message}`);
    }
}

// Call on startup
loadSeen();
loadTrackers();
loadPremiumUsers();

function isPremiumUser(message) {
    if (!message || !message.author) return false;
    const authorId = message.author.id;
    if (authorId === AUTHORIZED_DISCORD_USER_ID) return true;
    if (premiumUsers.has(authorId)) return true;
    if (message.member && message.member.roles && message.member.roles.cache) {
        const hasRole = message.member.roles.cache.some(r => {
            const name = r.name.toLowerCase();
            return name === 'premium' || name === 'vip' || (process.env.PREMIUM_ROLE_ID && r.id === process.env.PREMIUM_ROLE_ID);
        });
        if (hasRole) return true;
    }
    return false;
}

function sendPremiumRequiredNotice(message, cmdName) {
    const embed = new EmbedBuilder()
        .setTitle('🔒 Premium Access Required')
        .setDescription(
            `The \`${cmdName}\` command is exclusively available to **Premium** users.\n\n` +
            `💎 **How to unlock access:**\n` +
            `• Hold the **Premium** or **VIP** Discord role, or\n` +
            `• Have your user ID whitelisted by the bot owner.\n\n` +
            `*Contact <@${AUTHORIZED_DISCORD_USER_ID}> to get Premium access.*`
        )
        .setColor(0xF59E0B)
        .setFooter({ text: 'Larpifyy Premium Intelligence' });

    return message.channel.send({ embeds: [embed] });
}

function copyCaToClipboard(mint) {
    if (!mint || process.platform !== 'win32') return;
    try {
        const proc = exec('clip.exe');
        proc.stdin.write(mint.trim());
        proc.stdin.end();
        console.log(`📋 [CLIPBOARD] Auto-copied CA to clipboard: ${mint}`);
    } catch (e) {
        console.warn(`[CLIPBOARD] Failed to copy: ${e.message}`);
    }
}

/**
 * Builds the canonical Discord call embed matching user's exact specification.
 */
function buildMigratedEmbed(stats) {
    const name = stats.name || 'Token';
    const symbol = (stats.symbol || 'TOKEN').toUpperCase();
    const mint = stats.mint;

    const mcUsd = Number(stats.market_cap_usd || 0);
    const fdvVal = Number(stats.fdv || mcUsd);
    const mcStr = formatMcUsd(mcUsd);
    const fdvStr = formatMcUsd(fdvVal);

    const priceUsd = Number(stats.price_usd || 0);
    let priceStr = 'N/A';
    if (priceUsd > 0) {
        priceStr = priceUsd < 0.00001 ? priceUsd.toFixed(8).replace(/\.?0+$/, '') : priceUsd.toFixed(6).replace(/\.?0+$/, '');
    }

    const priceChangeM5 = Number(stats.price_change_m5 || 0);
    const liqUsd = Number(stats.liquidity_usd || 0);
    const liqStr = liqUsd > 0 ? formatMcUsd(liqUsd) : 'N/A';
    const volH1 = Number(stats.volume_h1 || stats.volume_m5 || 0);
    const volStr = volH1 > 0 ? formatMcUsd(volH1) : 'N/A';

    const createdTs = Number(stats.created_timestamp || 0);
    let ageStr = '1m';
    if (createdTs > 0) {
        const tsSec = createdTs > 1e11 ? createdTs / 1000 : createdTs;
        const ageSec = Math.max(0, (Date.now() / 1000) - tsSec);
        if (ageSec < 3600) {
            ageStr = `${Math.max(1, Math.floor(ageSec / 60))}m`;
        } else if (ageSec < 86400) {
            ageStr = `${Math.floor(ageSec / 3600)}h`;
        } else {
            ageStr = `${Math.floor(ageSec / 86400)}d`;
        }
    }

    const dexUrl = stats.dex_url || `https://dexscreener.com/solana/${mint}`;
    const pumpUrl = `https://pump.fun/${mint}`;
    const titleUrl = dexUrl.includes('dexscreener') ? dexUrl : pumpUrl;
    const bmapUrl = stats.bubblemap_url || getInsightxAtlasUrl(mint);
    const websiteUrl = stats.website_url || titleUrl;
    const twitterUrl = stats.twitter_url || titleUrl;

    const protoBadge = stats.source === 'pons' ? '🅿 ' : (stats.source === 'robinhood' ? '🤝 ' : '');
    const titleText = `${protoBadge}[${name}] [${mcStr}/${priceChangeM5 >= 0 ? '+' : ''}${priceChangeM5.toFixed(1)}%] - ${symbol}/SOL`;

    const descLines = [];
    if (stats.is_live) {
        const viewers = Number(stats.live_viewers || 0);
        const hype = viewers >= 8 ? ' 🔥 (Good Viewers)' : '';
        descLines.push(`🔴 **LIVE ON PUMP.FUN:** [${viewers} Viewers](${pumpUrl})${hype}\n`);
    }

    const networkBadge = stats.network_badge || '<:solana:1546954132424753182> Solana @ Pump.fun';

    descLines.push(
        `${networkBadge}\n`,
        `💰 **USD:** \`${priceStr}\``,
        `💎 **MC / FDV:** \`${mcStr}\` / \`${fdvStr}\` \`[${ageStr}]\``,
        `💧 **Liq:** \`${liqStr}\` \`[x1]\``,
        `📊 **Vol:** \`${volStr}\` · **Age:** \`${ageStr}\`\n`
    );

    const kolCount = Number(stats.gmgn_renowned_wallets || 0);
    const smartCount = Number(stats.gmgn_smart_wallets || stats.smart_traders || 0);
    const proTraders = stats.pro_traders || 'None Detected';

    const badges = [];
    if (kolCount > 0) badges.push(`👑 **KOL Buyers:** \`${kolCount}\``);
    if (smartCount > 0) badges.push(`🧠 **Smart Money:** \`${smartCount}\``);
    if (proTraders && proTraders !== 'None Detected') badges.push(`🎯 **Pro Traders:** \`${proTraders}\``);

    if (badges.length > 0) {
        descLines.push(badges.join(' · ') + '\n');
    }

    descLines.push(
        `📈 **Chart:** [DEX](${dexUrl}) · [DEF](https://defined.fi/sol/${mint}) · [Axiom](https://axiom.trade/pair/${mint})`,
        `🚘 **More:** [InsightX Atlas](${bmapUrl}) · [Web](${websiteUrl}) · [𝕏](${twitterUrl}) · [Lore](${pumpUrl})\n`,
        `📋 **CA (tap to copy on mobile):**\n\`${mint}\``
    );

    const embed = new EmbedBuilder()
        .setTitle(titleText)
        .setURL(titleUrl)
        .setDescription(descLines.join('\n'))
        .setColor(0xFF8C00)
        .setFooter({ text: 'dyor before buying any call' });

    if (stats.icon_url) {
        embed.setThumbnail(stats.icon_url);
    }
    if (stats.banner_url) {
        embed.setImage(stats.banner_url);
    }

    return embed;
}

// Discord Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

let targetChannel = null;
let plainCaChannel = null;
let rejectedChannel = null;
let winsChannel = null;
let doneChannel = null;

async function sendCallAlertInstantly(item) {
    const { stats, embed, stage, stageKey } = item;
    if (seen.has(stageKey)) return;
    seen.add(stageKey);
    saveSeen();

    const mint = stats.mint;

    try {
        const targetId = String(config.TARGET_CHANNEL_ID || '1540840819790184458');
        const channel = targetChannel || client.channels.cache.get(targetId) || await client.channels.fetch(targetId).catch(() => null);

        if (channel) {
            const liveTag = stats.is_live ? ` 🔴 **LIVE (${stats.live_viewers || 0} viewers)**` : '';
            const content = `<@&1540865315678720090> 🚀 **$${stats.symbol}** (${stats.name}) Called @ **${stats.market_cap_display}**${liveTag}`;

            await channel.send({ content, embeds: [embed] });
        }

        // Send to plain CA channel if configured
        const plainId = String(config.PLAIN_CA_CHANNEL_ID || '1541513168239460464');
        const pChan = plainCaChannel || client.channels.cache.get(plainId) || await client.channels.fetch(plainId).catch(() => null);
        if (pChan) {
            try {
                await pChan.send({ content: mint });
                console.log(`📋 [INSTANT] Posted plain CA ${mint} to CA channel ${plainId}`);
            } catch {}
        }

        console.log(`⚡ [INSTANT ALERT SENT] [${stage}] ${stats.symbol} (${mint}) — Holders: ${stats.holders}, MC: ${stats.market_cap_display}`);
    } catch (e) {
        console.error(`[Bot] Failed to post instant alert for ${mint}: ${e.message}`);
    }
}

async function processCoin(stage, coin, retryCount = 0) {
    const mint = coin?.mint;
    const stageKey = `${stage}:${mint}`;
    if (!mint || seen.has(stageKey) || queued.has(stageKey)) return;

    queued.add(stageKey);

    let stats = null;
    try {
        stats = await buildStats(coin, stage);
    } catch (e) {
        console.warn(`[${stage}] buildStats error for ${mint}: ${e.message}`);
    }

    if (!stats) {
        if (retryCount < 1 && stage !== 'New Pair') {
            await new Promise(r => setTimeout(r, 500));
            return processCoin(stage, coin, retryCount + 1);
        }
        return;
    }

    // Strict checks: NEVER send coins with < 2 holders
    if (Number(stats.holders || 0) < 2) {
        console.log(`[${stage}] ${stats.symbol} (${mint}) dropped: only ${stats.holders} holder(s)`);
        return;
    }

    // Post-restart protection: Do NOT blast old coins (>15m)
    const createdTs = Number(stats.created_timestamp || 0);
    if (createdTs > 0) {
        const tsSec = createdTs > 1e11 ? createdTs / 1000 : createdTs;
        const ageMins = ((Date.now() / 1000) - tsSec) / 60;
        if (ageMins > 15.0) {
            console.log(`[${stage}] ${stats.symbol} (${mint}) skipped: old coin (${ageMins.toFixed(0)}m old)`);
            return;
        }
    }

    // Launchpad enforcement on Solana: ONLY pump.fun tokens allowed
    const chainName = stats.chain_name || 'Solana';
    const launchpadName = stats.launchpad_name || 'Pump.fun';
    if (chainName === 'Solana' && stage !== 'Pons') {
        if (launchpadName !== 'Pump.fun') {
            console.log(`[${stage}] ${stats.symbol} (${mint}) skipped: launchpad ${launchpadName} not pump.fun`);
            return;
        }
    }

    // Market cap range check
    if (!config.IGNORE_MARKET_CAP) {
        const minMc = stage === 'Final Stretch' ? 28000.0 : (config.MIGRATED_MIN_MC_USD || 30000);
        const mcVal = Number(stats.market_cap_usd || 0);
        if (mcVal < minMc || mcVal > (config.MAX_MC_USD || 100000.0)) {
            console.log(`[${stage}] ${stats.symbol} (${mint}) dropped: MC $${mcVal.toLocaleString()} outside range`);
            return;
        }
    }

    const [passes, reasons, alertType] = evaluateCoin(stats, stage);
    let aiFailed = false;
    let aiRejectReason = '';

    if (passes) {
        const aiEval = await aiEvaluateToken(stats);
        if (!aiEval.passes) {
            aiFailed = true;
            aiRejectReason = `AI Rejected: ${aiEval.reason}`;
            console.log(`[${stage}] $${stats.symbol} (${mint}) AI evaluation failed: ${aiRejectReason}`);
        }
    }

    if (!passes || aiFailed) {
        console.log(`[${stage}] ${stats.symbol} (${mint}) rejected. Sending to rejected channel...`);
        const rejChan = rejectedChannel || client.channels.cache.get(String(config.REJECTED_CHANNEL_ID || '1541182755705065603'));
        if (rejChan) {
            try {
                const rejEmbed = buildMigratedEmbed(stats);
                const reasonStr = aiFailed ? aiRejectReason : (reasons[reasons.length - 1] || 'Filter check failed');
                rejEmbed.setFooter({ text: `⚠️ REJECTED COIN: ${reasonStr}` });
                await rejChan.send({
                    content: `⚠️ **FAILED / REJECTED COIN**: \`${mint}\`\n**Reason:** ${reasonStr}`,
                    embeds: [rejEmbed],
                });
            } catch {}
        }
        return;
    }

    const embed = buildMigratedEmbed(stats);

    // Auto copy CA to Windows clipboard
    copyCaToClipboard(mint);

    activeTrackers.set(mint, {
        mint,
        symbol: stats.symbol || 'TOKEN',
        name: stats.name || 'Token',
        called_mc: Number(stats.market_cap_usd || 0),
        call_time: Date.now(),
        ath_mc: Number(stats.market_cap_usd || 0),
        reported: false,
        mid_pump_reported: false,
    });
    saveTrackers();

    await sendCallAlertInstantly({
        stats,
        embed,
        stage,
        alert_type: alertType,
        stageKey,
    });
}

// Background Scanners
async function activeRunnerScanner() {
    await new Promise(r => setTimeout(r, 4000));
    console.log('🔍 Active Solana Runner Scanner started.');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 12000));

            const resp = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) continue;
            const profiles = await resp.json();

            const solTokens = (Array.isArray(profiles) ? profiles : []).filter(p => p && p.chainId === 'solana');

            const seenBatch = new Set();
            for (const item of solTokens.slice(0, 30)) {
                const mint = item.tokenAddress;
                if (!mint || seenBatch.has(mint) || seen.has(`Migrated:${mint}`)) continue;
                seenBatch.add(mint);

                const pair = await getDexscreenerData(mint).catch(() => null);
                if (!pair) continue;

                const mc = Number(pair.market_cap_usd || 0);
                if (!config.IGNORE_MARKET_CAP) {
                    if (mc < 28000 || mc > (config.MAX_MC_USD || 100000)) continue;
                }

                const pcM5 = Number(pair.price_change_m5 || 0);
                const volM5 = Number(pair.volume_m5 || 0);
                if (pcM5 < 0.0 && volM5 < 1500.0) continue;

                const stage = mc >= 30000 ? 'Migrated' : 'Final Stretch';
                const stageKey = `${stage}:${mint}`;
                if (seen.has(stageKey) || queued.has(stageKey)) continue;

                const coin = {
                    mint,
                    symbol: pair.symbol || item.symbol || 'TOKEN',
                    name: pair.name || item.name || 'Token',
                    created_timestamp: Date.now(),
                    market_cap_sol: mc / 180.0,
                    source: 'active_runner_scanner',
                };

                processCoin(stage, coin);
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

async function ponsRobinhoodScanner() {
    await new Promise(r => setTimeout(r, 8000));
    const interval = config.DEXSCREENER_POLL_INTERVAL || 15;
    console.log(`🅿🤝 Pons/Robinhood scanner started — polling every ${interval}s`);

    while (true) {
        try {
            await new Promise(r => setTimeout(r, interval * 1000));

            if (config.STAGES.pons) {
                const ponsPairs = await getPonsRobinhoodPairs(config.PONS_DEX_IDS).catch(() => []);
                for (const coin of ponsPairs) {
                    const mint = coin.mint;
                    if (!mint || seen.has(`Pons:${mint}`) || queued.has(`Pons:${mint}`)) continue;
                    coin.source = 'pons';
                    processCoin('Pons', coin);
                }
            }

            if (config.STAGES.robinhood) {
                const rhoodPairs = await getPonsRobinhoodPairs(config.ROBINHOOD_DEX_IDS).catch(() => []);
                for (const coin of rhoodPairs) {
                    const mint = coin.mint;
                    if (!mint || seen.has(`Robinhood:${mint}`) || queued.has(`Robinhood:${mint}`)) continue;
                    coin.source = 'robinhood';
                    processCoin('Robinhood', coin);
                }
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

async function gmgnTrenchesScanner() {
    await new Promise(r => setTimeout(r, 15000));
    console.log('🌱 GMGN Trenches Scanner started (Pump.fun smart money & anti-rug screener).');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 45000)); // 45s — stay within GMGN rate limits
            const coins = await getGmgnPumpfunTrenches(30).catch(() => []);
            for (const coin of coins) {
                const mint = coin.mint;
                if (!mint) continue;

                const stage = Number(coin.market_cap_usd || 0) >= 28000 ? 'Final Stretch' : 'New Pair';
                const stageKey = `${stage}:${mint}`;
                if (seen.has(stageKey) || queued.has(stageKey)) continue;

                processCoin(stage, coin);
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

/**
 * Periodically scans GMGN KOL buy signals & trending tokens.
 * Only tokens that pass the full anti-rug & AI audit pipeline will be called
 * with the exact canonical embed and real on-chain stats.
 */
async function gmgnOpportunityScanner() {
    await new Promise(r => setTimeout(r, 25000));
    console.log('👑 GMGN Opportunity Scanner started (feeds candidate coins through full anti-rug audit).');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 90000)); // 90s — rate-limit safe

            // 1. Check KOL Buy Signals
            const signals = await getGmgnKolSignal('sol').catch(() => []);
            for (const sig of (signals || []).slice(0, 5)) {
                const mint = sig.mint;
                if (!mint) continue;
                const stage = 'Migrated';
                const stageKey = `${stage}:${mint}`;
                if (seen.has(stageKey) || queued.has(stageKey)) continue;

                const coin = {
                    mint,
                    symbol: sig.symbol || 'TOKEN',
                    name: sig.name || 'Token',
                    created_timestamp: sig.timestamp || Date.now(),
                    source: 'kol_signal',
                };
                // Full pipeline: buildStats -> evaluateCoin anti-rug -> aiEvaluateToken -> canonical embed
                processCoin(stage, coin);
            }

            await new Promise(r => setTimeout(r, 10000));

            // 2. Check 5m Pump.fun Trending
            const trending = await getGmgnTrendingTokens('5m', 'Pump.fun').catch(() => []);
            for (const t of (trending || []).slice(0, 3)) {
                const mint = t.mint;
                if (!mint) continue;
                const stage = 'Migrated';
                const stageKey = `${stage}:${mint}`;
                if (seen.has(stageKey) || queued.has(stageKey)) continue;

                const coin = {
                    mint,
                    symbol: t.symbol || 'TOKEN',
                    name: t.name || 'Token',
                    created_timestamp: Date.now(),
                    source: 'gmgn_trending',
                };
                // Full pipeline: buildStats -> evaluateCoin anti-rug -> aiEvaluateToken -> canonical embed
                processCoin(stage, coin);
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 15000));
        }
    }
}

async function trackCalledCoinsPerformance() {
    await new Promise(r => setTimeout(r, 10000));
    console.log('📈 Profit & Performance Tracker started.');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 20000));
            if (!activeTrackers.size) continue;

            const now = Date.now();
            const toRemove = [];
            let updated = false;

            for (const [mint, tracker] of activeTrackers.entries()) {
                const elapsed = (now - tracker.call_time) / 1000;

                const pair = await getDexscreenerData(mint).catch(() => null);
                const currMc = Number(pair?.market_cap_usd || 0);

                if (currMc > tracker.ath_mc) {
                    tracker.ath_mc = currMc;
                    updated = true;
                }

                const calledMc = tracker.called_mc;
                const athMc = tracker.ath_mc;
                const symbol = (tracker.symbol || 'TOKEN').toUpperCase();

                // Mid-run live profit update (2x or higher ONLY)
                if (elapsed < 1200 && !tracker.mid_pump_reported) {
                    const mult = calledMc > 0 ? (Math.max(currMc, athMc) / calledMc) : 1.0;
                    if (mult >= 2.0 && calledMc > 0) {
                        const calledStr = `${formatMcUsd(calledMc)} MC`;
                        const currStr = `${formatMcUsd(Math.max(currMc, athMc))} MC`;

                        const winEmbed = new EmbedBuilder()
                            .setTitle('🏆 PROFIT UPDATE')
                            .setDescription(`**${symbol}** — ${calledStr} → ${currStr} ${mult.toFixed(2)}x`)
                            .setColor(0xFF8C00);

                        const wChan = winsChannel || client.channels.cache.get(String(config.WINS_CHANNEL_ID || '1540839154882056363'));
                        if (wChan) {
                            try {
                                await wChan.send({ embeds: [winEmbed] });
                                console.log(`🏆 Posted profit update for $${symbol}: ${calledStr} -> ${currStr} ${mult.toFixed(2)}x`);
                            } catch {}
                        }

                        tracker.mid_pump_reported = true;
                        updated = true;
                    }
                }

                // 20-minute Lifecycle Summary (DONE coins only)
                if (elapsed >= 1200 && !tracker.reported) {
                    const calledStr = `${formatMcUsd(calledMc)} MC`;
                    const athStr = `${formatMcUsd(athMc)} MC`;
                    const athMult = calledMc > 0 ? (athMc / calledMc) : 1.0;

                    if (athMult > 1.5) {
                        const doneEmbed = new EmbedBuilder()
                            .setTitle('🏁 COIN DONE')
                            .setDescription(`**${symbol}** — ${calledStr} → ${athStr} ${athMult.toFixed(2)}x`)
                            .setColor(0xFF8C00)
                            .setFooter({ text: 'dyor before buying any call' });

                        const dChan = doneChannel || client.channels.cache.get(String(config.DONE_CHANNEL_ID || '1541133072781811712'));
                        if (dChan) {
                            try {
                                await dChan.send({ embeds: [doneEmbed] });
                                console.log(`🏁 Posted DONE summary for $${symbol}: ${calledStr} -> ${athStr} ${athMult.toFixed(2)}x`);
                            } catch {}
                        }
                    }

                    tracker.reported = true;
                    toRemove.push(mint);
                    updated = true;
                }
            }

            for (const m of toRemove) {
                activeTrackers.delete(m);
            }

            if (updated || toRemove.length > 0) {
                saveTrackers();
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

client.once('clientReady', async () => {
    console.log(`🤖 Logged in as ${client.user.tag}`);
    loadSeen();
    loadTrackers();

    const targetId = String(config.TARGET_CHANNEL_ID || '1540840819790184458');
    targetChannel = await client.channels.fetch(targetId).catch(() => null);
    console.log(`📢 Calls channel: #${targetChannel?.name || targetId}`);

    const plainId = String(config.PLAIN_CA_CHANNEL_ID || '1541513168239460464');
    plainCaChannel = await client.channels.fetch(plainId).catch(() => null);

    const rejId = String(config.REJECTED_CHANNEL_ID || '1541182755705065603');
    rejectedChannel = await client.channels.fetch(rejId).catch(() => null);

    const winsId = String(config.WINS_CHANNEL_ID || '1540839154882056363');
    winsChannel = await client.channels.fetch(winsId).catch(() => null);

    const doneId = String(config.DONE_CHANNEL_ID || '1541133072781811712');
    doneChannel = await client.channels.fetch(doneId).catch(() => null);

    // Start background tasks
    activeRunnerScanner();
    ponsRobinhoodScanner();
    gmgnTrenchesScanner();
    trackCalledCoinsPerformance();
    gmgnOpportunityScanner();

    // Start PumpPortal WebSocket Stream
    const stream = new PumpPortalStream({
        onNewToken: (coin) => {
            if (config.STAGES.new_pairs) processCoin('New Pair', coin);
        },
        onMigration: (coin) => {
            if (config.STAGES.migrated) processCoin('Migrated', coin);
        },
        onFinalStretch: (coin) => {
            if (config.STAGES.final_stretch) processCoin('Final Stretch', coin);
        },
        onRug: (coin) => {
            console.log(`[RUG] ${coin.symbol} (${coin.mint}) dropped ${coin.rug_drop_pct}%`);
        },
    });
    stream.runForever();
});

// Command & Message Router
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();
    const aiChanId = String(config.AI_CHAT_CHANNEL_ID || '1541166799620542524');

    // 0. AI Chat Channel automated responder
    if (message.channel.id === aiChanId) {
        const caMatch = content.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
        const caStr = caMatch ? caMatch[0] : null;

        let tokenContext = '';
        if (caStr) {
            try {
                const stats = await buildStats({ mint: caStr }, 'Migrated');
                if (stats) {
                    tokenContext = `\n\n[LIVE ON-CHAIN CONTEXT FOR CA: ${caStr}]\n` +
                        `Symbol: $${stats.symbol} (${stats.name})\n` +
                        `Real MC: ${stats.market_cap_display}\n` +
                        `Holders: ${stats.holders}\n` +
                        `Dev: ${stats.dev_holdings_pct}%\n` +
                        `Top 10: ${stats.top10_holders_pct}%\n` +
                        `Clusters: ${stats.cluster_pct}%\n` +
                        `Bundlers: ${stats.bundlers_pct}%\n` +
                        `LP: ${stats.lp_burned ? '100% Burned' : 'Unburned'}`;
                }
            } catch {}
        }

        const systemPrompt = 'You are an expert Solana memecoin AI trader and anti-rug auditor. ' +
            'Provide direct, concise, high-IQ and friendly trading thoughts. ' +
            'State numbers and analysis directly without disclaimer filler.';

        try {
            await message.channel.sendTyping();
            const aiReply = await callAimlapi([{ role: 'user', content: `${content}${tokenContext}` }], systemPrompt);
            await message.channel.send(aiReply || '🤖 Token evaluated. Check dev holdings and cluster network before entry.');
        } catch (err) {
            await message.channel.send(`🤖 AI Assistant error: \`${err.message}\``);
        }
        return;
    }

    // 0.5. .help command
    if (content === '.help' || content === '/help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('🤖 Larpifyy Memecoin & GMGN Intelligence Bot')
            .setDescription(
                `Welcome! Here are all the available commands:\n\n` +
                `### 🔎 Token Analysis & Security\n` +
                `• \`.check <mint>\` — Full audit & InsightX Atlas bubble map\n` +
                `• \`.mc <mint>\` *(or paste CA)* — Live market cap, price & liquidity\n` +
                `• \`.predict <mint>\` — AI chart prediction & target MC\n` +
                `• \`.security <mint>\` — GMGN anti-rug & honeypot audit\n` +
                `• \`.holders <mint>\` — GMGN Top 100 holders concentration & snipers\n` +
                `• \`.devinfo <mint>\` — Dev wallet holdings, balance & CTO status\n` +
                `• \`.pool <mint>\` — Liquidity pool analysis & DEX breakdown\n\n` +
                `### 👑 KOL & Market Signals\n` +
                `• \`.signal\` — Latest KOL buy signals (type 13)\n` +
                `• \`.koltrades [buy|sell]\` — Real-time renowned KOL trades\n` +
                `• \`.kolholders <mint>\` — Renowned KOL holders ranked by profit\n` +
                `• \`.kol\` / \`.trenches\` — New tokens bought by >=2 renowned KOLs\n` +
                `• \`.trending\` — Top 5-minute Solana trending tokens\n` +
                `• \`.pumptop [1h|5m]\` — Top Pump.fun trending tokens\n` +
                `• \`.wallet <addr>\` — Check any wallet's portfolio holdings\n` +
                `• \`.news\` / \`.twitter <handle>\` — Crypto breaking news & X search`
            )
            .setColor(0x3B82F6)
            .setFooter({ text: 'Larpifyy Trading Bot • Type any command with a CA' });
        return message.channel.send({ embeds: [helpEmbed] });
    }

    // 1. .check <mint> command (InsightX Atlas Audit + Visualizer)
    if (content.startsWith('.check') || content.startsWith('/check')) {
        if (!isPremiumUser(message)) {
            return sendPremiumRequiredNotice(message, '.check');
        }

        const parts = content.split(/\s+/);
        if (parts.length < 2) {
            return message.channel.send('⚠️ Please provide a contract address.\nUsage: `.check <mint>`');
        }

        const mint = parts[1].trim();
        await message.channel.send(`🔎 Scanning token stats & InsightX Atlas audit for \`${mint}\`...`);

        try {
            const stats = await buildStats({ mint }, 'Migrated', true);
            if (!stats) {
                return message.channel.send(`❌ Failed to fetch token data for \`${mint}\`.`);
            }

            const [passes, reasons] = evaluateCoin(stats, 'Migrated');
            const symbol = (stats.symbol || 'TOKEN').toUpperCase();
            const name = stats.name || symbol;
            const mcStr = stats.market_cap_display || '$0';
            const devPct = Number(stats.dev_holdings_pct || 0);
            const singlePct = Number(stats.max_single_holder_pct || 0);
            const top10Pct = Number(stats.top10_holders_pct || 0);
            const holders = Number(stats.holders || 0);
            const clusterPct = Number(stats.cluster_pct || 0);
            const bundlersPct = Number(stats.bundlers_pct || 0);
            const snipersPct = Number(stats.snipers_pct || 0);
            const bmapUrl = getInsightxAtlasUrl(mint);
            const dexUrl = stats.dex_url || `https://dexscreener.com/solana/${mint}`;
            const pumpUrl = `https://pump.fun/${mint}`;
            const axiomUrl = `https://axiom.trade/pair/${mint}`;

            // Format age
            let ageStr = '1m';
            if (stats.created_timestamp) {
                const tsSec = stats.created_timestamp > 1e11 ? stats.created_timestamp / 1000 : stats.created_timestamp;
                const diff = Math.max(0, (Date.now() / 1000) - tsSec);
                if (diff < 60) ageStr = `${Math.floor(diff)}s`;
                else if (diff < 3600) ageStr = `${Math.floor(diff / 60)}m`;
                else if (diff < 86400) ageStr = `${Math.floor(diff / 3600)}h`;
                else ageStr = `${Math.floor(diff / 86400)}d`;
            }

            // Format volume & 5M activity
            const volStr = formatMcUsd(stats.volume_h1 || stats.volume_m5 || 0);
            const vol5mStr = formatMcUsd(stats.volume_m5 || 0);
            const pcM5 = Number(stats.price_change_m5 || 0);
            const buysM5 = stats.buys_m5 || 0;
            const sellsM5 = stats.sells_m5 || 0;

            // Format top holders
            let thStr = '0.0';
            if (stats.top_holders_pcts && stats.top_holders_pcts.length > 0) {
                thStr = stats.top_holders_pcts.slice(0, 5).map(p => Number(p).toFixed(1)).join('·');
            } else if (singlePct > 0) {
                thStr = `${singlePct.toFixed(1)}·0.0·0.0·0.0·0.0`;
            }

            // Dev & LP status
            const devStr = devPct <= 0 ? '❌ (0% Sold)' : `${devPct.toFixed(1)}%`;
            const lpStr = stats.lp_burned ? '100% Burned' : 'Unburned';

            // Verdict and Reason
            let verdictHeader = '';
            let verdictReason = '';
            if (passes) {
                verdictHeader = '🛡️ **VERDICT:** ✅ **PASSED (SAFE TO TRADE)**';
                verdictReason = '💡 *Low cluster concentration, dev holdings safe, no honeypot flags.*';
            } else {
                verdictHeader = '🛡️ **VERDICT:** 🚨 **HIGH RUG / CONCENTRATION RISK**';
                const mainReason = reasons.length > 0 ? reasons.slice(-2).join(' • ') : 'Failed anti-rug gate thresholds';
                verdictReason = `⚠️ **Why:** *${mainReason}*`;
            }

            const desc = [
                verdictHeader,
                verdictReason,
                '',
                `⏳ **@ ${stats.launchpad_name || 'Pump.fun'}**`,
                `💎 **FDV / MC:** \`${mcStr}\``,
                `📊 **Vol:** \`${volStr}\` · **Age:** \`${ageStr}\``,
                `🚀 **5M:** \`${vol5mStr}\` · \`${pcM5 >= 0 ? '+' : ''}${pcM5.toFixed(1)}%\` 🅱 \`${buysM5}\` Ⓢ \`${sellsM5}\``,
                '',
                `👤 **TH:** \`${thStr}\` \`[${top10Pct.toFixed(1)}%]\``,
                `🤝 **Total:** \`${holders.toLocaleString()}\` holders`,
                `🫧 **Clusters:** \`${clusterPct.toFixed(1)}%\` · **Bundlers:** \`${bundlersPct.toFixed(1)}%\` · **Snipers:** \`${snipersPct.toFixed(1)}%\``,
                `🧑 **DEV:** \`${devStr}\` · **LP:** \`${lpStr}\``,
                `📈 **Chart:** [DEX](${dexUrl}) · [Axiom](${axiomUrl})`,
                `🚘 **More:** [InsightX Atlas](${bmapUrl}) · [𝕏](${stats.twitter_url || dexUrl}) · [Lore](${pumpUrl})`,
                '',
                `\`${mint}\``,
            ].join('\n');

            const checkEmbed = new EmbedBuilder()
                .setTitle(`${passes ? '🟢' : '🚨'} ${name} - $${symbol}`)
                .setURL(dexUrl)
                .setDescription(desc)
                .setColor(passes ? 0x10B981 : 0xEF4444)
                .setFooter({ text: `Audit requested by ${message.author.tag} • InsightX Network` });

            if (stats.icon_url) {
                checkEmbed.setThumbnail(stats.icon_url);
            }

            const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`copy_ca_${mint}`)
                    .setLabel('Copy CA')
                    .setEmoji('📋')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setLabel('InsightX Atlas')
                    .setStyle(ButtonStyle.Link)
                    .setURL(bmapUrl)
                    .setEmoji('🫧'),
                new ButtonBuilder()
                    .setLabel('DexScreener')
                    .setStyle(ButtonStyle.Link)
                    .setURL(dexUrl)
                    .setEmoji('📈'),
            );

            // Capture real InsightX Atlas cluster screenshot
            let attachment = null;
            try {
                const atlasBuffer = await renderInsightXAtlas(mint, stats).catch(() => null);
                if (atlasBuffer && (Buffer.isBuffer(atlasBuffer) || atlasBuffer.length > 0)) {
                    attachment = new AttachmentBuilder(Buffer.from(atlasBuffer), { name: 'insightx_atlas.png' });
                    checkEmbed.setImage('attachment://insightx_atlas.png');
                }
            } catch (snapErr) {
                console.warn(`[Visualizer] Snapshot note: ${snapErr.message}`);
            }

            if (attachment) {
                await message.channel.send({ embeds: [checkEmbed], components: [actionRow], files: [attachment] });
            } else {
                await message.channel.send({ embeds: [checkEmbed], components: [actionRow] });
            }
        } catch (err) {
            console.error(`[.check] Error: ${err.message}`);
            await message.channel.send(`❌ Error checking token: \`${err.message}\``);
        }
        return;
    }

    // 2. .predict <mint>
    if (content.startsWith('.predict') || content.startsWith('/predict')) {
        const parts = content.split(/\s+/);
        if (parts.length < 2) {
            return message.channel.send('⚠️ Please provide a contract address.\nUsage: `.predict <mint>`');
        }

        const mint = parts[1].trim();
        await message.channel.send(`🤖 Generating chart & momentum prediction for \`${mint}\`...`);

        try {
            const stats = await buildStats({ mint }, 'Migrated', true);
            if (!stats) return message.channel.send(`❌ Failed to fetch token data for \`${mint}\`.`);

            const pred = stats.chart_prediction || {};
            const predEmbed = new EmbedBuilder()
                .setTitle(`🤖 AI PRICE & CHART PREDICTION: $${stats.symbol} (${stats.name})`)
                .setDescription(
                    `**CA:** \`${mint}\`\n\n` +
                    `### ${pred.emoji || '📈'} **${pred.pattern || 'Steady Uptrend'}**\n` +
                    `🎯 **Target Market Cap:** **${pred.target_mc_str || 'N/A'}**\n` +
                    `🛡️ **Key Support Level:** **${pred.support_mc_str || 'N/A'}**\n` +
                    `🧠 **AI Confidence Rating:** **${pred.confidence_pct || 80}%**\n` +
                    `📊 **Buy Pressure:** **${pred.buy_pressure_pct || 50}% Buys**`
                )
                .setColor(0xFF8C00)
                .addFields({
                    name: '🔗 Quick Chart Links',
                    value: `[DexScreener](${stats.dex_url}) • [InsightX Atlas](${stats.bubblemap_url})`,
                    inline: false,
                })
                .setFooter({ text: 'Always DYOR • AI Trading Analysis' });

            await message.channel.send({ embeds: [predEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error predicting token: \`${err.message}\``);
        }
        return;
    }

    // 3. .results <mint>
    if (content.startsWith('.results') || content.startsWith('/results')) {
        if (message.author.id !== AUTHORIZED_DISCORD_USER_ID) {
            return message.channel.send(`⚠️ Only authorized user <@${AUTHORIZED_DISCORD_USER_ID}> can run this command.`);
        }

        const parts = content.split(/\s+/);
        if (parts.length < 2) {
            return message.channel.send('⚠️ Please provide a contract address.\nUsage: `.results <mint>`');
        }

        const mint = parts[1].trim();
        await message.channel.send(`🔍 Fetching fresh live results for \`${mint}\`...`);

        try {
            const pair = await getDexscreenerData(mint);
            if (!pair) return message.channel.send(`⚠️ No pair found for \`${mint}\`.`);

            const currMc = Number(pair.market_cap_usd || 0);
            const tracker = activeTrackers.get(mint);
            const calledMc = tracker ? tracker.called_mc : currMc;
            const athMc = tracker ? Math.max(tracker.ath_mc, currMc) : currMc;
            const mult = calledMc > 0 ? (currMc / calledMc) : 1.0;
            const athMult = calledMc > 0 ? (athMc / calledMc) : 1.0;

            const resEmbed = new EmbedBuilder()
                .setTitle(`📊 RESULTS: $${pair.symbol} (${pair.name})`)
                .setDescription(
                    `**CA:** \`${mint}\`\n\n` +
                    `🎯 **Called At:** **${formatMcUsd(calledMc)}**\n` +
                    `🚀 **Peak ATH:** **${formatMcUsd(athMc)}** (**${athMult.toFixed(2)}x Peak**)\n` +
                    `💰 **Current Real MC:** **${formatMcUsd(currMc)}** (${mult.toFixed(2)}x)\n\n` +
                    `[DexScreener Link](${pair.dex_url})`
                )
                .setColor(0xFF8C00);

            await message.channel.send({ embeds: [resEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error fetching results: \`${err.message}\``);
        }
        return;
    }

    // 4. .mc <mint> or raw CA paste
    if (content.startsWith('.mc') || content.startsWith('/mc') || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(content)) {
        const parts = content.split(/\s+/);
        const targetMint = parts.length >= 2 ? parts[1].trim() : parts[0].trim();

        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(targetMint)) {
            const now = Date.now();
            if (now - (lastCaFetchTs.get(targetMint) || 0) < 5000) return;
            lastCaFetchTs.set(targetMint, now);

            try {
                await message.channel.sendTyping();
                const isExplicitCmd = content.startsWith('.mc') || content.startsWith('/mc');
                let searchMsg = null;
                if (isExplicitCmd) {
                    searchMsg = await message.channel.send(`🔍 Searching market cap & pool data for \`${targetMint}\`...`).catch(() => null);
                }
                const pair = await getDexscreenerData(targetMint);
                if (searchMsg) await searchMsg.delete().catch(() => {});
                if (!pair) return message.channel.send(`⚠️ No pool found yet for \`${targetMint}\``);

                const mcStr = formatMcUsd(pair.market_cap_usd);
                const mcEmbed = new EmbedBuilder()
                    .setTitle(`💰 REAL MARKET CAP: $${pair.symbol} (${pair.name})`)
                    .setURL(pair.dex_url)
                    .setDescription(
                        `**CA:** \`${targetMint}\`\n\n` +
                        `💰 **Real Market Cap:** **${mcStr}**\n` +
                        `💵 **Price USD:** \`$${pair.price_usd.toFixed(8)}\`\n` +
                        `💧 **Liquidity:** \`$${pair.liquidity_usd.toLocaleString()}\`\n` +
                        `🏛️ **DEX:** \`${pair.dex_id}\``
                    )
                    .setColor(0xFF8C00)
                    .setFooter({ text: 'Fresh DexScreener Live Data' });

                await message.channel.send({ embeds: [mcEmbed] });
            } catch {}
        }
        return;
    }

    // 5. .kol or .trenches (GMGN KOL-bought tokens)
    if (content.startsWith('.kol') || content.startsWith('.trenches')) {
        if (!isPremiumUser(message)) {
            return sendPremiumRequiredNotice(message, '.kol');
        }
        await message.channel.send('🔎 Scanning GMGN for new Solana tokens bought by **>= 2 renowned KOLs** (MC < $100k)...');
        try {
            const tokens = await getGmgnKolBoughtTokens(2, 100000, true);
            if (!tokens || tokens.length === 0) {
                return message.channel.send('⚠️ No tokens found matching KOL criteria right now.');
            }

            const kolList = tokens.slice(0, 5).map((t, idx) => {
                const sym = t.symbol || 'TOKEN';
                const name = t.name || sym;
                const mc = t.market_cap_usd ? formatMcUsd(t.market_cap_usd) : (t.market_cap ? formatMcUsd(t.market_cap) : 'N/A');
                const kols = t.renowned_count || 2;
                const mint = t.address || t.mint || '';
                return `**${idx + 1}. [${sym} (${name})](https://dexscreener.com/solana/${mint})**\n` +
                    `💎 MC: \`${mc}\` · 👑 KOLs: \`${kols}\`\n` +
                    `CA: \`${mint}\``;
            }).join('\n\n');

            const kolEmbed = new EmbedBuilder()
                .setTitle('👑 GMGN KOL-BOUGHT NEW CREATIONS')
                .setDescription(kolList)
                .setColor(0xF59E0B)
                .setFooter({ text: 'GMGN Intelligence • Min 2 Renowned KOL Buyers' });

            await message.channel.send({ embeds: [kolEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error scanning KOL tokens: \`${err.message}\``);
        }
        return;
    }

    // 6. .trending (GMGN 5m trending tokens)
    if (content.startsWith('.trending')) {
        if (!isPremiumUser(message)) {
            return sendPremiumRequiredNotice(message, '.trending');
        }
        await message.channel.send('🔥 Fetching top trending tokens on Solana (5-minute interval via GMGN)...');
        try {
            const tokens = await getGmgnTrendingTokens('5m', null, true);
            if (!tokens || tokens.length === 0) {
                return message.channel.send('⚠️ No trending tokens returned at the moment.');
            }

            const trendList = tokens.slice(0, 5).map((t, idx) => {
                const sym = t.symbol || 'TOKEN';
                const name = t.name || sym;
                const mc = t.market_cap_usd ? formatMcUsd(t.market_cap_usd) : 'N/A';
                const vol = t.volume_usd ? formatMcUsd(t.volume_usd) : 'N/A';
                const pc = Number(t.price_change_pct || 0);
                const mint = t.mint || '';
                return `**${idx + 1}. [${sym} (${name})](https://dexscreener.com/solana/${mint})**\n` +
                    `💎 MC: \`${mc}\` · 📊 Vol: \`${vol}\` · 🚀 \`${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%\`\n` +
                    `CA: \`${mint}\``;
            }).join('\n\n');

            const trendEmbed = new EmbedBuilder()
                .setTitle('🔥 GMGN 5-MINUTE TRENDING TOKENS')
                .setDescription(trendList)
                .setColor(0xEF4444)
                .setFooter({ text: 'GMGN Trending Intelligence' });

            await message.channel.send({ embeds: [trendEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error fetching trending tokens: \`${err.message}\``);
        }
        return;
    }

    // 7. .news (6551 OpenNews Breaking Market News)
    if (content.startsWith('.news')) {
        if (!isPremiumUser(message)) {
            return sendPremiumRequiredNotice(message, '.news');
        }
        await message.channel.send('📰 Fetching real-time Web3 breaking news & trading signals via 6551 OpenNews...');
        try {
            const items = await getHotCryptoNews('web3');
            if (!items || items.length === 0) {
                return message.channel.send('⚠️ No recent news items found.');
            }

            const newsDesc = items.slice(0, 5).map((item, idx) => {
                const coins = item.coins?.length ? `\`[${item.coins.slice(0, 3).join(', ')}]\` ` : '';
                const signalEmoji = item.signal === 'long' ? '🟢 LONG' : item.signal === 'short' ? '🔴 SHORT' : '⚪ NEUTRAL';
                const score = item.score ? `Score: ${item.score}` : '';
                const summary = item.summary || item.title || 'Breaking event';
                return `**${idx + 1}. ${coins}${signalEmoji} (${score})**\n${summary}`;
            }).join('\n\n');

            const newsEmbed = new EmbedBuilder()
                .setTitle('📰 6551 BREAKING WEB3 & CRYPTO NEWS')
                .setDescription(newsDesc)
                .setColor(0x3B82F6)
                .setFooter({ text: 'Powered by 6551 OpenNews AI' });

            await message.channel.send({ embeds: [newsEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error fetching news: \`${err.message}\``);
        }
        return;
    }

    // 8. .twitter <handle> (6551 OpenTwitter Profile lookup)
    if (content.startsWith('.twitter')) {
        if (!isPremiumUser(message)) {
            return sendPremiumRequiredNotice(message, '.twitter');
        }
        const parts = content.split(/\s+/);
        if (parts.length < 2) {
            return message.channel.send('⚠️ Please provide a Twitter/X username.\nUsage: `.twitter <handle>`');
        }

        const handle = parts[1].replace(/^@/, '').trim();
        await message.channel.send(`🐦 Looking up Twitter profile for \`@${handle}\`...`);
        try {
            const info = await getTwitterUserInfo(handle);
            if (!info || !info.screenName) {
                return message.channel.send(`⚠️ Twitter profile \`@${handle}\` not found or rate-limited.`);
            }

            const twEmbed = new EmbedBuilder()
                .setTitle(`🐦 @${info.screenName} (${info.name || handle})`)
                .setURL(`https://x.com/${info.screenName}`)
                .setDescription(
                    (info.description ? `*${info.description}*\n\n` : '') +
                    `👥 **Followers:** \`${Number(info.followersCount || 0).toLocaleString()}\`\n` +
                    `👤 **Following:** \`${Number(info.friendsCount || 0).toLocaleString()}\`\n` +
                    `📝 **Tweets:** \`${Number(info.statusesCount || 0).toLocaleString()}\`\n` +
                    `✅ **Verified:** \`${info.isBlueVerified ? 'Yes (X Blue)' : 'No'}\``
                )
                .setColor(0x1DA1F2)
                .setFooter({ text: '6551 OpenTwitter Intelligence' });

            if (info.profileImageUrl) {
                twEmbed.setThumbnail(info.profileImageUrl);
            }

            await message.channel.send({ embeds: [twEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error checking Twitter: \`${err.message}\``);
        }
        return;
    }

    // 9. .security <mint> (GMGN Token Security Check skill)
    if (content.startsWith('.security')) {
        if (!isPremiumUser(message)) {
            return sendPremiumRequiredNotice(message, '.security');
        }
        const parts = content.split(/\s+/);
        if (parts.length < 2) {
            return message.channel.send('⚠️ Please provide a contract address.\nUsage: `.security <mint>`');
        }
        const mint = parts[1].trim();
        await message.channel.send(`🛡️ Running GMGN Token Security Check for \`${mint}\`...`);
        try {
            const sec = await getGmgnTokenSecurity(mint, 'sol', true);
            if (!sec.security_checked) {
                return message.channel.send(`⚠️ Could not retrieve security report for \`${mint}\`.`);
            }

            const alertStr = sec.is_show_alert ? '🚨 **RUG / SCAM ALERT FLAGGED**' : '✅ **No Critical Alert**';
            const freezeStr = sec.renounced_freeze_account ? '✅ Renounced (Safe)' : '🚨 **ACTIVE (Honeypot Risk)**';
            const mintStr = sec.renounced_mint ? '✅ Renounced (Fixed Supply)' : '🚨 **ACTIVE (Dev can mint)**';
            const hpStr = sec.is_honeypot ? '🚨 **YES (Cannot sell)**' : '✅ No Honeypot';
            const taxStr = (sec.buy_tax > 0 || sec.sell_tax > 0) ? `🚨 Buy ${sec.buy_tax}% / Sell ${sec.sell_tax}%` : '✅ 0% / 0%';
            const burnStr = `${sec.burn_ratio.toFixed(1)}% (${sec.burn_status})`;
            const flagsStr = sec.flags.length > 0 ? sec.flags.join(', ') : 'None';

            const secEmbed = new EmbedBuilder()
                .setTitle(`🛡️ GMGN TOKEN SECURITY CHECK`)
                .setDescription(
                    `**CA:** \`${mint}\`\n\n` +
                    `⚠️ **GMGN Alert Status:** ${alertStr}\n` +
                    `❄️ **Freeze Authority:** ${freezeStr}\n` +
                    `🖨️ **Mint Authority:** ${mintStr}\n` +
                    `🍯 **Honeypot:** ${hpStr}\n` +
                    `💸 **Taxes:** ${taxStr}\n` +
                    `🔥 **LP Burned:** \`${burnStr}\`\n` +
                    `👥 **Top 10 Holder Rate:** \`${sec.top_10_holder_rate.toFixed(1)}%\`\n` +
                    `🚩 **Risk Flags:** \`${flagsStr}\``
                )
                .setColor(sec.is_show_alert || sec.is_honeypot || !sec.renounced_freeze_account ? 0xEF4444 : 0x10B981)
                .setFooter({ text: 'GMGN Token Security Intelligence' });

            await message.channel.send({ embeds: [secEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error checking security: \`${err.message}\``);
        }
        return;
    }

    // 10. .holders <mint> (GMGN Top100 Holders Analysis skill)
    if (content.startsWith('.holders')) {
        if (!isPremiumUser(message)) {
            return sendPremiumRequiredNotice(message, '.holders');
        }
        const parts = content.split(/\s+/);
        if (parts.length < 2) {
            return message.channel.send('⚠️ Please provide a contract address.\nUsage: `.holders <mint>`');
        }
        const mint = parts[1].trim();
        await message.channel.send(`👥 Analyzing top holders via GMGN for \`${mint}\`...`);
        try {
            const data = await getGmgnTopHolders(mint, 'sol', true);
            if (!data.holders_checked || data.holders.length === 0) {
                return message.channel.send(`⚠️ No holder records returned for \`${mint}\`.`);
            }

            const topList = data.holders.slice(0, 10).map((h, i) => {
                const addr = `${h.address.slice(0, 4)}...${h.address.slice(-4)}`;
                const pct = (Number(h.amount_percentage || 0) * 100).toFixed(2);
                const usd = h.usd_value ? `$${Math.round(h.usd_value).toLocaleString()}` : '';
                const susp = h.is_suspicious ? '⚠️ [SUSPICIOUS]' : '';
                const isNew = h.is_new ? '🌱 [NEW]' : '';
                const tag = h.wallet_tag_v2 ? `\`${h.wallet_tag_v2}\`` : '';
                const name = h.name ? `(${h.name})` : '';
                return `**${i + 1}.** \`${addr}\` ${tag} ${name} — **${pct}%** ${usd} ${susp} ${isNew}`.trim();
            }).join('\n');

            const hEmbed = new EmbedBuilder()
                .setTitle(`👥 GMGN TOP HOLDERS ANALYSIS`)
                .setDescription(
                    `**CA:** \`${mint}\`\n\n` +
                    `📊 **Top 10 Concentration:** \`${data.top10_pct.toFixed(1)}%\`\n` +
                    `🚨 **Suspicious Wallets:** \`${data.suspicious_count}\` (\`${data.suspicious_pct.toFixed(1)}%\` held)\n` +
                    `🌱 **New Wallets:** \`${data.new_wallets_pct.toFixed(1)}%\` held\n\n` +
                    `### Top 10 Largest Holders:\n${topList}`
                )
                .setColor(data.suspicious_pct > 8.0 || data.top10_pct > 60.0 ? 0xEF4444 : 0x10B981)
                .setFooter({ text: 'GMGN Top 100 Holders Analysis' });

            await message.channel.send({ embeds: [hEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error analyzing holders: \`${err.message}\``);
        }
        return;
    }

    // 11. .wallet <address> (GMGN Wallet Holdings skill)
    if (content.startsWith('.wallet')) {
        if (!isPremiumUser(message)) {
            return sendPremiumRequiredNotice(message, '.wallet');
        }
        const parts = content.split(/\s+/);
        if (parts.length < 2) {
            return message.channel.send('⚠️ Please provide a Solana wallet address.\nUsage: `.wallet <address>`');
        }
        const wallet = parts[1].trim();
        await message.channel.send(`💼 Fetching portfolio holdings for \`${wallet}\`...`);
        try {
            const list = await getGmgnWalletHoldings(wallet, 'sol', true);
            if (!list || list.length === 0) {
                return message.channel.send(`ℹ️ No active token holdings found for wallet \`${wallet}\`.`);
            }

            const holdingsDesc = list.slice(0, 10).map((t, i) => {
                const sym = t.symbol || 'TOKEN';
                const usd = t.usd_value ? `$${Math.round(t.usd_value).toLocaleString()}` : '';
                const pnl = t.pnl ? `(${t.pnl >= 0 ? '+' : ''}${Number(t.pnl).toFixed(1)}%)` : '';
                return `**${i + 1}.** **${sym}** — ${usd} ${pnl}`;
            }).join('\n');

            const wEmbed = new EmbedBuilder()
                .setTitle(`💼 WALLET PORTFOLIO HOLDINGS`)
                .setDescription(
                    `**Wallet:** \`${wallet}\`\n\n` +
                    `### Top Holdings:\n${holdingsDesc}`
                )
                .setColor(0x8B5CF6)
                .setFooter({ text: 'GMGN Wallet Portfolio Intelligence' });

            await message.channel.send({ embeds: [wEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error fetching wallet holdings: \`${err.message}\``);
        }
        return;
    }

    // 12. .pool <mint> — Liquidity Pool Analysis
    if (content.startsWith('.pool')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.pool');
        const parts = content.split(/\s+/);
        if (parts.length < 2) return message.channel.send('⚠️ Usage: `.pool <mint>`');
        const mint = parts[1].trim();
        await message.channel.send(`🏊 Fetching liquidity pool data for \`${mint}\`...`);
        try {
            const pool = await getGmgnTokenPool(mint, 'sol', true);
            if (!pool.pool_checked || pool.pools.length === 0) {
                return message.channel.send(`⚠️ No pool data found for \`${mint}\`.`);
            }
            const poolList = pool.pools.slice(0, 5).map((p, i) =>
                `**${i + 1}.** \`${p.dex}\` — Liq: \`${formatMcUsd(p.liquidity_usd)}\` · Vol 24h: \`${formatMcUsd(p.volume_24h)}\`\n` +
                `   Pool: \`${p.address ? p.address.slice(0, 20) + '...' : 'N/A'}\``
            ).join('\n');
            const poolEmbed = new EmbedBuilder()
                .setTitle('🏊 LIQUIDITY POOL ANALYSIS')
                .setDescription(
                    `**CA:** \`${mint}\`\n\n` +
                    `💧 **Total Liquidity:** \`${formatMcUsd(pool.total_liquidity_usd)}\`\n` +
                    `🏛️ **Main DEX:** \`${pool.main_dex}\`\n\n` +
                    `### Pools:\n${poolList}`
                )
                .setColor(0x06B6D4)
                .setFooter({ text: 'GMGN Liquidity Pool Analysis' });
            await message.channel.send({ embeds: [poolEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 13. .signal — KOL Call Signal (signal-type 13)
    if (content.startsWith('.signal')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.signal');
        await message.channel.send('👑 Fetching latest KOL call signals from GMGN...');
        try {
            const signals = await getGmgnKolSignal('sol', true);
            if (!signals || signals.length === 0) {
                return message.channel.send('⚠️ No KOL signals found right now.');
            }
            const sigList = signals.slice(0, 5).map((s, i) => {
                const mc = s.market_cap_usd ? formatMcUsd(s.market_cap_usd) : 'N/A';
                const amt = s.buy_amount_usd ? formatMcUsd(s.buy_amount_usd) : 'N/A';
                const kol = s.kol_name || s.kol_wallet?.slice(0, 8) + '...' || 'Unknown';
                return `**${i + 1}. [$${s.symbol || 'TOKEN'}](https://dexscreener.com/solana/${s.mint})**\n` +
                    `👑 KOL: \`${kol}\` · 💎 MC: \`${mc}\` · 💵 Bought: \`${amt}\`\n` +
                    `CA: \`${s.mint}\``;
            }).join('\n\n');
            const sigEmbed = new EmbedBuilder()
                .setTitle('👑 GMGN KOL CALL SIGNALS')
                .setDescription(sigList)
                .setColor(0xF59E0B)
                .setFooter({ text: 'GMGN Signal Type 13 — KOL Buys' });
            await message.channel.send({ embeds: [sigEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 14. .koltrades [buy|sell] — KOL Trade Tracker
    if (content.startsWith('.koltrades')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.koltrades');
        const parts = content.split(/\s+/);
        const side = parts[1] && ['buy', 'sell'].includes(parts[1].toLowerCase()) ? parts[1].toLowerCase() : null;
        await message.channel.send(`🔍 Fetching KOL trades${side ? ` (${side}s only)` : ''}...`);
        try {
            const trades = await getGmgnKolTrades('sol', side, true);
            if (!trades || trades.length === 0) {
                return message.channel.send('⚠️ No KOL trades found right now.');
            }
            const tradeList = trades.slice(0, 5).map((t, i) => {
                const mc = t.market_cap_usd ? formatMcUsd(t.market_cap_usd) : 'N/A';
                const amt = t.amount_usd ? formatMcUsd(t.amount_usd) : 'N/A';
                const kol = t.kol_name || t.kol_wallet?.slice(0, 8) + '...' || 'Unknown';
                const sideEmoji = t.side === 'sell' ? '🔴 SELL' : '🟢 BUY';
                return `**${i + 1}. [$${t.symbol || 'TOKEN'}](https://dexscreener.com/solana/${t.mint})** ${sideEmoji}\n` +
                    `👑 KOL: \`${kol}\` · 💎 MC: \`${mc}\` · 💵 \`${amt}\`\n` +
                    `CA: \`${t.mint}\``;
            }).join('\n\n');
            const tradeEmbed = new EmbedBuilder()
                .setTitle(`👑 GMGN KOL TRADES${side ? ` — ${side.toUpperCase()}S` : ''}`)
                .setDescription(tradeList)
                .setColor(side === 'sell' ? 0xEF4444 : 0x10B981)
                .setFooter({ text: 'GMGN KOL Trade Tracker • Usage: .koltrades [buy|sell]' });
            await message.channel.send({ embeds: [tradeEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 15. .kolholders <mint> — KOL Holders ranked by profit
    if (content.startsWith('.kolholders')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.kolholders');
        const parts = content.split(/\s+/);
        if (parts.length < 2) return message.channel.send('⚠️ Usage: `.kolholders <mint>`');
        const mint = parts[1].trim();
        await message.channel.send(`👑 Fetching KOL holders for \`${mint}\` sorted by profit...`);
        try {
            const data = await getGmgnKolHolders(mint, 'sol', true);
            if (!data.kol_holders_checked || data.kol_count === 0) {
                return message.channel.send(`⚠️ No KOL holders found for \`${mint}\`.`);
            }
            const holderList = data.kol_holders.slice(0, 8).map((h, i) => {
                const addr = h.address ? `${h.address.slice(0, 4)}...${h.address.slice(-4)}` : 'N/A';
                const profit = h.realized_profit >= 0 ? `+$${Math.round(h.realized_profit).toLocaleString()}` : `-$${Math.abs(Math.round(h.realized_profit)).toLocaleString()}`;
                return `**${i + 1}.** \`${h.name || addr}\` — **${h.holding_pct.toFixed(2)}%** · Profit: \`${profit}\``;
            }).join('\n');
            const kolHEmbed = new EmbedBuilder()
                .setTitle('👑 KOL HOLDERS ANALYSIS')
                .setDescription(
                    `**CA:** \`${mint}\`\n\n` +
                    `🧠 **KOL Count:** \`${data.kol_count}\`\n` +
                    `💎 **KOL Total Hold:** \`${data.kol_total_pct.toFixed(2)}%\`\n\n` +
                    `### KOLs by Realized Profit:\n${holderList}`
                )
                .setColor(0xA855F7)
                .setFooter({ text: 'GMGN KOL Holders Analysis • Sorted by profit' });
            await message.channel.send({ embeds: [kolHEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 16. .devinfo <mint> — Dev Info Analysis
    if (content.startsWith('.devinfo')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.devinfo');
        const parts = content.split(/\s+/);
        if (parts.length < 2) return message.channel.send('⚠️ Usage: `.devinfo <mint>`');
        const mint = parts[1].trim();
        await message.channel.send(`🧑 Fetching dev wallet info for \`${mint}\`...`);
        try {
            const dev = await getGmgnDevInfo(mint, 'sol', true);
            if (!dev.dev_checked) {
                return message.channel.send(`⚠️ Could not retrieve dev info for \`${mint}\`.`);
            }
            const ctoStr = dev.cto_flag === 1 ? '✅ YES (Community Takeover)' : '❌ No';
            const devAddr = dev.dev_wallet ? `\`${dev.dev_wallet.slice(0, 6)}...${dev.dev_wallet.slice(-4)}\`` : 'Unknown';
            const devEmbed = new EmbedBuilder()
                .setTitle('🧑 DEV INFO ANALYSIS')
                .setDescription(
                    `**CA:** \`${mint}\`\n\n` +
                    `👤 **Dev Wallet:** ${devAddr}\n` +
                    `💰 **Dev Holdings:** \`${dev.dev_hold_pct.toFixed(2)}%\`\n` +
                    `🏢 **Dev Team Holdings:** \`${dev.dev_team_hold_pct.toFixed(2)}%\`\n` +
                    `💎 **Dev SOL Balance:** \`${dev.dev_sol_balance} SOL\`\n` +
                    `🏳️ **CTO Flag:** ${ctoStr}`
                )
                .setColor(dev.dev_hold_pct > 10 ? 0xEF4444 : 0x10B981)
                .setFooter({ text: 'GMGN Dev Info Analysis' });
            await message.channel.send({ embeds: [devEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 17. .pumptop [1h|5m] — Pump.fun Platform Trending
    if (content.startsWith('.pumptop')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.pumptop');
        const parts = content.split(/\s+/);
        const interval = parts[1] && ['1h', '5m', '6h', '24h'].includes(parts[1]) ? parts[1] : '1h';
        await message.channel.send(`🚀 Fetching top Pump.fun trending tokens (${interval})...`);
        try {
            const tokens = await getGmgnPumpfunTrending(interval, 'Pump.fun', true);
            if (!tokens || tokens.length === 0) {
                return message.channel.send('⚠️ No Pump.fun trending tokens returned right now.');
            }
            const pumpList = tokens.slice(0, 5).map((t, idx) => {
                const sym = t.symbol || 'TOKEN';
                const mc = t.market_cap_usd ? formatMcUsd(t.market_cap_usd) : 'N/A';
                const vol = t.volume_usd ? formatMcUsd(t.volume_usd) : 'N/A';
                const pc = Number(t.price_change_pct || 0);
                const mint = t.mint || '';
                return `**${idx + 1}. [$${sym}](https://pump.fun/${mint})** — [DEX](https://dexscreener.com/solana/${mint})\n` +
                    `💎 MC: \`${mc}\` · 📊 Vol: \`${vol}\` · 🚀 \`${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%\`\n` +
                    `CA: \`${mint}\``;
            }).join('\n\n');
            const pumpEmbed = new EmbedBuilder()
                .setTitle(`🚀 PUMP.FUN TRENDING (${interval.toUpperCase()})`)
                .setDescription(pumpList)
                .setColor(0x8B5CF6)
                .setFooter({ text: `GMGN Pump.fun Trending • Interval: ${interval}` });
            await message.channel.send({ embeds: [pumpEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 18. Owner Admin Commands (.addpremium, .delpremium, .listpremium)
    if (message.author.id === AUTHORIZED_DISCORD_USER_ID) {
        if (content.startsWith('.addpremium')) {
            const parts = content.split(/\s+/);
            const target = parts[1] ? parts[1].replace(/[<@!>]/g, '').trim() : null;
            if (!target) return message.channel.send('Usage: `.addpremium <@user or ID>`');
            premiumUsers.add(target);
            savePremiumUsers();
            return message.channel.send(`✅ Added <@${target}> (\`${target}\`) to Premium whitelist!`);
        }

        if (content.startsWith('.delpremium')) {
            const parts = content.split(/\s+/);
            const target = parts[1] ? parts[1].replace(/[<@!>]/g, '').trim() : null;
            if (!target) return message.channel.send('Usage: `.delpremium <@user or ID>`');
            premiumUsers.delete(target);
            savePremiumUsers();
            return message.channel.send(`🗑️ Removed <@${target}> (\`${target}\`) from Premium whitelist.`);
        }

        if (content.startsWith('.listpremium')) {
            const list = Array.from(premiumUsers).map(id => `• <@${id}> (\`${id}\`)`).join('\n') || 'None';
            return message.channel.send(`👑 **Whitelisted Premium Users:**\n${list}`);
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId.startsWith('copy_ca_')) {
        const mint = interaction.customId.replace('copy_ca_', '');
        await interaction.reply({
            content: `📋 **CA:** \`${mint}\``,
            ephemeral: true,
        });
    }
});

const discordToken = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || config.DISCORD_BOT_TOKEN;
if (!discordToken) {
    console.error('❌ Neither DISCORD_TOKEN nor DISCORD_BOT_TOKEN is set in environment variables!');
    process.exit(1);
}

client.login(discordToken);
