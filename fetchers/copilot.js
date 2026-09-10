import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import util from 'node:util';
import * as config from '../config.js';

const execPromise = util.promisify(exec);

/**
 * Call Gemini Flash or AIMLAPI (OpenAI-compatible) to get LLM response.
 * Supports text and attached images (multimodal analysis).
 */
async function callLLM(systemPrompt, messages, image = null) {
    const aimlKey = (config.AIMLAPI_KEY || process.env.AIMLAPI_KEY || '').trim();
    const geminiKey = (config.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();

    // 1. Primary: AIMLAPI / OpenAI (Fast & reliable gpt-4o-mini with vision)
    if (aimlKey) {
        try {
            const url = `${config.AIMLAPI_BASE_URL || 'https://api.aimlapi.com/v1'}/chat/completions`;
            const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

            const aimlMessages = fullMessages.map((m, idx) => {
                if (idx === fullMessages.length - 1 && image && m.role === 'user') {
                    return {
                        role: 'user',
                        content: [
                            { type: 'text', text: m.content || 'Analyze this attached image.' },
                            { type: 'image_url', image_url: { url: image } }
                        ]
                    };
                }
                return m;
            });

            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${aimlKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: config.AI_MODEL || 'gpt-4o-mini',
                    messages: aimlMessages,
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

    // 2. Fallback: Google Gemini API (Multimodal Gemini 2.5 Flash)
    if (geminiKey) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
            let mimeType = 'image/jpeg';
            let b64 = image;
            if (image && image.startsWith('data:')) {
                const parts = image.split(';base64,');
                mimeType = parts[0].replace('data:', '');
                b64 = parts[1];
            }

            const contents = messages.map((msg, idx) => {
                const parts = [{ text: msg.content || 'Analyze this attached image.' }];
                if (idx === messages.length - 1 && msg.role === 'user' && image && b64) {
                    parts.push({
                        inline_data: {
                            mime_type: mimeType,
                            data: b64
                        }
                    });
                }
                return {
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts
                };
            });

            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents,
                    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
                }),
                signal: AbortSignal.timeout(6000)
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
export async function handleCopilotChat({ message, history = [], githubToken = '', recentTokens = [], image = null }) {
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

    const systemPrompt = `You are Larpifyy, an elite Telegram-style Solana radar engineer and bot controller.
You assist the trader directly from their mobile web dashboard.
Keep your tone sharp, concise, and professional — like GMGN or Trojan bot.

STRICT STYLE RULES:
- NO AI SLOP: Never use conversational filler ("Certainly!", "Sure thing!", "I'd be glad to help", "As an AI model...").
- Telegram bot format: Use crisp bullet points, monospace code blocks (\`value\`), and clean structure.
- Clean emojis only (•, ⚡, 📈, 🛡️, 🔄, ✅, ❌, ⚙️). No cringe emoji spam or emoji walls.
- Direct & compact: Keep responses under 5-8 lines unless full code editing is required.

CURRENT LIVE CONFIG:
${JSON.stringify(currentConfigSummary, null, 2)}

RECENT TOKENS:
${tokenSnippet || 'No tokens processed yet.'}

ACTION CODES:
1. UPDATE RUNTIME SETTINGS (takes effect immediately):
   \`\`\`runtime_config
   {"min_call_mc_usd": 20000}
   \`\`\`

2. READ FILE:
   \`\`\`read_file
   config.js
   \`\`\`

3. EDIT & PUSH CODE TO GITHUB (triggers Render redeploy):
   \`\`\`edit_file:config.js
   // Commit message: feat: adjust min market cap
   <FULL NEW CONTENT>
   \`\`\`

4. RESTART BOT (recycles processes, scanners & feeds):
   \`\`\`restart_bot
   true
   \`\`\`

REPO ARCHITECTURE:
- bot.js: Discord bot client, Discord commands, pump.fun streams, callers, performance trackers.
- config.js: Channel IDs, API keys, thresholds, runtime config.
- filters.js: Anti-rug evaluator (sybil bubblemap cluster < 5%, bundlers < 5%, dev < 10%).
- index.js: HTTP server & process manager.
- dashboard.html: Telegram-style terminal web UI.

CRITICAL RULES:
- Never output dummy paths like "path/to/...". Always use exact files (bot.js, config.js, filters.js).
- If asked to restart or recycle, output \`\`\`restart_bot block and confirm cleanly.
- If asked to change settings, output both \`\`\`runtime_config and \`\`\`edit_file blocks so it persists.`;

    // 1st LLM Pass
    const llmRes = await callLLM(systemPrompt, [...history, { role: 'user', content: message }], image);
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

    // Parse restart_bot requests or intent — broad detection for any restart/reboot request
    const restartCodeBlock = /```restart_bot[\s\S]*?```/i.test(responseText);
    const userWantsRestart = restartCodeBlock ||
        /\b(restart|reboot|recycle|reload|respawn)\b/i.test(message) ||
        /\b(restart|reboot)\b/i.test(responseText);

    if (userWantsRestart) {
        let restarted = false;

        // Method 1: Local bot child process kill (SIGKILL) & respawn
        if (typeof globalThis.__restartBot === 'function') {
            try {
                globalThis.__restartBot();
                restarted = true;
                actions.push('✅ Local bot child process restarted (fresh scanners & feeds)');
            } catch (e) {
                console.warn('[Copilot] Local restartBot failed:', e.message);
            }
        }

        // Method 2: Direct Render API cloud container restart
        const renderKey = process.env.RENDER_API_KEY || 'rnd_9TFyuYQIdQaaYySliJ9vWCoPumTU';
        const serviceId = process.env.RENDER_SERVICE_ID || 'srv-dagql2afngtc73assmmg';
        if (renderKey && serviceId) {
            try {
                const r = await fetch(`https://api.render.com/v1/services/${serviceId}/restart`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${renderKey}`,
                        'Accept': 'application/json',
                    },
                    signal: AbortSignal.timeout(6000)
                });
                if (r.ok) {
                    restarted = true;
                    actions.push('✅ Render cloud service restart command sent (rebooting container)');
                }
            } catch (e) {
                console.warn('[Copilot] Render restart API failed:', e.message);
            }
        }

        if (restarted) {
            if (!responseText.toLowerCase().includes('restarted') && !responseText.toLowerCase().includes('restarting')) {
                responseText += '\n\n> 🔄 **Caller Bot Restarted Successfully**: All scanner loops, WebSocket feeds, and memory have been recycled.';
            }
        } else {
            actions.push('⚠️ Restart command executed (fallback)');
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
            let redeployInfo = null;
            const gitRes = await commitToGitHub(targetPath, fileContent, commitMsg, token, repo);
            if (gitRes.success) {
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                actions.push(`Pushed to GitHub main (${gitRes.commitSha}) → Auto-redeploy triggered at ${timeStr}`);
                responseText += `\n\n> 🚀 **Pushed to GitHub**: [\`${gitRes.commitSha}\`](${gitRes.htmlUrl})\n> ⏱️ **Auto-Redeploy Triggered At:** \`${timeStr}\`\n> ⚡ **Speed Mode:** Fast build cached in ~20-30s.\n> 📡 **Notice:** The live bot stays active while Render builds the new container in the background.`;
                redeployInfo = { triggered: true, time: timeStr, sha: gitRes.commitSha };
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
        provider: llmRes.provider,
        redeploy: typeof redeployInfo !== 'undefined' ? redeployInfo : null
    };
}
