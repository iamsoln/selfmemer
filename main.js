const { Client } = require('djs-selfbot-v13');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { postLog } = require('./logger');

function postToApi(apiPath, data) {
    const body = JSON.stringify(data);
    const req  = http.request({
        hostname: '127.0.0.1', port: 5000, path: apiPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.write(body); req.end();
}

// ── Account selection ──────────────────────────────────────
const accountArg = process.argv.find(a => a.startsWith('--account='));
const ACCOUNT_ID = accountArg ? accountArg.split('=')[1] : 'default';

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadAccountConfig() {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const accounts = raw.accounts || [];
    const account  = accounts.find(a => a.id === ACCOUNT_ID);
    if (!account) throw new Error(`Account ${ACCOUNT_ID} not found in config.json`);
    return account;
}

let config = loadAccountConfig();

const TOKEN      = config.token;
const CHANNEL_ID = String(config.channel_id);
const BOT_ID     = String(config.bot_id);

// ── Live-reloadable runtime state ──────────────────────────
const _cfg = {
    cooldown:          config.cooldown          ?? 20,
    search_cooldown:   config.search_cooldown   ?? 25,
    beg_cooldown:      config.beg_cooldown      ?? 40,
    crime_cooldown:    config.crime_cooldown    ?? 40,
    hl_cooldown:       config.hl_cooldown       ?? 10,
    hl_wait_for:       config.hl_wait_for       ?? 5,
    pm_cooldown:       config.pm_cooldown       ?? 20,
    adv_cooldown:      config.adv_cooldown      ?? 1800,
    wait_for_response: config.wait_for_response ?? 10,
    search_risk:       config.search_risk       ?? 'medium',
    crime_risk:        config.crime_risk        ?? 'medium',
    adv_type:          config.adv_type          ?? 'Pepe Goes to Space',
    commands_enabled:  config.commands_enabled  ?? {
        hunt: true, dig: true, search: true,
        beg: true, crime: true, hl: true, pm: true, adv: false,
    },
};

function log(level, msg) {
    console.log(`[MAIN:${ACCOUNT_ID}] ${msg}`);
    postLog(`main:${ACCOUNT_ID}`, level, msg);
}

async function configReloadLoop() {
    while (true) {
        await sleep(5000);
        try {
            const fresh = loadAccountConfig();
            for (const key of [
                'cooldown', 'search_cooldown', 'beg_cooldown', 'crime_cooldown',
                'hl_cooldown', 'hl_wait_for', 'pm_cooldown', 'wait_for_response',
                'search_risk', 'crime_risk', 'adv_cooldown', 'adv_type',
            ]) {
                if (key in fresh && _cfg[key] !== fresh[key]) {
                    log('info', `Hot-reload ${key}: ${_cfg[key]} → ${fresh[key]}`);
                    _cfg[key] = fresh[key];
                }
            }
            if (fresh.commands_enabled) {
                for (const [cmd, val] of Object.entries(fresh.commands_enabled)) {
                    if (_cfg.commands_enabled[cmd] !== val) {
                        log('info', `Hot-reload commands_enabled.${cmd}: ${_cfg.commands_enabled[cmd]} → ${val}`);
                    }
                    _cfg.commands_enabled[cmd] = val;
                }
            }
        } catch (e) {
            log('error', `Config reload failed: ${e.message}`);
        }
    }
}

// ── Helpers ────────────────────────────────────────────────
function sleep(ms, extra = 500) {
    // Adds some extra cd.
    const totalWait = ms + Math.floor(Math.random() * extra);
    return new Promise(r => setTimeout(r, totalWait));
}

class Mutex {
    constructor() { this._locked = false; this._queue = []; this.lockFilePath = null; }
    acquire() {
        if (!this._locked) { this._locked = true; return Promise.resolve(); }
        return new Promise(resolve => this._queue.push(resolve));
    }
    release() {
        if (this._queue.length > 0) this._queue.shift()();
        else this._locked = false;
    }
    async runExclusive(fn) {
        await this.acquire();
        if (this.lockFilePath) try { fs.writeFileSync(this.lockFilePath, '1'); } catch {}
        try   { return await fn(); }
        finally {
            if (this.lockFilePath) try { fs.unlinkSync(this.lockFilePath); } catch {}
            this.release();
        }
    }
}

const client           = new Client({ checkUpdate: false });
const _interactionLock = new Mutex();
_interactionLock.lockFilePath = path.join(__dirname, `interaction_lock_${ACCOUNT_ID}.lock`);

function logMessage(message) {
    const content   = message.content || '(none)';
    const embedDesc = message.embeds[0]?.description?.slice(0, 80) || '';
    const buttons   = getButtons(message).map(b => b.label).join(', ');
    let detail = `content="${content}"`;
    if (embedDesc) detail += ` embed="${embedDesc.replace(/\n/g, ' ')}"`;
    if (buttons)   detail += ` buttons=[${buttons}]`;
    log('info', `Response — ${detail}`);
}

function getButtons(message) {
    const buttons = [];
    for (const row of message.components)
        for (const c of row.components)
            if (c.type === 'BUTTON' && (c.label?.trim() || c.emoji)) buttons.push(c);
    return buttons;
}

function isSkipButton(b) {
    const lbl = (b.label || '').toLowerCase().trim();
    const cid = (b.customId || '').toLowerCase();
    const emojiName = (b.emoji?.name || '').toLowerCase();
    return lbl === '→' || lbl === 'skip' || lbl === 'next' ||
           emojiName === '→' || emojiName === '➡️' || emojiName === 'arrow_right' ||
           cid.includes('skip') || cid.includes('next') || cid.includes('arrow') ||
           // Dank Memer adventure-specific advance buttons
           emojiName.includes('rightarrow') || emojiName.includes('arrowright') ||
           emojiName.includes('forward') || emojiName.includes('continue') ||
           emojiName.includes('next');
}

function isUtilityButton(b) {
    const lbl = (b.label || '').toLowerCase().trim();
    const cid = (b.customId || '').toLowerCase();
    const emojiName = (b.emoji?.name || '').toLowerCase();
    return lbl === 'backpack' || lbl.includes('backpack') ||
           cid.includes('backpack') || emojiName.includes('backpack') ||
           lbl === 'inventory' || cid.includes('inventory');
}

function getHazardColumn(description, hazard) {
    const gridLines = description.split('\n').filter(l => l.startsWith('#'));
    if (gridLines.length < 2) return null;
    const hazardLine = gridLines[1];
    if (!hazardLine.includes(`:${hazard}:`)) return null;
    const count = (hazardLine.match(/emptyspace/g) || []).length;
    if (count === 1) return 'Left';
    if (count === 2) return 'Middle';
    if (count === 3) return 'Right';
    return null;
}

function pickSafeColumn(hazardCol) {
    const options = ['Left', 'Middle', 'Right'].filter(o => o !== hazardCol);
    return options[Math.floor(Math.random() * options.length)];
}

async function clickButton(message, label) {
    for (const button of getButtons(message)) {
        if (button.label === label) {
            try { await message.clickButton(button.customId); } catch (e) { log('warn', `Click '${label}': ${e.message}`); }
            return true;
        }
    }
    return false;
}

async function clickButtonPrefix(message, prefix) {
    const lower = prefix.toLowerCase();
    for (const button of getButtons(message)) {
        if ((button.label || '').toLowerCase().startsWith(lower)) {
            try { await message.clickButton(button.customId); } catch (e) { log('warn', `Click prefix '${prefix}': ${e.message}`); }
            return button.label;
        }
    }
    return null;
}

async function handleDodge(message, hazard, label) {
    const description = message.embeds[0]?.description || '';
    const hazardCol   = getHazardColumn(description, hazard);
    if (!hazardCol) { log('warn', `[${label}] Could not detect hazard column`); return; }
    const safeCol = pickSafeColumn(hazardCol);
    log('info', `[${label}] Hazard at ${hazardCol} → dodging to ${safeCol}`);
    const ok = await clickButton(message, safeCol);
    log(ok ? 'info' : 'warn', ok ? `[${label}] ✓ Dodged to '${safeCol}'` : `[${label}] ✗ Failed to dodge`);
}

// ── Response queue ─────────────────────────────────────────
// Keyed by the SENT message's Discord ID — completely immune to
// cross-bot stealing because no two bots share the same sent message ID.
const _pendingReplies = new Map(); // sentMsgId -> { resolve, command }

client.on('messageCreate', message => {
    if (String(message.channelId) !== CHANNEL_ID) return;
    if (String(message.author.id) !== BOT_ID)     return;
    if (!message.reference)                        return;

    const refId = message.reference.messageId;
    if (!_pendingReplies.has(refId)) return;

    const { resolve } = _pendingReplies.get(refId);
    _pendingReplies.delete(refId);
    resolve(message);
});

async function sendAndWait(channel, command, timeoutSecs = null) {
    const ms = (timeoutSecs ?? _cfg.wait_for_response) * 1000;
    let resolve;
    const promise = new Promise(res => { resolve = res; });

    // Send first so we have the actual Discord message ID to key on
    const sent = await channel.send(command);
    log('info', `Sent: ${command}`);
    _pendingReplies.set(sent.id, { resolve, command });

    const timer = setTimeout(() => {
        if (_pendingReplies.has(sent.id)) {
            _pendingReplies.delete(sent.id);
            log('warn', `No response for '${command}' within ${timeoutSecs ?? _cfg.wait_for_response}s`);
            resolve(null);
        }
    }, ms);

    const response = await promise;
    clearTimeout(timer);
    if (response) logMessage(response);
    return response;
}

// ── Search Rankings ────────────────────────────────────────
const SEARCH_RANKINGS_LOW = [
    "Fridge","Dresser","Mailbox","Car","Computer","Vacuum","Basement","Sink",
    "Pantry","Grass","Shoe","Bus","Coat","Twitter","Pocket","Washer","Book",
    "Bed","Glovebox","Couch","Air","Toilet","Garage","Who asked","Dog",
    "Coffee shop","Dumpster","#dank-chat","Soup kitchen","Purse","Hospital",
    "Kitchen","Dank Museum","God's Own Place","Stock Market","Vegas Sphere",
    "Twitch","Movie Theater","Ocean","Bank","Bathroom","Dark room","Briefcase",
    "Beehive","Bushes","Attic","Crawlspace","Sewer","Tree","Lego bin","Uber","Van",
    "Soul's chamber","The Gambler's Kingdom","Heist Circle Lounge","Heist Circle",
    "Ultimate Dankers","Greg's Farm","Whole Foods","FightHub","ZomB's Grave",
    "McDonald's","NOT a casino","Shadow's Realm","Aeradella's home","ZomB's Server",
    "Toxic waste plant","Lovish's Gym","Phoenix pits","Police officer","Street","Tesla",
];
const SEARCH_RANKINGS_MEDIUM = [
    "Soul's chamber","The Gambler's Kingdom","Heist Circle Lounge","Heist Circle",
    "Ultimate Dankers","Greg's Farm","Whole Foods","FightHub","ZomB's Grave",
    "McDonald's","NOT a casino","Shadow's Realm","Aeradella's home","Dank Museum",
    "Hospital","Kitchen","Dark room","Ocean","Bank","Bathroom","God's Own Place",
    "Stock Market","Vegas Sphere","Twitch","Movie Theater","Briefcase","Beehive",
    "Bushes","Attic","Crawlspace","Sewer","Tree","Lego bin","Uber","Van","Glovebox",
    "Book","Coffee shop","Dog","Dumpster","Purse","Soup kitchen","#dank-chat","Garage",
    "Fridge","Dresser","Mailbox","Car","Computer","Vacuum","Basement","Sink","Pantry",
    "Grass","Shoe","Bus","Coat","Twitter","Pocket","Washer","Bed","Couch","Air",
    "Toilet","Who asked","ZomB's Server","Toxic waste plant","Lovish's Gym",
    "Phoenix pits","Police officer","Street","Tesla",
];
const SEARCH_RANKINGS_HIGH = [
    "Tesla","Soul's chamber","The Gambler's Kingdom","Heist Circle Lounge",
    "Lovish's Gym","Heist Circle","Ultimate Dankers","Phoenix pits","Whole Foods",
    "FightHub","ZomB's Grave","NOT a casino","Shadow's Realm","Police officer",
    "Street","Aeradella's home","Greg's Farm","ZomB's Server","Toxic waste plant",
    "Dank Museum","McDonald's","Purse","Bank","Bathroom","Ocean","Briefcase","Beehive",
    "Dark room","Attic","Hospital","Kitchen","God's Own Place","Vegas Sphere","Twitch",
    "Movie Theater","Soup kitchen","#dank-chat","Bushes","Sewer","Crawlspace","Lego bin",
    "Tree","Uber","Van","Stock Market","Glovebox","Book","Coffee shop","Dog","Dumpster",
    "Garage","Fridge","Dresser","Mailbox","Car","Computer","Vacuum","Basement","Sink",
    "Pantry","Grass","Shoe","Bus","Coat","Twitter","Pocket","Washer","Bed","Couch",
    "Air","Toilet","Who asked",
];
const SEARCH_RANKINGS_BY_MODE = {
    low: SEARCH_RANKINGS_LOW, medium: SEARCH_RANKINGS_MEDIUM, high: SEARCH_RANKINGS_HIGH,
};

function pickBestSearchButton(buttons) {
    const rankings = SEARCH_RANKINGS_BY_MODE[_cfg.search_risk];
    let best = null, bestRank = rankings.length;
    for (const btn of buttons) {
        const label = (btn.label || '').trim();
        const rank  = rankings.findIndex(n => n.toLowerCase() === label.toLowerCase());
        if (rank !== -1 && rank < bestRank) { bestRank = rank; best = btn; }
    }
    return best;
}

// ── Crime Rankings ─────────────────────────────────────────
const CRIME_RANKINGS_LOW = [
    "Gaslighting","Kicking dank memer","Eating A Hot Dog Sideways","Stab grandma",
    "Public urination","Paying for twitter blue","Pineapple on pizza","Cyber bullying",
    "Boredom","Murder","Grand Theft Auto","Prostitution","New player theft","Littering",
    "Hacking","Piracy","Driving under the influence","Jay Walking","Drug distribution",
    "Shoplifting","Identity theft","Bank robbing","Idle hands","Poisoning","Poaching",
    "Child labor","Highway Robbery","Vandalism","Stealing from drug lords",
    "Breaking and entering","Trespassing","Arson","Fraud","Tax evasion","Treason",
];
const CRIME_RANKINGS_MEDIUM = [
    "Poaching","Child labor","Kicking dank memer","Gaslighting","Stab grandma",
    "New player theft","Public urination","Idle hands","Poisoning","Piracy",
    "Eating A Hot Dog Sideways","Grand Theft Auto","Paying for twitter blue",
    "Identity theft","Driving under the influence","Drug distribution","Jay Walking",
    "Murder","Bank robbing","Prostitution","Shoplifting","Cyber bullying","Boredom",
    "Pineapple on pizza","Stealing from drug lords","Highway Robbery","Hacking",
    "Littering","Vandalism","Tax evasion","Treason",
    "Breaking and entering","Trespassing","Arson","Fraud",
];
const CRIME_RANKINGS_HIGH = [
    "Tax evasion","Treason","Poaching","Child labor","Kicking dank memer","Idle hands",
    "Poisoning","Stab grandma","New player theft","Public urination","Gaslighting",
    "Piracy","Eating A Hot Dog Sideways","Grand Theft Auto","Paying for twitter blue",
    "Identity theft","Driving under the influence","Stealing from drug lords",
    "Drug distribution","Jay Walking","Murder","Bank robbing","Prostitution","Shoplifting",
    "Cyber bullying","Boredom","Pineapple on pizza","Highway Robbery","Hacking",
    "Littering","Vandalism","Breaking and entering","Trespassing","Arson","Fraud",
];
const CRIME_RANKINGS_BY_MODE = {
    low: CRIME_RANKINGS_LOW, medium: CRIME_RANKINGS_MEDIUM, high: CRIME_RANKINGS_HIGH,
};

function pickBestCrimeButton(buttons) {
    const rankings = CRIME_RANKINGS_BY_MODE[_cfg.crime_risk];
    let best = null, bestRank = rankings.length;
    for (const btn of buttons) {
        const label = (btn.label || '').trim();
        const rank  = rankings.findIndex(n => n.toLowerCase() === label.toLowerCase());
        if (rank !== -1 && rank < bestRank) { bestRank = rank; best = btn; }
    }
    return best;
}

// ── Adventure knowledge base ───────────────────────────────
// Each entry: { keywords: [...], best: 'ButtonLabel' }
// keywords are matched against the embed description (case-insensitive)
// best is the button label to click (or null = pick first available button)
const ADV_DECISIONS = {
    'Pepe Goes to Space': [
        { keywords: ['karaoke bar'],              best: 'Sing' },
        { keywords: ['ran out of fuel'],          best: 'Urinate' },
        { keywords: ['shooting star'],            best: 'Wish' },
        { keywords: ['abducted by a group of aliens', 'probe you'],  best: 'Sit Back and Enjoy' },
        { keywords: ['transmission from deep space'], best: '*<)#%\':]|##' },
        { keywords: ['space kitchen'],            best: 'Inspect' },
        { keywords: ['never gonna give you up'],  best: 'Never gonna give you up' },
        { keywords: ['dying star', 'flew past a dying star'], best: 'Reach for it' },
        { keywords: ['dank sidious'],             best: 'Flee' },
        { keywords: ['radioactive chemicals'],    best: 'Distant Scan' },
        { keywords: ['webb telescope'],           best: 'Try and Fix it' },
        { keywords: ['strange looking object'],   best: 'Inspect' },
        { keywords: ['dark pyramid', 'spherical white ball'], best: 'Take Back Light' },
        { keywords: ['friendly alien approached'], best: 'Talk' },
        { keywords: ['small but wise green alien'], best: 'Do' },
        { keywords: ['odd eyes floating'],        best: 'Collect' },
        { keywords: ['space puppy', 'asteroid'],  best: 'Rescue' },
        { keywords: ['vending machine', 'moon pies'], best: 'Buy' },
        { keywords: ['cosmic bakery', 'galaxy donuts'], best: 'Buy' },
        { keywords: ['intergalactic karaoke'],    best: 'Sing' },
    ],
    'Pepe Goes out West': [
        { keywords: ['broken down wagon'],        best: 'Help Her' },
        { keywords: ['dope ass cowboy hat', 'radio equipment', 'lockpicking'], best: 'Pick a lock together' },
        { keywords: ['entered the saloon to rest'], best: 'Throw a drink' },
        { keywords: ['bandits about to rob the local towns bank'], best: 'Join them' },
        { keywords: ['bitten by a rattlesnake'],  best: 'Suck it' },
        { keywords: ['abandoned mine', 'old abandoned mine'], best: 'Go in' },
        { keywords: ['dying of thirst'],          best: 'Water Fountain' },
        { keywords: ['riding on your horse and you get ambushed'], best: 'Fight back' },
        { keywords: ['horse sees a snake and throws you off'], best: 'Kill the snake' },
        { keywords: ['catch one of em'],          best: '🐄' },
        { keywords: ['lost and asks you for directions'], best: 'Help them' },
        { keywords: ['train', 'bandits decide to rob the train'], best: 'Fight back' },
        { keywords: ['stray horse'],              best: 'Tame' },
        { keywords: ['horse stables', 'challenge you to a duel'], best: 'Lets duel!' },
        { keywords: ['dank cellar', 'old wooden box'], best: 'Grab it' },
        { keywords: ['wanted:'],                  best: 'Davy Jones' },
        { keywords: ['getting ambushed by bandits'], best: 'Save them' },
        { keywords: ['saloon with a poker game'], best: 'Join' },
        { keywords: ['mechanical bull'],          best: 'Kill it' },
        { keywords: ['find an abandoned mine'],   best: 'Explore' },
        { keywords: ['quick draw'],               best: 'Accept' },
    ],
    'Pepe Goes Down Under': [
        { keywords: ['animal sanctuary'],         best: 'Australia Map' },
        { keywords: ["can't decide where to go next"], best: 'Go hunting' },
        { keywords: ['scuba diving group'],       best: 'Stay together' },
        { keywords: ['kangaroo fight club'],      best: 'Place a bet' },
        { keywords: ['throaty growl', 'hiking through the woods north of victoria'], best: 'Run Away' },
        { keywords: ["nice gal at macca"],        best: 'Pay up' },
        { keywords: ['god of thunder', 'teach you to surf'], best: 'Hit the waves' },
        { keywords: ['aussie aussie aussie'],     best: 'Oi! Oi! Oi!' },
        { keywords: ['wallaby', 'kangaroo', 'crocodile cross the road'], best: 'Sweet!' },
        { keywords: ['suitcase for your favorite thongs', 'sock wiggles'], best: 'Deal with it another day' },
        { keywords: ["snake in your bed"],        best: 'Run' },
        { keywords: ['kangaroo island', 'egg on the ground'], best: 'Take it home' },
        { keywords: ['exploring the outback', 'footprints near a creek'], best: 'Follow the creek' },
        { keywords: ['great barrier reef has inspired you'], best: 'Admire the view' },
        { keywords: ['gathering on the beach', 'barbecue'], best: 'Wander alone' },
        { keywords: ['vegemite'],                 best: 'Big bite' },
        { keywords: ['chuck a sickie', 'stubby'], best: 'Say yes' },
        { keywords: ['spider has taken up residence'], best: 'Leave it be' },
        { keywords: ['website designer', 'coffee shop', 'business card'], best: 'Throw it away' },
    ],
    'Pepe Goes on Vacation': [
        { keywords: ['family road trip', 'lost and without cell service'], best: 'Keep Driving' },
        { keywords: ['amusement park'],           best: 'Rollercoaster' },
        { keywords: ['mountain resort', 'snow'],  best: 'Go Skiing' },
        { keywords: ['camping', 'wilderness'],    best: 'Rent an RV' },
        { keywords: ['lisbon', 'pastry for breakfast'], best: 'Eat it' },
        { keywords: ['paris', 'romantic vacation'], best: 'The Eiffel Tower' },
        { keywords: ['rome', 'colosseum', 'friendship bracelets'], best: 'Take a Bracelet' },
        { keywords: ['sightseeing', "can't go on vacation without"], best: 'Museum' },
        { keywords: ['famous landmarks', 'united states'], best: 'The Grand Canyon' },
        { keywords: ['beach', 'weekend away', 'which beach'], best: 'Daytona Beach, Florida' },
        { keywords: ['legoland'],                 best: 'Mini Lego City' },
        { keywords: ['whale watching'],           best: 'Melmsie' },
        { keywords: ['cruise ship', 'small island', 'sun and swimming'], best: 'Swim' },
        { keywords: ['discount cruises', 'destination do you choose'], best: 'Mediterranean' },
        { keywords: ['stargazing', 'chilean desert'], best: 'Night' },
    ],
    'Pepe Goes Fishing with Friends': [],
    'Pepe Goes to the Museum': [
        { keywords: ['fossils', 'aquatic world exhibit', 'drowning in information'], best: 'Power through' },
        { keywords: ['pepe history collection', 'works of art'], best: 'Paintings' },
        { keywords: ['hall of human history', 'bolt cutters'], best: 'Walk On' },
        { keywords: ['t-rex skeleton'],           best: 'Take a picture' },
        { keywords: ['gift shop', 'souvenir', 'how do you decide'], best: 'Flip a coin' },
        { keywords: ['dark hallway with two doors'], best: 'Right' },
        { keywords: ['legendary beasts', 'lights go out', 'doors close'], best: 'Dragon' },
        { keywords: ['pharaoh exhibit', 'modern medicine'], best: 'Pharmacology' },
        { keywords: ['bathroom', 'busload of kids', 'stalls'], best: 'Disgusting Floor' },
        { keywords: ['age of the internet', 'where it all started'], best: 'Computers' },
        { keywords: ['pepe history display', 'memes, pepes'], best: 'Pepe Crown' },
        { keywords: ['artifact cafe', 'taco tuesday'], best: 'Hit the vending machine' },
        { keywords: ['history of domestic pets', 'cats', 'dogs'], best: 'Dogs' },
        { keywords: ['education through the ages', 'ex approaching'], best: 'Science' },
        { keywords: ['licking one of the paintings', 'tiktok prank'], best: 'Apologise' },
        { keywords: ['decades of distilleries'],  best: 'Whiskey' },
        { keywords: ['weird and unexplained', 'something is watching'], best: 'Ignore it' },
        { keywords: ['hunter-gatherer exhibit', 'creeping you out'], best: 'Hunting' },
        { keywords: ['bird has gotten into the museum', 'reward'], best: 'U.S. Presidents' },
        { keywords: ['virtual reality', 'biome of your choice'], best: 'Ocean Biome' },
    ],
    'Pepe goes to Brazil': [
        { keywords: ['christ the redeemer'],      best: 'Bus' },
        { keywords: ['brazilian cheese bread'],   best: 'Brigaderio' },
        { keywords: ['brazilian steakhouse', 'meat you can eat'], best: 'Give me the meat!' },
        { keywords: ['capybaras'],                best: 'Pull up' },
        { keywords: ['amazon river', 'piranhas', 'anacondas'], best: 'Anacondas' },
        { keywords: ['carnival', 'bands playing music'], best: 'Dance' },
    ],
};

// Cooldown rules per adventure type (returns seconds to wait)
function calcAdvCooldown(advType, interactions) {
    const n = interactions || 10;
    const lc = advType.toLowerCase();
    if (lc.includes('space'))     return n * 60;
    if (lc.includes('west'))      return n * 60;
    if (lc.includes('brazil'))    return Math.ceil(n / 2) * 60;
    // Down Under, Vacation, Fishing, Museum: TBA – use 30 min
    return 30 * 60;
}

// Pick the best button for a given adventure prompt
function pickAdventureChoice(advType, embedDescription, buttons) {
    if (!buttons.length) return null;
    const desc      = embedDescription.toLowerCase();
    const decisions = ADV_DECISIONS[advType] || [];

    for (const rule of decisions) {
        const matches = rule.keywords.every(kw => desc.includes(kw.toLowerCase()));
        if (!matches) continue;

        if (!rule.best) return buttons[0];
        const found = buttons.find(b => (b.label || '').trim().toLowerCase() === rule.best.toLowerCase());
        if (found) return found;
        // Fallback: partial match
        const partial = buttons.find(b => (b.label || '').trim().toLowerCase().includes(rule.best.toLowerCase()));
        if (partial) return partial;
        break;
    }
    // No rule matched – pick first button
    return buttons[0];
}

// ── Channel resolver (retries + guild cache fallback) ──────
async function resolveChannel(client, channelId) {
    log('info', 'Waiting for guild sync...');
    await sleep(5000);

    const cached = client.channels.cache.get(channelId);
    if (cached) { log('info', 'Channel found in global cache'); return cached; }

    for (const guild of client.guilds.cache.values()) {
        const ch = guild.channels.cache.get(channelId);
        if (ch) { log('info', `Channel found in cache of guild "${guild.name}"`); return ch; }
    }

    const guilds = [...client.guilds.cache.values()];
    log('info', `Searching ${guilds.length} guild(s) for channel ${channelId}...`);
    for (const guild of guilds) {
        log('info', `Checking guild "${guild.name}" (${guild.id})...`);
        try {
            const channels = await guild.channels.fetch();
            const ch = channels.get(channelId);
            if (ch) { log('info', `Found channel "${ch.name}" in guild "${guild.name}"`); return ch; }
        } catch (e) {
            log('warn', `guild.channels.fetch() failed for "${guild.name}": ${e.message}`);
        }
    }

    try {
        return await client.channels.fetch(channelId, { force: true });
    } catch (e) {
        throw new Error(`Channel ${channelId} not found in any of ${guilds.length} guild(s). Original error: ${e.message}`);
    }
}

// ── Command loops ──────────────────────────────────────────
client.on('ready', async () => {
    log('info', `Logged in as ${client.user.tag} (${client.user.id})`);
    let channel;
    try {
        channel = await resolveChannel(client, CHANNEL_ID);
    } catch (e) {
        log('error', `Channel fetch failed: ${e.message} — verify channel_id in Connection settings`);
        client.destroy(); return;
    }
    log('info', `Sending commands in #${channel.name ?? CHANNEL_ID}`);

    // ── Save own Discord UID for mothership system ──────────
    postToApi(`/api/accounts/${ACCOUNT_ID}/discord_uid`, { discord_uid: String(client.user.id) });

    // ── Mothership transfer helpers ─────────────────────────
    const IGNORED_ITEMS = new Set([
        'lifesaver', 'huntingrifle', 'adventureticket', 'shovel', 'luckyhorseshoe',
        'triviatrophy',
    ]);

    function extractAllText(components) {
        const texts = [];
        if (!Array.isArray(components)) return texts;
        for (const c of components) {
            if (typeof c.content === 'string') texts.push(c.content);
            if (Array.isArray(c.components)) texts.push(...extractAllText(c.components));
            if (c.accessory) texts.push(...extractAllText([c.accessory]));
        }
        return texts;
    }

    function findConfirmButton(components) {
        for (const c of (components || [])) {
            if (c.type === 'BUTTON' && (c.label || '').toLowerCase().trim() === 'confirm') return c;
            if (Array.isArray(c.components)) {
                const found = findConfirmButton(c.components);
                if (found) return found;
            }
            if (c.accessory) {
                const found = findConfirmButton([c.accessory]);
                if (found) return found;
            }
        }
        return null;
    }

    async function confirmIfNeeded(msg, label) {
        if (!msg) return;
        const btn = findConfirmButton(msg.components || []);
        if (btn) {
            try {
                await msg.clickButton(btn.customId);
                log('info', `[TRANSFER] Confirmed: ${label}`);
            } catch (e) {
                log('warn', `[TRANSFER] Confirm click failed: ${e.message}`);
            }
        } else {
            log('info', `[TRANSFER] No confirm button found for: ${label}`);
        }
    }

    function writeTransferStatus(status, done = false) {
        const statusPath = path.join(__dirname, `transfer_status_${ACCOUNT_ID}.json`);
        try { fs.writeFileSync(statusPath, JSON.stringify({ status, ts: Date.now(), done })); } catch {}
        log('info', `[TRANSFER] ${status}`);
    }

    function parseInventoryItems(message) {
        const items = [];
        const targetComps = (message.components && message.components.length > 1)
            ? [message.components[1]]
            : (message.components || []);
        const texts = extractAllText(targetComps);
        for (const text of texts) {
            const matches = [...text.matchAll(/\*\*([^*]+)\*\*[^0-9]*([0-9,]+)/g)];
            for (const m of matches) {
                const raw     = m[1].trim();
                const noEmoji = raw.replace(/<a?:\w+:\d+>\s*/g, '').trim();
                const name    = noEmoji.replace(/\s+/g, '');
                const qty     = parseInt(m[2].replace(/,/g, ''), 10);
                if (name && qty > 0 && !IGNORED_ITEMS.has(name.toLowerCase())) items.push({ name, qty });
            }
        }
        return items;
    }

    async function transferLoop() {
        while (true) {
            await sleep(2000);
            const triggerPath = path.join(__dirname, `transfer_trigger_${ACCOUNT_ID}.json`);
            if (!fs.existsSync(triggerPath)) continue;

            let trigger;
            try {
                trigger = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
                fs.unlinkSync(triggerPath);
            } catch { continue; }

            const { type, mothership_uid, mothership_name } = trigger;

            if (type === 'items') {
                await _interactionLock.runExclusive(async () => {
                    let iterations = 0;
                    while (iterations < 15) {
                        iterations++;
                        writeTransferStatus('Checking inventory...');
                        const invMsg = await sendAndWait(channel, 'pls inv', 15);
                        if (!invMsg) { writeTransferStatus('No inventory response', true); break; }

                        const items = parseInventoryItems(invMsg);
                        if (items.length === 0) {
                            writeTransferStatus('All transferable items sent to mothership!', true);
                            break;
                        }

                        for (const item of items) {
                            writeTransferStatus(`Sending ${item.qty}x ${item.name} to ${mothership_name}...`);
                            const shareMsg = await sendAndWait(channel, `pls friends share items <@${mothership_uid}> ${item.qty} ${item.name}`, 12);
                            await confirmIfNeeded(shareMsg, `${item.qty}x ${item.name}`);
                            await sleep(600);
                        }
                        await sleep(400);
                    }
                });
            } else if (type === 'coins') {
                await _interactionLock.runExclusive(async () => {
                    writeTransferStatus('Checking wallet balance...');
                    const balMsg = await sendAndWait(channel, 'pls bal', 15);
                    if (!balMsg) { writeTransferStatus('No balance response', true); return; }

                    const chunks = extractAllText(balMsg.components || []);
                    for (const embed of (balMsg.embeds || [])) {
                        chunks.push(embed.description || '');
                        for (const f of (embed.fields || [])) chunks.push(f.value || '');
                    }
                    if (balMsg.content) chunks.push(balMsg.content);

                    let wallet = 0;
                    for (const chunk of chunks) {
                        for (const line of chunk.split('\n')) {
                            const m = line.match(/(?:<:\w+:\d+>|⏣)\s*([\d,]+)/);
                            if (m && !line.includes('/') && wallet === 0) {
                                wallet = parseInt(m[1].replace(/,/g, ''), 10);
                            }
                        }
                    }

                    if (wallet <= 0) {
                        writeTransferStatus('No coins in wallet to transfer', true);
                        return;
                    }

                    writeTransferStatus(`Sending ⏣${wallet.toLocaleString()} to ${mothership_name}...`);
                    const coinMsg = await sendAndWait(channel, `pls friends share coins <@${mothership_uid}> ${wallet}`, 12);
                    await confirmIfNeeded(coinMsg, `⏣${wallet.toLocaleString()} coins`);
                    await sleep(400);
                    writeTransferStatus(`Done! Sent ⏣${wallet.toLocaleString()} to ${mothership_name}`, true);
                });
            }
        }
    }

    const SELECT_TYPES = ['STRING_SELECT','SELECT_MENU','USER_SELECT','ROLE_SELECT','MENTIONABLE_SELECT','CHANNEL_SELECT'];

    function getMenuRows(msg) {
        const rows = [];
        for (let i = 0; i < msg.components.length; i++) {
            const comp = msg.components[i]?.components?.[0];
            if (comp && SELECT_TYPES.includes(comp.type)) rows.push({ rowIndex: i, menu: comp });
        }
        return rows;
    }

    async function begLoop() {
        while (true) {
            if (_cfg.commands_enabled.beg) {
                await _interactionLock.runExclusive(async () => {
                    await sendAndWait(channel, 'pls beg');
                });
            }
            await sleep(_cfg.beg_cooldown * 1000);
        }
    }

    async function searchLoop() {
        await sleep(3000);
        while (true) {
            if (_cfg.commands_enabled.search) {
                await _interactionLock.runExclusive(async () => {
                    const res = await sendAndWait(channel, 'pls search');
                    if (res) {
                        const btns   = getButtons(res);
                        const target = btns.length ? (pickBestSearchButton(btns) || btns[0]) : null;
                        if (target) {
                            log('info', `[SEARCH] Clicking '${target.label}'`);
                            try { await res.clickButton(target.customId); log('info', `[SEARCH] ✓ Clicked '${target.label}'`); }
                            catch (e) { log('warn', `[SEARCH] ${e.message}`); }
                        }
                    }
                });
            }
            await sleep(_cfg.search_cooldown * 1000);
        }
    }

    async function crimeLoop() {
        await sleep(12000);
        while (true) {
            if (_cfg.commands_enabled.crime) {
                await _interactionLock.runExclusive(async () => {
                    const res = await sendAndWait(channel, 'pls crime');
                    if (res) {
                        const btns   = getButtons(res);
                        const target = btns.length ? (pickBestCrimeButton(btns) || btns[0]) : null;
                        if (target) {
                            log('info', `[CRIME] Clicking '${target.label}'`);
                            try { await res.clickButton(target.customId); log('info', `[CRIME] ✓ Clicked '${target.label}'`); }
                            catch (e) { log('warn', `[CRIME] ${e.message}`); }
                        }
                    }
                });
            }
            await sleep(_cfg.crime_cooldown * 1000);
        }
    }

    async function digLoop() {
        await sleep(6000);
        while (true) {
            if (_cfg.commands_enabled.dig) {
                await _interactionLock.runExclusive(async () => {
                    const res = await sendAndWait(channel, 'pls dig');
                    if (res) {
                        const desc = res.embeds[0]?.description || '';
                        if (desc.includes('Dodge the Moleman'))     await handleDodge(res, 'Worm',    'MOLEMAN');
                        else if (desc.includes('Dodge the Sludge')) await handleDodge(res, 'PinkBits','SLUDGE');
                    }
                });
            }
            await sleep(_cfg.cooldown * 1000);
        }
    }

    async function huntLoop() {
        await sleep(9000);
        while (true) {
            if (_cfg.commands_enabled.hunt) {
                await _interactionLock.runExclusive(async () => {
                    const res = await sendAndWait(channel, 'pls hunt');
                    if (res) {
                        const desc = res.embeds[0]?.description || '';
                        if (desc.includes('Dodge the Dragon')) await handleDodge(res, 'FireBall','FIREBALL');
                    }
                });
            }
            await sleep(_cfg.cooldown * 1000);
        }
    }

    async function hlLoop() {
        await sleep(15000);
        while (true) {
            if (_cfg.commands_enabled.hl) {
                await _interactionLock.runExclusive(async () => {
                    const res = await sendAndWait(channel, 'pls hl', _cfg.hl_wait_for);
                    if (res) {
                        const desc  = res.embeds[0]?.description || '';
                        const match = desc.match(/\*\*(\d+)\*\*/);
                        if (match) {
                            const n = parseInt(match[1]);
                            const choice = n <= 50 ? 'Higher' : 'Lower';
                            log('info', `[HL] Number is ${n} → clicking '${choice}'`);
                            const ok = await clickButton(res, choice);
                            log(ok ? 'info' : 'warn', ok ? `[HL] ✓ Clicked '${choice}'` : `[HL] ✗ Failed`);
                        } else {
                            log('warn', '[HL] Could not parse number');
                        }
                    }
                });
            }
            await sleep(_cfg.hl_cooldown * 1000);
        }
    }

    async function pmLoop() {
        await sleep(18000);
        const PM_PLATFORMS = ['TikTok', 'Discord', 'Reddit', 'Twitter', 'Facebook'];
        while (true) {
            let pmCooldown = _cfg.pm_cooldown;
            if (_cfg.commands_enabled.pm) {
                const platform = PM_PLATFORMS[Math.floor(Math.random() * PM_PLATFORMS.length)];
                await _interactionLock.runExclusive(async () => {
                    const res = await sendAndWait(channel, 'pls pm');
                    if (res) {
                        const menuRows = getMenuRows(res);
                        log('info', `[PM] Found ${menuRows.length} menu(s), platform='${platform}'`);
                        if (menuRows.length > 0) {
                            const platformRow = menuRows.find(({ menu }) =>
                                (menu.options || []).some(o =>
                                    PM_PLATFORMS.map(p => p.toLowerCase()).includes((o.label || '').toLowerCase())
                                )
                            ) || menuRows[menuRows.length - 1];
                            const { rowIndex, menu } = platformRow;
                            const matchedOpt = (menu.options || []).find(
                                o => (o.label || '').trim().toLowerCase() === platform.toLowerCase()
                            );
                            const val = matchedOpt?.value || (menu.options?.length > 0 ? menu.options[0].value : null);
                            if (val) {
                                try {
                                    await res.selectMenu(rowIndex, [val]);
                                    log('info', `[PM] ✓ Selected '${matchedOpt?.label || val}'`);
                                } catch (e) { log('warn', `[PM] select failed: ${e.message}`); }
                            }
                        }
                        const posted = await clickButton(res, 'Post');
                        log(posted ? 'info' : 'warn', posted ? "[PM] ✓ Clicked 'Post'" : "[PM] ✗ 'Post' not found");
                        await sleep(3000);
                        try {
                            const updated = await channel.messages.fetch(res.id);
                            if ((updated.embeds[0]?.description || '').includes('another 2 minutes')) {
                                log('warn', '[PM] Rate-limited — waiting 120s');
                                pmCooldown = 120;
                            }
                        } catch (e) { log('warn', `[PM] Cooldown check failed: ${e.message}`); }
                    }
                });
            }
            await sleep(pmCooldown * 1000);
        }
    }

    // ── Adventure loop ─────────────────────────────────────
    async function advLoop() {
        await sleep(21000);
        while (true) {
            if (!_cfg.commands_enabled.adv) {
                await sleep(10000);
                continue;
            }
            let advCooldown = _cfg.adv_cooldown;
            if (_cfg.commands_enabled.adv) {
                await _interactionLock.runExclusive(async () => {
                    const advType = _cfg.adv_type;
                    log('info', `[ADV] Starting adventure: "${advType}"`);

                    // Step 1: send pls adv and wait for bot reply
                    const res = await sendAndWait(channel, 'pls adv', 15);
                    if (!res) { log('warn', '[ADV] No response to pls adv'); return; }

                    // Step 2: always use select menu if present (ensures correct adventure type is set)
                    let msg = res;
                    const menuRows = getMenuRows(res);
                    if (menuRows.length > 0) {
                        const { rowIndex, menu } = menuRows[menuRows.length - 1];
                        const opts = menu.options || [];
                        const matchedOpt = opts.find(o =>
                            (o.label || '').toLowerCase().includes(advType.toLowerCase()) ||
                            advType.toLowerCase().includes((o.label || '').toLowerCase())
                        ) || opts[0];
                        if (matchedOpt) {
                            try {
                                await res.selectMenu(rowIndex, [matchedOpt.value]);
                                log('info', `[ADV] ✓ Selected adventure: "${matchedOpt.label}"`);
                            } catch (e) {
                                log('warn', `[ADV] Select failed: ${e.message} — checking for Start anyway`);
                            }
                            // Fetch updated message regardless of whether selectMenu threw
                            await sleep(300);
                            try { msg = await channel.messages.fetch(res.id); } catch {}
                        } else {
                            log('warn', '[ADV] No matching adventure option found in menu');
                            return;
                        }
                    } else if (!getButtons(res).some(b => (b.label || '').toLowerCase().startsWith('start'))) {
                        log('info', '[ADV] Adventure already in progress — entering interaction loop');
                    }

                    // Step 3: click Start (1st press — confirms selection)
                    const startLabel = await clickButtonPrefix(msg, 'Start');
                    if (startLabel) {
                        log('info', `[ADV] ✓ Clicked "${startLabel}" (1st)`);

                        // Step 4: fetch and click Start again if it appears (2nd press begins adventure)
                        await sleep(300);
                        try { msg = await channel.messages.fetch(res.id); } catch {}
                        const start2Label = await clickButtonPrefix(msg, 'Start');
                        if (start2Label) {
                            log('info', `[ADV] ✓ Clicked "${start2Label}" (2nd) — adventure begun`);
                        } else {
                            log('info', '[ADV] No 2nd Start needed — adventure begun');
                        }
                    } else {
                        log('info', '[ADV] No Start button — entering interaction loop directly');
                    }

                    // Step 5: interaction loop
                    let interactions     = 0;
                    let maxIter          = 80;   // safety cap
                    let consecutiveFails = 0;
                    let lastClickedDesc  = null;
                    let nextWait         = 300; // ms to sleep before next fetch

                    const btnName = b => b.label?.trim() || b.emoji?.name || b.customId || '?';

                    while (maxIter-- > 0) {
                        await sleep(nextWait);
                        nextWait = 300; // default — reset each iteration

                        try {
                            msg = await channel.messages.fetch(res.id);
                        } catch (e) {
                            log('warn', `[ADV] Fetch failed: ${e.message}`);
                            break;
                        }

                        try {
                            const embed    = msg.embeds[0];
                            const buttons  = getButtons(msg);

                            if (!embed) {
                                consecutiveFails++;
                                if (consecutiveFails > 3) { log('warn', '[ADV] No embed 3× in a row — aborting'); break; }
                                nextWait = 250;
                                continue;
                            }
                            consecutiveFails = 0;

                            const embedTitle = (embed.title || '').toLowerCase();
                            const embedDesc  = embed.description || '';
                            const embedDescL = embedDesc.toLowerCase();

                            // Detect adventure end
                            const endBtn  = buttons.find(b =>
                                (b.label || '').toLowerCase().includes('adventure again')
                            );
                            const hasSkip = buttons.some(isSkipButton);
                            // Title/endBtn matches are definitive; description matches only
                            // count if there's no skip button (otherwise it's a transition prompt)
                            const isRealEnd =
                                endBtn ||
                                embedTitle.includes('adventure summary') ||
                                embedTitle.includes('your adventure has ended') ||
                                embedTitle.includes('you have died') ||
                                (!hasSkip && (
                                    embedDescL.includes('adventure summary') ||
                                    embedDescL.includes('your adventure has ended') ||
                                    embedDescL.includes('you have died')
                                ));
                            if (isRealEnd) {
                                const intMatch = embedDesc.match(/(\d+)\s*(?:\/\s*\d+\s*)?interactions?/i)
                                              || embedDesc.match(/interactions?\s*[:\-]?\s*(\d+)/i);
                                if (intMatch) interactions = parseInt(intMatch[1]);
                                if (endBtn) {
                                    const lbl = endBtn.label || '';
                                    log('info', `[ADV] End button: "${lbl}"`);
                                    // Parse text duration e.g. "Adventure again in 1 hour 30 minutes 20 seconds"
                                    const hMatch = lbl.match(/(\d+)\s*hour/i);
                                    const mMatch = lbl.match(/(\d+)\s*min/i);
                                    const sMatch = lbl.match(/(\d+)\s*sec/i);
                                    const parsedSecs =
                                        (hMatch ? parseInt(hMatch[1]) * 3600 : 0) +
                                        (mMatch ? parseInt(mMatch[1]) * 60  : 0) +
                                        (sMatch ? parseInt(sMatch[1])       : 0);
                                    if (parsedSecs > 0) {
                                        advCooldown = parsedSecs;
                                        log('info', `[ADV] Cooldown from button: ${Math.round(parsedSecs / 60)}min`);
                                    }
                                }
                                log('info', `[ADV] Adventure ended — ${interactions} interactions`);
                                break;
                            }

                            // Track interactions from progress fields
                            for (const field of (embed.fields || [])) {
                                const m = (field.value || '').match(/(\d+)\s*(?:\/\s*\d+\s*)?interactions?/i);
                                if (m) interactions = parseInt(m[1]);
                            }

                            if (!buttons.length) {
                                nextWait = 250;
                                continue;
                            }

                            const skipBtn       = buttons.find(isSkipButton);
                            const choiceButtons = buttons.filter(b => !isSkipButton(b) && !isUtilityButton(b));

                            // This embed is the result of a previous answer — click skip to advance
                            if (embedDesc === lastClickedDesc) {
                                if (skipBtn) {
                                    try {
                                        await msg.clickButton(skipBtn.customId);
                                        log('info', '[ADV] ✓ → advanced past result');
                                        lastClickedDesc = null;
                                        nextWait = 150;
                                    } catch (e) { nextWait = 200; }
                                } else {
                                    nextWait = 150; // skip not ready yet, check again soon
                                }
                                continue;
                            }

                            // Pick best answer
                            const bestBtn = choiceButtons.length
                                ? pickAdventureChoice(advType, embedDesc, choiceButtons)
                                : skipBtn;

                            if (bestBtn && !isSkipButton(bestBtn)) {
                                log('info', `[ADV] Clicking '${btnName(bestBtn)}'`);
                                let clickSucceeded = false;
                                try {
                                    await msg.clickButton(bestBtn.customId);
                                    log('info', `[ADV] ✓ Clicked '${btnName(bestBtn)}'`);
                                    lastClickedDesc = embedDesc;
                                    nextWait = 150;
                                    clickSucceeded = true;
                                } catch (e) {
                                    log('warn', `[ADV] Click failed: ${e.message} — falling back to skip`);
                                }
                                // Button was disabled — try skip immediately as fallback
                                if (!clickSucceeded && skipBtn) {
                                    try {
                                        await msg.clickButton(skipBtn.customId);
                                        log('info', `[ADV] ✓ Fallback skip clicked`);
                                        lastClickedDesc = null;
                                        nextWait = 150;
                                    } catch (e) {
                                        log('warn', `[ADV] Fallback skip failed: ${e.message}`);
                                        nextWait = 250;
                                    }
                                } else if (!clickSucceeded) {
                                    nextWait = 250;
                                }
                            } else if (skipBtn) {
                                log('info', `[ADV] Clicking skip '${btnName(skipBtn)}'`);
                                try {
                                    await msg.clickButton(skipBtn.customId);
                                    log('info', '[ADV] ✓ Skipped');
                                    lastClickedDesc = null;
                                    nextWait = 150;
                                } catch (e) {
                                    log('warn', `[ADV] Skip failed: ${e.message}`);
                                    nextWait = 250;
                                }
                            }
                        } catch (iterErr) {
                            log('warn', `[ADV] Iteration error: ${iterErr.message}`);
                        }
                    }

                    // Compute cooldown — use formula if not already set by end-button parsing
                    if (advCooldown === _cfg.adv_cooldown) {
                        advCooldown = calcAdvCooldown(advType, interactions);
                    }
                    advCooldown += 60;
                    log('info', `[ADV] Cooldown: ${Math.round(advCooldown / 60)}min (includes +60s buffer)`);
                });
            }
            await sleep(advCooldown * 1000);
        }
    }

    async function heartbeatLoop() {
        while (true) {
            await sleep(30000);
            log('info', '♥ heartbeat');
        }
    }

    Promise.all([
        configReloadLoop(), heartbeatLoop(),
        huntLoop(), digLoop(),
        searchLoop(), begLoop(), crimeLoop(), hlLoop(), pmLoop(), advLoop(),
        transferLoop(),
    ]).catch(e => log('error', `Fatal: ${e.message}`));
});

client.login(TOKEN);
