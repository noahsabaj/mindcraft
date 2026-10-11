import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { actionsList } from '../commands/actions.js';
import { queryList } from '../commands/queries.js';
import { commandExists, executeCommand } from '../commands/index.js';
import { getTeamState, sendBotChatToServer } from '../mindserver_proxy.js';
import convoManager from '../conversation.js';
import settings from '../settings.js';
import * as building from './building.js';
import * as skills from '../library/skills.js';
import { crewOf } from './prompt.js';

// Mindcraft commands that make no sense for a Claude Code session: chat history and self-prompting
// are the session's own job, bot conversations are replaced by tell, and restart would kill it.
const LEFT_OUT = ['!stfu', '!restart', '!clearChat', '!goal', '!endGoal', '!startConversation', '!endConversation', '!help'];

const point = z.array(z.number().int()).length(3).describe('[x, y, z]');

function zodFor(param) {
    switch (param.type) {
        case 'int': return z.number().int().describe(param.description);
        case 'float': return z.number().describe(param.description);
        case 'boolean': return z.boolean().describe(param.description);
        case 'BlockName': return z.string().describe(`${param.description} (a block id, e.g. oak_log)`);
        case 'ItemName': return z.string().describe(`${param.description} (an item id, e.g. oak_planks)`);
        case 'BlockOrItemName': return z.string().describe(`${param.description} (a block or item id)`);
        default: return z.string().describe(param.description);
    }
}

// A command call in Mindcraft's own syntax, so it gets the same checks as ever.
function commandLine(command, args) {
    const values = Object.keys(command.params || {}).map(name => {
        const v = args[name];
        return typeof v === 'string' ? `"${v.replaceAll('"', '')}"` : String(v);
    });
    return values.length ? `${command.name}(${values.join(', ')})` : command.name;
}

function text(t) {
    return { content: [{ type: 'text', text: t || 'Done.' }] };
}

export function makeTools(brain) {
    const agent = brain.agent;
    const tools = [];

    for (const command of [...queryList, ...actionsList]) {
        if (LEFT_OUT.includes(command.name) || !commandExists(command.name)) continue; // blocked in settings
        if (command.name === '!newAction' && !settings.allow_insecure_coding) continue;
        const name = command.name.slice(1);
        const shape = Object.fromEntries(Object.entries(command.params || {}).map(([k, p]) => [k, zodFor(p)]));
        const isAction = actionsList.includes(command);
        tools.push(tool(name, command.description, shape, async (args) => {
            const line = commandLine(command, args);
            if (!isAction) return text(await executeCommand(agent, line));
            return text(await brain.act(name, () => executeCommand(agent, line), line));
        }));
    }

    tools.push(tool('chat', 'Say something in public chat, to everyone. Keep it short, like a player would.', {
        message: z.string(),
    }, async ({ message }) => {
        await agent.openChat(message);
        return text('Said.');
    }));

    tools.push(tool('tell', 'Send a private message to one teammate (another Claude player) or one human player.', {
        to: z.string().describe('their exact name'),
        message: z.string(),
    }, async ({ to, message }) => {
        if (to === agent.name) return text('That is you.');
        if (convoManager.isOtherAgent(to)) {
            sendBotChatToServer(to, { message, start: true, end: false });
            if (settings.chat_bot_messages) agent.bot.chat(`(to ${to}) ${message.replaceAll('\n', ' ')}`);
            return text(`Sent to ${to}.`);
        }
        if (agent.bot.players[to]) {
            agent.bot.whisper(to, message.replaceAll('\n', ' '));
            return text(`Whispered to ${to}.`);
        }
        return text(`Nobody called ${to} is online. Teammates: ${brain.roster().map(m => m.name).join(', ')}.`);
    }));

    tools.push(tool('team', 'See your teammates: role, who they report to, where they are, health, what they are doing and carrying.', {},
        async () => text(await teamReport(brain))));

    tools.push(tool('build', 'Build a structure from cuboids, bottom to top. Each part fills the box from..to (inclusive, absolute '
        + 'coordinates) with one block; hollow: true places only its outer shell. Later parts override earlier ones at the same '
        + 'spot, and block "air" clears a spot (doorways, windows). You must carry the blocks: it checks first and says what is '
        + `missing. Up to ${building.MAX_BLOCKS} blocks per call.`, {
        parts: z.array(z.object({
            block: z.string().describe('block id, or "air" to clear'),
            from: point,
            to: point.optional().describe('[x, y, z]; leave out for a single block'),
            hollow: z.boolean().optional(),
        })).min(1),
    }, async ({ parts }) => text(await brain.act('build', () => skillAction(agent, 'build', bot => building.build(bot, parts))))));

    tools.push(tool('clearArea', `Break every block in a box (inclusive, absolute coordinates, up to ${building.MAX_BLOCKS} blocks), top down. `
        + 'For clearing or levelling a site. Needs the right tools for what is there.', {
        from: point,
        to: point,
    }, async ({ from, to }) => text(await brain.act('clearArea', () => skillAction(agent, 'clearArea', bot => building.clearArea(bot, from, to))))));

    tools.push(tool('placeBlockAt', 'Place one block at absolute coordinates (it walks there if needed).', {
        block: z.string().describe('block id'),
        x: z.number().int(), y: z.number().int(), z: z.number().int(),
    }, async ({ block, x, y, z: zz }) => text(await brain.act('placeBlockAt', () => skillAction(agent, 'placeBlockAt', bot => skills.placeBlock(bot, block, x, y, zz))))));

    tools.push(tool('breakBlockAt', 'Break one block at absolute coordinates (it walks there if needed).', {
        x: z.number().int(), y: z.number().int(), z: z.number().int(),
    }, async ({ x, y, z: zz }) => text(await brain.act('breakBlockAt', () => skillAction(agent, 'breakBlockAt', bot => skills.breakBlockAt(bot, x, y, zz))))));

    tools.push(tool('surface', 'Map of the ground in an area (up to 32 by 32 columns): the height and type of the top block of each column. '
        + 'Use it to pick and level a building site.', {
        x1: z.number().int(), z1: z.number().int(), x2: z.number().int(), z2: z.number().int(),
    }, async ({ x1, z1, x2, z2 }) => text(building.surface(agent.bot, x1, z1, x2, z2))));

    return tools;
}

// Runs a skill as a Mindcraft action (interruptible, shown as the current action) and returns
// what it logged.
async function skillAction(agent, label, fn) {
    const res = await agent.actions.runAction(`action:${label}`, async () => { await fn(agent.bot); });
    if (res.interrupted && !res.timedout) return undefined;
    return res.message;
}

async function teamReport(brain) {
    const roster = brain.roster();
    if (roster.length <= 1) return 'No teammates.';
    const states = await getTeamState();
    const me = brain.agent.name;
    return roster.filter(m => m.name !== me).map(m => {
        const role = [m.role, m.boss && `reports to ${m.boss}`, crewOf(roster, m.name).length && `leads ${crewOf(roster, m.name).join(', ')}`]
            .filter(Boolean).join(', ');
        const s = states[m.name];
        if (!m.in_game || !s) return `${m.name}${role ? ` (${role})` : ''}: offline`;
        const g = s.gameplay;
        const items = Object.entries(s.inventory?.counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v} ${k}`).join(', ');
        return `${m.name}${role ? ` (${role})` : ''}: at ${Math.round(g.position.x)}, ${Math.round(g.position.y)}, ${Math.round(g.position.z)}, `
            + `health ${g.health}, food ${g.hunger}, ${s.action.current}${items ? `; carrying ${items}` : '; empty-handed'}`;
    }).join('\n');
}
