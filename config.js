import dotenv from 'dotenv';
import fs from 'fs';
// Load .env — fall back to .env.txt if not found (common on Windows bot-hosting setups)
if (!fs.existsSync('.env') && fs.existsSync('.env.txt')) {
    dotenv.config({ path: '.env.txt' });
} else {
    dotenv.config();
}

// ---- Discord ----
export const DISCORD_BOT_TOKEN   = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || '';
export const TARGET_CHANNEL_ID   = '1540840819790184458';  // Calls Channel
export const MIGRATED_CHANNEL_ID = '1540840819790184458';  // Calls Channel
export const PLAIN_CA_CHANNEL_ID = '1541513168239460464';  // Plain CAs Channel
export const RUG_CHANNEL_ID      = '1540067249656963124';  // Rug alerts
export const WINS_CHANNEL_ID     = '1540839154882056363';  // Live profit / win updates channel
export const DONE_CHANNEL_ID     = '1541133072781811712';  // Completed / Done coins channel
export const AI_CHAT_CHANNEL_ID  = '1541166799620542524';  // AI Chat channel
export const REJECTED_CHANNEL_ID = '1541182755705065603';  // Rejected coins channel

// ---- Pro Trader & Smart Money Wallets ----
export const PRO_TRADER_WALLETS = {
    'CuP3sEY7x2t9K8m5Q1vL6N0jR4wH3zY8uP': 'Cupsey (Pro Trader)',
    '86x6a6s4D2k8L0m2N4v5P6q7R8s9T0u1': 'Smart Money Trader #1',
    '5Q544ftkK21EDjz5h4wxfW8V7qL3N2P4': 'Raydium Whale Caller',
    'GJ2f6b8w9K1m0N3v5P7q9R1s3T5u7V9w': 'Solana Alpha Trader',
};

// ---- InsightX API Keys (10 Accounts / Key Rotation Pool) ----
const _raw_insightx_keys = process.env.INSIGHTX_API_KEYS || '';
export const INSIGHTX_API_KEYS = _raw_insightx_keys
    ? _raw_insightx_keys.split(',').map(k => k.trim()).filter(Boolean)
    : [
        'd86a57a5-37ae-43e5-800c-cf53a42dc985',
        '3c6f92e5-6d4f-4187-8129-8a9b1da0556f',
        '8d2bdec2-ed4c-43f4-8b12-b2bb5b81cb3f',
        'ad605d1d-ea23-435c-90d3-18431bb9f0a0',
        '813d4523-cfaa-4828-b958-ee3e5b957a63',
        '998f1642-0e93-42f3-92a3-e5b34312cf3c',
        'd9c5eeb5-cfdb-4f5c-add5-293f25ea7729',
        'ea15e393-0007-4163-bbab-d783af59694f',
        '97764101-263b-4d5d-b283-981c35e09cdd',
        '931a4990-93cf-415b-993d-04681ceb2e7b',
    ];

export const INSIGHTX_API_KEY = process.env.INSIGHTX_API_KEY || (INSIGHTX_API_KEYS[0] || '');

// ---- Solana Tracker API Key ----
export const SOLANATRACKER_API_KEY = process.env.SOLANATRACKER_API_KEY || '505107a5-41ee-4297-ad1b-47f108b2dbe7';

// ---- GMGN API Key ----
export const GMGN_API_KEY = process.env.GMGN_API_KEY || 'gmgn_da06ce8392291430de6f06e5b7f6a30f';

// ---- Chart-IMG API Key ----
export const CHART_IMG_API_KEY = process.env.CHART_IMG_API_KEY || '6oT4Sl00aa8bB7EtByKIG5kiXzV9atry3tojN1Ag';

// ---- Polling & Storage ----
export const SEEN_FILE = 'seen_mints.json';
export const TRACKERS_FILE = 'active_trackers.json';

// ---- Stages to watch ----
export const STAGES = {
    new_pairs: true,
    final_stretch: true,
    migrated: true,
    pons: true,
    robinhood: true,
};

// ---- Market Cap Limits & Early Entry Ceiling ----
export const MAX_CALL_MC_USD = 1_500_000;  // 1.5M USD hard early-entry ceiling
export const MAX_DEV_HOLDINGS_PCT = 30.0;  // Max 30% dev limit (synced to Axiom devHolding.max = 30)
export const MAX_SINGLE_HOLDER_PCT = 35.0;
export const MAX_BUNDLERS_PCT = 35.0;
export const MAX_TOP10_NONPOOL_PCT = 75.0;
export const MIN_HOLDERS_COUNT = 3;

// ---- Pump.fun Livestream Settings ----
export const PUMPFUN_MIN_GOOD_VIEWERS = 8;

// ---- Filter Thresholds ----
export const FILTERS = {
    max_top10_holders_pct: 40.0,
    max_dev_holdings_pct: 30.0,
    max_snipers_pct: 40.0,
    max_insiders_pct: 20.0,
    max_bundlers_pct: 25.0,
    max_single_holder_pct: 35.0,
    require_lp_burned: false,
    min_holders: 2,
    require_dex_paid: false,
};

export const EARLY_FILTERS = {
    max_top10_holders_pct: 40.0,
    max_dev_holdings_pct: 30.0,
    max_snipers_pct: 40.0,
    max_insiders_pct: 20.0,
    max_bundlers_pct: 25.0,
    max_single_holder_pct: 35.0,
    min_holders: 2,
    min_market_cap_sol: 0.0,
};

export const ACTIVITY_FILTERS = {
    min_buys_h1: 0,
    min_volume_h1_usd: 500,
    min_liquidity_usd: 5000,
};

export const PONS_DEX_IDS = ['pons', 'pons-amm', 'pons-v2', 'ponsv2'];
export const ROBINHOOD_DEX_IDS = ['robinhood', 'robinhood-amm', 'robinhoodamm'];
export const DEXSCREENER_POLL_INTERVAL = 15;

export const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || '';
export const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';
export const DEXSCREENER_API_BASE = 'https://api.dexscreener.com';
export const RUGCHECK_API_BASE = 'https://api.rugcheck.xyz/v1';

export const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '22ebf944-06df-4475-a6b5-c163e85cd6f8';
export const FLUX_RPC_URL = process.env.FLUX_RPC_URL || 'https://eu.fluxrpc.com?key=fd28c393-45a5-49b5-889d-9353c1580b95';
export const SOLANA_RPC_URL = FLUX_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` || 'https://api.mainnet-beta.solana.com';
export const RUGCHECK_API_KEY = process.env.RUGCHECK_API_KEY || 'fd28c393-45a5-49b5-889d-9353c1580b95';

export const AIMLAPI_KEY = process.env.AIMLAPI_KEY || '';
export const AIMLAPI_BASE_URL = 'https://api.aimlapi.com/v1';
export const AI_MODEL = 'gpt-4o-mini';

export const MIGRATION_MARKET_CAP_SOL = 85;
export const FINAL_STRETCH_THRESHOLD_PCT = 0.85;
