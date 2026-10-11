// Sets up a local Minecraft server for you and the bots, in server/run:
//   Paper       the server; the bots join it directly
//   Geyser      lets Bedrock clients join (at 127.0.0.1, port 19132)
//   ViaVersion  lets clients newer than the server join, Geyser included
//   Java        a Temurin JDK for Paper, when this machine has none that is new enough
// The server only listens on this PC and runs in offline mode, which the bots need.
//
//   npm run server:setup -- --accept-eula    (read https://aka.ms/MinecraftEULA first)
//   npm run server

import { createHash } from 'crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

// The newest Minecraft version the bots support (mineflayer / minecraft-data).
export const MC_VERSION = '26.1.2';
const JAVA_MAJOR = 25; // what Paper needs for 26.1

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUN_DIR = path.join(here, 'run');
const JDK_DIR = path.join(RUN_DIR, 'jdk');
const PLUGINS_DIR = path.join(RUN_DIR, 'plugins');
const UA = { 'User-Agent': 'mindcraft-server-setup (https://github.com/noahsabaj/mindcraft)' };

// Our settings for server.properties; anything else keeps Paper's default.
const SERVER_PROPERTIES = {
    'server-ip': '127.0.0.1',        // this PC only
    'server-port': '25565',
    'online-mode': 'false',          // the bots have no Microsoft accounts
    'enforce-secure-profile': 'false',
    'spawn-protection': '0',         // otherwise only ops can build near spawn
    'allow-flight': 'true',          // bots' jumps and climbs would get them kicked for flying
    'motd': 'Mindcraft',
};

export function javaPath() {
    const bundled = findJavaIn(JDK_DIR);
    if (bundled) return bundled;
    for (const candidate of [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'java'), 'java']) {
        if (candidate && javaMajor(candidate) >= JAVA_MAJOR) return candidate;
    }
    return null;
}

function findJavaIn(dir) {
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    for (const bin of [path.join(dir, 'bin'), path.join(dir, 'Contents', 'Home', 'bin')]) {
        if (existsSync(path.join(bin, exe))) return path.join(bin, exe);
    }
    return null;
}

function javaMajor(java) {
    const r = spawnSync(java, ['-version'], { encoding: 'utf8' });
    const m = `${r.stderr}${r.stdout}`.match(/version "(\d+)/);
    return m ? Number(m[1]) : 0;
}

async function getJson(url) {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
}

// Downloads to dest, unless dest already has the expected sha256.
async function download(url, dest, sha256, label) {
    if (existsSync(dest) && await sha256Of(dest) === sha256) {
        console.log(`  ${label}: already downloaded`);
        return;
    }
    console.log(`  ${label}: downloading ${url}`);
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const tmp = dest + '.part';
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const got = await sha256Of(tmp);
    if (got !== sha256) {
        rmSync(tmp, { force: true });
        throw new Error(`${label}: checksum mismatch (expected ${sha256}, got ${got})`);
    }
    renameSync(tmp, dest);
}

async function sha256Of(file) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
}

async function setUpJava() {
    const existing = javaPath();
    if (existing) {
        console.log(`  Java ${JAVA_MAJOR}+: ${existing}`);
        return existing;
    }
    const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
    const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
    if (!os || !arch) throw new Error(`No Temurin JDK for ${process.platform}/${process.arch}; install Java ${JAVA_MAJOR} yourself.`);
    const [asset] = await getJson(`https://api.adoptium.net/v3/assets/latest/${JAVA_MAJOR}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`);
    const pkg = asset.binary.package;
    const archive = path.join(RUN_DIR, pkg.name);
    await download(pkg.link, archive, pkg.checksum, `Temurin ${asset.release_name}`);
    const unpack = path.join(RUN_DIR, 'jdk-unpack');
    rmSync(unpack, { recursive: true, force: true });
    mkdirSync(unpack);
    // Windows' own tar (bsdtar) unpacks zip files; Git Bash's GNU tar would not
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tar, ['-xf', archive, '-C', unpack], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`Could not unpack ${archive}`);
    const [top] = readdirSync(unpack);
    rmSync(JDK_DIR, { recursive: true, force: true });
    renameSync(path.join(unpack, top), JDK_DIR);
    rmSync(unpack, { recursive: true, force: true });
    rmSync(archive, { force: true });
    const java = findJavaIn(JDK_DIR);
    if (!java) throw new Error(`No java executable in ${JDK_DIR}`);
    console.log(`  Java: ${java}`);
    return java;
}

async function setUpPaper() {
    const build = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${MC_VERSION}/builds/latest`);
    const file = build.downloads['server:default'];
    await download(file.url, path.join(RUN_DIR, 'paper.jar'), file.checksums.sha256, `Paper ${MC_VERSION} build ${build.id}`);
}

async function setUpGeyser() {
    const build = await getJson('https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest');
    const url = `https://download.geysermc.org/v2/projects/geyser/versions/${build.version}/builds/${build.build}/downloads/spigot`;
    await download(url, path.join(PLUGINS_DIR, 'Geyser-Spigot.jar'), build.downloads.spigot.sha256, `Geyser ${build.version} build ${build.build}`);
}

async function setUpViaVersion() {
    const { result: [version] } = await getJson('https://hangar.papermc.io/api/v1/projects/ViaVersion/versions?limit=1&offset=0&channel=Release&platform=PAPER');
    const file = version.downloads.PAPER;
    await download(file.downloadUrl, path.join(PLUGINS_DIR, 'ViaVersion.jar'), file.fileInfo.sha256Hash, `ViaVersion ${version.name}`);
}

function writeServerProperties() {
    const fp = path.join(RUN_DIR, 'server.properties');
    const lines = existsSync(fp) ? readFileSync(fp, 'utf8').split(/\r?\n/) : [];
    const todo = new Map(Object.entries(SERVER_PROPERTIES));
    const out = lines.map(line => {
        const key = line.split('=')[0];
        if (!todo.has(key)) return line;
        const value = todo.get(key);
        todo.delete(key);
        return `${key}=${value}`;
    }).filter((line, i, all) => line || i < all.length - 1);
    for (const [key, value] of todo) out.push(`${key}=${value}`);
    writeFileSync(fp, out.join('\n') + '\n');
}

// Geyser writes its config on its first start; ours: Bedrock on this PC only, and no Java account
// needed to join (the server is in offline mode).
export function configureGeyser() {
    const fp = path.join(PLUGINS_DIR, 'Geyser-Spigot', 'config.yml');
    if (!existsSync(fp)) return false;
    let text = readFileSync(fp, 'utf8');
    const before = text;
    text = setYamlKey(text, 'bedrock', 'address', '127.0.0.1');
    text = setYamlKey(text, ['remote', 'java'], 'auth-type', 'offline');
    if (text !== before) writeFileSync(fp, text);
    return true;
}

// Sets `key: value` inside the first top-level section of `sections` that has the key.
function setYamlKey(text, sections, key, value) {
    for (const section of [].concat(sections)) {
        const re = new RegExp(`(^${section}:\\s*\\r?\\n(?:(?:[ \\t]+.*|[ \\t]*#.*|[ \\t]*)\\r?\\n)*?[ \\t]+${key}:[ \\t]*)([^\\r\\n#]*)`, 'm');
        if (re.test(text)) return text.replace(re, (_, head) => `${head}${value}`);
    }
    console.warn(`  Geyser config: no ${key} under ${[].concat(sections).join('/')}; leaving it as is`);
    return text;
}

// The first start writes the world and the plugins' configs; then it stops by itself.
async function firstStart(java) {
    console.log('First start (makes the world and plugin configs)...');
    const child = spawn(java, ['-Xms1G', '-Xmx4G', '-jar', 'paper.jar', '--nogui'], { cwd: RUN_DIR, stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.on('error', () => {}); // the server closes it as it stops
    let out = '';
    let stopping = false;
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('the server took over 10 minutes to start')); }, 10 * 60 * 1000);
        child.stdout.on('data', chunk => {
            const s = chunk.toString();
            process.stdout.write(s.split(/\r?\n/).filter(l => /WARN|ERROR|Done \(|Geyser|ViaVersion/i.test(l)).map(l => l + '\n').join(''));
            out += s;
            // the server's own "Done", not a plugin's
            if (!stopping && /Done \([\d.,]+s\)! For help/.test(out)) {
                stopping = true;
                child.stdin.write('stop\n');
            }
        });
        child.on('exit', code => { clearTimeout(timer); stopping ? resolve() : reject(new Error(`the server exited with code ${code}`)); });
    });
    await done;
}

async function main() {
    const acceptEula = process.argv.includes('--accept-eula');
    mkdirSync(PLUGINS_DIR, { recursive: true });
    const eula = path.join(RUN_DIR, 'eula.txt');
    if (!existsSync(eula) || !/eula=true/.test(readFileSync(eula, 'utf8'))) {
        if (!acceptEula) {
            console.log('Minecraft servers need you to accept the Minecraft EULA: https://aka.ms/MinecraftEULA');
            console.log('Once you have read it: npm run server:setup -- --accept-eula');
            process.exit(1);
        }
        writeFileSync(eula, `# Accepted with npm run server:setup -- --accept-eula (https://aka.ms/MinecraftEULA)\neula=true\n`);
    }
    console.log(`Setting up a Minecraft ${MC_VERSION} server in ${RUN_DIR}`);
    const java = await setUpJava();
    await setUpPaper();
    await setUpGeyser();
    await setUpViaVersion();
    writeServerProperties();
    if (!configureGeyser()) {
        await firstStart(java);
        if (!configureGeyser()) throw new Error('Geyser did not write its config');
    }
    console.log('\nReady. Start it with: npm run server');
    console.log('Bedrock: Play > Servers > Add Server, address 127.0.0.1, port 19132. Java: localhost.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(err => {
        console.error(`Setup failed: ${err.message}`);
        process.exit(1);
    });
}
