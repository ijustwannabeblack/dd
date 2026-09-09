import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

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

    // Main Dashboard Web UI
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
});

server.listen(port, () => {
    console.log(`[Dashboard & Health Check] Web server listening on port ${port}`);
});

// Enforce strict 128MB heap limit so container never OOM crashes
if (process.env.__MEM_CONSTRAINED !== '1') {
    const botPath = path.resolve(process.cwd(), 'bot.js');
    const child = spawn(process.execPath, ['--max-old-space-size=128', botPath, ...process.argv.slice(2)], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
            ...process.env,
            __MEM_CONSTRAINED: '1'
        }
    });

    child.on('message', (msg) => {
        if (msg && msg.type === 'TOKEN_FEED') {
            pushToken(msg.data);
        }
    });

    child.on('exit', (code, signal) => {
        try {
            if (signal) process.kill(process.pid, signal);
            else process.exit(code || 0);
        } catch {
            process.exit(code || 1);
        }
    });
} else {
    await import('./bot.js');
}
