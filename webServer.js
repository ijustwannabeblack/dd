import express from 'express';
import * as config from './config.js';
import { buildStats, formatMcUsd } from './fetchers/index.js';
import { evaluateCoin } from './filters.js';

const app = express();
app.use(express.json());

const HTML_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Solana Token & InsightX Atlas Screener</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0e14;
            --card-bg: #151a23;
            --border-color: #232a36;
            --accent-green: #10b981;
            --accent-red: #ef4444;
            --accent-purple: #8b5cf6;
            --accent-gold: #f59e0b;
            --text-main: #f8fafc;
            --text-sub: #94a3b8;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Inter', sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            padding: 24px;
            min-height: 100vh;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
        }
        header {
            text-align: center;
            margin-bottom: 30px;
        }
        header h1 {
            font-size: 2.2rem;
            font-weight: 800;
            background: linear-gradient(135deg, #a78bfa 0%, #38bdf8 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
        }
        header p {
            color: var(--text-sub);
            font-size: 0.95rem;
        }
        .search-box {
            display: flex;
            gap: 12px;
            margin-bottom: 30px;
        }
        .search-box input {
            flex: 1;
            padding: 16px 20px;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            background: var(--card-bg);
            color: #fff;
            font-size: 1.05rem;
            outline: none;
            transition: border 0.2s;
        }
        .search-box input:focus {
            border-color: #8b5cf6;
        }
        .search-box button {
            padding: 16px 28px;
            border-radius: 12px;
            border: none;
            background: linear-gradient(135deg, #7c3aed 0%, #2563eb 100%);
            color: #fff;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
        }
        .search-box button:hover {
            opacity: 0.9;
        }
        .loading-spinner {
            display: none;
            text-align: center;
            padding: 40px;
            color: var(--text-sub);
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid var(--border-color);
            border-top: 4px solid #8b5cf6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px auto;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        .results-container {
            display: none;
        }
        .verdict-card {
            padding: 24px;
            border-radius: 16px;
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .verdict-card.safe {
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.4);
        }
        .verdict-card.rug {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.4);
        }
        .verdict-title {
            font-size: 1.5rem;
            font-weight: 800;
        }
        .verdict-card.safe .verdict-title { color: var(--accent-green); }
        .verdict-card.rug .verdict-title { color: var(--accent-red); }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        .stat-card {
            background: var(--card-bg);
            padding: 16px 20px;
            border-radius: 12px;
            border: 1px solid var(--border-color);
        }
        .stat-label {
            font-size: 0.85rem;
            color: var(--text-sub);
            margin-bottom: 6px;
        }
        .stat-value {
            font-size: 1.25rem;
            font-weight: 700;
        }

        .section-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            margin-bottom: 24px;
        }
        @media (max-width: 768px) {
            .section-grid { grid-template-columns: 1fr; }
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 20px;
        }
        .card-header {
            font-size: 1.1rem;
            font-weight: 700;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .metric-row {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
            font-size: 0.95rem;
        }
        .metric-row:last-child { border-bottom: none; }
        .metric-key { color: var(--text-sub); }
        .metric-val { font-weight: 600; }

        .reasons-list {
            list-style: none;
        }
        .reasons-list li {
            padding: 10px 14px;
            border-radius: 8px;
            margin-bottom: 8px;
            font-size: 0.95rem;
            line-height: 1.4;
        }
        .reasons-list li.pass { background: rgba(16, 185, 129, 0.1); color: #34d399; }
        .reasons-list li.fail { background: rgba(239, 68, 68, 0.1); color: #f87171; }

        .bubblemap-container {
            width: 100%;
            height: 480px;
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid var(--border-color);
            background: #000;
        }
        iframe {
            width: 100%;
            height: 100%;
            border: none;
        }
        .bubble-info-banner {
            background: rgba(139, 92, 246, 0.1);
            border: 1px solid rgba(139, 92, 246, 0.3);
            padding: 12px 16px;
            border-radius: 10px;
            margin-bottom: 16px;
            font-size: 0.9rem;
            color: #c4b5fd;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🫧 Solana Token & InsightX Atlas Screener</h1>
            <p>Paste any contract address (CA) to inspect InsightX wallet clusters, rug risk, and live market cap.</p>
        </header>

        <div class="search-box">
            <input type="text" id="caInput" placeholder="Paste Solana Token Address (e.g. JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN)..." onkeypress="handleKeyPress(event)">
            <button onclick="analyzeToken()">Analyze Token</button>
        </div>

        <div class="loading-spinner" id="loader">
            <div class="spinner"></div>
            <p>Fetching on-chain security, DexScreener, and InsightX Atlas clusters...</p>
        </div>

        <div class="results-container" id="results">
            <!-- Verdict -->
            <div class="verdict-card" id="verdictCard">
                <div>
                    <div class="verdict-title" id="verdictTitle">SAFE TO TRADE</div>
                    <div id="verdictSub" style="color: var(--text-sub); margin-top: 4px; font-size: 0.9rem;">No major cluster or rug risk detected</div>
                </div>
                <div style="font-size: 2.5rem;" id="verdictEmoji">✅</div>
            </div>

            <!-- Stats Grid -->
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">Token</div>
                    <div class="stat-value" id="tokenSymbol">JUP</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Real Market Cap</div>
                    <div class="stat-value" id="tokenMc">$0</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Holders Count</div>
                    <div class="stat-value" id="tokenHolders">0</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">LP Burned</div>
                    <div class="stat-value" id="tokenLp">100%</div>
                </div>
            </div>

            <!-- Holder & Clusters breakdown -->
            <div class="section-grid">
                <div class="card">
                    <div class="card-header">👥 Holder Concentration</div>
                    <div class="metric-row">
                        <span class="metric-key">Top 10 Holders:</span>
                        <span class="metric-val" id="top10Pct">0.0%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-key">Single Largest Holder:</span>
                        <span class="metric-val" id="singlePct">0.0%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-key">Dev Wallet Holdings:</span>
                        <span class="metric-val" id="devPct">0.0%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-key">Mint Authority Revoked:</span>
                        <span class="metric-val" id="mintRevoked">Yes</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-key">Freeze / Honeypot Free:</span>
                        <span class="metric-val" id="freezeRevoked">Yes</span>
                    </div>
                </div>

                <div class="card">
                    <div class="card-header">🫧 InsightX Atlas Clusters</div>
                    <div class="metric-row">
                        <span class="metric-key">Wallet Clusters:</span>
                        <span class="metric-val" id="clusterPct">0.0%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-key">Coordinated Bundlers:</span>
                        <span class="metric-val" id="bundlerPct">0.0%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-key">Early Snipers:</span>
                        <span class="metric-val" id="sniperPct">0.0%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-key">Creator Insiders:</span>
                        <span class="metric-val" id="insiderPct">0.0%</span>
                    </div>
                </div>
            </div>

            <!-- Interactive InsightX Atlas Embed -->
            <div class="card" style="margin-bottom: 24px;">
                <div class="card-header">
                    <span>🫧 Interactive InsightX Atlas Graph</span>
                    <a id="atlasDirectLink" href="#" target="_blank" style="margin-left: auto; color: #8b5cf6; text-decoration: none; font-size: 0.9rem;">Open Fullscreen ↗</a>
                </div>
                <div class="bubble-info-banner">
                    Interactive cluster network visualizer powered by InsightX Atlas. Direct embed view.
                </div>
                <div class="bubblemap-container">
                    <iframe id="bubblemapIframe" src="" loading="lazy"></iframe>
                </div>
            </div>

            <!-- Audit Rule Checklist -->
            <div class="card">
                <div class="card-header">📋 Safety Filter Checklist</div>
                <ul class="reasons-list" id="reasonsList"></ul>
            </div>
        </div>
    </div>

    <script>
        function handleKeyPress(e) {
            if (e.key === 'Enter') analyzeToken();
        }

        async function analyzeToken() {
            const ca = document.getElementById('caInput').value.trim();
            if (!ca) return alert('Please enter a valid Solana contract address.');

            document.getElementById('loader').style.display = 'block';
            document.getElementById('results').style.display = 'none';

            try {
                const resp = await fetch('/api/audit?mint=' + encodeURIComponent(ca));
                const data = await resp.json();

                if (!data.success) {
                    alert('Error auditing token: ' + (data.error || 'Unknown error'));
                    document.getElementById('loader').style.display = 'none';
                    return;
                }

                renderResults(data);
            } catch (err) {
                alert('Failed to connect to audit backend: ' + err.message);
            } finally {
                document.getElementById('loader').style.display = 'none';
            }
        }

        function renderResults(res) {
            const stats = res.stats;
            const passes = res.passes;
            const reasons = res.reasons || [];

            // Verdict
            const vCard = document.getElementById('verdictCard');
            const vTitle = document.getElementById('verdictTitle');
            const vSub = document.getElementById('verdictSub');
            const vEmoji = document.getElementById('verdictEmoji');

            if (passes) {
                vCard.className = 'verdict-card safe';
                vTitle.innerText = 'PASSED AUDIT — SAFE TO TRADE';
                vSub.innerText = 'Token passed all anti-rug and cluster safety checks.';
                vEmoji.innerText = '✅';
            } else {
                vCard.className = 'verdict-card rug';
                vTitle.innerText = 'HIGH RUG / CLUSTER RISK';
                vSub.innerText = reasons[reasons.length - 1] || 'Failed safety criteria';
                vEmoji.innerText = '🚨';
            }

            // Stats
            document.getElementById('tokenSymbol').innerText = stats.symbol + ' (' + stats.name + ')';
            document.getElementById('tokenMc').innerText = stats.market_cap_display;
            document.getElementById('tokenHolders').innerText = (stats.holders || 0).toLocaleString();
            document.getElementById('tokenLp').innerText = stats.lp_burned ? '100% Burned' : 'Unburned';

            // Holder concentration
            document.getElementById('top10Pct').innerText = (stats.top10_holders_pct || 0).toFixed(1) + '%';
            document.getElementById('singlePct').innerText = (stats.max_single_holder_pct || 0).toFixed(1) + '%';
            document.getElementById('devPct').innerText = (stats.dev_holdings_pct || 0).toFixed(1) + '%';
            document.getElementById('mintRevoked').innerText = stats.is_mintable ? 'No ❌' : 'Yes ✅';
            document.getElementById('freezeRevoked').innerText = stats.is_honeypot ? 'No ❌' : 'Yes ✅';

            // InsightX
            document.getElementById('clusterPct').innerText = (stats.cluster_pct || 0).toFixed(1) + '%';
            document.getElementById('bundlerPct').innerText = (stats.bundlers_pct || 0).toFixed(1) + '%';
            document.getElementById('sniperPct').innerText = (stats.snipers_pct || 0).toFixed(1) + '%';
            document.getElementById('insiderPct').innerText = (stats.insiders_pct || 0).toFixed(1) + '%';

            // InsightX Atlas embed
            const embedUrl = 'https://embed.insightx.network/atlas/sol/' + stats.mint;
            document.getElementById('bubblemapIframe').src = embedUrl;
            document.getElementById('atlasDirectLink').href = embedUrl;

            // Reasons
            const list = document.getElementById('reasonsList');
            list.innerHTML = '';
            if (passes) {
                const li = document.createElement('li');
                li.className = 'pass';
                li.innerText = '✓ Passed: Low dev allocation (< 30%)';
                list.appendChild(li);
                const li2 = document.createElement('li');
                li2.className = 'pass';
                li2.innerText = '✓ Passed: Low wallet cluster concentration & no critical honeypot flags';
                list.appendChild(li2);
            } else {
                for (const r of reasons) {
                    const li = document.createElement('li');
                    li.className = 'fail';
                    li.innerText = '✕ ' + r;
                    list.appendChild(li);
                }
            }

            document.getElementById('results').style.display = 'block';
        }
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(HTML_INDEX);
});

app.get('/api/audit', async (req, res) => {
    const mint = String(req.query.mint || '').trim();
    if (!mint) {
        return res.status(400).json({ success: false, error: 'Missing mint parameter' });
    }

    try {
        const stats = await buildStats({ mint }, 'Migrated');
        if (!stats) {
            return res.status(404).json({ success: false, error: 'Could not fetch data for token' });
        }

        const [passes, reasons, alertType] = evaluateCoin(stats, 'Migrated');

        return res.json({
            success: true,
            passes,
            reasons,
            alert_type: alertType,
            stats,
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

export function startWebServer(port = 5000) {
    return new Promise((resolve) => {
        const server = app.listen(port, () => {
            console.log(`🚀 [Web App] InsightX Atlas Screener running on http://localhost:${port}`);
            resolve(server);
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`[Web App] Port ${port} is in use, trying ${port + 1}...`);
                startWebServer(port + 1).then(resolve);
            } else {
                console.error(`[Web App] Server error: ${err.message}`);
            }
        });
    });
}

if (process.argv[1]?.endsWith('webServer.js')) {
    const port = Number(process.env.PORT || 5000);
    startWebServer(port);
}
