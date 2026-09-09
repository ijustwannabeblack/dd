import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import * as config from './config.js';
import { handleCopilotChat } from './fetchers/copilot.js';

// Ring buffer of last 200 tokens seen by the bot
const recentTokens = [];
const sseClients = new Set();

export function pushToken(token) {
    if (!token || !token.mint) return;
    const existingIdx = recentTokens.findIndex(t => t.mint === token.mint);
    if (existingIdx >= 0) {
        recentTokens[existingIdx] = { ...recentTokens[existingIdx], ...token };
    } else {
        recentTokens.unshift(token);
        if (recentTokens.length > 200) recentTokens.pop();
    }

    const payload = `data: ${JSON.stringify({ type: 'TOKEN', token })}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(payload);
        } catch {
            sseClients.delete(client);
        }
    }
}

globalThis.__pushToken = pushToken;

// Web server hosting the real-time Solana Trading Terminal & health checks
const port = process.env.PORT || 3000;
let dashboardHtml = null;

function getDashboardHtml() {
    if (!dashboardHtml || process.env.NODE_ENV !== 'production') {
        const p = path.resolve(process.cwd(), 'dashboard.html');
        if (fs.existsSync(p)) {
            dashboardHtml = fs.readFileSync(p, 'utf8');
        } else {
            dashboardHtml = '<h1>DD Solana Terminal</h1><p>dashboard.html not found</p>';
        }
    }
    return dashboardHtml;
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // SSE Stream
    if (url.pathname === '/api/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        res.write(`data: ${JSON.stringify({ type: 'SNAPSHOT', tokens: recentTokens })}\n\n`);
        sseClients.add(res);

        const keepAlive = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
            } catch {
                clearInterval(keepAlive);
                sseClients.delete(res);
            }
        }, 15000);

        req.on('close', () => {
            clearInterval(keepAlive);
            sseClients.delete(res);
        });
        return;
    }

    // JSON API Tokens
    if (url.pathname === '/api/tokens') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(recentTokens));
        return;
    }

    // Health check endpoint
    if (url.pathname === '/api/health' || url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', tokens: recentTokens.length, uptime: process.uptime() }));
        return;
    }

    // Copilot Status
    // Copilot Status
    if (url.pathname === '/api/copilot/status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            runtimeConfig: config.RUNTIME_CONFIG,
            hasGithubToken: Boolean(config.GITHUB_TOKEN || process.env.GITHUB_TOKEN),
            hasGeminiKey: Boolean(config.GEMINI_API_KEY || process.env.GEMINI_API_KEY),
            hasAimlKey: Boolean(config.AIMLAPI_KEY || process.env.AIMLAPI_KEY),
        }));
        return;
    }

    // Bot Avatar Endpoint
    if (url.pathname === '/avatar.jpg' || url.pathname === '/avatar.png') {
        const avatarPath = path.resolve(process.cwd(), 'larpifyy_avatar.jpg');
        if (fs.existsSync(avatarPath)) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
            fs.createReadStream(avatarPath).pipe(res);
            return;
        }
    }

    // Copilot Chat & Autonomous Code Exec
    if (url.pathname === '/api/copilot/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 15000000) req.destroy(); // Allow up to 15MB for base64 images
        });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body || '{}');
                const result = await handleCopilotChat({
                    message: data.message || '',
                    history: data.history || [],
                    githubToken: data.githubToken || config.GITHUB_TOKEN || process.env.GITHUB_TOKEN || '',
                    recentTokens,
                    image: data.image || null,
                });

                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ success: true, ...result }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // Restart Bot endpoint
    if (url.pathname === '/api/copilot/restart' && (req.method === 'POST' || req.method === 'GET')) {
        restartBot();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, message: 'Caller bot process restarted successfully' }));
        return;
    }

    // Main Dashboard Web UI
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
});

server.listen(port, () => {
    console.log(`[Dashboard & Health Check] Web server listening on port ${port}`);
});

// Bot Child Process Management with dynamic restart support
let botChild = null;

export function restartBot() {
    console.log('[Bot Controller] Restart requested. Terminating current bot process...');
    if (botChild) {
        try {
            botChild.removeAllListeners('exit');
            botChild.kill('SIGTERM');
        } catch (e) {
            console.warn('[Bot Controller] Kill error:', e.message);
        }
        botChild = null;
    }
    setTimeout(() => {
        spawnBotChild();
    }, 500);
    return true;
}

globalThis.__restartBot = restartBot;

function spawnBotChild() {
    if (process.env.__MEM_CONSTRAINED === '1') return;
    const botPath = path.resolve(process.cwd(), 'bot.js');
    console.log('[Bot Controller] Spawning bot child process...');
    botChild = spawn(process.execPath, ['--max-old-space-size=128', botPath, ...process.argv.slice(2)], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
            ...process.env,
            __MEM_CONSTRAINED: '1'
        }
    });

    botChild.on('message', (msg) => {
        if (msg && msg.type === 'TOKEN_FEED') {
            pushToken(msg.data);
        }
    });

    botChild.on('exit', (code, signal) => {
        console.log(`[Bot Controller] Bot child exited (code: ${code}, signal: ${signal}). Auto-restarting in 2s...`);
        setTimeout(() => {
            spawnBotChild();
        }, 2000);
    });
}

// Initial launch
if (process.env.__MEM_CONSTRAINED !== '1') {
    spawnBotChild();
} else {
    await import('./bot.js');
}

