// Starts the local server that `npm run server:setup` made. Server commands (op <name>, stop, ...)
// can be typed right here. SERVER_MEMORY sets the heap (default 4G).
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { RUN_DIR, configureGeyser, javaPath } from './setup.mjs';

// Paper's recommended JVM flags
const FLAGS = ['-XX:+AlwaysPreTouch', '-XX:+DisableExplicitGC', '-XX:+ParallelRefProcEnabled', '-XX:+PerfDisableSharedMem',
    '-XX:+UnlockExperimentalVMOptions', '-XX:+UseG1GC', '-XX:G1HeapRegionSize=8M', '-XX:G1HeapWastePercent=5',
    '-XX:G1MaxNewSizePercent=40', '-XX:G1MixedGCCountTarget=4', '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1NewSizePercent=30', '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:G1ReservePercent=20',
    '-XX:InitiatingHeapOccupancyPercent=15', '-XX:MaxGCPauseMillis=200', '-XX:MaxTenuringThreshold=1', '-XX:SurvivorRatio=32'];

const java = javaPath();
if (!java || !existsSync(path.join(RUN_DIR, 'paper.jar'))) {
    console.error('No server yet. Set one up first: npm run server:setup -- --accept-eula');
    process.exit(1);
}
configureGeyser();
const memory = process.env.SERVER_MEMORY || '4G';
const server = spawn(java, [`-Xms${memory}`, `-Xmx${memory}`, ...FLAGS, '-jar', 'paper.jar', '--nogui'], { cwd: RUN_DIR, stdio: 'inherit' });
// Ctrl+C reaches the server too, which saves the world and exits; wait for it
process.on('SIGINT', () => {});
server.on('exit', code => process.exit(code ?? 0));
