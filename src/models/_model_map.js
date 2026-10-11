import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamically discover model classes in this directory.
// Each model class must export a static `prefix` string.
// A model file is only imported once a profile uses it: importing every one, and with it every
// provider's SDK, would cost each bot seconds at startup. So the prefixes are read from the source.
const apiFiles = {}; // prefix -> file
const apiClasses = {}; // prefix -> class, once imported

async function importModels(file) {
    const mod = await import(pathToFileURL(file).href);
    for (const exported of Object.values(mod)) {
        if (typeof exported === 'function' && Object.prototype.hasOwnProperty.call(exported, 'prefix')) {
            const prefix = exported.prefix;
            if (typeof prefix === 'string' && prefix.length > 0) {
                apiClasses[prefix] = exported;
                apiFiles[prefix] ??= file;
            }
        }
    }
}

for (const name of readdirSync(__dirname)) {
    if (!name.endsWith('.js') || name === '_model_map.js' || name === 'prompter.js') continue;
    const file = path.join(__dirname, name);
    const prefixes = [...readFileSync(file, 'utf8').matchAll(/static\s+prefix\s*=\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    if (prefixes.length) {
        for (const prefix of prefixes) apiFiles[prefix] = file;
        continue;
    }
    try {
        await importModels(file); // no plain prefix in the source; find it the slow way
    } catch (e) {
        console.warn('Failed to load model module:', name, e?.message || e);
    }
}

async function loadAPI(api) {
    if (!apiClasses[api] && apiFiles[api]) {
        try {
            await importModels(apiFiles[api]);
        } catch (e) {
            throw new Error(`Failed to load the ${api} model module (${path.basename(apiFiles[api])}): ${e?.message || e}`);
        }
    }
    if (!apiClasses[api]) {
        throw new Error(`Unknown api: ${api}`);
    }
    return apiClasses[api];
}

export function selectAPI(profile) {
    if (typeof profile === 'string' || profile instanceof String) {
        profile = {model: profile};
    }
    // backwards compatibility with local->ollama
    if (profile.api?.includes('local') || profile.model?.includes('local')) {
        profile.api = 'ollama';
        if (profile.model) {
            profile.model = profile.model.replace('local', 'ollama');
        }
    }
    if (!profile.api) {
        const api = Object.keys(apiFiles).find(key => profile.model?.startsWith(key));
        if (api) {
            profile.api = api;
        }
        else {
            // check for some common models that do not require prefixes
            if (profile.model.includes('gpt') || profile.model.includes('o1')|| profile.model.includes('o3'))
                profile.api = 'openai';
            else if (profile.model.includes('claude'))
                profile.api = 'anthropic';
            else if (profile.model.includes('gemini'))
                profile.api = "google";
            else if (profile.model.includes('grok'))
                profile.api = 'xai';
            else if (profile.model.includes('mistral'))
                profile.api = 'mistral';
            else if (profile.model.includes('deepseek'))
                profile.api = 'deepseek';
            else if (profile.model.includes('qwen'))
                profile.api = 'qwen';
        }
        if (!profile.api) {
            throw new Error(`Unknown model: ${profile.model}`);
        }
    }
    if (!apiFiles[profile.api]) {
        throw new Error(`Unknown api: ${profile.api}`);
    }
    let model_name = profile.model.replace(profile.api + '/', ''); // remove prefix
    profile.model = model_name === "" ? null : model_name; // if model is empty, set to null
    return profile;
}

export async function createModel(profile) {
    if (!!apiFiles[profile.model]) {
        // if the model value is an api (instead of a specific model name)
        // then set model to null so it uses the default model for that api
        profile.model = null;
    }
    const Model = await loadAPI(profile.api);
    return new Model(profile.model, profile.url, profile.params);
}
