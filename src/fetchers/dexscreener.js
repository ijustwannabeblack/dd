import * as config from '../config.js';

export async function getDexscreenerData(mint) {
    if (!mint) return null;
    const url = `${config.DEXSCREENER_API_BASE}/latest/dex/tokens/${mint}`;

    try {
        const resp = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;

        const data = await resp.json();
        const pairs = data?.pairs;
        if (!Array.isArray(pairs) || pairs.length === 0) return null;

        const validPairs = pairs.filter(p => {
            if (!p || typeof p !== 'object') return false;
            const qSym = String(p.quoteToken?.symbol || '').toUpperCase();
            const qAddr = String(p.quoteToken?.address || '');
            const price = Number(p.priceUsd || 0);
            const mc = Number(p.marketCap || p.fdv || (price * 1_000_000_000));
            const isStdQuote = ['SOL', 'WSOL', 'USDC', 'USDT'].includes(qSym) ||
                ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'].includes(qAddr);
            return isStdQuote && mc < 2_000_000_000;
        });

        if (!validPairs.length) return null;

        validPairs.sort((a, b) => {
            const liqA = Number(a.liquidity?.usd || 0);
            const liqB = Number(b.liquidity?.usd || 0);
            return liqB - liqA;
        });

        const best = validPairs[0];
        const priceUsd = Number(best.priceUsd || 0);
        const mc = Number(best.marketCap || best.fdv || (priceUsd * 1_000_000_000));
        const fdv = Number(best.fdv || mc);
        const liqUsd = Number(best.liquidity?.usd || 0);
        const vol24h = Number(best.volume?.h24 || 0);
        const volM5 = Number(best.volume?.m5 || 0);

        const txnsM5 = best.txns?.m5 || {};
        const buysM5 = Number(txnsM5.buys || 0);
        const sellsM5 = Number(txnsM5.sells || 0);

        const priceChgM5 = Number(best.priceChange?.m5 || 0);
        const priceChgH1 = Number(best.priceChange?.h1 || 0);
        const priceChgH24 = Number(best.priceChange?.h24 || 0);

        const baseToken = best.baseToken || {};
        const dexUrl = String(best.url || `https://dexscreener.com/solana/${mint}`);

        let websiteUrl = '';
        let twitterUrl = '';
        let telegramUrl = '';
        for (const w of (best.info?.websites || [])) {
            if (w.url) { websiteUrl = w.url; break; }
        }
        for (const s of (best.info?.socials || [])) {
            const t = String(s.type || '').toLowerCase();
            const u = String(s.url || '');
            if (t === 'twitter' || u.includes('x.com') || u.includes('twitter.com')) twitterUrl = u;
            if (t === 'telegram' || u.includes('t.me')) telegramUrl = u;
        }

        const iconUrl = best.info?.imageUrl || '';
        const bannerUrl = best.info?.header || '';

        return {
            mint,
            symbol: String(baseToken.symbol || 'TOKEN').toUpperCase(),
            name: String(baseToken.name || baseToken.symbol || 'Token'),
            price_usd: priceUsd,
            market_cap_usd: mc,
            fdv_usd: fdv,
            liquidity_usd: liqUsd,
            volume_24h_usd: vol24h,
            volume_m5: volM5,
            buys_m5: buysM5,
            sells_m5: sellsM5,
            price_change_m5: priceChgM5,
            price_change_h1: priceChgH1,
            price_change_h24: priceChgH24,
            pair_address: String(best.pairAddress || ''),
            dex_id: String(best.dexId || ''),
            dex_url: dexUrl,
            icon_url: iconUrl,
            banner_url: bannerUrl,
            has_website: Boolean(websiteUrl),
            has_twitter: Boolean(twitterUrl),
            has_telegram: Boolean(telegramUrl),
            website_url: websiteUrl,
            twitter_url: twitterUrl,
            telegram_url: telegramUrl,
            created_timestamp: Number(best.pairCreatedAt || 0),
        };
    } catch (err) {
        return null;
    }
}

export async function getPonsRobinhoodPairs() {
    const tokens = [];
    const searchTerms = ['pons', 'robinhood'];

    for (const term of searchTerms) {
        try {
            const url = `${config.DEXSCREENER_API_BASE}/latest/dex/search?q=${term}`;
            const resp = await fetch(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(6000),
            });
            if (!resp.ok) continue;

            const data = await resp.json();
            const pairs = data?.pairs || [];

            for (const p of pairs) {
                if (String(p.chainId || '').toLowerCase() !== 'solana') continue;
                const dexId = String(p.dexId || '').toLowerCase();
                const isPons = config.PONS_DEX_IDS.some(id => dexId.includes(id));
                const isRobinhood = config.ROBINHOOD_DEX_IDS.some(id => dexId.includes(id));

                if (isPons || isRobinhood) {
                    const baseToken = p.baseToken || {};
                    const mint = baseToken.address;
                    if (mint) {
                        tokens.push({
                            mint,
                            symbol: baseToken.symbol,
                            name: baseToken.name,
                            source: isPons ? 'pons' : 'robinhood',
                            dexId,
                            pairAddress: p.pairAddress,
                        });
                    }
                }
            }
        } catch (err) {
            // ignore network err
        }
    }
    return tokens;
}
