import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import util from 'node:util';
import * as config from '../config.js';

const execPromise = util.promisify(exec);

/**
 * Call Gemini Flash or AIMLAPI (OpenAI-compatible) to get LLM response.
 */
async function callLLM(systemPrompt, messages) {
    const aimlKey = (config.AIMLAPI_KEY || process.env.AIMLAPI_KEY || '').trim();
    const geminiKey = (config.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();

    // 1. Primary: AIMLAPI / OpenAI (Fast & reliable gpt-4o-mini)
    if (aimlKey) {
        try {
            const url = `${config.AIMLAPI_BASE_URL || 'https://api.aimlapi.com/v1'}/chat/completions`;
            const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${aimlKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: config.AI_MODEL || 'gpt-4o-mini',
                    messages: fullMessages,
                    temperature: 0.3,
                    max_tokens: 2048,
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (resp.ok) {
                const data = await resp.json();
                const text = data?.choices?.[0]?.message?.content;
                if (text) return { text, provider: config.AI_MODEL || 'gpt-4o-mini' };
            } else {
                console.warn(`[Copilot] AIMLAPI error ${resp.status}:`, await resp.text());
            }
        } catch (e) {
            console.warn(`[Copilot] AIMLAPI call failed: ${e.message}`);
        }
    }

    // 2. Fallback: Google Gemini API
    // Fallback: Google Gemini API if AIMLAPI failed or missing
    if (geminiKey) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
            const contents = messages.map(msg => ({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            }));

            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents,
                    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
                }),
                signal: AbortSignal.timeout(5000)
            });

            if (resp.ok) {
                const data = await resp.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) return { text, provider: 'Gemini 2.5 Flash' };
            }
        } catch (e) {
            console.warn(`[Copilot] Gemini call failed: ${e.message}`);
        }
    }

    return null;
}

/**
 * Commit a file directly to GitHub via REST API
 */
async function commitToGitHub(filePath, content, commitMsg, token, repo = config.GITHUB_REPO) {
    if (!token) {
        return { success: false, reason: 'No GitHub token configured' };
    }

    const cleanPath = filePath.replace(/\\/g, '/').replace(/^\//, '');
    const url = `https://api.github.com/repos/${repo}/contents/${cleanPath}`;
    const headers = {
        'Authorization': `Bearer ${token.trim()}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'DD-Autonomous-Copilot',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
        // Step 1: Get current file SHA if file already exists
        let sha = null;
        const getResp = await fetch(`${url}?ref=main`, { headers });
        if (getResp.ok) {
            const fileData = await getResp.json();
            sha = fileData.sha;
        }

        // Step 2: PUT commit to branch main
        const payload = {
            message: commitMsg || `chore(copilot): update ${cleanPath} from remote dashboard`,
            content: Buffer.from(content).toString('base64'),
            branch: 'main',
        };
        if (sha) payload.sha = sha;

        const putResp = await fetch(url, {
            method: 'PUT',
            headers,
            body: JSON.stringify(payload)
        });

        if (putResp.ok) {
            const result = await putResp.json();
            const commitSha = result?.commit?.sha?.slice(0, 7) || 'latest';
            return {
                success: true,
                commitSha,
                htmlUrl: result?.commit?.html_url || `https://github.com/${repo}/commit/${commitSha}`
            };
        } else {
            const errText = await putResp.text();
            return { success: false, reason: `GitHub API error (${putResp.status}): ${errText}` };
        }
    } catch (e) {
        return { success: false, reason: `GitHub commit exception: ${e.message}` };
    }
}

/**
 * Main handler for Copilot Chat
 */
export async function handleCopilotChat({ message, history = [], githubToken = '', recentTokens = [] }) {
    const cwd = process.cwd();
    const token = (githubToken || config.GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim();
    const repo = config.GITHUB_REPO || 'ijustwannabeblack/dd';

    // Build context on current repo state
    const currentConfigSummary = {
        min_call_mc_usd: config.RUNTIME_CONFIG.min_call_mc_usd,
        migrated_min_mc_usd: config.RUNTIME_CONFIG.migrated_min_mc_usd,
        max_mc_usd: config.RUNTIME_CONFIG.max_mc_usd,
        max_dev_holdings_pct: config.RUNTIME_CONFIG.max_dev_holdings_pct,
        max_bundlers_pct: config.RUNTIME_CONFIG.max_bundlers_pct,
        stages: config.STAGES,
        github_repo: repo,
        has_github_token: Boolean(token),
    };

    const tokenSnippet = recentTokens.slice(0, 5).map(t =>
        `• [${t.symbol || 'UNK'}] MC: $${Math.round(t.market_cap_usd || 0)} | Status: ${t.status} | Reason: ${t.reason || 'N/A'}`
    ).join('\n');

    const systemPrompt = `You are the DD Solana Radar Autonomous Engineer & Copilot.
You assist the user with monitoring, tweaking, and coding their Solana caller and sniper bot directly from their remote web dashboard.
The user is often on their phone away from their PC.

CURRENT LIVE BOT CONFIG:
${JSON.stringify(currentConfigSummary, null, 2)}

RECENT TOKENS SEEN:
${tokenSnippet || 'No tokens processed yet.'}

YOUR CAPABILITIES & ACTION CODES:
You can perform autonomous actions by including action code blocks in your response:

1. UPDATE RUNTIME SETTINGS (instantly takes effect in memory without server redeploy):
   Format:
   \`\`\`runtime_config
   {"min_call_mc_usd": 20000, "max_dev_holdings_pct": 25}
   \`\`\`

2. READ A FILE (to inspect code before making changes):
   Format:
   \`\`\`read_file
   config.js
   \`\`\`

3. EDIT & PUSH CODE (writes file to disk, commits & pushes to GitHub branch 'main' to trigger Render auto-deploy):
   Format:
   \`\`\`edit_file:config.js
   // Commit message: feat: adjust min market cap
   <FULL NEW CONTENT OF FILE>
   \`\`\`

4. RESTART CALLER BOT (instantly recycles scanner processes, reconnects WebSockets, and resets memory):
   Format:
   \`\`\`restart_bot
   true
   \`\`\`

PROJECT REPOSITORY ARCHITECTURE:
- bot.js: Contains the Discord bot client, prefix commands (.check, .mc, .uptime, .help, etc.), background scanners, and pump.fun stream handlers.
- config.js: Contains thresholds (MIN_CALL_MC_USD, MAX_DEV_HOLDINGS_PCT), Discord channel IDs, API keys, and runtime parameters.
- filters.js: Contains token safety evaluation logic.
- index.js: HTTP server and health check endpoints.
- dashboard.html: Telegram-style web chat interface.

CRITICAL INSTRUCTIONS:
- NEVER output dummy placeholder filepaths like "filepath/to/..." or "path/to/...". Always use the exact real filename (e.g. \`bot.js\` or \`config.js\`).
- When the user asks to add or change a Discord command (like \`.uptime\`), the file to edit is \`bot.js\`.
- When the user asks to change a configuration value (e.g. "change min mc to 25k"), always do BOTH:
  1) Output the \`runtime_config\` block so the running bot updates instantly.
  2) Output the \`edit_file\` block for \`config.js\` and/or \`filters.js\` so the change is committed & saved to GitHub permanently via the configured GitHub PAT.
- When the user asks to restart the bot or recycle scanners, output the \`restart_bot\` block.
- Keep explanations concise, professional, and formatted in clean markdown.
- Highlight git commit hashes and link to the commit if pushed.
- If the user asks general questions about why coins failed or how the bot works, reference the live parameters and anti-rug rules (sybil bubblemap cluster < 5%, bundlers < 5%, dev < 30%, Raydium LP pool excluded from whale count).`;

    // 1st LLM Pass
    const llmRes = await callLLM(systemPrompt, [...history, { role: 'user', content: message }]);
    if (!llmRes) {
        return {
            reply: '⚠️ Unable to connect to AI engine (no valid `GEMINI_API_KEY` or `AIMLAPI_KEY` available).',
            actions: [],
            diffs: []
        };
    }

    let responseText = llmRes.text;
    const actions = [];
    const diffs = [];

    // Parse read_file requests
    const readFileRegex = /```read_file\s*\n([\s\S]*?)\n```/g;
    let readMatch;
    while ((readMatch = readFileRegex.exec(responseText)) !== null) {
        const reqPath = readMatch[1].trim();
        const safePath = path.resolve(cwd, reqPath);
        if (safePath.startsWith(cwd) && fs.existsSync(safePath)) {
            const content = fs.readFileSync(safePath, 'utf8');
            // If the LLM just wanted to read, we run a 2nd turn feeding the file content to the LLM
            const followUpRes = await callLLM(systemPrompt, [
                ...history,
                { role: 'user', content: message },
                { role: 'assistant', content: responseText },
                { role: 'user', content: `[FILE CONTENT OF ${reqPath}]:\n\`\`\`javascript\n${content.slice(0, 8000)}\n\`\`\`\nNow proceed with the user's request.` }
            ]);
            if (followUpRes) {
                responseText = followUpRes.text;
                actions.push(`Read ${reqPath}`);
            }
        }
    }

    // Parse runtime_config updates
    const runtimeConfigRegex = /```runtime_config\s*\n([\s\S]*?)\n```/g;
    let configMatch;
    while ((configMatch = runtimeConfigRegex.exec(responseText)) !== null) {
        try {
            const updates = JSON.parse(configMatch[1].trim());
            for (const [k, v] of Object.entries(updates)) {
                if (k in config.RUNTIME_CONFIG) {
                    config.RUNTIME_CONFIG[k] = v;
                    actions.push(`Updated live in-memory ${k} = ${v}`);
                }
            }
        } catch (e) {
            console.warn('[Copilot] Runtime config parse error:', e.message);
        }
    }

    // Parse restart_bot requests or intent
    const restartRegex = /```restart_bot\s*\n([\s\S]*?)\n```/i;
    if (restartRegex.test(responseText) || /restart\s+(the\s+)?(caller\s+)?bot/i.test(message)) {
        if (typeof globalThis.__restartBot === 'function') {
            globalThis.__restartBot();
            actions.push('Caller bot process restarted');
            if (!responseText.toLowerCase().includes('restarted')) {
                responseText += '\n\n> 🔄 **Caller Bot Restarted**: Scanner loops, WebSocket feeds, and memory have been refreshed.';
            }
        }
    }

    // Parse edit_file requests
    const editFileRegex = /```edit_file:([^\n]+)\s*\n([\s\S]*?)\n```/g;
    let editMatch;
    while ((editMatch = editFileRegex.exec(responseText)) !== null) {
        const targetPath = editMatch[1].trim();
        let fileContent = editMatch[2];
        let commitMsg = `feat(copilot): update ${targetPath} from remote dashboard`;

        // Check if first line contains commit message
        const lines = fileContent.split('\n');
        if (lines[0].startsWith('// Commit message:')) {
            commitMsg = lines[0].replace('// Commit message:', '').trim();
            fileContent = lines.slice(1).join('\n').trim();
        }

        const absPath = path.resolve(cwd, targetPath);
        if (absPath.startsWith(cwd)) {
            // Safety guard: reject dummy paths like filepath/to/...
            if (targetPath.includes('filepath') || targetPath.includes('path/to')) {
                console.warn(`[Copilot] Rejecting dummy path: ${targetPath}`);
                actions.push(`Skipped invalid dummy path "${targetPath}". Please specify a real file (e.g. bot.js or config.js).`);
                continue;
            }

            // Safety guard: never overwrite file if content contains placeholder text
            if (fileContent.includes('<EXISTING CONTENT') || fileContent.includes('<REST OF') || fileContent.includes('// ... rest') || fileContent.length < 50) {
                console.warn(`[Copilot] Aborting edit for ${targetPath}: detected placeholder text`);
                actions.push(`Skipped edit for ${targetPath} (contained placeholder instead of complete code)`);
                continue;
            }

            // Write to local disk safely
            try {
                fs.mkdirSync(path.dirname(absPath), { recursive: true });
                fs.writeFileSync(absPath, fileContent, 'utf8');
                actions.push(`Modified ${targetPath} locally`);
                diffs.push({ file: targetPath, lines: lines.length });
            } catch (writeErr) {
                console.error(`[Copilot] Disk write error for ${targetPath}:`, writeErr.message);
                actions.push(`Write error on ${targetPath}: ${writeErr.message}`);
                continue;
            }

            // Push to GitHub via REST API
            const gitRes = await commitToGitHub(targetPath, fileContent, commitMsg, token, repo);
            if (gitRes.success) {
                actions.push(`Pushed to GitHub main (${gitRes.commitSha}) → Render auto-deploy triggered`);
                responseText += `\n\n> 🚀 **Pushed to GitHub**: [\`${gitRes.commitSha}\`](${gitRes.htmlUrl}) — Render will auto-redeploy in ~45s.`;
            } else if (!token) {
                actions.push(`Local file saved. (Add GitHub PAT in Copilot Settings to push automatically when PC is off).`);
            } else {
                actions.push(`GitHub Push Note: ${gitRes.reason}`);
            }

            // Also try local git commit & push if git command is available
            try {
                await execPromise(`git add "${targetPath}" && git commit -m "${commitMsg.replace(/"/g, '')}" && git push origin main`);
                actions.push(`Pushed via local Git client`);
            } catch {
                // Ignore local git failure if in headless cloud container
            }
        }
    }

    return {
        reply: responseText,
        actions,
        diffs,
        updatedConfig: config.RUNTIME_CONFIG,
        provider: llmRes.provider
    };
}
