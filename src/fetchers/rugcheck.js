import * as config from '../config.js';

export async function getPumpfunLivestreamInfo(mint) {
    if (!mint) return { is_live: false, viewers: 0, title: '', has_good_viewers: false };

    const url = `https://frontend-api-v3.pump.fun/coins/${mint}`;
    try {
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
            const data = await resp.json();
            const isLive = Boolean(data.is_currently_live);
            const viewers = Number(data.num_participants || 0);
            const title = String(data.livestream_title || '').trim();
            const minViewers = config.PUMPFUN_MIN_GOOD_VIEWERS || 8;
            return {
                is_live: isLive,
                viewers,
                title,
                has_good_viewers: isLive && viewers >= minViewers,
            };
        }
    } catch (err) {
        // ignore timeout
    }
    return { is_live: false, viewers: 0, title: '', has_good_viewers: false };
}

export async function getRugcheckReport(mint) {
    if (!mint) return null;

    const headers = { 'Accept': 'application/json' };
    if (config.RUGCHECK_API_KEY) {
        headers['Authorization'] = `Bearer ${config.RUGCHECK_API_KEY}`;
    }

    let url = `${config.RUGCHECK_API_BASE}/tokens/${mint}/report`;
    try {
        let resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        let data = resp.ok ? await resp.json() : null;

        if (!data || typeof data !== 'object' || !data.mint) {
            url = `${config.RUGCHECK_API_BASE}/tokens/${mint}/report/summary`;
            resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
            data = resp.ok ? await resp.json() : null;
        }

        if (!data || typeof data !== 'object') return null;

        const topHoldersRaw = Array.isArray(data.topHolders) ? data.topHolders : [];
        const holders = Number(data.totalHolders || topHoldersRaw.length);

        const top10Pct = topHoldersRaw.slice(0, 10).reduce((acc, h) => acc + Number(h?.pct || 0), 0);
        const insidersPct = topHoldersRaw
            .filter(h => h && typeof h === 'object' && h.insider)
            .reduce((acc, h) => acc + Number(h?.pct || 0), 0);

        const creatorAddr = String(
            data.creator ||
            data.tokenMeta?.creator ||
            data.tokenMeta?.updateAuthority ||
            data.token?.creator ||
            ''
        );

        let devHoldingsPct = 0;
        if (creatorAddr && topHoldersRaw.length) {
            const devHolder = topHoldersRaw.find(h => h && (h.address === creatorAddr || h.owner === creatorAddr));
            if (devHolder) {
                devHoldingsPct = Number(Number(devHolder.pct || 0).toFixed(2));
            }
        }

        let lpLockedPct = 0;
        for (const market of (data.markets || [])) {
            if (market?.lp) {
                lpLockedPct = Math.max(lpLockedPct, Number(market.lp.lpLockedPct || 0));
            }
        }

        const tokenObj = data.token || {};
        const freezeAuth = data.freezeAuthority || tokenObj.freezeAuthority || null;
        const mintAuth = data.mintAuthority || tokenObj.mintAuthority || null;

        const risksList = Array.isArray(data.risks) ? data.risks : [];
        const dangerRisks = risksList
            .filter(r => r && typeof r === 'object' &&
                !String(r.name || '').toLowerCase().includes('lp') &&
                (['danger', 'critical'].includes(r.level) || String(r.name || '').toLowerCase().includes('freeze'))
            )
            .map(r => r.name);

        const fileMeta = data.fileMeta || {};
        const tokenMeta = data.tokenMeta || {};
        const rcIcon = fileMeta.image || tokenMeta.image || '';
        const rcBanner = fileMeta.header || '';

        return {
            holders,
            top10_holders_pct: Number(top10Pct.toFixed(2)),
            insiders_pct: Number(insidersPct.toFixed(2)),
            dev_holdings_pct: devHoldingsPct,
            lp_burned: lpLockedPct >= 95.0,
            lp_locked_pct: Number(lpLockedPct.toFixed(2)),
            risk_score: Number(data.score || 0),
            score_normalised: Number(data.score_normalised || 0),
            risks: risksList.map(r => r?.name).filter(Boolean),
            danger_risks: dangerRisks,
            freeze_authority: freezeAuth,
            mint_authority: mintAuth,
            icon_url: rcIcon,
            banner_url: rcBanner,
            raw: data,
        };
    } catch (err) {
        return null;
    }
}
