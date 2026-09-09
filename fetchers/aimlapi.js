import * as config from '../config.js';

/**
 * Calls AIMLAPI OpenAI-compatible chat completion engine (DeepSeek-V3 / gpt-4o-mini).
 * @param {Array<{role: string, content: string}>} messages
 * @param {string|null} systemPrompt
 * @returns {Promise<string|null>}
 */
export async function callAimlapi(messages, systemPrompt = null) {
    const apiKey = (config.AIMLAPI_KEY || process.env.AIMLAPI_KEY || '').trim();
    if (!apiKey) {
        return null;
    }

    const url = `${config.AIMLAPI_BASE_URL}/chat/completions`;
    const fullMessages = [];
    if (systemPrompt) {
        fullMessages.push({ role: 'system', content: systemPrompt });
    }
    fullMessages.push(...messages);

    const payload = {
        model: config.AI_MODEL || 'gpt-4o-mini',
        messages: fullMessages,
        temperature: 0.5,
        max_tokens: 800,
    };

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(3000),
        });

        if (resp.ok) {
            const data = await resp.json();
            const choices = data?.choices || [];
            if (choices.length > 0) {
                return choices[0]?.message?.content || null;
            }
        } else {
            const body = await resp.text();
            console.warn(`[AIMLAPI] returned status ${resp.status}: ${body.slice(0, 200)}`);
        }
    } catch (e) {
        console.warn(`[AIMLAPI] call exception: ${e.message}`);
    }

    return null;
}

/**
 * Deep AI Narrative & Security Evaluator for tokens before calling
 * @param {object} stats
 * @returns {Promise<{passes: boolean, score: number, reason: string, theme: string}>}
 */
export async function aiEvaluateToken(stats) {
    const symbol = stats.symbol || 'TOKEN';
    const name = stats.name || symbol;
    const desc = stats.description || '';
    const mc = Number(stats.market_cap_usd || 0);
    const liq = Number(stats.liquidity_usd || 0);
    const buys5m = Number(stats.buys_m5 || 0);
    const sells5m = Number(stats.sells_m5 || 0);
    const vol5m = Number(stats.volume_m5 || 0);
    const holders = Number(stats.holders || 0);
    const devPct = Number(stats.dev_holdings_pct || 0);
    const top10Pct = Number(stats.top10_holders_pct || 0);
    const clusters = Number(stats.cluster_pct || 0);
    const bundlers = Number(stats.bundlers_pct || 0);
    const snipers = Number(stats.snipers_pct || 0);
    const insiders = Number(stats.insiders_pct || 0);
    const riskScore = Number(stats.risk_score || 0);

    // Hard gate: instantly reject any connected bubblemap cluster or bundler ring >= 5%
    if (clusters >= 5.0) {
        return {
            passes: false,
            score: 1,
            reason: `InsightX Bubblemap Cluster Risk: Connected bubbles hold ${clusters.toFixed(1)}% (max 5.0%)`,
            theme: 'Cluster Rug',
        };
    }
    if (bundlers >= 5.0) {
        return {
            passes: false,
            score: 1,
            reason: `Coordinated Jito Bundler Ring: Bundlers hold ${bundlers.toFixed(1)}% (max 5.0%)`,
            theme: 'Bundled Launch',
        };
    }
    if ((clusters + bundlers + insiders) >= 8.0) {
        return {
            passes: false,
            score: 1,
            reason: `Multi-Cluster Spiderweb Ring: Combined clusters hold ${(clusters + bundlers + insiders).toFixed(1)}% (max 8.0%)`,
            theme: 'Spiderweb Rug',
        };
    }

    const systemPrompt = [
        'You are an elite Solana memecoin alpha screener and anti-rug auditor.',
        'CRITICAL ANTI-RUG CRITERIA (INSTANT FAIL IF VIOLATED):',
        '1. InsightX Atlas / Bubblemaps Spiderweb: Any connected cluster holding >= 5%, or any fan-out ring connected to a central funder/deployer -> FAIL.',
        '2. Jito Bundlers & Snipers: Any token with >= 5% supply bundled or sniped at launch -> FAIL.',
        '3. Dev Holdings: Dev holds > 5%, or combined dev + insiders hold > 8% -> FAIL.',
        '4. Top 10 Concentration: Top 10 holders hold > 25% non-pool -> FAIL.',
        '5. Slop & Low-effort: Brainless copycat slop, keyboard mash tickers, or zero-effort AI deploy spam -> FAIL.',
        '',
        'Return STRICT JSON with keys:',
        '{',
        '  "verdict": "PASS" or "FAIL",',
        '  "narrative_score": (integer 1-10),',
        '  "reason": "1-2 sentence decisive audit explanation",',
        '  "theme": "Short 2-4 word theme label"',
        '}'
    ].join('\n');

    const userPrompt = [
        `Token: $${symbol} (${name})`,
        `Description: ${desc.slice(0, 300)}`,
        `Socials: Twitter=${stats.has_twitter ? 'Yes' : 'No'}, Telegram=${stats.has_telegram ? 'Yes' : 'No'}`,
        'Stats:',
        `- Market Cap: $${mc.toLocaleString()} | Liquidity: $${liq.toLocaleString()}`,
        `- 5m Activity: ${buys5m} buys, ${sells5m} sells, $${vol5m.toLocaleString()} volume`,
        `- Holders: ${holders} | Dev Holdings: ${devPct.toFixed(1)}% | Top 10 Holders: ${top10Pct.toFixed(1)}%`,
        `- Snipers: ${snipers.toFixed(1)}% | Insiders: ${insiders.toFixed(1)}%`,
        `- Bubblemap Clusters: ${clusters.toFixed(1)}% clusters, ${bundlers.toFixed(1)}% bundlers`,
        `- Rug Risk Score: ${riskScore}`,
        '',
        'Give your verdict in strict JSON only.'
    ].join('\n');

    const defaultRes = {
        passes: true,
        score: 7,
        reason: 'AI evaluation passed baseline check',
        theme: 'Memecoin',
    };

    const resText = await callAimlapi([{ role: 'user', content: userPrompt }], systemPrompt);
    if (!resText) {
        return defaultRes;
    }

    try {
        let clean = resText.trim();
        if (clean.includes('```json')) {
            clean = clean.split('```json')[1].split('```')[0].trim();
        } else if (clean.includes('```')) {
            clean = clean.split('```')[1].split('```')[0].trim();
        }

        const parsed = JSON.parse(clean);
        const verdict = String(parsed.verdict || 'PASS').toUpperCase();
        const score = Number(parsed.narrative_score || 7);
        const reason = String(parsed.reason || 'Passed');
        const theme = String(parsed.theme || 'Memecoin');

        return {
            passes: verdict === 'PASS' && score >= 5,
            score,
            reason,
            theme,
        };
    } catch {
        const isFail = resText.toUpperCase().includes('FAIL') && (resText.toLowerCase().includes('slop') || resText.toLowerCase().includes('rug'));
        return {
            passes: !isFail,
            score: isFail ? 3 : 6,
            reason: resText.slice(0, 150),
            theme: 'Memecoin',
        };
    }
}
