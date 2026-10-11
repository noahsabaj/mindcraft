// Sends commands to the running local server from any terminal, through its RCON console (on this PC only):
//   npm run server:cmd -- time set day
//   npm run server:cmd                    then type commands, one per line
import net from 'net';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import readline from 'readline';
import { RUN_DIR } from './setup.mjs';

const fp = path.join(RUN_DIR, 'server.properties');
const props = Object.fromEntries((existsSync(fp) ? readFileSync(fp, 'utf8') : '').split(/\r?\n/)
    .filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
if (props['enable-rcon'] !== 'true' || !props['rcon.password']) {
    console.error('The server has no console for scripts yet; it gets one the next time it starts (npm run server).');
    process.exit(1);
}

// RCON packets: little-endian length, id, type, then the text and two zero bytes.
// Types: 3 logs in, 2 runs a command; replies carry the request's id (-1 for a wrong password).
const socket = net.connect(Number(props['rcon.port'] || 25575), props['server-ip'] || '127.0.0.1');
const handlers = new Map(); // id -> reply text => void
let nextId = 1;
let received = Buffer.alloc(0);

function send(type, text) {
    const id = nextId++;
    const body = Buffer.from(text, 'utf8');
    const packet = Buffer.alloc(14 + body.length);
    packet.writeInt32LE(10 + body.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    body.copy(packet, 12);
    socket.write(packet);
    return id;
}

socket.on('data', chunk => {
    received = Buffer.concat([received, chunk]);
    while (received.length >= 4 && received.length >= 4 + received.readInt32LE(0)) {
        const length = received.readInt32LE(0);
        const id = received.readInt32LE(4);
        const text = received.toString('utf8', 12, 2 + length);
        received = received.subarray(4 + length);
        handlers.get(id)?.(text);
    }
});

function logIn() {
    return new Promise((resolve, reject) => {
        handlers.set(send(3, props['rcon.password']), resolve);
        handlers.set(-1, () => reject(new Error('The server turned down the console password in server.properties.')));
    });
}

// A long reply comes in several packets. The server answers in order, so the reply to a second,
// unknown request marks the end of it.
function run(command) {
    return new Promise(resolve => {
        let reply = '';
        handlers.set(send(2, command), text => { reply += text; });
        handlers.set(send(0, ''), () => resolve(reply.replace(/§./g, '').trim()));
    });
}

socket.once('connect', async () => {
    try {
        await logIn();
        const command = process.argv.slice(2).join(' ').trim();
        if (command) {
            const reply = await run(command);
            if (reply) console.log(reply);
        } else {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
            let open = true;
            rl.on('close', () => { open = false; });
            const prompt = () => { if (open && process.stdin.isTTY) rl.prompt(); };
            prompt();
            for await (const line of rl) {
                const reply = line.trim() ? await run(line.trim()) : '';
                if (reply) console.log(reply);
                prompt();
            }
        }
        socket.end();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
socket.on('error', err => {
    console.error(err.code === 'ECONNREFUSED' ? "Can't reach the server's console. Is the server running (npm run server)?" : err.message);
    process.exit(1);
});
