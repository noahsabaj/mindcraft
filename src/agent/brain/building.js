import Vec3 from 'vec3';
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';

export const MAX_BLOCKS = 4000;
const MAX_SURVEY = 32;
const PASSES = 3; // a block with nothing to build off yet may fit once its neighbours are placed

function box(from, to) {
    const [x1, y1, z1] = from.map(Math.floor), [x2, y2, z2] = (to ?? from).map(Math.floor);
    return {
        min: new Vec3(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)),
        max: new Vec3(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)),
    };
}

function volume({ min, max }) {
    return (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
}

function isKnownBlock(name) {
    return name === 'air' || mc.getBlockId(name) != null || mc.getItemId(name) != null;
}

// Runs one skill call, keeping only what it logged when it failed: a big build would otherwise
// fill the action's output with a line per block.
async function quietly(bot, fn) {
    const mark = bot.output.length;
    let ok = false;
    try {
        ok = await fn();
    } catch (err) {
        skills.log(bot, String(err?.message || err));
    }
    const said = bot.output.slice(mark).trim();
    bot.output = bot.output.slice(0, mark);
    return { ok, said };
}

// parts: [{block, from: [x, y, z], to?: [x, y, z], hollow?: boolean}]
export async function build(bot, parts) {
    const targets = new Map(); // "x,y,z" -> block; later parts override earlier ones
    for (const part of parts) {
        if (!isKnownBlock(part.block)) {
            skills.log(bot, `Unknown block "${part.block}". Nothing was built.`);
            return;
        }
        const b = box(part.from, part.to);
        if (volume(b) > MAX_BLOCKS) {
            skills.log(bot, `A part from ${b.min} to ${b.max} is over ${MAX_BLOCKS} blocks. Nothing was built.`);
            return;
        }
        for (let x = b.min.x; x <= b.max.x; x++)
            for (let y = b.min.y; y <= b.max.y; y++)
                for (let z = b.min.z; z <= b.max.z; z++) {
                    if (part.hollow && x > b.min.x && x < b.max.x && y > b.min.y && y < b.max.y && z > b.min.z && z < b.max.z)
                        continue;
                    targets.set(`${x},${y},${z}`, part.block);
                }
        if (targets.size > MAX_BLOCKS) {
            skills.log(bot, `That is over ${MAX_BLOCKS} blocks. Split it into smaller builds. Nothing was built.`);
            return;
        }
    }

    let todo = [];
    let already = 0;
    for (const [key, block] of targets) {
        const [x, y, z] = key.split(',').map(Number);
        const here = bot.blockAt(new Vec3(x, y, z));
        if (here && (here.name === block || (block === 'air' && ['air', 'cave_air', 'void_air'].includes(here.name)))) already++;
        else todo.push({ x, y, z, block });
    }

    const creative = bot.game.gameMode === 'creative' || bot.modes.isOn('cheat');
    if (!creative) {
        const need = {};
        for (const t of todo) if (t.block !== 'air') need[t.block] = (need[t.block] || 0) + 1;
        const have = world.getInventoryCounts(bot);
        const short = Object.entries(need).filter(([b, n]) => (have[b] || 0) < n).map(([b, n]) => `${n - (have[b] || 0)} ${b}`);
        if (short.length) {
            skills.log(bot, `Not enough blocks: missing ${short.join(', ')} (${todo.length} blocks to place, ${already} already there). Nothing was built.`);
            return;
        }
    }

    let placed = 0, cleared = 0;
    let failures = [];
    for (let pass = 0; pass < PASSES && todo.length; pass++) {
        const me = bot.entity.position;
        todo.sort((a, b) => a.y - b.y || me.distanceTo(new Vec3(a.x, a.y, a.z)) - me.distanceTo(new Vec3(b.x, b.y, b.z)));
        failures = [];
        for (const t of todo) {
            if (bot.interrupt_code) {
                skills.log(bot, `Build interrupted: placed ${placed}, cleared ${cleared}, ${todo.length - placed - cleared} left.`);
                return;
            }
            if (!bot.blockAt(new Vec3(t.x, t.y, t.z)))
                await quietly(bot, () => skills.goToPosition(bot, t.x, t.y, t.z, 3)); // not loaded yet
            const { ok, said } = await quietly(bot, () => t.block === 'air'
                ? skills.breakBlockAt(bot, t.x, t.y, t.z)
                : skills.placeBlock(bot, t.block, t.x, t.y, t.z));
            if (ok) t.block === 'air' ? cleared++ : placed++;
            else failures.push({ ...t, said });
        }
        todo = failures;
    }
    let msg = `Build done: placed ${placed}${cleared ? `, cleared ${cleared}` : ''}${already ? `, ${already} already there` : ''}.`;
    if (failures.length) {
        const reasons = [...new Set(failures.map(f => f.said.split('\n').pop()))].slice(0, 5);
        msg += ` ${failures.length} failed, e.g. ${reasons.join(' | ')}`;
    }
    skills.log(bot, msg);
}

export async function clearArea(bot, from, to) {
    const b = box(from, to);
    if (volume(b) > MAX_BLOCKS) {
        skills.log(bot, `That box is over ${MAX_BLOCKS} blocks. Clear it in parts.`);
        return;
    }
    const todo = [];
    for (let y = b.max.y; y >= b.min.y; y--)
        for (let x = b.min.x; x <= b.max.x; x++)
            for (let z = b.min.z; z <= b.max.z; z++) {
                const here = bot.blockAt(new Vec3(x, y, z));
                if (!here || !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(here.name)) todo.push({ x, y, z });
            }
    let broken = 0;
    const failures = [];
    for (const t of todo) {
        if (bot.interrupt_code) {
            skills.log(bot, `Clearing interrupted: broke ${broken}, ${todo.length - broken - failures.length} left.`);
            return;
        }
        if (!bot.blockAt(new Vec3(t.x, t.y, t.z)))
            await quietly(bot, () => skills.goToPosition(bot, t.x, t.y, t.z, 3));
        const { ok, said } = await quietly(bot, () => skills.breakBlockAt(bot, t.x, t.y, t.z));
        if (ok) broken++;
        else failures.push(said);
    }
    let msg = `Cleared: broke ${broken} blocks.`;
    if (failures.length) msg += ` ${failures.length} failed, e.g. ${[...new Set(failures.map(f => f.split('\n').pop()))].slice(0, 5).join(' | ')}`;
    skills.log(bot, msg);
}

const NOT_GROUND = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
    'dandelion', 'poppy', 'torch', 'wall_torch']);

// Height map of the highest block in each column (plants and snow layers skipped), with a map of
// what that block is.
export function surface(bot, x1, z1, x2, z2) {
    const minX = Math.floor(Math.min(x1, x2)), maxX = Math.floor(Math.max(x1, x2));
    const minZ = Math.floor(Math.min(z1, z2)), maxZ = Math.floor(Math.max(z1, z2));
    if (maxX - minX + 1 > MAX_SURVEY || maxZ - minZ + 1 > MAX_SURVEY)
        return `At most ${MAX_SURVEY}x${MAX_SURVEY} columns at a time.`;
    const top = Math.min(319, Math.floor(bot.entity.position.y) + 48);
    const bottom = Math.max(-64, Math.floor(bot.entity.position.y) - 48);
    const codes = new Map();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const heights = [], kinds = [];
    for (let z = minZ; z <= maxZ; z++) {
        const hRow = [], kRow = [];
        for (let x = minX; x <= maxX; x++) {
            let found = null;
            for (let y = top; y >= bottom; y--) {
                const block = bot.blockAt(new Vec3(x, y, z));
                if (!block) break; // not loaded
                if (!NOT_GROUND.has(block.name)) { found = { y, name: block.name }; break; }
            }
            if (!found) { hRow.push('?'); kRow.push('?'); continue; }
            if (!codes.has(found.name)) codes.set(found.name, letters[codes.size] ?? '*');
            hRow.push(String(found.y));
            kRow.push(codes.get(found.name));
        }
        heights.push(`${String(z).padStart(6)} | ${hRow.map(h => h.padStart(4)).join('')}`);
        kinds.push(`${String(z).padStart(6)} | ${kRow.join('')}`);
    }
    const xs = [];
    for (let x = minX; x <= maxX; x++) xs.push(String(x).padStart(4));
    const legend = [...codes].map(([name, c]) => `${c}=${name}`).join(', ');
    return `Ground from x ${minX} to ${maxX} (columns, west to east) and z ${minZ} to ${maxZ} (rows, north to south). ? = not loaded or not found.\n`
        + `Height of the top block:\n     z | ${xs.join('')}\n${heights.join('\n')}\n`
        + `Top block (${legend}):\n${kinds.join('\n')}`;
}
