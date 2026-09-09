import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';

// Bind to PORT if provided (required by Render & cloud web services for health checks)
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Solana Sniper Bot is active and running!\n');
});
server.listen(port, () => {
    console.log(`[Health Check] HTTP server listening on port ${port}`);
});

// Enforce strict 128MB heap limit so container never OOM crashes
if (process.env.__MEM_CONSTRAINED !== '1') {
    const botPath = path.resolve(process.cwd(), 'bot.js');
    const child = spawn(process.execPath, ['--max-old-space-size=128', botPath, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: {
            ...process.env,
            __MEM_CONSTRAINED: '1'
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
