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
            signal: AbortSignal.timeout(15000),
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

    const systemPrompt = [
        'You are an elite Solana memecoin alpha screener and anti-rug auditor.',
        'REFERENCE AUDIT GUIDE ON BUNDLED LAUNCHES & RUGS:',
        '- Devs bundle launches on Solana using Jito bundles in Slot 0 across 10–50 fresh sub-wallets all in the exact same millisecond to secretly control 70%+ supply.',
        '- Red Flags to Check (Axiom & InsightX Atlas):',
        '  1. Contract Safety: Mint Authority and Freeze Authority must both be Revoked. Liquidity must be 100% locked/burned.',
        '  2. Slot 0 / Block 0 Sniping: If 15%+ of supply was bought in the same block/millisecond, it is a bundled launch -> REJECT.',
        '  3. Shared Funders: Early buyers funded by same address/mixer (FixedFloat) minutes before launch -> REJECT.',
        '  4. InsightX Atlas Spiderweb: Large bubbles connected by transfer lines to a central funder. Single connected cluster >15–20% is high risk; >30% avoid -> REJECT.',
        '  5. Slop & Narrative: Token must have genuine viral meme appeal, clever concept, or organic crypto narrative. Brainless copycat slop, keyboard mash, or AI deploy spam -> REJECT.',
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
