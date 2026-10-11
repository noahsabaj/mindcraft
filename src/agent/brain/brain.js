import { createSdkMcpServer, query, USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { runEnv } from '../../models/claude_code.js';
import { loadRoster, systemPrompt } from './prompt.js';
import { makeTools } from './tools.js';

// A bot's mind as one long-lived Claude Code session ("native": true in the profile). Chat, team
// messages and game events go in as user messages; the bot acts through tools: Mindcraft's
// commands plus chat, tell, team and building. Its plain text is private and only logged.

const ACTION_WAIT_MS = 30_000; // how long a tool waits on an action before saying "still running"
const BATCH_MS = 250;          // events this close together go in as one message
const RESTART_DELAY_MS = 10_000;
const LOG_CHARS = 300;

export class ClaudeBrain {
    constructor(agent, profile) {
        this.agent = agent;
        this.name = agent.name;
        this.profile = profile;
        const model = typeof profile.model === 'string' ? { model: profile.model.replace(/^claude-code\//, '') } : profile.model;
        this.model = model.model || 'claude-haiku-5-5';
        this.params = model.params || {};
        this.inbox = new Inbox();
        this.pending = [];
        this.batchTimer = null;
        this.query = null;
        this.sessionId = null;
        this.busy = false;          // the session is working on a turn
        this.toolChain = Promise.resolve(); // tools run one at a time
        this.actionSeq = 0;
        this.urgent = deferred();   // settles when a message the bot should look at right away arrives
        this.warnedUsage = false;
        this.restarts = 0;
        this.sessionFile = path.resolve('bots', this.name, 'claude_session.json');
    }

    roster() {
        const roster = loadRoster();
        if (!roster.some(m => m.name === this.name))
            roster.push({ name: this.name, role: this.profile.role ?? null, boss: this.profile.boss ?? null, in_game: true });
        return roster;
    }

    me() {
        return this.roster().find(m => m.name === this.name);
    }

    // --- input ---

    // resume: pick up the last session (memory loading on, or the process restarted)
    start(init_message, resume) {
        this._run(resume || settings.load_memory ? this._savedSession() : null);
        this.post(`[event] You just joined the server.${init_message ? ` ${init_message}` : ''}`);
    }

    // Public chat or a whisper from a human player (or a message typed in the Mindcraft web UI).
    onPlayerMessage(username, message, whisper) {
        if (!message || username === this.name || convoManager.isOtherAgent(username)) return;
        if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
        if (!whisper && !this._isForMe(message)) return;
        this.post(`[${whisper ? 'whisper' : 'chat'}] ${username}: ${message}`, true);
    }

    onTeamMessage(sender, message) {
        if (!message) return;
        // !endConversation and similar leftovers from bots in the classic mode mean nothing here
        message = message.replace(/!endConversation\([^)]*\)/g, '').trim();
        if (!message) return;
        this.post(`[team] ${sender}: ${message}`, sender === this.me()?.boss);
    }

    // Everything Mindcraft itself would have prompted the model with: deaths, restarts, tasks.
    onSystemMessage(source, message) {
        message = message?.replace('(AUTO MESSAGE)', '').replace(/\s*Respond accordingly\.\s*$/, '').trim();
        if (!message) return;
        this.post(`[event] ${message}`, true);
    }

    // Public chat is for the bots it names, and only them ("Claude, can your team..." is for Claude).
    // Naming none, it is for everyone when it calls on everyone, else for the bot players talk to
    // first (the master, or any bot when there is none).
    _isForMe(message) {
        const roster = this.roster();
        const named = roster.filter(m => new RegExp(`\\b${escapeRegExp(m.name)}\\b`, 'i').test(message));
        if (named.length > 0) return named.some(m => m.name === this.name);
        if (/\b(everyone|everybody|all of you|team|y'?all|guys)\b/i.test(message)) return true;
        const master = roster.find(m => m.role === 'master');
        return master ? master.name === this.name : true;
    }

    post(line, urgent = false) {
        this.pending.push(line);
        if (urgent) {
            const u = this.urgent;
            this.urgent = deferred();
            u.resolve();
        }
        if (!this.batchTimer)
            this.batchTimer = setTimeout(() => this._flush(), BATCH_MS);
    }

    _flush() {
        this.batchTimer = null;
        if (this.pending.length === 0) return;
        const behavior = this._behaviorLog();
        const lines = [...this.pending, ...(behavior ? [`[event] Meanwhile, on your own: ${behavior}`] : []), this._status()];
        this.pending = [];
        this.busy = true;
        this.inbox.push({
            type: 'user',
            message: { role: 'user', content: lines.join('\n') },
            parent_tool_use_id: null,
        });
    }

    _status() {
        const bot = this.agent.bot;
        const p = bot.entity?.position;
        const t = bot.time?.timeOfDay ?? 0;
        const when = t < 6000 ? 'morning' : t < 12000 ? 'afternoon' : t < 13000 ? 'sunset' : t < 23000 ? 'night' : 'dawn';
        const doing = this.agent.actions.executing ? this.agent.actions.currentActionLabel : 'nothing';
        return `[status] at ${p ? `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}` : '?'}`
            + ` | health ${Math.round(bot.health ?? 0)}/20 | food ${Math.round(bot.food ?? 0)}/20 | ${when}`
            + ` | holding ${bot.heldItem?.name ?? 'nothing'} | doing ${doing}`;
    }

    _behaviorLog() {
        const log = this.agent.bot.modes?.flushBehaviorLog?.().trim();
        if (!log) return '';
        return log.length > 400 ? '...' + log.slice(-400) : log.replaceAll('\n', ' ');
    }

    // --- actions ---

    // Runs a Mindcraft action for a tool: waits for it up to ACTION_WAIT_MS, or until a message
    // the bot should see arrives; after that it keeps going, and its end comes as an [event].
    // The same call (same `call` key) while it still runs waits on it again instead of starting
    // it over: models repeat a call to keep waiting, and a restart loses the progress.
    act(label, run, call = null) {
        const result = this.toolChain.then(async () => {
            let job = this.job;
            if (!call || !job || job.ended || job.call !== call) {
                job = this.job = { call, seq: ++this.actionSeq, ended: false, told: false, watched: false };
                job.done = run().then(res => ({ res }), err => ({ res: `Error: ${err?.message || err}` }));
                job.done.then(() => { job.ended = true; });
            }
            const urgent = this.urgent.promise;
            let timer;
            const outcome = await Promise.race([
                job.done.then(r => ({ finished: true, ...r })),
                new Promise(r => { timer = setTimeout(() => r({ why: 'time' }), ACTION_WAIT_MS); }),
                urgent.then(() => ({ why: 'message' })),
            ]);
            clearTimeout(timer);
            const behavior = this._behaviorLog();
            const note = behavior ? `\nMeanwhile, on your own: ${behavior}` : '';
            if (outcome.finished) {
                job.told = true;
                return describe(label, outcome.res) + note;
            }
            if (!job.watched) {
                job.watched = true;
                // after the microtasks, so a call that waits on it again tells the result instead
                job.done.then(({ res }) => setImmediate(() => {
                    if (!job.told && this.actionSeq === job.seq) // not replaced by a newer action
                        this.post(`[event] ${label} ended: ${describe(label, res)}`);
                    job.told = true;
                }));
            }
            return (outcome.why === 'message'
                ? `${label} is still running. A new message just came in, read it. The action keeps going unless you start another one or call stop.`
                : `${label} is still running after ${ACTION_WAIT_MS / 1000}s. You will get an [event] when it ends; the same call again waits on it, another action or stop cancels it.`) + note;
        });
        this.toolChain = result.catch(() => {});
        return result;
    }

    // --- the session ---

    _savedSession() {
        try {
            return existsSync(this.sessionFile) ? JSON.parse(readFileSync(this.sessionFile, 'utf8')).session_id : null;
        } catch {
            return null;
        }
    }

    _saveSession(id) {
        this.sessionId = id;
        try {
            mkdirSync(path.dirname(this.sessionFile), { recursive: true });
            writeFileSync(this.sessionFile, JSON.stringify({ session_id: id, model: this.model }, null, 2));
        } catch (err) {
            console.warn(`${this.name}: could not save the session id: ${err.message}`);
        }
    }

    async _run(resume) {
        const me = this.me();
        const label = `${this.model}${this.params.effort ? ` (${this.params.effort})` : ''}`;
        console.log(`${this.name}: starting a Claude Code session on ${label}${resume ? `, resuming ${resume}` : ''}`);
        const server = createSdkMcpServer({ name: 'mc', version: '1.0.0', tools: makeTools(this), alwaysLoad: true });
        try {
            this.query = query({
                prompt: this.inbox,
                options: {
                    model: this.model,
                    ...(this.params.effort ? { effort: this.params.effort } : {}),
                    thinking: { type: 'adaptive', display: 'omitted' },
                    systemPrompt: systemPrompt(me, this.roster(), this.profile.persona),
                    tools: [], // no built-in tools: no files, shell or web
                    mcpServers: { mc: server },
                    strictMcpConfig: true,
                    allowedTools: ['mcp__mc'],
                    permissionMode: 'dontAsk',
                    settingSources: [],
                    cwd: path.dirname(this.sessionFile),
                    env: runEnv(this.params.auth === 'login'),
                    ...(resume ? { resume } : {}),
                },
            });
            for await (const msg of this.query)
                this._handle(msg);
            console.warn(`${this.name}: the Claude Code session ended.`);
        } catch (err) {
            console.error(`${this.name}: the Claude Code session failed:`, err?.message || err);
        }
        this.busy = false;
        if (this.inbox.closed) return;
        // start over (keeping the conversation when there is one), with what was queued meanwhile
        if (++this.restarts > 5) {
            console.error(`${this.name}: the session keeps failing; giving up. Restart the bot to try again.`);
            return;
        }
        this.inbox = this.inbox.reopen();
        setTimeout(() => this._run(this.sessionId), RESTART_DELAY_MS);
    }

    _handle(msg) {
        switch (msg.type) {
            case 'system':
                if (msg.subtype === 'init') {
                    this._saveSession(msg.session_id);
                    console.log(`${this.name}: session ${msg.session_id} on ${msg.model}`);
                }
                break;
            case 'assistant':
                if (msg.parent_tool_use_id) break;
                for (const block of msg.message?.content || []) {
                    if (block.type === 'text' && block.text.trim())
                        console.log(`${this.name} (thinking): ${clip(block.text)}`);
                    else if (block.type === 'tool_use')
                        console.log(`${this.name} > ${block.name.replace('mcp__mc__', '')} ${clip(JSON.stringify(block.input))}`);
                }
                break;
            case 'result': {
                this.busy = (msg.queued_turn_count ?? 0) > 0;
                this.restarts = 0;
                const secs = (msg.duration_ms / 1000).toFixed(1);
                if (msg.subtype === 'success' && !msg.is_error) {
                    console.log(`${this.name}: turn done in ${secs}s`);
                    break;
                }
                const detail = msg.subtype === 'success' ? msg.result : [msg.subtype, ...(msg.errors || [])].join(': ');
                console.error(`${this.name}: turn failed: ${detail}`);
                if (USAGE_LIMIT_ERROR_PREFIXES.some(p => (detail || '').startsWith(p)) && !this.warnedUsage) {
                    this.warnedUsage = true;
                    this.agent.openChat(`I'm out of Claude usage for now, so I'll be quiet for a while.`);
                } else if (/log ?in|\/login|api key|authenticat/i.test(detail || '')) {
                    console.error('Sign Claude Code in: run `claude` in a terminal and use /login.');
                }
                break;
            }
        }
    }

    stop() {
        this.inbox.close();
        try { this.query?.close(); } catch { /* already closed */ }
    }
}

// Messages for the session, as an async iterable that waits for the next one.
class Inbox {
    constructor(items = []) {
        this.items = items;
        this.waiter = null;
        this.closed = false;
    }

    push(item) {
        if (this.closed) return;
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w(item);
        } else {
            this.items.push(item);
        }
    }

    close() {
        this.closed = true;
        if (this.waiter) this.waiter(null);
    }

    // a fresh inbox with whatever this one still holds, for a restarted session
    reopen() {
        this.closed = true;
        return new Inbox(this.items.splice(0));
    }

    async *[Symbol.asyncIterator]() {
        while (!this.closed) {
            const item = this.items.length ? this.items.shift() : await new Promise(r => { this.waiter = r; });
            if (item === null || this.closed) return;
            yield item;
        }
    }
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function describe(label, res) {
    if (res === undefined) return `${label} was interrupted before it finished.`;
    return String(res).trim() || 'Done.';
}

function clip(s) {
    s = s.replaceAll('\n', ' ');
    return s.length > LOG_CHARS ? s.slice(0, LOG_CHARS) + '...' : s;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
