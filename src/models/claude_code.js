import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { CACHE_BOUNDARY } from '../utils/text.js';

// Claude through headless Claude Code: each request is one short Claude Code run with no tools,
// signed in the way the `claude` CLI on this machine is (run `claude` and /login once). Mindcraft
// sends the whole recent conversation with every request, so no session is kept between runs.
//
// Profile:
//   "model": "claude-code/claude-haiku-5-5"
// or, to tune it:
//   "model": {"api": "claude-code", "model": "claude-opus-5-5",
//             "params": {"effort": "medium", "auth": "login", "timeout_ms": 300000}}
// effort: low | medium | high | xhigh | max (the model's default when left out).
// auth: "login" ignores ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so the run always uses your own
// Claude login; for your own personal use only. Left out, Claude Code picks as it normally does.

// Variables that make Claude Code bill an API key or token instead of the login.
const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
// Set when Mindcraft itself was started from a Claude Code session; the bots' runs are their own.
// CLAUDE_EFFORT would override each bot's own effort.
const PARENT_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_EFFORT'];
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class ClaudeCode {
    static prefix = 'claude-code';

    constructor(model_name, url, params) {
        this.model_name = model_name || 'claude-haiku-5-5';
        this.params = params || {};
        // the prompter keeps a prompt's $CACHE_BOUNDARY for models that cache the part before it
        this.supportsCacheBoundary = true;
        if (url)
            console.warn('claude-code ignores "url".');
    }

    async sendRequest(turns, systemMessage) {
        return this._run(transcript(turns), systemMessage);
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const message = {
            type: 'user',
            parent_tool_use_id: null,
            message: {
                role: 'user',
                content: [
                    { type: 'text', text: transcript(turns) },
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
                ],
            },
        };
        return this._run((async function* () { yield message; })(), systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Claude Code.');
    }

    async _run(prompt, systemMessage) {
        const abortController = new AbortController();
        const timeout_ms = this.params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => abortController.abort(), timeout_ms);
        const label = `${this.model_name}${this.params.effort ? ` (${this.params.effort})` : ''}`;
        console.log(`Awaiting Claude Code response from ${label}...`);
        let res = null;
        try {
            const q = query({
                prompt,
                options: {
                    model: this.model_name,
                    ...(this.params.effort ? { effort: this.params.effort } : {}),
                    thinking: { type: 'adaptive', display: 'omitted' },
                    systemPrompt: systemBlocks(systemMessage),
                    // a player, not a coding agent: no tools, MCP servers, settings, hooks or CLAUDE.md
                    tools: [],
                    mcpServers: {},
                    strictMcpConfig: true,
                    settingSources: [],
                    persistSession: false,
                    maxTurns: 1,
                    env: runEnv(this.params.auth === 'login'),
                    abortController,
                },
            });
            for await (const msg of q) {
                if (msg.type !== 'result') continue;
                if (msg.subtype === 'success' && !msg.is_error) {
                    res = msg.result;
                    console.log(`Received (${(msg.duration_ms / 1000).toFixed(1)}s).`);
                } else {
                    const detail = msg.subtype === 'success' ? msg.result : [msg.subtype, ...(msg.errors || [])].join(': ');
                    console.error(`Claude Code request failed: ${detail}`);
                    if (/log ?in|\/login|api key|authenticat/i.test(detail || ''))
                        console.error('Sign Claude Code in: run `claude` in a terminal and use /login.');
                }
            }
        } catch (err) {
            if (abortController.signal.aborted)
                console.error(`Claude Code request timed out after ${timeout_ms / 1000}s.`);
            else
                console.error('Claude Code request failed:', err);
        } finally {
            clearTimeout(timer);
        }
        return res ?? 'My brain disconnected, try again.';
    }
}

// Claude Code takes one prompt, not a message list: the conversation goes in as a transcript.
function transcript(turns) {
    const lines = [];
    for (const turn of turns) {
        const content = typeof turn.content === 'string' ? turn.content.trim() : JSON.stringify(turn.content);
        if (!content) continue;
        if (turn.role === 'assistant')
            lines.push(`[you] ${content}`);
        else if (turn.role === 'system')
            lines.push(`[system] ${content}`);
        else
            lines.push(`[chat] ${content}`); // already "name: message"
    }
    if (lines.length === 0)
        return 'Respond now.';
    return 'The conversation so far, oldest first ([you] is you, [system] is the game and your commands\' output):\n\n'
        + lines.join('\n\n')
        + '\n\nReply with your next message only.';
}

// Everything before the prompter's cache boundary is the same on every request, and cached.
function systemBlocks(systemMessage) {
    const i = systemMessage.indexOf(CACHE_BOUNDARY);
    if (i < 0)
        return systemMessage;
    const head = systemMessage.slice(0, i).trim();
    const tail = systemMessage.slice(i + CACHE_BOUNDARY.length).trim();
    return [head, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...(tail ? [tail] : [])];
}

export function runEnv(useLogin) {
    const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'mindcraft' };
    const drop = useLogin ? [...PARENT_SESSION_VARS, ...API_KEY_VARS] : PARENT_SESSION_VARS;
    for (const k of Object.keys(env))
        if (drop.includes(k.toUpperCase())) delete env[k];
    return env;
}
