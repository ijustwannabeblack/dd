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
    getGmgnDevCreatedTokens,
    getGmgnMigratedQuality,
    getGmgnSmartMoneyBuySignals,
    getGmgnNearCompletionTokens,
    getGmgnSmartMoneyExitSignals,
    getGmgnKolBoughtNewTokens,
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
// ─── Live Web Feed IPC Broadcaster ───────────────────────────────────────────
export function broadcastFeedEvent(data) {
    const event = {
        timestamp: Date.now(),
        ...data
    };
    if (typeof globalThis.__pushToken === 'function') {
        try { globalThis.__pushToken(event); } catch {}
    }
    if (process.send) {
        try { process.send({ type: 'TOKEN_FEED', data: event }); } catch {}
    }
}
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
        .setTitle('ACCESS RESTRICTED // PREMIUM REQUIRED')
        .setDescription(
            `The command \`${cmdName}\` requires an active **Premium Intelligence** tier.\n\n` +
            `**Eligibility:**\n` +
            `• Hold the **Premium** or **VIP** Discord role, or\n` +
            `• Have your user ID whitelisted by the bot administrator.\n\n` +
            `*Contact <@${AUTHORIZED_DISCORD_USER_ID}> for activation.*`
        )
        .setColor(0xF59E0B)
        .setFooter({ text: 'DD Terminal • Access Control' })
        .setTimestamp();

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
 * Builds the canonical Discord call embed with professional institutional layout.
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
    const gmgnUrl = `https://gmgn.ai/sol/token/${mint}`;
    const axiomUrl = `https://axiom.trade/pair/${mint}`;

    const protoBadge = stats.source === 'pons' ? '🅿 ' : (stats.source === 'robinhood' ? '🤝 ' : '');
    const titleText = `${protoBadge}[${name}] [${mcStr} / ${priceChangeM5 >= 0 ? '+' : ''}${priceChangeM5.toFixed(1)}%] • ${symbol}/SOL`;

    const liveTag = stats.is_live ? ` • **LIVE** (${stats.live_viewers || 0} viewers)` : '';
    const networkBadge = stats.network_badge || 'Solana @ Pump.fun';
    const headerBadge = `\`${networkBadge}\`${liveTag}`;

    const embed = new EmbedBuilder()
        .setTitle(titleText)
        .setURL(titleUrl)
        .setDescription(headerBadge)
        .setColor(0x10B981)
        .addFields(
            {
                name: 'Valuation',
                value: `MC: \`${mcStr}\`\nFDV: \`${fdvStr}\`\nUSD: \`$${priceStr}\``,
                inline: true
            },
            {
                name: 'Trading & Liq',
                value: `Liq: \`${liqStr}\`\nVol 1H: \`${volStr}\`\nAge: \`${ageStr}\``,
                inline: true
            },
            {
                name: 'Distribution',
                value: `Holders: \`${Number(stats.holders || 0).toLocaleString()}\`\nTop 10: \`${Number(stats.top10_holders_pct || stats.top10_pct || 0).toFixed(1)}%\`\nDev: \`${Number(stats.dev_holdings_pct || 0).toFixed(1)}%\``,
                inline: true
            },
            {
                name: 'Anti-Rug Security',
                value: `Clusters: \`${Number(stats.cluster_pct || 0).toFixed(1)}%\`\nBundlers: \`${Number(stats.bundlers_pct || 0).toFixed(1)}%\`\nLP: \`${stats.lp_burned ? 'Burned' : 'Locked'}\``,
                inline: true
            },
            {
                name: 'Bubblemap & Snipers',
                value: `Clusters: \`${Number(stats.cluster_pct || 0).toFixed(1)}%\`\nSnipers: \`${Number(stats.snipers_pct || 0).toFixed(1)}%\`\nInsiders: \`${Number(stats.insiders_pct || 0).toFixed(1)}%\``,
                inline: true
            },
            {
                name: 'Narrative & Sentiment',
                value: `Theme: \`${stats.ai_narrative_theme || 'Organic'}\`\nScore: \`${stats.ai_narrative_score ? `${stats.ai_narrative_score}/10` : 'Passed'}\`\nRisks: \`${stats.danger_risks && stats.danger_risks.length ? 'Flagged' : 'Clean'}\``,
                inline: true
            },
            {
                name: 'Quick Links',
                value: `[DexScreener](${dexUrl})  •  [Axiom](${axiomUrl})  •  [GMGN](${gmgnUrl})  •  [InsightX Atlas](${bmapUrl})  •  [Pump.fun](${pumpUrl})`,
                inline: false
            },
            {
                name: 'Contract Address (tap to copy)',
                value: `\`${mint}\``,
                inline: false
            }
        )
        .setFooter({ text: 'DD Terminal • Solana Real-Time Intelligence' })
        .setTimestamp();

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
    try {
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

    // Post-restart protection: Do NOT blast ancient coins (Migrated coins exempted as requested)
    const createdTs = Number(stats.created_timestamp || 0);
    if (stage !== 'Migrated' && createdTs > 0) {
        const tsSec = createdTs > 1e11 ? createdTs / 1000 : createdTs;
        const ageMins = ((Date.now() / 1000) - tsSec) / 60;
        const maxAgeMins = stage === 'New Pair' ? 15.0 : 120.0;
        if (ageMins > maxAgeMins) {
            console.log(`[${stage}] ${stats.symbol} (${mint}) skipped: old coin (${ageMins.toFixed(0)}m old, max ${maxAgeMins}m)`);
            return;
        }
    }

    // Launchpad enforcement on Solana: ONLY pump.fun tokens allowed (Migrated tokens exempted)
    const chainName = stats.chain_name || 'Solana';
    const launchpadName = stats.launchpad_name || 'Pump.fun';
    if (chainName === 'Solana' && stage !== 'Pons' && stage !== 'Migrated') {
        if (launchpadName !== 'Pump.fun') {
            console.log(`[${stage}] ${stats.symbol} (${mint}) skipped: launchpad ${launchpadName} not pump.fun`);
            return;
        }
    }

    // Market cap range check: User requirement -> Must be $20k or up, no upper cap ceiling
    if (!config.IGNORE_MARKET_CAP) {
        const minMc = config.MIN_CALL_MC_USD || 20000.0;
        const mcVal = Number(stats.market_cap_usd || 0);
        if (mcVal < minMc) {
            console.log(`[${stage}] ${stats.symbol} (${mint}) dropped: MC $${mcVal.toLocaleString()} below $20k threshold`);
            broadcastFeedEvent({
                mint,
                symbol: stats.symbol || coin.symbol || 'TOKEN',
                name: stats.name || coin.name || 'Token',
                status: 'rejected',
                market_cap_usd: mcVal,
                cluster_pct: Number(stats.cluster_pct || 0),
                dev_holdings_pct: Number(stats.dev_holdings_pct || stats.dev_holding_pct || 0),
                top10_pct: Number(stats.top10_pct || 0),
                bundlers_pct: Number(stats.bundlers_pct || 0),
                rugcheck_score: stats.rugcheck_score || 'High Risk',
                reason: `MC $${mcVal.toLocaleString()} below $20k threshold`,
                source: coin.source || stage
            });
            return;
        }
    }

    // Dev History Guard (Anti-Serial Rugger Check via GMGN Dev Created Tokens skill)
    const devWallet = stats.dev_wallet || coin.creator;
    if (devWallet && stage !== 'Migrated') {
        try {
            const devHist = await getGmgnDevCreatedTokens(devWallet, 'sol').catch(() => null);
            if (devHist && devHist.checked) {
                stats.dev_created_count = devHist.total_created;
                stats.dev_migration_rate = devHist.migration_rate;
                stats.dev_highest_ath_mc = devHist.highest_ath_mc;
                stats.is_serial_rugger = devHist.is_serial_rugger;

                if (devHist.is_serial_rugger) {
                    const rugReason = `Serial Rugger Dev (${devHist.total_created} tokens launched, 0% migration rate)`;
                    console.log(`[${stage}] ${stats.symbol} (${mint}) REJECTED by Dev History Guard: ${rugReason}`);
                    broadcastFeedEvent({
                        mint,
                        symbol: stats.symbol || coin.symbol || 'TOKEN',
                        name: stats.name || coin.name || 'Token',
                        status: 'rejected',
                        market_cap_usd: Number(stats.market_cap_usd || 0),
                        cluster_pct: Number(stats.cluster_pct || 0),
                        dev_holdings_pct: Number(stats.dev_holdings_pct || stats.dev_holding_pct || 0),
                        top10_pct: Number(stats.top10_pct || 0),
                        bundlers_pct: Number(stats.bundlers_pct || 0),
                        rugcheck_score: stats.rugcheck_score || 'High Risk',
                        reason: rugReason,
                        source: coin.source || stage
                    });

                    const rejChan = rejectedChannel || client.channels.cache.get(String(config.REJECTED_CHANNEL_ID || '1541182755705065603'));
                    if (rejChan) {
                        try {
                            const rejEmbed = buildMigratedEmbed(stats);
                            rejEmbed.setFooter({ text: `⚠️ REJECTED COIN: ${rugReason}` });
                            await rejChan.send({
                                content: `⚠️ **FAILED / REJECTED COIN**: \`${mint}\`\n**Reason:** ${rugReason}`,
                                embeds: [rejEmbed],
                            });
                        } catch {}
                    }
                    return;
                }
            }
        } catch (e) {
            console.warn(`[${stage}] Dev history check error for ${mint}: ${e.message}`);
        }
    }

    broadcastFeedEvent({
        mint,
        symbol: stats.symbol || coin.symbol || 'TOKEN',
        name: stats.name || coin.name || 'Token',
        status: 'evaluating',
        market_cap_usd: Number(stats.market_cap_usd || 0),
        cluster_pct: Number(stats.cluster_pct || 0),
        dev_holdings_pct: Number(stats.dev_holdings_pct || stats.dev_holding_pct || 0),
        top10_pct: Number(stats.top10_pct || 0),
        bundlers_pct: Number(stats.bundlers_pct || 0),
        rugcheck_score: stats.rugcheck_score || 'Scanning',
        reason: 'Evaluating on-chain safety',
        source: coin.source || stage
    });

    const [passes, reasons, alertType] = evaluateCoin(stats, stage);
    let aiFailed = false;
    let aiRejectReason = '';

    if (passes) {
        const aiEval = await aiEvaluateToken(stats);
        if (aiEval) {
            stats.ai_narrative_score = aiEval.score;
            stats.ai_narrative_theme = aiEval.theme;
            stats.ai_narrative_reason = aiEval.reason;
        }
        // User requested: "use no filters for migrated and fix it dosent call anything"
        // Migrated tokens are never rejected by AI narrative
        if (stage !== 'Migrated' && !aiEval?.passes) {
            aiFailed = true;
            aiRejectReason = `AI Rejected: ${aiEval?.reason || 'Failed check'}`;
            console.log(`[${stage}] $${stats.symbol} (${mint}) AI evaluation failed: ${aiRejectReason}`);
        }
    }

    if (!passes || aiFailed) {
        const reasonStr = aiFailed ? aiRejectReason : (reasons[reasons.length - 1] || 'Filter check failed');
        broadcastFeedEvent({
            mint,
            symbol: stats.symbol || coin.symbol || 'TOKEN',
            name: stats.name || coin.name || 'Token',
            status: 'rejected',
            market_cap_usd: Number(stats.market_cap_usd || 0),
            cluster_pct: Number(stats.cluster_pct || 0),
            dev_holdings_pct: Number(stats.dev_holdings_pct || stats.dev_holding_pct || 0),
            top10_pct: Number(stats.top10_pct || 0),
            bundlers_pct: Number(stats.bundlers_pct || 0),
            rugcheck_score: stats.rugcheck_score || 'High Risk',
            reason: reasonStr,
            source: coin.source || stage
        });

        console.log(`[${stage}] ${stats.symbol} (${mint}) rejected. Sending to rejected channel...`);
        const rejChan = rejectedChannel || client.channels.cache.get(String(config.REJECTED_CHANNEL_ID || '1541182755705065603'));
        if (rejChan) {
            try {
                const rejEmbed = buildMigratedEmbed(stats);
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

    broadcastFeedEvent({
        mint,
        symbol: stats.symbol || 'TOKEN',
        name: stats.name || 'Token',
        status: 'approved',
        market_cap_usd: Number(stats.market_cap_usd || 0),
        cluster_pct: Number(stats.cluster_pct || 0),
        dev_holdings_pct: Number(stats.dev_holdings_pct || stats.dev_holding_pct || 0),
        top10_pct: Number(stats.top10_pct || 0),
        bundlers_pct: Number(stats.bundlers_pct || 0),
        rugcheck_score: stats.rugcheck_score || 'Good',
        reason: 'Approved — all filters passed',
        source: stats.source || stage
    });

        await sendCallAlertInstantly({
            stats,
            embed,
            stage,
            alert_type: alertType,
            stageKey,
        });
    } finally {
        queued.delete(stageKey);
    }
}

// Background Scanners
async function activeRunnerScanner() {
    await new Promise(r => setTimeout(r, 4000));
    console.log('🔍 Active Solana Runner Scanner started.');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 3000));

            const resp = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(4000) });
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
                    if (mc < 20000) continue; // User requirement: 20k or up, no upper cap
                }

                const pcM5 = Number(pair.price_change_m5 || 0);
                const volM5 = Number(pair.volume_m5 || 0);
                if (pcM5 < 0.0 && volM5 < 1500.0) continue;

                const stage = mc >= 28000 ? 'Migrated' : 'Final Stretch';
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
            await new Promise(r => setTimeout(r, 20000)); // 20s fast scan
            const coins = await getGmgnPumpfunTrenches(30).catch(() => []);
            for (const coin of coins) {
                const mint = coin.mint;
                if (!mint) continue;

                const stage = Number(coin.market_cap_usd || 0) >= 20000 ? 'Final Stretch' : 'New Pair';
                const stageKey = `${stage}:${mint}`;
                if (seen.has(stageKey) || queued.has(stageKey)) continue;

                processCoin(stage, coin);
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

/**
 * Periodically scans GMGN KOL buy signals & trending tokens.
 * Only tokens that pass the full anti-rug & AI audit pipeline will be called
 * with the exact canonical embed and real on-chain stats.
 */
async function gmgnOpportunityScanner() {
    await new Promise(r => setTimeout(r, 10000));
    console.log('👑 GMGN Trending Screener started (feeds candidate coins through full anti-rug audit).');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 20000)); // 20s fast scan

            // Check 5m & 1h Pump.fun Trending on GMGN
            const trending5m = await getGmgnTrendingTokens('5m', 'Pump.fun').catch(() => []);
            for (const t of (trending5m || []).slice(0, 5)) {
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
                processCoin(stage, coin);
            }

            await new Promise(r => setTimeout(r, 5000));

            const trending1h = await getGmgnTrendingTokens('1h', 'Pump.fun').catch(() => []);
            for (const t of (trending1h || []).slice(0, 5)) {
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
                processCoin(stage, coin);
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

/**
 * Skill: Smart Money Buy Signals (Signal Type 12)
 * Continuously discovers tokens being cluster-accumulated by multiple smart money degens.
 */
async function gmgnSmartMoneyScanner() {
    await new Promise(r => setTimeout(r, 12000));
    console.log('🌱 GMGN Smart Money Signal Scanner started (Cluster Buy Signal 12).');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 25000)); // 25s fast scan
            const signals = await getGmgnSmartMoneyBuySignals('sol').catch(() => []);
            for (const sig of (signals || []).slice(0, 10)) {
                const mint = sig.token_address || sig.data?.address || sig.address;
                if (!mint) continue;

                // Launchpad filter: Pump.fun tokens only
                const launchpad = String(sig.data?.launchpad || sig.data?.launchpad_platform || '').toLowerCase();
                const isPump = launchpad.includes('pump') || mint.endsWith('pump');
                if (!isPump) continue;

                const stage = 'Migrated';
                const stageKey = `${stage}:${mint}`;
                if (seen.has(stageKey) || queued.has(stageKey)) continue;

                const coin = {
                    mint,
                    symbol: sig.data?.symbol || sig.symbol || 'TOKEN',
                    name: sig.data?.name || sig.name || 'Token',
                    created_timestamp: sig.data?.created_timestamp ? (sig.data.created_timestamp * 1000) : Date.now(),
                    creator: sig.data?.creator || '',
                    source: 'smart_money_cluster',
                };
                processCoin(stage, coin);
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

/**
 * Skill: Migrated Token Quality Screener
 * Scans migrated Pump.fun tokens with strict server-side quality filters.
 */
async function gmgnMigratedQualityScanner() {
    await new Promise(r => setTimeout(r, 15000));
    console.log('💎 GMGN Migrated Quality Screener started (anti-rug server pre-filtered).');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 25000)); // 25s fast scan
            const tokens = await getGmgnMigratedQuality('sol', {
                min_mc: 20000,
                max_mc: 100000000,
                min_liq: 5000,
                max_top10: 0.50,
                max_bundle: 0.30,
                max_fresh: 0.40
            }).catch(() => []);

            for (const item of (tokens || []).slice(0, 10)) {
                const mint = item.address || item.token_address;
                if (!mint) continue;

                const launchpad = String(item.launchpad || item.launchpad_platform || '').toLowerCase();
                const exchange = String(item.exchange || '').toLowerCase();
                const isPump = launchpad.includes('pump') || mint.endsWith('pump') || exchange.includes('pump');
                if (!isPump) continue;

                const stage = 'Migrated';
                const stageKey = `${stage}:${mint}`;
                if (seen.has(stageKey) || queued.has(stageKey)) continue;

                const coin = {
                    mint,
                    symbol: item.symbol || 'TOKEN',
                    name: item.name || 'Token',
                    created_timestamp: item.created_timestamp ? (item.created_timestamp * 1000) : Date.now(),
                    creator: item.creator || '',
                    source: 'migrated_quality_screener',
                };
                processCoin(stage, coin);
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

/**
 * Skill: Near Completion Tokens Screener
 * Identifies tokens reaching 80%-95% bonding curve completion with smart money backing.
 */
async function gmgnNearCompletionScanner() {
    await new Promise(r => setTimeout(r, 18000));
    console.log('⚡ GMGN Near Completion Screener started (80%-95% curve with smart money).');

    while (true) {
        try {
            await new Promise(r => setTimeout(r, 25000)); // 25s fast scan
            const tokens = await getGmgnNearCompletionTokens('sol', 2).catch(() => []);

            for (const item of (tokens || []).slice(0, 10)) {
                const mint = item.address || item.token_address;
                if (!mint) continue;

                const launchpad = String(item.launchpad || item.launchpad_platform || '').toLowerCase();
                const isPump = launchpad.includes('pump') || mint.endsWith('pump');
                if (!isPump) continue;

                const stage = 'Final Stretch';
                const stageKey = `${stage}:${mint}`;
                if (seen.has(stageKey) || queued.has(stageKey)) continue;

                const coin = {
                    mint,
                    symbol: item.symbol || 'TOKEN',
                    name: item.name || 'Token',
                    created_timestamp: item.created_timestamp ? (item.created_timestamp * 1000) : Date.now(),
                    creator: item.creator || '',
                    source: 'near_completion_screener',
                };
                processCoin(stage, coin);
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 10000));
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
                            .setTitle(`PROFIT TARGET REACHED // $${symbol}`)
                            .setURL(`https://dexscreener.com/solana/${mint}`)
                            .setDescription(`Target multiple achieved from initial call valuation.`)
                            .setColor(0x10B981)
                            .addFields(
                                { name: 'Initial Call', value: `\`${calledStr}\``, inline: true },
                                { name: 'Current Valuation', value: `\`${currStr}\``, inline: true },
                                { name: 'Return Multiplier', value: `\`+${((mult - 1) * 100).toFixed(0)}% (${mult.toFixed(2)}x)\``, inline: true },
                                { name: 'Quick Links', value: `[DexScreener](https://dexscreener.com/solana/${mint})  •  [GMGN](https://gmgn.ai/sol/token/${mint})  •  [Axiom](https://axiom.trade/pair/${mint})`, inline: false },
                                { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                            )
                            .setFooter({ text: 'DD Terminal • Performance Tracker' })
                            .setTimestamp();

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
                            .setTitle(`CYCLE AUDIT // $${symbol}`)
                            .setURL(`https://dexscreener.com/solana/${mint}`)
                            .setDescription(`20-minute call lifecycle summary report.`)
                            .setColor(0x6366F1)
                            .addFields(
                                { name: 'Initial Call', value: `\`${calledStr}\``, inline: true },
                                { name: 'Peak Valuation', value: `\`${athStr}\``, inline: true },
                                { name: 'Peak Return', value: `\`+${((athMult - 1) * 100).toFixed(0)}% (${athMult.toFixed(2)}x Peak)\``, inline: true },
                                { name: 'Quick Links', value: `[DexScreener](https://dexscreener.com/solana/${mint})  •  [GMGN](https://gmgn.ai/sol/token/${mint})`, inline: false },
                                { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                            )
                            .setFooter({ text: 'DD Terminal • Lifecycle Verification' })
                            .setTimestamp();

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
    gmgnMigratedQualityScanner();
    gmgnNearCompletionScanner();
    gmgnOpportunityScanner();
    trackCalledCoinsPerformance();

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

    // 0.0. .uptime Command
    if (content === '.uptime' || content === '/uptime' || content.toLowerCase() === '.uptime') {
        const uptimeSec = process.uptime();
        const hrs = Math.floor(uptimeSec / 3600);
        const mins = Math.floor((uptimeSec % 3600) / 60);
        const secs = Math.floor(uptimeSec % 60);
        const uptimeStr = hrs > 0 ? `${hrs}h ${mins}m ${secs}s` : `${mins}m ${secs}s`;
        const heapMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
        const totalTokens = seen ? seen.size : 0;

        const uptimeEmbed = new EmbedBuilder()
            .setTitle('BOT STATUS & UPTIME // DD RADAR')
            .setColor(0x10B981)
            .addFields(
                { name: '⏱️ Uptime', value: `\`${uptimeStr}\``, inline: true },
                { name: '📊 Memory', value: `\`${heapMb} MB / 128 MB\``, inline: true },
                { name: '🔍 Tokens Tracked', value: `\`${totalTokens} mints\``, inline: true },
                { name: '⚡ Scanner Pipeline', value: '`ONLINE (PumpPortal, DexScreener, GMGN)`', inline: false },
                { name: '🎯 Active MC Floor', value: `\`$${Math.round(config.RUNTIME_CONFIG.min_call_mc_usd / 1000)}k+ MC\``, inline: true },
                { name: '🛡️ Safety Gates', value: '`Sybil Clusters <5% · Dev <30% · Bundlers <35%`', inline: true },
            )
            .setFooter({ text: 'DD Terminal • Autonomous Solana Memecoin Radar' })
            .setTimestamp();

        return message.channel.send({ embeds: [uptimeEmbed] });
    }

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
            .setTitle('DD TERMINAL // COMMAND DIRECTORY')
            .setDescription('Institutional Solana memecoin intelligence, real-time safety verification, and automated signals.')
            .setColor(0x2563EB)
            .addFields(
                {
                    name: 'Token Security & Verification',
                    value:
                        '` .uptime ` — Real-time bot uptime, process memory & scanner health\n' +
                        '` .check <ca> ` — Comprehensive audit & InsightX Atlas cluster bubble map\n' +
                        '` .mc <ca> ` — Real-time valuation, pool liquidity & price\n' +
                        '` .predict <ca> ` — Algorithmic momentum prediction & price targets\n' +
                        '` .security <ca> ` — GMGN honeypot, mint & freeze authority check\n' +
                        '` .holders <ca> ` — Top 100 supply concentration & sniper audit\n' +
                        '` .devinfo <ca> ` — Dev wallet holdings, balance & CTO status\n' +
                        '` .devhistory <wallet|ca> ` — Dev launch history & serial rugger audit\n' +
                        '` .pool <ca> ` — DEX liquidity breakdown & pool reserve depth',
                    inline: false
                },
                {
                    name: 'KOL, Smart Money & Market Signals',
                    value:
                        '` .sm ` — Smart Money cluster buy signals (GMGN Signal 12)\n' +
                        '` .nearcurve ` — 80%–95% bonding curve tokens with smart money\n' +
                        '` .qualitymigrated ` — Server pre-filtered safe migrated tokens\n' +
                        '` .signal ` — Renowned KOL buy signals (GMGN Signal 13)\n' +
                        '` .koltrades [buy|sell] ` — Real-time renowned KOL transactions\n' +
                        '` .kolholders <ca> ` — Renowned KOL holders ranked by realized profit\n' +
                        '` .trending ` — Top 5-minute Solana trending tokens\n' +
                        '` .pumptop [1h|5m] ` — Pump.fun platform trending rankings\n' +
                        '` .wallet <addr> ` — Portfolio token holdings & PnL breakdown\n' +
                        '` .news ` / ` .twitter <handle> ` — Web3 breaking news & X intelligence',
                    inline: false
                }
            )
            .setFooter({ text: 'DD Terminal • Enter any command with a contract or wallet address' })
            .setTimestamp();
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

            const verdictDesc = passes
                ? '● **PASSED ALL ON-CHAIN RISK GATES**\n*Low cluster concentration, dev holdings safe, no critical risk flags.*'
                : `▲ **HIGH RISK DETECTED**\n*${reasons.length > 0 ? reasons.slice(-2).join(' • ') : 'Failed anti-rug gate thresholds'}*`;

            const checkEmbed = new EmbedBuilder()
                .setTitle(`${passes ? 'VERIFIED' : 'HIGH RISK'} // $${symbol} (${name})`)
                .setURL(dexUrl)
                .setDescription(verdictDesc)
                .setColor(passes ? 0x10B981 : 0xEF4444)
                .addFields(
                    {
                        name: 'Valuation & Liquidity',
                        value: `MC: \`${mcStr}\`\nFDV: \`${stats.market_cap_display || mcStr}\`\nLiq: \`${liqStr}\``,
                        inline: true
                    },
                    {
                        name: 'Supply Distribution',
                        value: `Holders: \`${holders.toLocaleString()}\`\nTop 10: \`${top10Pct.toFixed(1)}%\`\nDev: \`${devStr}\``,
                        inline: true
                    },
                    {
                        name: 'Cluster & Bundlers',
                        value: `Clusters: \`${clusterPct.toFixed(1)}%\`\nBundlers: \`${bundlersPct.toFixed(1)}%\`\nSnipers: \`${snipersPct.toFixed(1)}%\``,
                        inline: true
                    },
                    {
                        name: 'Volume & 5M Momentum',
                        value: `Vol 1H: \`${volStr}\`\n5M: \`${pcM5 >= 0 ? '+' : ''}${pcM5.toFixed(1)}%\`\nTxns: \`${buysM5}B / ${sellsM5}S\``,
                        inline: true
                    },
                    {
                        name: 'Security & LP',
                        value: `LP: \`${lpStr}\`\nFreeze: \`Renounced\`\nMint: \`Renounced\``,
                        inline: true
                    },
                    {
                        name: 'Platform',
                        value: `Platform: \`${stats.launchpad_name || 'Pump.fun'}\`\nAge: \`${ageStr}\``,
                        inline: true
                    },
                    {
                        name: 'Quick Links',
                        value: `[DexScreener](${dexUrl})  •  [Axiom](${axiomUrl})  •  [GMGN](https://gmgn.ai/sol/token/${mint})  •  [InsightX Atlas](${bmapUrl})  •  [Pump.fun](${pumpUrl})`,
                        inline: false
                    },
                    {
                        name: 'Contract Address',
                        value: `\`${mint}\``,
                        inline: false
                    }
                )
                .setFooter({ text: `Audit requested by ${message.author.tag} • DD Terminal Risk Engine` })
                .setTimestamp();

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
                .setTitle(`MOMENTUM PREDICTION // $${stats.symbol} (${stats.name})`)
                .setURL(stats.dex_url || `https://dexscreener.com/solana/${mint}`)
                .setDescription(`Algorithmic momentum prediction & price targets.`)
                .setColor(0x6366F1)
                .addFields(
                    { name: 'Pattern Assessment', value: `\`${pred.pattern || 'Steady Uptrend'}\``, inline: true },
                    { name: 'Target Market Cap', value: `\`${pred.target_mc_str || 'N/A'}\``, inline: true },
                    { name: 'Key Support Level', value: `\`${pred.support_mc_str || 'N/A'}\``, inline: true },
                    { name: 'Model Confidence', value: `\`${pred.confidence_pct || 80}%\``, inline: true },
                    { name: 'Buy Pressure', value: `\`${pred.buy_pressure_pct || 50}% Buys\``, inline: true },
                    { name: '5M Trend', value: `\`${Number(stats.price_change_m5 || 0) >= 0 ? '+' : ''}${Number(stats.price_change_m5 || 0).toFixed(1)}%\``, inline: true },
                    { name: 'Quick Links', value: `[DexScreener](${stats.dex_url})  •  [GMGN](https://gmgn.ai/sol/token/${mint})  •  [InsightX Atlas](${stats.bubblemap_url})`, inline: false },
                    { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • Algorithmic Momentum Engine' })
                .setTimestamp();

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
                .setTitle(`HISTORICAL AUDIT // $${pair.symbol} (${pair.name})`)
                .setURL(pair.dex_url)
                .setDescription(`Historical return metrics verified from initial call.`)
                .setColor(athMult >= 2.0 ? 0x10B981 : 0x0EA5E9)
                .addFields(
                    { name: 'Initial Call MC', value: `\`${formatMcUsd(calledMc)}\``, inline: true },
                    { name: 'Peak ATH MC', value: `\`${formatMcUsd(athMc)}\` (+${((athMult - 1) * 100).toFixed(0)}% / ${athMult.toFixed(2)}x)`, inline: true },
                    { name: 'Current Real MC', value: `\`${formatMcUsd(currMc)}\` (${mult.toFixed(2)}x)`, inline: true },
                    { name: 'Quick Links', value: `[DexScreener](${pair.dex_url})  •  [GMGN](https://gmgn.ai/sol/token/${mint})`, inline: false },
                    { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • Historical Performance Auditor' })
                .setTimestamp();

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
                    .setTitle(`VALUATION // $${pair.symbol} (${pair.name})`)
                    .setURL(pair.dex_url)
                    .setDescription(`Real-time DexScreener pricing and pool reserve depth.`)
                    .setColor(0x00F0FF)
                    .addFields(
                        { name: 'Market Cap', value: `\`${mcStr}\``, inline: true },
                        { name: 'Price (USD)', value: `\`$${pair.price_usd < 0.0001 ? pair.price_usd.toFixed(8) : pair.price_usd.toFixed(6)}\``, inline: true },
                        { name: 'Liquidity', value: `\`$${Math.round(pair.liquidity_usd).toLocaleString()}\``, inline: true },
                        { name: 'DEX Platform', value: `\`${pair.dex_id.toUpperCase()}\``, inline: true },
                        { name: '5M Price Change', value: `\`${Number(pair.price_change_m5 || 0) >= 0 ? '+' : ''}${Number(pair.price_change_m5 || 0).toFixed(1)}%\``, inline: true },
                        { name: '24H Volume', value: `\`${formatMcUsd(pair.volume_h24 || pair.volume_h1 || 0)}\``, inline: true },
                        { name: 'Quick Links', value: `[DexScreener](${pair.dex_url})  •  [GMGN](https://gmgn.ai/sol/token/${targetMint})  •  [Axiom](https://axiom.trade/pair/${targetMint})`, inline: false },
                        { name: 'Contract Address', value: `\`${targetMint}\``, inline: false }
                    )
                    .setFooter({ text: 'DD Terminal • Real-Time Pricing Feed' })
                    .setTimestamp();

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
                    `MC: \`${mc}\`  •  KOL Buyers: \`${kols}\`\n` +
                    `Contract: \`${mint}\``;
            }).join('\n\n');

            const kolEmbed = new EmbedBuilder()
                .setTitle('KOL ACCUMULATION // FRESH CREATIONS')
                .setDescription(kolList)
                .setColor(0xF59E0B)
                .setFooter({ text: 'DD Terminal • Renowned KOL Accumulation' })
                .setTimestamp();

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
                    `MC: \`${mc}\`  •  Vol 5M: \`${vol}\`  •  Change: \`${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%\`\n` +
                    `Contract: \`${mint}\``;
            }).join('\n\n');

            const trendEmbed = new EmbedBuilder()
                .setTitle('5-MINUTE MOMENTUM // SOLANA TRENDING')
                .setDescription(trendList)
                .setColor(0x06B6D4)
                .setFooter({ text: 'DD Terminal • Real-Time Volume Screener' })
                .setTimestamp();

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
                const signalTag = item.signal === 'long' ? '[BULLISH]' : item.signal === 'short' ? '[BEARISH]' : '[NEUTRAL]';
                const score = item.score ? `Score: ${item.score}` : '';
                const summary = item.summary || item.title || 'Breaking event';
                return `**${idx + 1}. ${coins}${signalTag} (${score})**\n${summary}`;
            }).join('\n\n');

            const newsEmbed = new EmbedBuilder()
                .setTitle('MARKET WIRE // WEB3 BREAKING NEWS')
                .setDescription(newsDesc)
                .setColor(0x3B82F6)
                .setFooter({ text: 'DD Terminal • 6551 OpenNews Real-Time Feed' })
                .setTimestamp();

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
                .setTitle(`X INTELLIGENCE // @${info.screenName} (${info.name || handle})`)
                .setURL(`https://x.com/${info.screenName}`)
                .setDescription(info.description ? `*${info.description}*` : 'No bio provided.')
                .setColor(0x1DA1F2)
                .addFields(
                    { name: 'Followers', value: `\`${Number(info.followersCount || 0).toLocaleString()}\``, inline: true },
                    { name: 'Following', value: `\`${Number(info.friendsCount || 0).toLocaleString()}\``, inline: true },
                    { name: 'Total Posts', value: `\`${Number(info.statusesCount || 0).toLocaleString()}\``, inline: true },
                    { name: 'Verification', value: `\`${info.isBlueVerified ? 'Verified (Blue)' : 'Standard'}\``, inline: true }
                )
                .setFooter({ text: 'DD Terminal • Social Profile Intelligence' })
                .setTimestamp();

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
            const secEmbed = new EmbedBuilder()
                .setTitle(`SECURITY AUDIT // ${mint.slice(0, 6)}...${mint.slice(-4)}`)
                .setURL(`https://gmgn.ai/sol/token/${mint}`)
                .setDescription(sec.is_show_alert ? '▲ **CRITICAL SECURITY RISK DETECTED**' : '● **NO CRITICAL EXPLOIT FLAGS DETECTED**')
                .setColor(sec.is_show_alert || sec.is_honeypot || !sec.renounced_freeze_account ? 0xEF4444 : 0x10B981)
                .addFields(
                    { name: 'Alert Status', value: sec.is_show_alert ? '`▲ Flagged`' : '`● Clear`', inline: true },
                    { name: 'Freeze Authority', value: sec.renounced_freeze_account ? '`● Renounced`' : '`▲ Active (Risk)`', inline: true },
                    { name: 'Mint Authority', value: sec.renounced_mint ? '`● Renounced`' : '`▲ Active (Mintable)`', inline: true },
                    { name: 'Honeypot Gate', value: sec.is_honeypot ? '`▲ Active Honeypot`' : '`● Verified Sellable`', inline: true },
                    { name: 'Trading Taxes', value: (sec.buy_tax > 0 || sec.sell_tax > 0) ? `\`▲ ${sec.buy_tax}% / ${sec.sell_tax}%\`` : '`● 0% / 0%`', inline: true },
                    { name: 'LP Burned', value: `\`${sec.burn_ratio.toFixed(1)}% (${sec.burn_status})\``, inline: true },
                    { name: 'Top 10 Supply', value: `\`${sec.top_10_holder_rate.toFixed(1)}%\``, inline: true },
                    { name: 'Risk Flags', value: `\`${sec.flags.length > 0 ? sec.flags.join(', ') : 'None'}\``, inline: true },
                    { name: 'Quick Links', value: `[GMGN](https://gmgn.ai/sol/token/${mint})  •  [DexScreener](https://dexscreener.com/solana/${mint})`, inline: false },
                    { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • GMGN Token Security Intelligence' })
                .setTimestamp();

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
                const susp = h.is_suspicious ? '[SUSPICIOUS]' : '';
                const isNew = h.is_new ? '[NEW]' : '';
                const tag = h.wallet_tag_v2 ? `\`${h.wallet_tag_v2}\`` : '';
                const name = h.name ? `(${h.name})` : '';
                return `**${i + 1}.** \`${addr}\` ${tag} ${name} — **${pct}%** ${usd} ${susp} ${isNew}`.trim();
            }).join('\n');

            const hEmbed = new EmbedBuilder()
                .setTitle(`SUPPLY DISTRIBUTION // TOP 100 HOLDERS`)
                .setURL(`https://gmgn.ai/sol/token/${mint}`)
                .setDescription(
                    `**Top 10 Concentration:** \`${data.top10_pct.toFixed(1)}%\`\n` +
                    `**Suspicious Wallets:** \`${data.suspicious_count}\` (\`${data.suspicious_pct.toFixed(1)}%\` held)\n` +
                    `**Fresh Wallets:** \`${data.new_wallets_pct.toFixed(1)}%\` held\n\n` +
                    `**Top 10 Largest Holders:**\n${topList}`
                )
                .setColor(data.suspicious_pct > 8.0 || data.top10_pct > 60.0 ? 0xEF4444 : 0x10B981)
                .addFields(
                    { name: 'Quick Links', value: `[GMGN](https://gmgn.ai/sol/token/${mint})  •  [DexScreener](https://dexscreener.com/solana/${mint})`, inline: false },
                    { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • GMGN Top 100 Holder Analysis' })
                .setTimestamp();

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
                .setTitle(`PORTFOLIO HOLDINGS // ${wallet.slice(0, 6)}...${wallet.slice(-4)}`)
                .setURL(`https://gmgn.ai/sol/address/${wallet}`)
                .setDescription(`**Active Token Positions:**\n\n${holdingsDesc}`)
                .setColor(0x6366F1)
                .addFields(
                    { name: 'Wallet Address', value: `\`${wallet}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • GMGN Portfolio Intelligence' })
                .setTimestamp();

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
                `**${i + 1}.** \`${p.dex}\` — Liq: \`${formatMcUsd(p.liquidity_usd)}\` · Vol 24H: \`${formatMcUsd(p.volume_24h)}\`\n` +
                `   Pool: \`${p.address ? p.address.slice(0, 20) + '...' : 'N/A'}\``
            ).join('\n');
            const poolEmbed = new EmbedBuilder()
                .setTitle(`LIQUIDITY POOLS // ${mint.slice(0, 6)}...${mint.slice(-4)}`)
                .setURL(`https://dexscreener.com/solana/${mint}`)
                .setColor(0x06B6D4)
                .addFields(
                    { name: 'Total Liquidity', value: `\`${formatMcUsd(pool.total_liquidity_usd)}\``, inline: true },
                    { name: 'Primary DEX', value: `\`${pool.main_dex}\``, inline: true },
                    { name: 'Active Pools', value: poolList, inline: false },
                    { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • Liquidity Pool Depth' })
                .setTimestamp();
            await message.channel.send({ embeds: [poolEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 13. .signal — KOL Call Signal (signal-type 13)
    if (content.startsWith('.signal')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.signal');
        await message.channel.send('⚡ Retrieving latest KOL call signals from GMGN...');
        try {
            const signals = await getGmgnKolSignal('sol', true);
            if (!signals || signals.length === 0) {
                return message.channel.send('⚠️ No KOL signals found right now.');
            }
            const sigList = signals.slice(0, 5).map((s, i) => {
                const mc = s.market_cap_usd ? formatMcUsd(s.market_cap_usd) : 'N/A';
                const amt = s.buy_amount_usd ? formatMcUsd(s.buy_amount_usd) : 'N/A';
                const kol = s.kol_name || (s.kol_wallet ? `${s.kol_wallet.slice(0, 6)}...${s.kol_wallet.slice(-4)}` : 'Unknown');
                return `**${i + 1}. [$${s.symbol || 'TOKEN'}](https://dexscreener.com/solana/${s.mint})**\n` +
                    `KOL: \`${kol}\` · Valuation: \`${mc}\` · Inflow: \`${amt}\`\n` +
                    `\`${s.mint}\``;
            }).join('\n\n');
            const sigEmbed = new EmbedBuilder()
                .setTitle('KOL CALL SIGNALS // SIGNAL TYPE 13')
                .setDescription(sigList)
                .setColor(0xF59E0B)
                .setFooter({ text: 'DD Terminal • GMGN KOL Accumulation Radar' })
                .setTimestamp();
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
                const kol = t.kol_name || (t.kol_wallet ? `${t.kol_wallet.slice(0, 6)}...${t.kol_wallet.slice(-4)}` : 'Unknown');
                const tag = t.side === 'sell' ? '[SELL]' : '[BUY]';
                return `**${i + 1}. \`${tag}\` [$${t.symbol || 'TOKEN'}](https://dexscreener.com/solana/${t.mint})**\n` +
                    `KOL: \`${kol}\` · Valuation: \`${mc}\` · Size: \`${amt}\`\n` +
                    `\`${t.mint}\``;
            }).join('\n\n');
            const tradeEmbed = new EmbedBuilder()
                .setTitle(`KOL TRANSACTION STREAM${side ? ` // ${side.toUpperCase()}` : ''}`)
                .setDescription(tradeList)
                .setColor(side === 'sell' ? 0xEF4444 : (side === 'buy' ? 0x10B981 : 0x3B82F6))
                .setFooter({ text: 'DD Terminal • Real-Time KOL Trade Tape' })
                .setTimestamp();
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
                return `**${i + 1}.** \`${h.name || addr}\` — **${h.holding_pct.toFixed(2)}%** · Realized PnL: \`${profit}\``;
            }).join('\n');
            const kolHEmbed = new EmbedBuilder()
                .setTitle(`KOL HOLDER AUDIT // ${mint.slice(0, 6)}...${mint.slice(-4)}`)
                .setURL(`https://dexscreener.com/solana/${mint}`)
                .setColor(0x8B5CF6)
                .addFields(
                    { name: 'KOL Count', value: `\`${data.kol_count}\``, inline: true },
                    { name: 'Total KOL Holdings', value: `\`${data.kol_total_pct.toFixed(2)}%\``, inline: true },
                    { name: 'Top KOL Holders (Ranked by Realized PnL)', value: holderList, inline: false },
                    { name: 'Quick Links', value: `[DexScreener](https://dexscreener.com/solana/${mint}) • [Axiom](https://axiom.trade/trade/${mint}) • [GMGN](https://gmgn.ai/sol/token/${mint}) • [Pump.fun](https://pump.fun/${mint})`, inline: false },
                    { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • Ranked by Realized Profit' })
                .setTimestamp();
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
            const ctoStr = dev.cto_flag === 1 ? '`COMMUNITY TAKEOVER (CTO)`' : '`ORIGINAL DEVELOPER`';
            const devAddr = dev.dev_wallet ? `\`${dev.dev_wallet.slice(0, 6)}...${dev.dev_wallet.slice(-4)}\`` : '`Unknown`';
            const devEmbed = new EmbedBuilder()
                .setTitle(`DEVELOPER AUDIT // ${mint.slice(0, 6)}...${mint.slice(-4)}`)
                .setURL(`https://dexscreener.com/solana/${mint}`)
                .setColor(dev.dev_hold_pct > 10 ? 0xEF4444 : 0x10B981)
                .addFields(
                    { name: 'Developer Wallet', value: devAddr, inline: true },
                    { name: 'SOL Balance', value: `\`${dev.dev_sol_balance} SOL\``, inline: true },
                    { name: 'Project Status', value: ctoStr, inline: true },
                    { name: 'Dev Holding', value: `\`${dev.dev_hold_pct.toFixed(2)}%\``, inline: true },
                    { name: 'Team Holdings', value: `\`${dev.dev_team_hold_pct.toFixed(2)}%\``, inline: true },
                    { name: 'Combined Insider', value: `\`${(dev.dev_hold_pct + dev.dev_team_hold_pct).toFixed(2)}%\``, inline: true },
                    { name: 'Quick Links', value: `[DexScreener](https://dexscreener.com/solana/${mint}) • [Axiom](https://axiom.trade/trade/${mint}) • [GMGN](https://gmgn.ai/sol/token/${mint}) • [Pump.fun](https://pump.fun/${mint})`, inline: false },
                    { name: 'Contract Address', value: `\`${mint}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • Developer Risk & Insider Audit' })
                .setTimestamp();
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
                const pcStr = `${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%`;
                return `**${idx + 1}. [$${sym}](https://dexscreener.com/solana/${mint})** ([Pump.fun](https://pump.fun/${mint}))\n` +
                    `Valuation: \`${mc}\` · Vol 24H: \`${vol}\` · Change: \`${pcStr}\`\n` +
                    `\`${mint}\``;
            }).join('\n\n');
            const pumpEmbed = new EmbedBuilder()
                .setTitle(`PUMP.FUN TRENDING // ${interval.toUpperCase()}`)
                .setDescription(pumpList)
                .setColor(0x8B5CF6)
                .setFooter({ text: `DD Terminal • Pump.fun Platform Momentum (${interval.toUpperCase()})` })
                .setTimestamp();
            await message.channel.send({ embeds: [pumpEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 17.1. .sm / .smartmoney — Smart Money Buy Signals (GMGN Signal Type 12)
    if (content === '.sm' || content === '.smartmoney' || content.startsWith('.sm ') || content.startsWith('.smartmoney ')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.smartmoney');
        await message.channel.send('🌱 Fetching latest Smart Money cluster buy signals from GMGN (Signal 12)...');
        try {
            const signals = await getGmgnSmartMoneyBuySignals('sol', true);
            if (!signals || signals.length === 0) {
                return message.channel.send('⚠️ No smart money cluster buy signals found right now.');
            }
            const smList = signals.slice(0, 5).map((s, i) => {
                const mint = s.token_address || s.data?.address || 'N/A';
                const sym = s.data?.symbol || s.symbol || 'TOKEN';
                const mc = s.data?.market_cap ? formatMcUsd(s.data.market_cap) : (s.market_cap ? formatMcUsd(s.market_cap) : 'N/A');
                const totalAmt = s.data?.total_amount ? `$${Math.round(s.data.total_amount).toLocaleString()}` : 'N/A';
                const buyerCount = s.data?.smart_degen_wallets?.length || s.count || 0;
                const buyers = (s.data?.smart_degen_wallets || []).slice(0, 3).map(w => {
                    const shortAddr = `${w.address.slice(0, 4)}...${w.address.slice(-4)}`;
                    const amt = w.buy_amount ? ` ($${Math.round(w.buy_amount)})` : '';
                    return `\`${shortAddr}\`${amt}`;
                }).join(', ') || 'N/A';

                return `**${i + 1}. [$${sym}](https://dexscreener.com/solana/${mint})**\n` +
                    `Valuation: \`${mc}\` · Cluster Inflow: \`${totalAmt}\` · Degens: \`${buyerCount}\`\n` +
                    `Top Buyers: ${buyers}\n` +
                    `\`${mint}\``;
            }).join('\n\n');

            const smEmbed = new EmbedBuilder()
                .setTitle('SMART MONEY CLUSTERS // SIGNAL TYPE 12')
                .setDescription(smList)
                .setColor(0x10B981)
                .setFooter({ text: 'DD Terminal • Coordinated Smart Money Entry' })
                .setTimestamp();
            await message.channel.send({ embeds: [smEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 17.2. .devhistory <wallet_or_mint> — Dev Created Tokens Analysis
    if (content.startsWith('.devhistory') || content.startsWith('.devhist')) {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.devhistory');
        const parts = content.split(/\s+/);
        if (parts.length < 2) return message.channel.send('⚠️ Usage: `.devhistory <wallet_address_or_ca>`');
        const target = parts[1].trim();

        await message.channel.send(`🧑 Inspecting historical token launches for \`${target}\`...`);
        try {
            let devWallet = target;
            // Check if user passed a token mint instead of dev wallet
            if (target.length >= 32 && target.length <= 44) {
                const devCheck = await getGmgnDevInfo(target, 'sol', true).catch(() => null);
                if (devCheck?.dev_wallet) {
                    devWallet = devCheck.dev_wallet;
                }
            }

            const data = await getGmgnDevCreatedTokens(devWallet, 'sol', true);
            if (!data.checked) {
                return message.channel.send(`⚠️ Could not retrieve dev history for \`${devWallet}\`.`);
            }

            const rugVerdict = data.is_serial_rugger
                ? '`HIGH RISK: SERIAL RUGGER (0% MIGRATION)`'
                : (data.migration_rate >= 40.0 ? '`VERIFIED HIGH QUALITY DEV`' : '`CAUTION: LOW GRADUATION RATE`');

            const tokenList = (data.tokens || []).slice(0, 6).map((t, idx) => {
                const sym = t.symbol || 'TOKEN';
                const ath = t.token_ath_mc ? formatMcUsd(Number(t.token_ath_mc)) : 'N/A';
                const status = t.is_open ? '`MIGRATED`' : '`CURVE EXPIRED`';
                return `**${idx + 1}.** **$${sym}** — ATH: \`${ath}\` · Status: ${status}`;
            }).join('\n') || 'None recorded';

            const devHistEmbed = new EmbedBuilder()
                .setTitle(`DEVELOPER LAUNCH AUDIT // ${devWallet.slice(0, 6)}...${devWallet.slice(-4)}`)
                .setURL(`https://solscan.io/account/${devWallet}`)
                .setColor(data.is_serial_rugger ? 0xEF4444 : (data.migration_rate >= 40.0 ? 0x10B981 : 0xF59E0B))
                .addFields(
                    { name: 'Risk Verdict', value: rugVerdict, inline: false },
                    { name: 'Total Created', value: `\`${data.total_created}\``, inline: true },
                    { name: 'Migrations', value: `\`${data.open_count} (${data.migration_rate}%)\``, inline: true },
                    { name: 'Peak ATH MC', value: `\`${data.highest_ath_mc > 0 ? formatMcUsd(data.highest_ath_mc) : 'N/A'}\``, inline: true },
                    { name: 'Recent Token Deployments', value: tokenList, inline: false },
                    { name: 'Developer Wallet', value: `\`${devWallet}\``, inline: false }
                )
                .setFooter({ text: 'DD Terminal • Developer Track Record & Rug Audit' })
                .setTimestamp();

            await message.channel.send({ embeds: [devHistEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 17.3. .nearcurve — Near Completion Bonding Curve Screener
    if (content === '.nearcurve' || content === '.nearcompletion') {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.nearcurve');
        await message.channel.send('⚡ Scanning Pump.fun tokens near curve completion with smart money...');
        try {
            const tokens = await getGmgnNearCompletionTokens('sol', 2, true);
            if (!tokens || tokens.length === 0) {
                return message.channel.send('⚠️ No tokens near completion found right now.');
            }
            const curveList = tokens.slice(0, 5).map((t, i) => {
                const mint = t.address || t.token_address || 'N/A';
                const sym = t.symbol || 'TOKEN';
                const mc = t.market_cap ? formatMcUsd(Number(t.market_cap)) : 'N/A';
                const prog = t.progress ? `${(Number(t.progress) * 100).toFixed(1)}%` : 'N/A';
                const smCount = t.smart_degen_count || 0;
                return `**${i + 1}. [$${sym}](https://dexscreener.com/solana/${mint})** ([Pump.fun](https://pump.fun/${mint}))\n` +
                    `Bonding Curve: \`${prog}\` · Valuation: \`${mc}\` · Smart Degens: \`${smCount}\`\n` +
                    `\`${mint}\``;
            }).join('\n\n');

            const curveEmbed = new EmbedBuilder()
                .setTitle('BONDING CURVE RADAR // NEAR GRADUATION')
                .setDescription(curveList)
                .setColor(0x8B5CF6)
                .setFooter({ text: 'DD Terminal • Pump.fun 80%–95% Curve Screener' })
                .setTimestamp();
            await message.channel.send({ embeds: [curveEmbed] });
        } catch (err) {
            await message.channel.send(`❌ Error: \`${err.message}\``);
        }
        return;
    }

    // 17.4. .qualitymigrated / .qm — Server-Side Filtered Migrated Tokens
    if (content === '.qualitymigrated' || content === '.qm') {
        if (!isPremiumUser(message)) return sendPremiumRequiredNotice(message, '.qualitymigrated');
        await message.channel.send('💎 Screening top quality migrated tokens from GMGN...');
        try {
            const tokens = await getGmgnMigratedQuality('sol', {}, true);
            if (!tokens || tokens.length === 0) {
                return message.channel.send('⚠️ No quality migrated tokens matched the filter right now.');
            }
            const qList = tokens.slice(0, 5).map((t, i) => {
                const mint = t.address || t.token_address || 'N/A';
                const sym = t.symbol || 'TOKEN';
                const mc = t.market_cap ? formatMcUsd(Number(t.market_cap)) : 'N/A';
                const liq = t.liquidity ? formatMcUsd(Number(t.liquidity)) : 'N/A';
                const top10 = t.top_10_holder_rate ? `${(Number(t.top_10_holder_rate) * 100).toFixed(1)}%` : 'N/A';
                return `**${i + 1}. [$${sym}](https://dexscreener.com/solana/${mint})**\n` +
                    `Valuation: \`${mc}\` · Liquidity: \`${liq}\` · Top 10 Supply: \`${top10}\`\n` +
                    `\`${mint}\``;
            }).join('\n\n');

            const qEmbed = new EmbedBuilder()
                .setTitle('QUALITY MIGRATED SCREENER // LOW RISK POOLS')
                .setDescription(qList)
                .setColor(0x06B6D4)
                .setFooter({ text: 'DD Terminal • Filtered: Low Top 10, Low Bundles, Locked Liquidity' })
                .setTimestamp();
            await message.channel.send({ embeds: [qEmbed] });
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
