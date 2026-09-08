import * as config from '../config.js';

export async function getOnchainMintSecurity(mint) {
    const defaultRet = { freeze_authority: null, mint_authority: null, is_honeypot_risk: false, mintable: false };
    if (!mint) return defaultRet;

    const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed' }],
    };

    try {
        const resp = await fetch(config.SOLANA_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        });

        if (!resp.ok) return defaultRet;
        const data = await resp.json();
        if (!data || typeof data !== 'object') return defaultRet;

        const val = data.result?.value;
        if (!val || typeof val !== 'object') return defaultRet;

        const parsed = val.data?.parsed;
        if (!parsed || typeof parsed !== 'object') return defaultRet;

        const info = parsed.info;
        if (!info || typeof info !== 'object') return defaultRet;

        const freezeAuth = info.freezeAuthority || null;
        const mintAuth = info.mintAuthority || null;

        return {
            freeze_authority: freezeAuth,
            mint_authority: mintAuth,
            is_honeypot_risk: freezeAuth !== null,
            mintable: mintAuth !== null,
        };
    } catch (err) {
        return defaultRet;
    }
}

export async function getOnchainTopHolders(mint) {
    if (!mint) return [];

    try {
        const supplyPayload = { jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] };
        const holdersPayload = { jsonrpc: '2.0', id: 2, method: 'getTokenLargestAccounts', params: [mint] };

        const [r1, r2] = await Promise.all([
            fetch(config.SOLANA_RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(supplyPayload),
                signal: AbortSignal.timeout(4500),
            }),
            fetch(config.SOLANA_RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(holdersPayload),
                signal: AbortSignal.timeout(4500),
            }),
        ]);

        const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
        const supply = Number(d1.result?.value?.uiAmount || 0);
        const accounts = d2.result?.value || [];

        return accounts.map(a => {
            const amt = Number(a.uiAmount || 0);
            const pct = supply > 0 ? (amt / supply) * 100 : 0;
            return {
                address: String(a.address || ''),
                pct: Number(pct.toFixed(2)),
                amount: amt,
            };
        });
    } catch (err) {
        return [];
    }
}
