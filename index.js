import { spawn } from 'node:child_process';
import path from 'node:path';

// Enforce strict 128MB heap limit so bot-hosting.net container (256MB limit) never OOM crashes
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
        if (signal) process.kill(process.pid, signal);
        else process.exit(code || 0);
    });
} else {
    await import('./bot.js');
}
