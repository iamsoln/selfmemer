const { Client } = require('djs-selfbot-v13');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { postLog }    = require('./logger');
const { detectFish } = require('./fish_detector');

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
    pm_cooldown:       config.pm_cooldown       ?? 20,
    adv_cooldown:      config.adv_cooldown      ?? 1800,
    wait_for_response: config.wait_for_response ?? 10,
    search_risk:           config.search_risk           ?? 'medium',
    crime_risk:            config.crime_risk            ?? 'medium',
    search_custom_ranking: Array.isArray(config.search_custom_ranking) ? config.search_custom_ranking : [],
    crime_custom_ranking:  Array.isArray(config.crime_custom_ranking)  ? config.crime_custom_ranking  : [],
    adv_type:          config.adv_type          ?? 'Pepe Goes to Space',
    adv_response_mode:    config.adv_response_mode    ?? 'recommended',
    adv_custom_responses: config.adv_custom_responses ?? {},
    fish_sell_currency:        config.fish_sell_currency        ?? 'coins',
    disable_interaction_lock:  config.disable_interaction_lock  ?? false,
    limit_flags:               config.limit_flags               ?? false,
    stealth_mode:              config.stealth_mode              ?? 'moderate',
    cycle_uptime_mins:         config.cycle_uptime_mins         ?? 0,
    cycle_downtime_mins:       config.cycle_downtime_mins       ?? 0,
    market_study_item:       config.market_study_item       ?? '',
    market_sniper_enabled:   config.market_sniper_enabled   ?? false,
    market_sniper_items:     config.market_sniper_items     ?? [],
    market_sniper_cooldown:  config.market_sniper_cooldown  ?? 60,
    daily_cooldown:   config.daily_cooldown   ?? 86400,
    work_cooldown:    config.work_cooldown    ?? 3600,
    deposit_cooldown: config.deposit_cooldown ?? 60,
    trivia_cooldown:  config.trivia_cooldown  ?? 10,
    stream_cooldown:  config.stream_cooldown  ?? 660,
    pet_cooldown:     config.pet_cooldown     ?? 1800,
        commands_enabled:  Object.assign({
        hunt: true, dig: true, search: true,
        beg: true, crime: true, hl: true, pm: true, adv: false,
        fish: false, daily: false, work: false, deposit: false,
        trivia: false, stream: false, pet: false,
                }, config.commands_enabled || {}),
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
                'hl_cooldown', 'pm_cooldown', 'wait_for_response',
                'search_risk', 'crime_risk', 'adv_cooldown', 'adv_type', 'fish_sell_currency', 'disable_interaction_lock',
                'limit_flags', 'stealth_mode', 'cycle_uptime_mins', 'cycle_downtime_mins',
                'market_sniper_enabled', 'market_sniper_cooldown',
                'daily_cooldown', 'work_cooldown', 'deposit_cooldown',
                'trivia_cooldown', 'stream_cooldown', 'pet_cooldown',
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
            if (fresh.market_sniper_items !== undefined) {
                _cfg.market_sniper_items = fresh.market_sniper_items;
            }
            if (fresh.search_custom_ranking !== undefined)
                _cfg.search_custom_ranking = Array.isArray(fresh.search_custom_ranking) ? fresh.search_custom_ranking : [];
            if (fresh.crime_custom_ranking !== undefined)
                _cfg.crime_custom_ranking  = Array.isArray(fresh.crime_custom_ranking)  ? fresh.crime_custom_ranking  : [];
            if (fresh.adv_response_mode !== undefined)
                _cfg.adv_response_mode = fresh.adv_response_mode;
            if (fresh.adv_custom_responses !== undefined && typeof fresh.adv_custom_responses === 'object')
                _cfg.adv_custom_responses = fresh.adv_custom_responses;
        } catch (e) {
            log('error', `Config reload failed: ${e.message}`);
        }
    }
}

// ── Helpers ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Browser fingerprint ──────────────────────────────────────
// ALWAYS ACTIVE — applied unconditionally at client init, independent of limit_flags.
// Matches a real Chrome 103 on Chrome OS session (captured from Discord web client).
const DISCORD_UA = 'Mozilla/5.0 (X11; CrOS x86_64 14816.131.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';

// x-super-properties: exact structure decoded from real Discord traffic.
// Identifies the client as a stable-channel Chrome browser, not a bot.
const _superPropsObj = {
    os:                       'Chrome OS',
    browser:                  'Chrome',
    device:                   '',
    system_locale:            'en-US',
    has_client_mods:          false,
    browser_user_agent:       DISCORD_UA,
    browser_version:          '103.0.0.0',
    os_version:               '',
    referrer:                 '',
    referring_domain:         '',
    referrer_current:         '',
    referring_domain_current: '',
    release_channel:          'stable',
    client_build_number:      409397,
    client_event_source:      null,
};
const SUPER_PROPS = Buffer.from(JSON.stringify(_superPropsObj)).toString('base64');

// x-installation-id: per-install stable random ID (snowflake-style).
// Generated once at process start and reused for the session lifetime.
const INSTALL_ID = `${Date.now()}${Math.floor(Math.random() * 1_000_000_000)}`;

const client = new Client({
    checkUpdate: false,
    ws: {
        // WS IDENTIFY payload properties — must match the HTTP User-Agent and super-props.
        properties: {
            $os:      'Chrome OS',
            $browser: 'Chrome',
            $device:  '',
        },
    },
    http: {
        // REST HTTP headers — replicate every header a real Chrome Discord session sends.
        headers: {
            'Accept':             '*/*',
            'Accept-Language':    'en-US,en;q=0.9',
            'Referer':            'https://discord.com/channels/@me',
            'Sec-CH-UA':          '".Not/A)Brand";v="99", "Google Chrome";v="103", "Chromium";v="103"',
            'Sec-CH-UA-Mobile':   '?0',
            'Sec-CH-UA-Platform': '"Chrome OS"',
            'Sec-Fetch-Dest':     'empty',
            'Sec-Fetch-Mode':     'cors',
            'Sec-Fetch-Site':     'same-origin',
            'User-Agent':         DISCORD_UA,
            'X-Debug-Options':    'bugReporterEnabled',
            'X-Discord-Locale':   'en-US',
            'X-Discord-Timezone': 'Asia/Manila',
            'X-Installation-Id':  INSTALL_ID,
            'X-Super-Properties': SUPER_PROPS,
        },
    },
});
const _interactionLock = new Mutex();
_interactionLock.lockFilePath = path.join(__dirname, `interaction_lock_${ACCOUNT_ID}.lock`);

// Wrapper: bypasses the mutex entirely when disable_interaction_lock is true
function runWithLock(fn) {
    if (_cfg.disable_interaction_lock) return fn();
    return _interactionLock.runExclusive(fn);
}

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
            for (let attempt = 0; attempt < 2; attempt++) {
                try { await message.clickButton(button.customId); return true; }
                catch (e) {
                    if (attempt === 0) { log('warn', `[RETRY] '${label}': ${e.message} — retrying in 2s`); await sleep(2000); }
                    else { log('warn', `Click '${label}': ${e.message}`); }
                }
            }
            return false;
        }
    }
    return false;
}

async function clickButtonPrefix(message, prefix) {
    const lower = prefix.toLowerCase();
    for (const button of getButtons(message)) {
        if ((button.label || '').toLowerCase().startsWith(lower)) {
            for (let attempt = 0; attempt < 2; attempt++) {
                try { await message.clickButton(button.customId); return button.label; }
                catch (e) {
                    if (attempt === 0) { log('warn', `[RETRY] prefix '${prefix}': ${e.message} — retrying in 2s`); await sleep(2000); }
                    else { log('warn', `Click prefix '${prefix}': ${e.message}`); }
                }
            }
            return null;
        }
    }
    return null;
}

function isPremiumCooldown(msg) {
    if (!msg) return false;
    for (const embed of (msg.embeds || [])) {
        if (/premium.*cooldown|cooldown is/i.test(embed.description || '')) return true;
    }
    return false;
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

// Buffer for replies that land between channel.send() returning and
// _pendingReplies.set() running (race window across an await boundary).
const _earlyReplies = new Map(); // sentMsgId -> Message

client.on('messageCreate', message => {
    if (String(message.channelId) !== CHANNEL_ID) return;
    if (String(message.author.id) !== BOT_ID)     return;
    if (!message.reference)                        return;

    const refId = String(message.reference.messageId);
    if (_pendingReplies.has(refId)) {
        const { resolve } = _pendingReplies.get(refId);
        _pendingReplies.delete(refId);
        resolve(message);
        return;
    }
    // Reply arrived before sendAndWait registered — park it briefly
    _earlyReplies.set(refId, message);
    setTimeout(() => _earlyReplies.delete(refId), 5000);
});

// ── Stealth mode presets ─────────────────────────────────────
// typingRate  : probability of firing a typing indicator (0–1)
// typingMin   : minimum typing delay in ms
// typingRange : added random range in ms  (actual = min + rand * range)
// variancePct : max additive cooldown variance as % of base
// biasPow     : exponent for random^n  (1 = uniform, 2 = biased low, 3 = heavily biased low)
const STEALTH_MODES = {
    strict:   { typingRate: 1.00, typingMin: 700, typingRange: 700, variancePct: 35, biasPow: 1.0 },
    moderate: { typingRate: 0.80, typingMin: 300, typingRange: 300, variancePct: 20, biasPow: 2.0 },
    casual:   { typingRate: 0.40, typingMin: 100, typingRange: 200, variancePct: 10, biasPow: 3.0 },
    fast:     { typingRate: 0.00, typingMin: 0,   typingRange: 0,   variancePct: 0,  biasPow: 2.0 },
};

// ── Limit Flags helpers ─────────────────────────────────────
let _botPaused = false;  // set by cycleLoop when in downtime
const PAUSED_FLAG = path.join(__dirname, `paused_${ACCOUNT_ID}.flag`);

function setPaused(paused) {
    _botPaused = paused;
    try {
        if (paused) fs.writeFileSync(PAUSED_FLAG, '1');
        else        fs.unlinkSync(PAUSED_FLAG);
    } catch {}
}

function _stealthMode() {
    return STEALTH_MODES[_cfg.stealth_mode] ?? STEALTH_MODES.moderate;
}

// Additive cooldown variance — distribution biased toward base by biasPow
function humanJitter(baseMs) {
    if (!_cfg.limit_flags) return baseMs;
    const m = _stealthMode();
    if (m.variancePct === 0) return baseMs;
    const maxExtra = Math.floor(baseMs * m.variancePct / 100);
    return baseMs + Math.floor((Math.random() ** m.biasPow) * maxExtra);
}

// Returns jitter-applied cooldown in ms for a given config key
function cd(key) {
    return humanJitter(_cfg[key] * 1000);
}

async function stealthSendDelay(channel) {
    if (!_cfg.limit_flags) return;
    const m = _stealthMode();
    let typed = false;
    if (m.typingRate > 0 && Math.random() < m.typingRate) {
        try { await channel.sendTyping(); typed = true; } catch {}
    }
    const delay = m.typingMin > 0 ? m.typingMin + Math.floor(Math.random() * m.typingRange) : 0;
    if (typed || delay > 0) {
        log('info', `[STEALTH] ${_cfg.stealth_mode} — ${typed ? 'typing' : 'no typing'}, delay ${delay}ms`);
    }
    if (delay > 0) await sleep(delay);
}

// Dummy for backward compat — cycle replaces the old per-command sleep
async function stealthExtraSleep() { }

async function sendAndWait(channel, command, timeoutSecs = null) {
    const ms = (timeoutSecs ?? _cfg.wait_for_response) * 1000;
    let resolve;
    const promise = new Promise(res => { resolve = res; });

    // Limit Flags: simulate typing before sending
    await stealthSendDelay(channel);

    // Send first so we have the actual Discord message ID to key on
    const sent = await channel.send(command);
    const sentId = String(sent.id);
    log('info', `Sent: ${command}`);
    _pendingReplies.set(sentId, { resolve, command });

    // Race-condition check: reply may have arrived in the await gap above and
    // been buffered by the messageCreate handler before we registered the key.
    if (_earlyReplies.has(sentId)) {
        const early = _earlyReplies.get(sentId);
        _earlyReplies.delete(sentId);
        _pendingReplies.delete(sentId);
        if (early) logMessage(early);
        return early;
    }

    // Raw fallback — discord.js occasionally drops messageCreate events under
    // load. Listening on the raw gateway packet catches what the high-level
    // emitter misses, matching the same pattern used by waitForEdit().
    async function rawFallback(packet) {
        if (packet.t !== 'MESSAGE_CREATE') return;
        if (String(packet.d.channel_id) !== String(CHANNEL_ID)) return;
        if (String(packet.d.author?.id)  !== String(BOT_ID))    return;
        // Guard: raw gateway may send message_id as string or number — normalise both
        const rawRefId = String(packet.d.message_reference?.message_id ?? '');
        if (!rawRefId || rawRefId !== sentId) return;
        try {
            const msg = await channel.messages.fetch(packet.d.id, { force: true });
            if (!_pendingReplies.has(sentId)) return; // messageCreate already resolved it
            const { resolve: res } = _pendingReplies.get(sentId);
            _pendingReplies.delete(sentId);
            res(msg);
        } catch {}
    }
    client.on('raw', rawFallback);

    const timer = setTimeout(() => {
        if (_pendingReplies.has(sentId)) {
            _pendingReplies.delete(sentId);
            log('warn', `No response for '${command}' within ${timeoutSecs ?? _cfg.wait_for_response}s`);
            resolve(null);
        }
        client.off('raw', rawFallback);
    }, ms);

    const response = await promise;
    clearTimeout(timer);
    client.off('raw', rawFallback); // clean up whether messageCreate or raw resolved it
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
    const rankings = (_cfg.search_risk === 'custom' && _cfg.search_custom_ranking.length)
        ? _cfg.search_custom_ranking
        : (SEARCH_RANKINGS_BY_MODE[_cfg.search_risk] ?? SEARCH_RANKINGS_MEDIUM);
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
    const rankings = (_cfg.crime_risk === 'custom' && _cfg.crime_custom_ranking.length)
        ? _cfg.crime_custom_ranking
        : (CRIME_RANKINGS_BY_MODE[_cfg.crime_risk] ?? CRIME_RANKINGS_MEDIUM);
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
function parseAdvCooldownFromEmbed(msg) {
    const embed = msg.embeds[0];
    if (!embed) return null;
    const text = [embed.description, embed.footer?.text, msg.content]
        .filter(Boolean).join(' ');
    if (!/start another adventure/i.test(text) && !/adventure.*cooldown/i.test(text)) return null;
    // Prefer Discord relative timestamp <t:UNIX:R>
    const tsMatch = text.match(/<t:(\d+):[RrtTdDfF]>/);
    if (tsMatch) {
        const secs = Math.round(parseInt(tsMatch[1]) - Date.now() / 1000);
        if (secs > 0) return secs;
    }
    // Fall back to "in N hours / N minutes / N seconds" text
    const m = text.match(/in\s+(?:(\d+)\s*hours?\s*)?(?:(\d+)\s*min(?:utes?)?\s*)?(?:(\d+)\s*sec(?:onds?)?)?/i);
    if (m && (m[1] || m[2] || m[3])) {
        return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + (parseInt(m[3] || 0));
    }
    return null;
}

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

        // In custom mode, check for a user-defined response override using the first keyword as ID
        let best = rule.best;
        if (_cfg.adv_response_mode === 'custom') {
            const customForAdv = (_cfg.adv_custom_responses || {})[advType] || {};
            const customChoice = customForAdv[rule.keywords[0]];
            if (customChoice) best = customChoice;
        }

        if (!best) return buttons[0];
        const found = buttons.find(b => (b.label || '').trim().toLowerCase() === best.toLowerCase());
        if (found) return found;
        // Fallback: partial match
        const partial = buttons.find(b => (b.label || '').trim().toLowerCase().includes(best.toLowerCase()));
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
    log('info', `Searching ${guilds.length} guild(s) for channel/thread ${channelId}...`);
    for (const guild of guilds) {
        log('info', `Checking guild "${guild.name}" (${guild.id})...`);
        try {
            const channels = await guild.channels.fetch();
            const ch = channels.get(channelId);
            if (ch) { log('info', `Found channel "${ch.name}" in guild "${guild.name}"`); return ch; }
        } catch (e) {
            log('warn', `guild.channels.fetch() failed for "${guild.name}": ${e.message}`);
        }
        // Also search active threads (not returned by guild.channels.fetch)
        try {
            const { threads } = await guild.channels.fetchActiveThreads();
            const th = threads.get(channelId);
            if (th) { log('info', `Found thread "${th.name}" in guild "${guild.name}"`); return th; }
        } catch (e) {
            log('warn', `fetchActiveThreads() failed for "${guild.name}": ${e.message}`);
        }
    }

    // Direct REST fetch — works for both channels and threads
    try {
        return await client.channels.fetch(channelId, { force: true });
    } catch (e) {
        throw new Error(`Channel/thread ${channelId} not found in any of ${guilds.length} guild(s). Original error: ${e.message}`);
    }
}

// Clear any stale paused flag from a previous crashed session
try { fs.unlinkSync(PAUSED_FLAG); } catch {}

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

    // ── Referer: point to exact channel URL now that guild is known ──
    const guildId = channel.guildId ?? channel.guild?.id ?? '@me';
    const exactReferer = `https://discord.com/channels/${guildId}/${CHANNEL_ID}`;
    client.options.http.headers['Referer'] = exactReferer;
    log('info', `[HEADERS] Referer updated → ${exactReferer}`);

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

    // ── Fishing helpers ─────────────────────────────────────
    function findButtonDeep(components, labelSubstr) {
        const lower = labelSubstr.toLowerCase();
        for (const c of (components || [])) {
            if (c.type === 'BUTTON' && (c.label || '').toLowerCase().includes(lower)) return c;
            if (Array.isArray(c.components)) {
                const found = findButtonDeep(c.components, labelSubstr);
                if (found) return found;
            }
            if (c.accessory) {
                const found = findButtonDeep([c.accessory], labelSubstr);
                if (found) return found;
            }
        }
        return null;
    }

    function findAllButtonsDeep(components, labelSubstr) {
        const lower = labelSubstr.toLowerCase();
        const results = [];
        for (const c of (components || [])) {
            if (c.type === 'BUTTON' && (c.label || '').toLowerCase().includes(lower)) results.push(c);
            if (Array.isArray(c.components)) results.push(...findAllButtonsDeep(c.components, labelSubstr));
            if (c.accessory) results.push(...findAllButtonsDeep([c.accessory], labelSubstr));
        }
        return results;
    }

    function extractTextDeep(components) {
        let text = '';
        for (const c of (components || [])) {
            // Components V2 text fields — discord.js may map these differently
            for (const key of ['content', 'description', 'label', 'text', 'value', 'title', 'placeholder']) {
                if (typeof c[key] === 'string') text += ' ' + c[key];
            }
            if (Array.isArray(c.components)) text += extractTextDeep(c.components);
            if (c.accessory) text += extractTextDeep([c.accessory]);
            if (c.fields) for (const f of c.fields) text += ' ' + (f.name || '') + ' ' + (f.value || '');
        }
        return text;
    }

    function isBucketFull(components) {
        const text = extractTextDeep(components);
        if (/no more bucket space/i.test(text)) return true;
        // ` 10 / 10 ` <emojis> Bucket Space — numbers may be separated from label by emoji codes
        const m = text.match(/(\d+)\s*\/\s*(\d+)[^]*?Bucket\s*Space/i);
        if (m && parseInt(m[1]) >= parseInt(m[2])) return true;
        return false;
    }

    function waitForEdit(messageId, timeout = 45000) {
        return new Promise((resolve, reject) => {
            let done = false;
            const t = setTimeout(() => {
                if (done) return;
                done = true;
                client.off('messageUpdate', muHandler);
                client.off('raw', rawHandler);
                reject(new Error('Edit timeout'));
            }, timeout);

            function finish(msg) {
                if (done) return;
                done = true;
                clearTimeout(t);
                client.off('messageUpdate', muHandler);
                client.off('raw', rawHandler);
                resolve(msg);
            }

            function muHandler(oldMsg, newMsg) {
                if (String(newMsg.id) !== String(messageId)) return;
                finish(newMsg);
            }

            async function rawHandler(packet) {
                if (packet.t !== 'MESSAGE_UPDATE') return;
                if (String(packet.d.id) !== String(messageId)) return;
                if (!packet.d.components && !packet.d.attachments) return;
                try {
                    const msg = await channel.messages.fetch(messageId, { force: true });
                    // Preserve raw attachment data in case discord.js doesn't map it
                    if (packet.d.attachments?.length) {
                        msg._rawAttachments = packet.d.attachments;
                    }
                    finish(msg);
                } catch {}
            }

            client.on('messageUpdate', muHandler);
            client.on('raw', rawHandler);
        });
    }

    function waitForReply(messageId, timeout = 20000) {
        return new Promise((resolve, reject) => {
            let done = false;
            const t = setTimeout(() => {
                if (done) return;
                done = true;
                _pendingReplies.delete(messageId);
                reject(new Error('Reply timeout'));
            }, timeout);
            _pendingReplies.set(messageId, {
                resolve: (msg) => {
                    if (done) return;
                    done = true;
                    clearTimeout(t);
                    resolve(msg);
                },
                command: 'waitForReply'
            });
        });
    }

    // Wait for a bot message in the channel that contains an Offer ID
    function waitForMarketOfferMessage(timeout = 15000) {
        return new Promise((resolve, reject) => {
            let done = false;
            const t = setTimeout(() => {
                if (done) return;
                done = true;
                client.removeListener('raw', handler);
                reject(new Error('Timeout waiting for market offer ID message'));
            }, timeout);
            function handler(packet) {
                if (packet.t !== 'MESSAGE_CREATE') return;
                if (String(packet.d.channel_id) !== String(CHANNEL_ID)) return;
                if (String(packet.d.author?.id) !== String(BOT_ID)) return;
                // Only resolve if this looks like an offer ID confirmation
                if (!/offer\s+id/i.test(JSON.stringify(packet.d))) return;
                if (done) return;
                done = true;
                clearTimeout(t);
                client.removeListener('raw', handler);
                resolve(packet.d);
            }
            client.on('raw', handler);
        });
    }

    // Extract offer ID from "Offer ID: **<id>**." — strips trailing period
    function parseMarketOfferId(text) {
        const m = text.match(/[Oo]ffer\s+ID[:\s*]+\*\*([^*.]+)\*\*/);
        return m ? m[1].trim() : null;
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

    // ── Market-post transfer (support vessel side) ───────────
    async function transferItemsViaMarket(mothership_name) {
        let iterations = 0;
        while (iterations < 15) {
            iterations++;
            writeTransferStatus('Checking inventory...');
            const invMsg = await sendAndWait(channel, 'pls inv', 15);
            if (!invMsg) { writeTransferStatus('No inventory response', true); return; }

            const items = parseInventoryItems(invMsg);
            if (items.length === 0) {
                writeTransferStatus('All transferable items posted to market!', true);
                return;
            }

            for (const item of items) {
                writeTransferStatus(`Posting ${item.qty}x ${item.name} to private market...`);

                // Step 1: post the private market listing
                const cmd = `pls market post for_coins sell ${item.qty} ${item.name} 1 1 false true`;
                const postMsg = await sendAndWait(channel, cmd, 15);
                if (!postMsg) {
                    log('warn', `[TRANSFER] No response to market post for ${item.name}`);
                    await sleep(2000); continue;
                }

                // Step 2: find Confirm button — register listener BEFORE click to avoid race
                const confirmBtn = findButtonDeep(postMsg.components, 'Confirm')
                                || findConfirmButton(postMsg.components || []);
                if (!confirmBtn) {
                    log('warn', `[TRANSFER] No Confirm button for market post of ${item.name}`);
                    await sleep(2000); continue;
                }

                const offerMsgPromise = waitForMarketOfferMessage(15000);
                try {
                    await postMsg.clickButton(confirmBtn.customId || confirmBtn.custom_id);
                    log('info', `[TRANSFER] Clicked Confirm for ${item.qty}x ${item.name}`);
                } catch (e) {
                    log('warn', `[TRANSFER] Confirm click failed for ${item.name}: ${e.message}`);
                    await sleep(2000); continue;
                }

                // Step 3: wait for the offer ID message
                let offerRaw;
                try { offerRaw = await offerMsgPromise; } catch {
                    log('warn', `[TRANSFER] No offer ID message received for ${item.name}`);
                    await sleep(2000); continue;
                }

                // Step 4: parse offer ID
                const rawText = [
                    offerRaw.content || '',
                    ...extractAllText(offerRaw.components || []),
                    ...(offerRaw.embeds || []).map(e =>
                        (e.description || '') + ' ' + (e.fields || []).map(f => f.value).join(' ')),
                ].join(' ');

                const offerId = parseMarketOfferId(rawText);
                if (!offerId) {
                    log('warn', `[TRANSFER] Could not parse offer ID from: ${rawText.slice(0, 300)}`);
                    await sleep(2000); continue;
                }

                log('info', `[TRANSFER] Offer ID for ${item.name}: ${offerId}`);
                writeTransferStatus(`Posted ${item.qty}x ${item.name} (ID: ${offerId}) — waiting for ${mothership_name}...`);

                // Step 5: write pending file for the mothership to pick up
                const pendingPath = path.join(__dirname, `market_pending_${ACCOUNT_ID}.json`);
                fs.writeFileSync(pendingPath, JSON.stringify({
                    offer_id: offerId, item: item.name, qty: item.qty, ts: Date.now(),
                }));

                // Step 6: wait up to 45s for mothership to accept (it deletes the file)
                const deadline = Date.now() + 45000;
                while (Date.now() < deadline && fs.existsSync(pendingPath)) {
                    await sleep(2000);
                }
                if (fs.existsSync(pendingPath)) {
                    log('warn', `[TRANSFER] Mothership did not accept ${item.name} within 45s — continuing`);
                    try { fs.unlinkSync(pendingPath); } catch {}
                } else {
                    log('info', `[TRANSFER] Mothership accepted ${item.name}`);
                }

                await sleep(1500);
            }
            await sleep(400);
        }
        writeTransferStatus('Market item transfer complete.', true);
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
                try {
                    await runWithLock(async () => {
                        let iterations = 0;
                        let finished = false;
                        while (iterations < 15) {
                            iterations++;
                            writeTransferStatus('Checking inventory...');
                            const invMsg = await sendAndWait(channel, 'pls inv', 15);
                            if (!invMsg) { writeTransferStatus('No inventory response', true); finished = true; break; }

                            const items = parseInventoryItems(invMsg);
                            if (items.length === 0) {
                                writeTransferStatus('All transferable items sent to mothership!', true);
                                finished = true;
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
                        if (!finished) writeTransferStatus('Item transfer complete.', true);
                    });
                } catch (e) {
                    writeTransferStatus(`Transfer error: ${e.message}`, true);
                }
            } else if (type === 'market_items') {
                try {
                    await runWithLock(() => transferItemsViaMarket(mothership_name));
                } catch (e) {
                    writeTransferStatus(`Transfer error: ${e.message}`, true);
                }
            } else if (type === 'market_coins') {
                try {
                    await runWithLock(() => transferCoinsViaMarket(mothership_name));
                } catch (e) {
                    writeTransferStatus(`Transfer error: ${e.message}`, true);
                }
            } else if (type === 'coins') {
                try {
                    await runWithLock(async () => {
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
                } catch (e) {
                    writeTransferStatus(`Transfer error: ${e.message}`, true);
                }
            }
        }
    }

    // ── Market-post transfer (support vessel, coins side) ───────────────────
    async function transferCoinsViaMarket(mothership_name) {
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
            writeTransferStatus('No coins in wallet to transfer via market', true);
            return;
        }

        const tax        = Math.floor(wallet * 0.005);
        const toSend     = wallet - tax;

        writeTransferStatus(`Posting market buy order for ⏣${toSend.toLocaleString()} (wallet ⏣${wallet.toLocaleString()}, tax ⏣${tax.toLocaleString()})...`);

        const cmd = `pls market post for_coins buy 1 ant ${toSend} 1 false true`;
        const postMsg = await sendAndWait(channel, cmd, 15);
        if (!postMsg) {
            writeTransferStatus('No response to market post for coins', true);
            return;
        }

        const confirmBtn = findButtonDeep(postMsg.components, 'Confirm')
                        || findConfirmButton(postMsg.components || []);
        if (!confirmBtn) {
            writeTransferStatus('No Confirm button for coins market post', true);
            return;
        }

        const offerMsgPromise = waitForMarketOfferMessage(15000);
        try {
            await postMsg.clickButton(confirmBtn.customId || confirmBtn.custom_id);
            log('info', `[TRANSFER] Clicked Confirm for coins market post (⏣${toSend.toLocaleString()})`);
        } catch (e) {
            writeTransferStatus(`Confirm click failed for coins post: ${e.message}`, true);
            return;
        }

        let offerRaw;
        try { offerRaw = await offerMsgPromise; } catch {
            writeTransferStatus('No offer ID message received for coins market post', true);
            return;
        }

        const rawText = [
            offerRaw.content || '',
            ...extractAllText(offerRaw.components || []),
            ...(offerRaw.embeds || []).map(e =>
                (e.description || '') + ' ' + (e.fields || []).map(f => f.value).join(' ')),
        ].join(' ');

        const offerId = parseMarketOfferId(rawText);
        if (!offerId) {
            log('warn', `[TRANSFER] Could not parse offer ID from coins post: ${rawText.slice(0, 300)}`);
            writeTransferStatus('Could not parse offer ID for coins market post', true);
            return;
        }

        log('info', `[TRANSFER] Coins market offer ID: ${offerId}`);
        writeTransferStatus(`Posted coins offer (ID: ${offerId}) — waiting for ${mothership_name}...`);

        const pendingPath = path.join(__dirname, `market_pending_coins_${ACCOUNT_ID}.json`);
        fs.writeFileSync(pendingPath, JSON.stringify({
            offer_id: offerId, item: 'coins', qty: toSend, ts: Date.now(),
        }));

        const deadline = Date.now() + 45000;
        while (Date.now() < deadline && fs.existsSync(pendingPath)) {
            await sleep(2000);
        }
        if (fs.existsSync(pendingPath)) {
            log('warn', `[TRANSFER] Mothership did not accept coins offer within 45s`);
            try { fs.unlinkSync(pendingPath); } catch {}
        } else {
            writeTransferStatus(`Done! Mothership accepted coins offer (ID: ${offerId})`, true);
            log('info', `[TRANSFER] Mothership accepted coins market offer ${offerId}`);
        }
    }

    // ── Mothership market acceptance loop ────────────────────
    // Polls for market_pending_<vessel_id>.json files written by support vessels,
    // accepts the offer, confirms, then deletes the file to unblock the vessel.
    async function mothershipMarketLoop() {
        await sleep(8000);
        while (true) {
            await sleep(2000);

            // Only the mothership account runs this
            let rawCfg;
            try { rawCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { continue; }
            if (rawCfg.mothership_id !== ACCOUNT_ID) continue;

            // Find pending offer files from any support vessel
            let pendingFiles;
            try {
                pendingFiles = fs.readdirSync(__dirname)
                    .filter(f => f.startsWith('market_pending_') && f.endsWith('.json'));
            } catch { continue; }

            if (pendingFiles.length === 0) continue;

            for (const filename of pendingFiles) {
                const pendingPath = path.join(__dirname, filename);
                let pending;
                try { pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')); } catch { continue; }

                const { offer_id, item, qty } = pending;
                log('info', `[MOTHERSHIP] Waiting 30s before accepting offer ${offer_id} for ${qty}x ${item}...`);

                // Buffer: Dank Memer shows "You cannot accept this offer just yet" if accepted too quickly
                await sleep(30000);

                log('info', `[MOTHERSHIP] Accepting market offer ${offer_id} for ${qty}x ${item}`);

                // Accept the offer
                const acceptMsg = await sendAndWait(channel, `pls market accept ${offer_id}`, 15);
                if (!acceptMsg) {
                    log('warn', `[MOTHERSHIP] No response to market accept ${offer_id}`);
                    continue;
                }

                // Click Confirm (Components V2 aware)
                const confirmBtn = findButtonDeep(acceptMsg.components, 'Confirm')
                                || findConfirmButton(acceptMsg.components || []);
                if (confirmBtn) {
                    try {
                        await acceptMsg.clickButton(confirmBtn.customId || confirmBtn.custom_id);
                        log('info', `[MOTHERSHIP] Confirmed accept of offer ${offer_id}`);
                    } catch (e) {
                        log('warn', `[MOTHERSHIP] Confirm click failed for ${offer_id}: ${e.message}`);
                    }
                } else {
                    log('warn', `[MOTHERSHIP] No Confirm button for market accept ${offer_id}`);
                }

                await sleep(1500);

                // Delete the pending file — this signals the support vessel to continue
                try { fs.unlinkSync(pendingPath); } catch {}
                log('info', `[MOTHERSHIP] Cleared pending offer ${offer_id}`);

                await sleep(1000);
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

    // ── Uptime / Downtime cycle ──────────────────────────────
    // Polls every 5 s so config changes (disable, duration edits) take effect
    // within one polling tick instead of waiting for a full sleep to expire.
    async function cycleLoop() {
        while (true) {
            const up   = _cfg.cycle_uptime_mins;
            const down = _cfg.cycle_downtime_mins;

            // Cycle disabled — keep bot unpaused and re-check shortly
            if (!_cfg.limit_flags || !up || !down) {
                if (_botPaused) setPaused(false);
                await sleep(5000);
                continue;
            }

            // === UPTIME ===
            // Unpause immediately — no 5 s gap at the top of the loop
            setPaused(false);
            log('info', `[CYCLE] Uptime started — active for ${up}min`);
            const uptimeEnd = Date.now() + up * 60000;
            while (Date.now() < uptimeEnd) {
                await sleep(5000);
                // Cycle disabled mid-uptime — exit early, skip downtime
                if (!_cfg.limit_flags || !_cfg.cycle_uptime_mins || !_cfg.cycle_downtime_mins) break;
            }

            // Re-check: if cycle was turned off during uptime, stay unpaused
            if (!_cfg.limit_flags || !_cfg.cycle_uptime_mins || !_cfg.cycle_downtime_mins) {
                if (_botPaused) setPaused(false);
                continue;
            }

            // === DOWNTIME ===
            setPaused(true);
            const downMins = _cfg.cycle_downtime_mins;
            log('info', `[CYCLE] Downtime started — resting for ${downMins}min`);
            const downtimeEnd = Date.now() + downMins * 60000;
            while (Date.now() < downtimeEnd) {
                await sleep(5000);
                // Cycle disabled mid-downtime — unpause immediately
                if (!_cfg.limit_flags || !_cfg.cycle_uptime_mins || !_cfg.cycle_downtime_mins) {
                    setPaused(false);
                    break;
                }
            }
            // Loop continues straight into next uptime — no extra sleep gap
        }
    }

    async function begLoop() {
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled.beg) {
                await runWithLock(async () => {
                    await sendAndWait(channel, 'pls beg');
                });
            }
            await sleep(cd('beg_cooldown'));
        }
    }

    async function searchLoop() {
        await sleep(3000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled.search) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls search');
                    if (res) {
                        if (isPremiumCooldown(res)) { log('warn', '[SEARCH] Premium cooldown — skipping'); return; }
                        const btns   = getButtons(res);
                        const target = btns.length ? (pickBestSearchButton(btns) || btns[0]) : null;
                        if (target) {
                            log('info', `[SEARCH] Clicking '${target.label}'`);
                            const ok = await clickButton(res, target.label);
                            log(ok ? 'info' : 'warn', ok ? `[SEARCH] ✓ Clicked '${target.label}'` : `[SEARCH] ✗ Failed to click '${target.label}'`);
                        }
                    }
                });
            }
            await sleep(cd('search_cooldown'));
        }
    }

    async function digLoop() {
        await sleep(6000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled.dig) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls dig');
                    if (res) {
                        if (isPremiumCooldown(res)) { log('warn', '[DIG] Premium cooldown — skipping'); return; }
                        const desc = res.embeds[0]?.description || '';
                        if (desc.includes('Dodge the Moleman'))     await handleDodge(res, 'Worm',     'MOLEMAN');
                        else if (desc.includes('Dodge the Sludge')) await handleDodge(res, 'PinkBits', 'SLUDGE');
                    }
                });
            }
            await sleep(cd('cooldown'));
        }
    }

    async function huntLoop() {
        await sleep(9000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled.hunt) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls hunt');
                    if (res) {
                        if (isPremiumCooldown(res)) { log('warn', '[HUNT] Premium cooldown — skipping'); return; }
                        const desc = res.embeds[0]?.description || '';
                        if (desc.includes('Dodge the Dragon')) await handleDodge(res, 'FireBall', 'FIREBALL');
                    }
                });
            }
            await sleep(cd('cooldown'));
        }
    }

    async function crimeLoop() {
        await sleep(12000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled.crime) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls crime');
                    if (res) {
                        if (isPremiumCooldown(res)) { log('warn', '[CRIME] Premium cooldown — skipping'); return; }
                        const btns   = getButtons(res);
                        const target = btns.length ? (pickBestCrimeButton(btns) || btns[0]) : null;
                        if (target) {
                            log('info', `[CRIME] Clicking '${target.label}'`);
                            const ok = await clickButton(res, target.label);
                            log(ok ? 'info' : 'warn', ok ? `[CRIME] ✓ Clicked '${target.label}'` : `[CRIME] ✗ Failed to click '${target.label}'`);
                        }
                    }
                });
            }
            await sleep(cd('crime_cooldown'));
        }
    }

    async function hlLoop() {
        await sleep(15000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled.hl) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls hl', _cfg.wait_for_response);
                    if (res) {
                        if (isPremiumCooldown(res)) { log('warn', '[HL] Premium cooldown — skipping'); return; }
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
            await sleep(cd('hl_cooldown'));
        }
    }

    async function pmLoop() {
        await sleep(18000);
        const PM_PLATFORMS = ['TikTok', 'Discord', 'Reddit', 'Twitter', 'Facebook'];
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            let pmCooldown = _cfg.pm_cooldown;
            if (_cfg.commands_enabled.pm) {
                const platform = PM_PLATFORMS[Math.floor(Math.random() * PM_PLATFORMS.length)];
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls pm');
                    if (res) {
                        if (isPremiumCooldown(res)) { log('warn', '[PM] Premium cooldown — skipping'); return; }
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
            if (_botPaused) { await sleep(5000); continue; }
            if (!_cfg.commands_enabled.adv) {
                await sleep(10000);
                continue;
            }
            let advCooldown = _cfg.adv_cooldown;
            await runWithLock(async () => {
                    const advType = _cfg.adv_type;
                    log('info', `[ADV] Starting adventure: "${advType}"`);

                    // Step 1: send pls adv and wait for bot reply
                    const res = await sendAndWait(channel, 'pls adv', 15);
                    if (!res) { log('warn', '[ADV] No response to pls adv'); return; }

                    // Step 1b: detect cooldown message — "You can start another adventure in N minutes"
                    const cooldownSecs = parseAdvCooldownFromEmbed(res);
                    if (cooldownSecs !== null) {
                        advCooldown = cooldownSecs + 10;
                        log('info', `[ADV] Adventure on cooldown — waiting ${Math.round(advCooldown / 60)}min ${advCooldown % 60}s`);
                        return;
                    }

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
                        nextWait = 150; // default — reset each iteration

                        try {
                            msg = await channel.messages.fetch(res.id);
                        } catch (e) {
                            log('warn', `[ADV] Fetch failed: ${e.message}`);
                            break;
                        }

                        try {
                            const embed      = msg.embeds[0];
                            const allButtons = getButtons(msg);
                            // Never attempt to click a disabled button — filter first
                            const buttons    = allButtons.filter(b => !b.disabled);

                            if (!embed) {
                                consecutiveFails++;
                                if (consecutiveFails > 3) { log('warn', '[ADV] No embed 3× in a row — aborting'); break; }
                                continue;
                            }
                            consecutiveFails = 0;

                            const embedTitle = (embed.title || '').toLowerCase();
                            const embedDesc  = embed.description || '';
                            const embedDescL = embedDesc.toLowerCase();

                            // Detect adventure end (check allButtons so disabled end-btn is still detected)
                            const endBtn  = allButtons.find(b =>
                                (b.label || '').toLowerCase().includes('adventure again')
                            );
                            const hasSkip = allButtons.some(isSkipButton);
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

                            // All buttons disabled — mid-transition, re-fetch quickly
                            if (!buttons.length) {
                                continue;
                            }

                            const skipBtn       = buttons.find(isSkipButton);
                            const choiceButtons = buttons.filter(b => !isSkipButton(b) && !isUtilityButton(b));

                            // Already answered — wait for enabled skip to advance past result screen
                            if (embedDesc === lastClickedDesc) {
                                if (skipBtn) {
                                    try {
                                        await msg.clickButton(skipBtn.customId);
                                        log('info', '[ADV] ✓ → advanced past result');
                                        lastClickedDesc = null;
                                    } catch (e) { log('warn', `[ADV] Advance skip failed: ${e.message}`); }
                                }
                                // skip not enabled yet — loop will re-fetch immediately
                                continue;
                            }

                            // Pick and click best enabled button
                            const bestBtn = choiceButtons.length
                                ? pickAdventureChoice(advType, embedDesc, choiceButtons)
                                : skipBtn;

                            if (!bestBtn) { continue; }

                            if (!isSkipButton(bestBtn)) {
                                log('info', `[ADV] Clicking '${btnName(bestBtn)}'`);
                                try {
                                    await msg.clickButton(bestBtn.customId);
                                    log('info', `[ADV] ✓ Clicked '${btnName(bestBtn)}'`);
                                    lastClickedDesc = embedDesc;
                                } catch (e) {
                                    log('warn', `[ADV] Click failed: ${e.message}`);
                                }
                            } else {
                                log('info', `[ADV] Clicking skip '${btnName(bestBtn)}'`);
                                try {
                                    await msg.clickButton(bestBtn.customId);
                                    log('info', '[ADV] ✓ Skipped');
                                    lastClickedDesc = null;
                                } catch (e) {
                                    log('warn', `[ADV] Skip failed: ${e.message}`);
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
            await sleep(advCooldown * 1000);
        }
    }

    // ── Fishing loop ─────────────────────────────────────────
    async function fishLoop() {
        await sleep(7000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (!_cfg.commands_enabled?.fish) { await sleep(5000); continue; }

            await _interactionLock.runExclusive(async () => {
                log('info', '[FISH] Fishing started');

                // Step 1: send pls fish catch
                const res = await sendAndWait(channel, 'pls fish catch', 15);
                if (!res) { log('warn', '[FISH] No response to pls fish catch'); return; }
                if (isPremiumCooldown(res)) { log('warn', '[FISH] Premium cooldown — skipping'); return; }

                // Step 2: find "Go Fishing" button (Components V2 aware)
                const goBtn = findButtonDeep(res.components, 'Go Fishing');
                if (!goBtn) { log('warn', '[FISH] No "Go Fishing" button found'); return; }

                // Step 3: register edit listener BEFORE clicking to avoid race
                let editPromise = waitForEdit(res.id, 30000);
                try {
                    await res.clickButton(goBtn.customId);
                    log('info', '[FISH] Go Fishing clicked');
                } catch (e) {
                    log('warn', `[FISH] Go Fishing click failed: ${e.message}`);
                    return;
                }

                // Step 4: await the edited fishing grid message
                let fishMsg;
                try {
                    fishMsg = await editPromise;
                } catch {
                    log('warn', '[FISH] Timed out waiting for fishing grid');
                    return;
                }

                // Step 5: inner loop — Catch fish, use Fish Again, sell bucket when full
                while (_cfg.commands_enabled?.fish) {

                    // ── Bucket full? Sell before continuing ──────────────────
                    // Detect fullness via "n / n Bucket Space" text or ⚠️ warning emoji
                    const openBucketsBtn = findButtonDeep(fishMsg.components, 'Open Buckets');
                    if (openBucketsBtn && isBucketFull(fishMsg.components)) {
                        log('info', `[FISH] Bucket full — text: ${extractTextDeep(fishMsg.components).replace(/\s+/g, ' ').slice(0, 200)}`);
                        log('info', '[FISH] Bucket at capacity — opening buckets to sell');
                        const bucketsReplyPromise = waitForReply(fishMsg.id, 8000);
                        try {
                            await fishMsg.clickButton(openBucketsBtn.customId);
                        } catch (e) {
                            log('warn', `[FISH] Open Buckets click failed: ${e.message}`);
                            break;
                        }
                        let bucketsMsg;
                        try {
                            bucketsMsg = await bucketsReplyPromise;
                        } catch {
                            log('warn', '[FISH] Timed out waiting for buckets view');
                            break;
                        }

                        const sellAllBtn = findButtonDeep(bucketsMsg.components, 'Sell All Fish');
                        if (!sellAllBtn) { log('warn', '[FISH] No "Sell All Fish" button'); break; }

                        // Sell All Fish may edit bucketsMsg OR send a new reply — race both
                        const sellEditPromise = waitForEdit(bucketsMsg.id, 8000);
                        const sellReplyPromise = waitForReply(bucketsMsg.id, 8000);
                        try {
                            await bucketsMsg.clickButton(sellAllBtn.customId);
                        } catch (e) {
                            log('warn', `[FISH] Sell All Fish click failed: ${e.message}`);
                            break;
                        }
                        let sellMsg;
                        try {
                            sellMsg = await Promise.race([sellEditPromise, sellReplyPromise]);
                        } catch {
                            log('warn', `[FISH] Timed out waiting for sell options — bucketsMsg components: ${JSON.stringify(bucketsMsg.components || []).slice(0, 400)}`);
                            break;
                        }

                        log('info', `[FISH] Sell options received — components: ${JSON.stringify(sellMsg.components || []).slice(0, 400)}`);

                        // Pick Coins or Tokens based on config
                        const currency   = _cfg.fish_sell_currency === 'tokens' ? 'tokens' : 'coins';
                        log('info', `[FISH] fish_sell_currency cfg="${_cfg.fish_sell_currency}" → selling for ${currency}`);

                        // Match button by customId suffix (:coins / :tokens) — more reliable than label text
                        function findSellBtn(components, want) {
                            for (const c of (components || [])) {
                                if (c.type === 'BUTTON' && c.customId && c.customId.endsWith(':' + want)) return c;
                                if (Array.isArray(c.components)) { const f = findSellBtn(c.components, want); if (f) return f; }
                            }
                            return null;
                        }
                        const sellBtn = findSellBtn(sellMsg.components, currency);
                        if (!sellBtn) {
                            log('warn', `[FISH] No sell button found for currency "${currency}" — available: ${JSON.stringify(sellMsg.components || []).slice(0, 400)}`);
                            break;
                        }
                        try {
                            await sellMsg.clickButton(sellBtn.customId);
                            log('info', `[FISH] Sold fish for ${currency}`);
                            log('info', '[FISH:SELL]');
                        } catch (e) {
                            log('warn', `[FISH] Sell click failed: ${e.message}`);
                        }
                        // Bucket emptied — restart from pls fish catch
                        break;
                    }

                    // ── No Catch buttons yet — wait 15s then Fish Again ──────
                    const catchBtns = findAllButtonsDeep(fishMsg.components, 'Catch');

                    if (catchBtns.length === 0) {
                        log('info', '[FISH] No fish visible — waiting 15s');
                        await sleep(15000);
                        if (!_cfg.commands_enabled?.fish) break;

                        const fishAgainBtn = findButtonDeep(fishMsg.components, 'Fish Again');
                        if (!fishAgainBtn) { log('warn', '[FISH] No "Fish Again" button'); break; }

                        editPromise = waitForEdit(fishMsg.id, 30000);
                        try {
                            await fishMsg.clickButton(fishAgainBtn.customId);
                        } catch (e) {
                            log('warn', `[FISH] Fish Again click failed: ${e.message}`);
                            break;
                        }
                        try {
                            fishMsg = await editPromise;
                        } catch {
                            log('warn', '[FISH] Timed out waiting for fishing grid update');
                            break;
                        }
                        continue;
                    }

                    // Catch buttons found — get image and detect fish
                    // Try multiple sources: standard attachments, embeds, Components V2 media
                    function extractImageUrl(msg) {
                        // 1. Standard message attachment
                        const att = msg.attachments?.first?.();
                        if (att?.url)      return att.url;
                        if (att?.proxyURL) return att.proxyURL;

                        // 2. Embed image or thumbnail
                        for (const embed of (msg.embeds || [])) {
                            if (embed.image?.url)     return embed.image.url;
                            if (embed.thumbnail?.url) return embed.thumbnail.url;
                        }

                        // 3. Components V2 — recurse component tree
                        // Convert to plain JSON first — discord.js wrapper objects hide properties like .items/.media
                        function searchComponents(comps) {
                            for (const c of (comps || [])) {
                                // items[].media.url — used by type 11 (Media Gallery) AND type 12 in Dank Memer
                                if (Array.isArray(c.items)) {
                                    for (const item of c.items) {
                                        const u = item.media?.url || item.media?.proxy_url;
                                        if (u) return u;
                                    }
                                }
                                // Standard file property (type 12 File component)
                                if (c.file?.url || c.file?.proxy_url) {
                                    return c.file.url || c.file.proxy_url;
                                }
                                // Accessory (type 9 Section)
                                if (c.accessory) {
                                    const u = c.accessory?.media?.url || c.accessory?.url || c.accessory?.proxy_url;
                                    if (u) return u;
                                }
                                // Recurse nested components
                                if (Array.isArray(c.components)) {
                                    const found = searchComponents(c.components);
                                    if (found) return found;
                                }
                            }
                            return null;
                        }
                        // Serialize to plain JSON so all properties are directly accessible
                        let plainComps;
                        try { plainComps = JSON.parse(JSON.stringify(msg.components || [])); } catch { plainComps = []; }
                        const fromComps = searchComponents(plainComps);
                        if (fromComps) return fromComps;

                        // 4. Raw _rawAttachments set by waitForEdit rawHandler
                        const rawAtts = msg._rawAttachments;
                        if (rawAtts?.length) {
                            return rawAtts[0].url || rawAtts[0].proxy_url;
                        }

                        return null;
                    }

                    let imgUrl = extractImageUrl(fishMsg);

                    // If still nothing, log full component structure for debugging
                    if (!imgUrl) {
                        log('warn', `[FISH] No image found — attachments:${fishMsg.attachments?.size ?? 0} embeds:${fishMsg.embeds?.length ?? 0} components:${JSON.stringify(fishMsg.components || []).slice(0, 300)}`);
                        break;
                    }

                    let fishCell;
                    try {
                        fishCell = await detectFish(imgUrl);
                    } catch (e) {
                        log('warn', `[FISH] Image detection failed: ${e.message}`);
                        break;
                    }

                    log('info', `[FISH] Fish detected at Row ${fishCell.row + 1} Col ${fishCell.col + 1}`);

                    const targetBtn = catchBtns[fishCell.index];
                    if (!targetBtn) {
                        log('warn', `[FISH] No Catch button at grid index ${fishCell.index} (only ${catchBtns.length} buttons)`);
                        break;
                    }

                    editPromise = waitForEdit(fishMsg.id, 20000);
                    try {
                        await fishMsg.clickButton(targetBtn.customId);
                    } catch (e) {
                        log('warn', `[FISH] Catch click failed: ${e.message}`);
                        break;
                    }
                    try {
                        fishMsg = await editPromise;
                        log('info', '[FISH] Fish caught — waiting 15s before next cast');
                        // Log fish name for dashboard stats
                        const _catchText = extractTextDeep(fishMsg.components);
                        const _nameMatch = _catchText.match(/You caught (?:a |an )?(.+?)\./i);
                        if (_nameMatch) log('info', `[FISH:CATCH] ${_nameMatch[1].trim()}`);
                    } catch {
                        log('warn', '[FISH] No edit after catch — restarting');
                        break;
                    }
                    // Continue inner loop: "no Catch buttons" branch will wait 15s then click Fish Again
                }
            });

            await sleep(5000);
        }
    }

    async function heartbeatLoop() {
        while (true) {
            await sleep(30000);
            log('info', '♥ heartbeat');
        }
    }

    // ── Market View Components V2 Parser ───────────────────────
    // Studied from live `pls market view apple` response (see study probe below).
    // Structure:
    //   message.components[0] = top-level Container
    //   .components[N]        = listing Section (has .components[] + .accessory button)
    //   .components[N].components[0].content = listing text (TextDisplay, type 10)
    //   .components[N].accessory              = Accept button (type 2, customId "market-accept:<uid>:<id>")
    // Text format:
    //   "**Selling 2,252 <:Apple:...> Apple**\n... For: ⏣ 99,088,000\n... Value per Unit: ⏣ 44,000\n..."
    // "Buy from Shop" entries have customId containing ":DM:" — skip them.
    // Non-coin listings have no "⏣" in "Value per Unit:" line — skip them.
    function parseMarketListings(components) {
        const listings = [];
        let plain;
        try { plain = JSON.parse(JSON.stringify(components || [])); } catch { return listings; }

        const container = plain[0];
        if (!container) return listings;

        for (const child of (container.components || [])) {
            if (!child.components || !child.accessory) continue;

            const textNode = child.components.find(c => typeof c.content === 'string');
            if (!textNode) continue;
            const text = textNode.content;

            const btn = child.accessory;
            if (!btn || (btn.type !== 2 && btn.type !== 'BUTTON')) continue;
            if (btn.disabled) continue;

            const cid = btn.customId || btn.custom_id || '';
            if (cid.includes(':DM:'))          continue; // "Buy from Shop" — DM official price
            if (!cid.startsWith('market-accept:')) continue;

            // Only coin-denominated listings
            const unitMatch = text.match(/Value per Unit:\s*⏣\s*([\d,]+)/);
            if (!unitMatch) continue;
            const pricePerUnit = parseInt(unitMatch[1].replace(/,/g, ''), 10);

            const qtyMatch    = text.match(/\*\*Selling\s+([\d,]+)/);
            const qty         = qtyMatch ? parseInt(qtyMatch[1].replace(/,/g, ''), 10) : 1;

            const totalMatch  = text.match(/For:\s*⏣\s*([\d,]+)/);
            const totalPrice  = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : pricePerUnit * qty;

            const listingId      = cid.split(':').slice(2).join(':');
            const partialAllowed = text.includes('Partial Accepting Allowed');

            listings.push({ pricePerUnit, qty, totalPrice, listingId, partialAllowed, button: btn, text: text.slice(0, 300) });
        }
        return listings;
    }

    // ── Market Sniper loop ──────────────────────────────────────
    async function marketSniperLoop() {
        await sleep(35000); // stagger after other loops
        while (true) {
            if (!_cfg.market_sniper_enabled || !Array.isArray(_cfg.market_sniper_items) || !_cfg.market_sniper_items.length) {
                await sleep(5000);
                continue;
            }

            for (const sniperItem of [..._cfg.market_sniper_items]) {
                if (!_cfg.market_sniper_enabled) break;
                const { name, max_price, buy_qty = 1 } = sniperItem;
                if (!name || !(max_price > 0)) continue;

                const maxBuys = Math.max(1, Math.min(50, Math.floor(Number(buy_qty)) || 1));

                for (let buyN = 0; buyN < maxBuys; buyN++) {
                if (!_cfg.market_sniper_enabled) break;
                if (buyN > 0) log('info', `[SNIPER] Buy ${buyN + 1}/${maxBuys} for "${name}"`);

                await runWithLock(async () => {
                    log('info', `[SNIPER] Checking market: "${name}" (max ⏣${max_price.toLocaleString()})`);
                    const res = await sendAndWait(channel, `pls market view ${name}`, 15);
                    if (!res) { log('warn', `[SNIPER] No response for: ${name}`); return; }

                    const listings = parseMarketListings(res.components);
                    log('info', `[SNIPER] Found ${listings.length} coin listing(s) for "${name}"`);

                    if (!listings.length) return;

                    // Sort ascending by price, keep only those at or below max_price
                    const eligible = listings
                        .filter(l => l.pricePerUnit <= max_price)
                        .sort((a, b) => a.pricePerUnit - b.pricePerUnit);

                    if (!eligible.length) {
                        const cheapest = [...listings].sort((a, b) => a.pricePerUnit - b.pricePerUnit)[0];
                        log('info', `[SNIPER] Cheapest ⏣${cheapest.pricePerUnit.toLocaleString()}/unit > max ⏣${max_price.toLocaleString()} for "${name}" — skipping`);
                        return;
                    }

                    const target = eligible[0];
                    log('info', `[SNIPER] TARGET: "${name}" @ ⏣${target.pricePerUnit.toLocaleString()}/unit × ${target.qty} (listing ${target.listingId})`);

                    const btnCid = target.button.customId || target.button.custom_id;
                    if (!btnCid) { log('warn', '[SNIPER] No customId on Accept button'); return; }

                    // Register reply listener BEFORE clicking to avoid race condition
                    let replyPromise;
                    try { replyPromise = waitForReply(res.id, 12000); } catch (e) { replyPromise = null; }

                    try {
                        await res.clickButton(btnCid);
                        log('info', `[SNIPER] ✓ Clicked Accept (listing ${target.listingId})`);
                    } catch (e) {
                        log('warn', `[SNIPER] Accept click failed: ${e.message}`);
                        return;
                    }

                    // Wait for confirmation dialog (new reply or edit)
                    let confirmMsg = null;
                    if (replyPromise) {
                        try { confirmMsg = await replyPromise; }
                        catch { confirmMsg = null; }
                    }
                    if (!confirmMsg) {
                        // Fallback: fetch edit on original message
                        await sleep(1000);
                        try { confirmMsg = await channel.messages.fetch(res.id, { force: true }); } catch {}
                    }

                    if (!confirmMsg) {
                        log('warn', '[SNIPER] No confirmation message received after Accept');
                        return;
                    }

                    // Look for Confirm / Yes button in the follow-up
                    let cfmPlain;
                    try { cfmPlain = JSON.parse(JSON.stringify(confirmMsg.components || [])); } catch { cfmPlain = []; }

                    // Search for confirm button (label "Confirm" or "Yes") in plain component tree
                    function findCfmBtn(comps) {
                        for (const c of (comps || [])) {
                            if ((c.type === 2 || c.type === 'BUTTON') && !c.disabled) {
                                const lbl = (c.label || '').toLowerCase();
                                if (lbl === 'confirm' || lbl === 'yes' || lbl === 'accept' || lbl === 'buy') return c;
                            }
                            if (Array.isArray(c.components)) { const f = findCfmBtn(c.components); if (f) return f; }
                            if (c.accessory) { const f = findCfmBtn([c.accessory]); if (f) return f; }
                        }
                        return null;
                    }
                    const cfmBtn = findCfmBtn(cfmPlain);

                    if (cfmBtn) {
                        const cfmCid = cfmBtn.customId || cfmBtn.custom_id;
                        try {
                            await confirmMsg.clickButton(cfmCid);
                            log('info', `[SNIPER] ✓ Purchase confirmed: "${name}" @ ⏣${target.pricePerUnit.toLocaleString()}/unit × ${target.qty}`);
                            log('info', `[SNIPER:BUY] ${name} ${target.pricePerUnit} ${target.qty}`);
                            postToApi(`/api/accounts/${ACCOUNT_ID}/sniper-event`, { item: name, price: target.pricePerUnit, qty: target.qty });
                        } catch (e) {
                            log('warn', `[SNIPER] Confirm click failed: ${e.message}`);
                        }
                    } else {
                        // No confirm button — check if purchase already went through automatically
                        const cfmText = extractTextDeep(cfmPlain);
                        if (/purchased|bought|success|accepted/i.test(cfmText)) {
                            log('info', `[SNIPER] ✓ Purchase auto-confirmed: "${name}" @ ⏣${target.pricePerUnit.toLocaleString()}`);
                            log('info', `[SNIPER:BUY] ${name} ${target.pricePerUnit} ${target.qty}`);
                            postToApi(`/api/accounts/${ACCOUNT_ID}/sniper-event`, { item: name, price: target.pricePerUnit, qty: target.qty });
                        } else {
                            log('warn', `[SNIPER] No confirm button found — dialog text: ${cfmText.slice(0, 200)}`);
                        }
                    }
                });

                if (buyN < maxBuys - 1) await sleep(2000); // inter-buy pause
                } // close buy-qty loop

                await sleep(2500); // inter-item pause
            }

            await sleep(_cfg.market_sniper_cooldown * 1000);
        }
    }

    // ── Market Study Probe ──────────────────────────────────────
    // Sends `pls market view <item>` once, dumps the FULL raw component
    // tree and all interactive elements so we can study the structure.
    async function studyMarketView() {
        const item = _cfg.market_study_item;
        if (!item) return;

        log('info', `[STUDY] === Starting market view study for: "${item}" ===`);
        await sleep(12000); // Wait for bot to be fully ready

        await runWithLock(async () => {
            const res = await sendAndWait(channel, `pls market view ${item}`, 20);
            if (!res) { log('warn', '[STUDY] No response received'); return; }

            // ── 1. Raw content & embeds ─────────────────────────────
            log('info', `[STUDY] content: ${JSON.stringify(res.content || '')}`);
            for (let i = 0; i < (res.embeds || []).length; i++) {
                const e = res.embeds[i];
                log('info', `[STUDY] embed[${i}]: title=${JSON.stringify(e.title)} desc=${JSON.stringify((e.description || '').slice(0, 300))}`);
                for (const f of (e.fields || [])) {
                    log('info', `[STUDY] embed[${i}].field: name=${JSON.stringify(f.name)} value=${JSON.stringify(f.value)}`);
                }
            }

            // ── 2. Full raw components JSON (chunked to avoid log truncation) ──
            let plainComps;
            try { plainComps = JSON.parse(JSON.stringify(res.components || [])); } catch { plainComps = []; }
            const raw = JSON.stringify(plainComps, null, 2);
            const chunkSize = 400;
            const chunks = Math.ceil(raw.length / chunkSize);
            log('info', `[STUDY] components JSON — ${raw.length} chars, ${chunks} chunks:`);
            for (let i = 0; i < chunks; i++) {
                log('info', `[STUDY] RAW[${i}/${chunks}] ${raw.slice(i * chunkSize, (i + 1) * chunkSize)}`);
            }

            // ── 3. Walk ALL buttons (deep) ──────────────────────────
            function collectButtons(comps, path = '') {
                const found = [];
                for (let i = 0; i < (comps || []).length; i++) {
                    const c = comps[i];
                    const p = `${path}[${i}]`;
                    const t = c.type || c.component_type;
                    if (t === 'BUTTON' || t === 2) {
                        found.push({ path: p, label: c.label, customId: c.customId || c.custom_id, style: c.style, disabled: c.disabled, emoji: c.emoji?.name });
                    }
                    if (Array.isArray(c.components)) found.push(...collectButtons(c.components, p + '.components'));
                    if (c.accessory) found.push(...collectButtons([c.accessory], p + '.accessory'));
                }
                return found;
            }
            const buttons = collectButtons(plainComps);
            log('info', `[STUDY] Total buttons found: ${buttons.length}`);
            for (const b of buttons) {
                log('info', `[STUDY] BTN path=${b.path} label=${JSON.stringify(b.label)} customId=${JSON.stringify(b.customId)} style=${b.style} disabled=${b.disabled} emoji=${b.emoji}`);
            }

            // ── 4. Walk ALL text content (deep) ────────────────────
            function collectText(comps, path = '') {
                const texts = [];
                for (let i = 0; i < (comps || []).length; i++) {
                    const c = comps[i];
                    const p = `${path}[${i}]`;
                    const t = c.type || c.component_type;
                    for (const key of ['content', 'description', 'label', 'text', 'value', 'title', 'placeholder']) {
                        if (typeof c[key] === 'string' && c[key].length > 0) {
                            texts.push({ path: p, type: t, key, value: c[key] });
                        }
                    }
                    if (Array.isArray(c.items)) {
                        for (let j = 0; j < c.items.length; j++) {
                            const item = c.items[j];
                            texts.push({ path: `${p}.items[${j}]`, type: 'item', key: 'media', value: JSON.stringify(item.media || {}) });
                        }
                    }
                    if (Array.isArray(c.components)) texts.push(...collectText(c.components, p + '.components'));
                    if (c.accessory) texts.push(...collectText([c.accessory], p + '.accessory'));
                }
                return texts;
            }
            const texts = collectText(plainComps);
            log('info', `[STUDY] Total text nodes: ${texts.length}`);
            for (const t of texts) {
                log('info', `[STUDY] TXT path=${t.path} type=${t.type} key=${t.key} val=${JSON.stringify(t.value.slice(0, 200))}`);
            }

            // ── 5. Old-style component rows ─────────────────────────
            const oldBtns = getButtons(res);
            log('info', `[STUDY] Legacy getButtons() found: ${oldBtns.length}`);
            for (const b of oldBtns) {
                log('info', `[STUDY] LEGACY_BTN label=${JSON.stringify(b.label)} customId=${JSON.stringify(b.customId)}`);
            }

            // ── 6. Click first non-disabled button that looks like Buy ──
            const buyBtn = buttons.find(b => !b.disabled && (b.label || '').toLowerCase().includes('buy'));
            if (!buyBtn) {
                log('warn', '[STUDY] No Buy-like button found — trying first non-disabled button');
                const firstBtn = buttons.find(b => !b.disabled);
                if (!firstBtn) { log('warn', '[STUDY] No clickable buttons at all'); return; }
            }

            const targetBtn = buyBtn || buttons.find(b => !b.disabled);
            if (!targetBtn || !targetBtn.customId) { log('warn', '[STUDY] No button with customId to click'); return; }

            log('info', `[STUDY] Clicking: label=${JSON.stringify(targetBtn.label)} customId=${JSON.stringify(targetBtn.customId)}`);
            try {
                await res.clickButton(targetBtn.customId);
                log('info', '[STUDY] ✓ Click succeeded — waiting for follow-up message');
            } catch (e) {
                log('warn', `[STUDY] Click failed: ${e.message}`);
                return;
            }

            await sleep(2000);

            // Try to fetch updated message
            try {
                const updated = await channel.messages.fetch(res.id, { force: true });
                let updPlain;
                try { updPlain = JSON.parse(JSON.stringify(updated.components || [])); } catch { updPlain = []; }
                const updRaw = JSON.stringify(updPlain, null, 2);
                log('info', `[STUDY] POST-CLICK components (${updRaw.length} chars):`);
                const updChunks = Math.ceil(updRaw.length / chunkSize);
                for (let i = 0; i < updChunks; i++) {
                    log('info', `[STUDY] UPD[${i}/${updChunks}] ${updRaw.slice(i * chunkSize, (i + 1) * chunkSize)}`);
                }
                const updBtns = collectButtons(updPlain);
                for (const b of updBtns) {
                    log('info', `[STUDY] UPD_BTN label=${JSON.stringify(b.label)} customId=${JSON.stringify(b.customId)} disabled=${b.disabled}`);
                }
            } catch (e) {
                log('warn', `[STUDY] Fetch updated msg failed: ${e.message}`);
            }

            log('info', '[STUDY] === Study complete ===');
        });
    }

    // ── Daily reward loop ──────────────────────────────────────────────
    async function dailyLoop() {
        await sleep(25000);
        let _dailyNextAt = 0; // track when next claim is available
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled?.daily) {
                // honour the next-available timestamp if we know it
                if (_dailyNextAt > Date.now()) {
                    await sleep(Math.min(_dailyNextAt - Date.now() + 5000, 30000));
                    continue;
                }
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls daily', 12);
                    if (!res) { log('warn', '[DAILY] No response'); return; }
                    if (isPremiumCooldown(res)) { log('warn', '[DAILY] Premium cooldown — skipping'); return; }

                    const embed = res.embeds[0]?.toJSON?.() || res.embeds[0] || {};
                    const desc  = embed.description || '';

                    // Already claimed — parse the time remaining and back off precisely
                    const alreadyMatch = desc.match(/(\d+)\s*hour/i) || desc.match(/(\d+)\s*hr/i);
                    if (alreadyMatch || desc.toLowerCase().includes('already') || desc.toLowerCase().includes('come back')) {
                        const hrs = alreadyMatch ? parseInt(alreadyMatch[1]) : 23;
                        _dailyNextAt = Date.now() + hrs * 3600 * 1000;
                        log('info', `[DAILY] Already claimed — next in ~${hrs}h`);
                        return;
                    }

                    // Parse streak and reward for the log
                    const streakMatch = desc.match(/streak[^*]*\*{1,2}(\d+)\*{1,2}/i);
                    const coinMatch   = desc.match(/⏣\s*([\d,]+)/);
                    const streak = streakMatch ? streakMatch[1] : '?';
                    const coins  = coinMatch   ? coinMatch[1]   : '?';
                    log('info', `[DAILY] ✓ Claimed — streak ${streak} | +⏣${coins}`);

                    // Click any confirmation button (some daily responses have one)
                    await sleep(800 + Math.random() * 600);
                    const confirmBtn = getButtons(res).find(b => /claim|collect|ok/i.test(b.label || ''));
                    if (confirmBtn) {
                        await clickButton(res, confirmBtn.label);
                    }
                    _dailyNextAt = Date.now() + 23 * 3600 * 1000;
                });
            }
            await sleep(cd('daily_cooldown'));
        }
    }

    // ── Work shift loop ────────────────────────────────────────────────
    async function workLoop() {
        await sleep(28000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled?.work) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls work shift', 12);
                    if (!res) { log('warn', '[WORK] No response'); return; }
                    if (isPremiumCooldown(res)) { log('warn', '[WORK] Premium cooldown — skipping'); return; }

                    const embed = res.embeds[0]?.toJSON?.() || res.embeds[0] || {};
                    const desc  = embed.description || '';

                    // Already working — detect and wait it out
                    if (desc.toLowerCase().includes('already working') || desc.toLowerCase().includes('still on shift')) {
                        log('info', '[WORK] Still on shift — will retry later');
                        return;
                    }

                    const btns = getButtons(res);
                    if (!btns.length) {
                        log('info', '[WORK] ✓ Shift started (no button response)');
                        return;
                    }

                    // Simulate reading the available shifts before picking one
                    await sleep(1200 + Math.random() * 1800);

                    // Prefer shifts that mention higher-value keywords, otherwise random
                    const preferred = btns.find(b => /overtime|bonus|double/i.test(b.label || ''));
                    const pick      = preferred || btns[Math.floor(Math.random() * btns.length)];
                    log('info', `[WORK] Starting shift: '${pick.label}'`);
                    const shiftOk = await clickButton(res, pick.label);
                    if (!shiftOk) log('warn', '[WORK] Shift click failed after retry');
                });
            }
            await sleep(cd('work_cooldown'));
        }
    }

    // ── Deposit-all loop ───────────────────────────────────────────────
    async function depositLoop() {
        await sleep(31000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled?.deposit) {
                await runWithLock(async () => {
                    // Check wallet first — no point depositing nothing
                    const walletRes = await sendAndWait(channel, 'pls bal', 8);
                    if (walletRes) {
                        const walletDesc = walletRes.embeds[0]?.description || walletRes.content || '';
                        const walletMatch = walletDesc.match(/wallet[^\d]*([\d,]+)/i);
                        const walletAmt   = walletMatch ? parseInt(walletMatch[1].replace(/,/g, '')) : -1;
                        if (walletAmt === 0) { log('info', '[DEPOSIT] Wallet empty — nothing to deposit'); return; }
                        if (walletAmt > 0) log('info', `[DEPOSIT] Wallet: ⏣${walletMatch[1]} — depositing`);
                    }

                    await sleep(600 + Math.random() * 800);
                    const res = await sendAndWait(channel, 'pls dep max', 8);
                    if (!res) { log('warn', '[DEPOSIT] No response'); return; }

                    const depDesc = res.embeds[0]?.description || res.content || '';
                    const depMatch = depDesc.match(/⏣\s*([\d,]+)/);
                    log('info', `[DEPOSIT] ✓ Deposited${depMatch ? ' ⏣' + depMatch[1] : ''}`);
                });
            }
            await sleep(cd('deposit_cooldown'));
        }
    }

  // ── Trivia loop (answer from trivia.json) ──────────────────────────
    const TRIVIA_DB = (() => {
        const map = new Map();
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'trivia.json'), 'utf8'));
            for (const [catB64, entries] of Object.entries(raw)) {
                const category = Buffer.from(catB64, 'base64').toString().toLowerCase().trim();
                for (const e of entries) {
                    const q = Buffer.from(e.question, 'base64').toString().toLowerCase().trim();
                    const a = Buffer.from(e.answer, 'base64').toString().trim();
                    const key = `${category}::${q}`;
                    if (!map.has(key)) map.set(key, a);
                }
            }
            log('info', `[TRIVIA] Loaded ${map.size} answers from trivia.json`);
        } catch (err) {
            log('warn', `[TRIVIA] Failed to load trivia.json: ${err.message}`);
        }
        return map;
    })();

    function findTriviaAnswer(question, category, buttons) {
        const q = question.toLowerCase().trim();
        const c = category.toLowerCase().trim();
        const answer = TRIVIA_DB.get(`${c}::${q}`);
        if (!answer) return null;
        const aLower = answer.toLowerCase().trim();
        return buttons.find(b => {
            const lbl = (b.label || '').toLowerCase().trim();
            if (lbl === aLower) return true;
            const stripped = lbl.replace(/^[a-z]\s*\.\s*/, '').trim();
            return stripped === aLower;
        }) || null;
    }

      async function triviaLoop() {
        await sleep(34000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled?.trivia) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls trivia', 12);
                    if (!res) { log('warn', '[TRIVIA] No response'); return; }
                    if (isPremiumCooldown(res)) { log('warn', '[TRIVIA] Premium cooldown — skipping'); return; }

                    const embed    = res.embeds[0]?.toJSON?.() || res.embeds[0] || {};
                    const desc     = embed.description || '';
                    const fields   = embed.fields || [];
                    const question = desc.match(/\*\*(.*?)\*\*/)?.[1] || '';
                    const category = fields[1]?.value || fields[0]?.value || '';
                    const btns     = getButtons(res);
                    if (!btns.length) { log('warn', '[TRIVIA] No buttons'); return; }

                    const pick = findTriviaAnswer(question, category, btns);

                    if (!pick) {
                        log('warn', `[TRIVIA] Unknown question — skipping: "${question}" (${category})`);
                        return;
                    }

                    await sleep(1500 + Math.random() * 2500);
                    log('info', `[TRIVIA] Answering: '${pick.label}' (${category})`);

                    const triviaOk = await clickButton(res, pick.label);
                    if (!triviaOk) { log('warn', '[TRIVIA] Click failed after retry'); return; }
                });
            }
            await sleep(cd('trivia_cooldown'));
        }
    }

    // ── Stream loop ────────────────────────────────────────────────────
    // Pick a "favourite" game at startup — rotates every few days worth of sessions
    let _streamPreferredGame = Math.floor(Math.random() * 25);

    async function streamLoop() {
        await sleep(37000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled?.stream) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls stream', 12);
                    if (!res) { log('warn', '[STREAM] No response'); return; }
                    if (isPremiumCooldown(res)) { log('warn', '[STREAM] Premium cooldown — skipping'); return; }

                    const embed  = res.embeds[0]?.toJSON?.() || res.embeds[0] || {};
                    const fields = embed.fields || [];
                    const field2 = (fields[1]?.name || fields[0]?.name || '').toLowerCase();

                    // Note the trending game but don't blindly follow it every time
                    if ((embed.title || '').includes('Trending Game')) {
                        const m = (embed.description || '').match(/\*\*(.*?)\*\*/);
                        if (m) log('info', `[STREAM] Trending game is '${m[1]}' — noted`);
                        return;
                    }

                    // Already live — scroll through chat naturally
                    if (field2.includes('live since')) {
                        await sleep(1000 + Math.random() * 1500);
                        const chatBtn = getButtons(res).find(b => /read chat|chat/i.test(b.label || ''));
                        if (chatBtn) {
                            const chatOk = await clickButton(res, chatBtn.label);
                            if (chatOk) log('info', '[STREAM] ✓ Read Chat');
                        }
                        return;
                    }

                    // Not live — pause as if deciding to go live, then proceed
                    await sleep(1500 + Math.random() * 2000);
                    const goBtn = getButtons(res).find(b => /go live/i.test(b.label || ''));
                    if (!goBtn) { log('warn', '[STREAM] No "Go Live" button found'); return; }
                    const liveOk = await clickButton(res, goBtn.label);
                    if (!liveOk) { log('warn', '[STREAM] Go Live failed after retry'); return; }
                    log('info', '[STREAM] Going live…');

                    // Wait for the game-select UI to appear
                    await sleep(3000 + Math.random() * 1500);
                    let updated = res;
                    try { updated = await channel.messages.fetch(res.id); } catch {}

                    const menuRows = getMenuRows(updated);
                    if (menuRows.length) {
                        const { rowIndex, menu } = menuRows[0];
                        const opts = menu.options || [];
                        if (opts.length) {
                            // 70 % chance to pick preferred game, 30 % drift to a nearby option
                            const base  = Math.min(_streamPreferredGame, opts.length - 1);
                            const drift = Math.random() < 0.3 ? Math.floor(Math.random() * 3) - 1 : 0;
                            const idx   = Math.max(0, Math.min(opts.length - 1, base + drift));
                            // Occasionally update preferred to drift value to simulate taste change
                            if (drift !== 0 && Math.random() < 0.15) _streamPreferredGame = idx;

                            await sleep(800 + Math.random() * 1200); // scroll time
                            try {
                                await updated.selectMenu(rowIndex, [opts[idx].value]);
                                log('info', `[STREAM] ✓ Selected game '${opts[idx].label}'`);
                            } catch (e) { log('warn', `[STREAM] Game select: ${e.message}`); }
                            await sleep(600 + Math.random() * 600);
                            try { updated = await channel.messages.fetch(res.id); } catch {}
                        }
                    }

                    // Click through any confirm/next/start buttons with short human pauses
                    for (const label of ['Confirm', 'Next', 'Start', 'Go Live']) {
                        await sleep(600 + Math.random() * 800);
                        const clicked = await clickButtonPrefix(updated, label);
                        if (clicked) {
                            log('info', `[STREAM] ✓ '${clicked}'`);
                            try { updated = await channel.messages.fetch(res.id); } catch {}
                        }
                    }
                });
            }
            await sleep(cd('stream_cooldown'));
        }
    }

    // ── Pet care loop ──────────────────────────────────────────────────
    async function petLoop() {
        await sleep(40000);
        while (true) {
            if (_botPaused) { await sleep(5000); continue; }
            if (_cfg.commands_enabled?.pet) {
                await runWithLock(async () => {
                    const res = await sendAndWait(channel, 'pls pets care', 12);
                    if (!res) { log('warn', '[PET] No response'); return; }
                    if (isPremiumCooldown(res)) { log('warn', '[PET] Premium cooldown — skipping'); return; }

                    const menuRows = getMenuRows(res);
                    if (!menuRows.length) { log('warn', '[PET] No pet select menu'); return; }

                    const { rowIndex: petRow, menu } = menuRows[0];
                    const petOptions = menu.options || [];
                    log('info', `[PET] Checking ${petOptions.length} pet(s)`);

                    for (const petOpt of petOptions) {
                        // Small pause between pets — flicking through the dropdown
                        await sleep(700 + Math.random() * 800);
                        try { await res.selectMenu(petRow, [petOpt.value]); }
                        catch (e) { log('warn', `[PET] Select '${petOpt.label}': ${e.message}`); continue; }
                        await sleep(900 + Math.random() * 600);

                        let updated = res;
                        try { updated = await channel.messages.fetch(res.id); } catch {}

                        const btns = getButtons(updated);
                        // Skip this pet entirely if all care buttons are disabled (fully cared)
                        const hasActive = btns.slice(0, 3).some(b => b && !b.disabled);
                        if (!hasActive) { log('info', `[PET] '${petOpt.label}' is already happy — skipping`); continue; }

                        for (let i = 0; i < Math.min(btns.length, 3); i++) {
                            const btn = btns[i];
                            if (!btn || btn.disabled) continue;

                            const embed = updated.embeds[0]?.toJSON?.() || updated.embeds[0] || {};
                            const field = (embed.fields || [])[i];
                            let pct     = parseInt(field?.value?.match(/\((\d+)%\)/)?.[1] ?? '100');

                            if (pct >= 90) continue; // already high enough

                            let clicks = 0;
                            while (pct < 90 && clicks < 15) {
                                await sleep(400 + Math.random() * 400);
                                const careOk = await clickButton(updated, btn.label);
                                if (!careOk) { log('warn', `[PET] Care click failed: '${btn.label}'`); break; }
                                clicks++;
                                if (i === 2) break; // Play: one trigger is enough per round
                                await sleep(500 + Math.random() * 300);
                                try { updated = await channel.messages.fetch(res.id); } catch { break; }
                                const updField = ((updated.embeds[0]?.toJSON?.() || updated.embeds[0] || {}).fields || [])[i];
                                pct = parseInt(updField?.value?.match(/\((\d+)%\)/)?.[1] ?? '100');
                            }
                            if (clicks) log('info', `[PET] '${petOpt.label}' stat[${i}] → ${pct}% (${clicks}×)`);
                        }
                    }
                });
            }
            await sleep(cd('pet_cooldown'));
        }
    }

    // ── Global event handler: captcha, alerts, auto-buy, minigames ──────
    client.on('messageCreate', async (msg) => {
        if (String(msg.channelId) !== CHANNEL_ID) return;
        if (String(msg.author.id) !== BOT_ID) return;

        // ── 1. CAPTCHA — pause bot immediately ───────────────────────────
        for (const embed of (msg.embeds || [])) {
            if ((embed.title || '').toUpperCase().includes('CAPTCHA')) {
                log('warn', '[CAPTCHA] CAPTCHA detected — pausing bot! Solve it manually.');
                setPaused(true);
                return;
            }
        }

        // ── 2. Unread alert notification ─────────────────────────────────
        for (const embed of (msg.embeds || [])) {
            if ((embed.title || '').includes('You have an unread alert')) {
                if ((msg.content || '').includes(`<@${client.user.id}>`)) {
                    log('info', '[ALERT] Unread alert detected — running pls alert');
                    await sleep(1000 + Math.random() * 500);
                    await sendAndWait(channel, 'pls alert', 8);
                    return;
                }
            }
        }

        // ── 3. Auto-buy missing tools ─────────────────────────────────────
        for (const embed of (msg.embeds || [])) {
            const desc = embed.description || '';
            if (desc.includes("You don't have a shovel")) {
                log('warn', '[AUTOBUY] Missing shovel — buying one');
                setTimeout(async () => {
                    await runWithLock(async () => {
                        await sendAndWait(channel, 'pls withdraw 35000', 10);
                        await sleep(800);
                        await sendAndWait(channel, 'pls shop buy shovel 1', 10);
                    });
                }, 1500);
                return;
            }
            if (desc.includes("You don't have a hunting rifle")) {
                log('warn', '[AUTOBUY] Missing hunting rifle — buying one');
                setTimeout(async () => {
                    await runWithLock(async () => {
                        await sendAndWait(channel, 'pls withdraw 35000', 10);
                        await sleep(800);
                        await sendAndWait(channel, 'pls shop buy hunting rifle 1', 10);
                    });
                }, 1500);
                return;
            }
            if (desc.includes("You don't have a fishing pole")) {
                log('warn', '[AUTOBUY] Missing fishing pole — buying one');
                setTimeout(async () => {
                    await runWithLock(async () => {
                        await sendAndWait(channel, 'pls withdraw 35000', 10);
                        await sleep(800);
                        await sendAndWait(channel, 'pls shop buy fishing pole 1', 10);
                    });
                }, 1500);
                return;
            }
        }

        // ── 4. Minigames — only our own interaction responses ─────────────
        if (!msg.interaction || String(msg.interaction.user?.id) !== String(client.user.id)) return;

        for (const embed of (msg.embeds || [])) {
            const desc = embed.description || '';

            // Color match: memorise word→color pairs, wait 6s, then click the right button
            if (desc.includes('Look at each color next to the words closely!')) {
                try {
                    const colorMap = {};
                    for (const line of desc.split('\n').slice(1)) {
                        const word  = line.match(/`(.+?)`/)?.[1];
                        const color = line.match(/:([^:\n]+):/)?.[1];
                        if (word && color) colorMap[word] = color;
                    }
                    log('info', '[MINIGAME] Color match — waiting 6s');
                    await sleep(6000);
                    let updated = msg;
                    try { updated = await channel.messages.fetch(msg.id); } catch {}
                    const targetWord = (updated.embeds[0]?.description || '').match(/`(.+?)`/)?.[1];
                    if (targetWord && colorMap[targetWord]) {
                        const targetColor = colorMap[targetWord];
                        for (const btn of getButtons(updated)) {
                            if ((btn.label || '').toLowerCase() === targetColor.toLowerCase()) {
                                log('info', `[MINIGAME] Color match → '${btn.label}'`);
                                try { await updated.clickButton(btn.customId); } catch (e) { log('warn', `[MINIGAME] Color click: ${e.message}`); }
                                return;
                            }
                        }
                    }
                } catch (e) { log('warn', `[MINIGAME] Color match error: ${e.message}`); }
                return;
            }

            // Emoji match: remember the emoji shown, wait 4s, click matching button
            if (desc.includes('Look at the emoji closely!')) {
                try {
                    const targetEmoji = desc.split('\n')[1]?.trim() || '';
                    log('info', `[MINIGAME] Emoji match — waiting 4s (target: ${targetEmoji})`);
                    await sleep(4000);
                    let updated = msg;
                    try { updated = await channel.messages.fetch(msg.id); } catch {}
                    const btns = getButtons(updated);
                    let clicked = false;
                    for (const btn of btns) {
                        const e = btn.emoji;
                        const eStr = e ? (e.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : (e.name || '')) : '';
                        if (eStr && targetEmoji.includes(eStr)) {
                            log('info', `[MINIGAME] Emoji match → clicking button`);
                            try { await updated.clickButton(btn.customId); } catch (err) { log('warn', `[MINIGAME] Emoji click: ${err.message}`); }
                            clicked = true;
                            break;
                        }
                    }
                    if (!clicked && btns.length) {
                        log('info', '[MINIGAME] Emoji fallback → first button');
                        try { await updated.clickButton(btns[0].customId); } catch {}
                    }
                } catch (e) { log('warn', `[MINIGAME] Emoji match error: ${e.message}`); }
                return;
            }

            // Repeat order: remember sequence, wait 6s, click buttons in order
            if (/repeat order|word order|words order/i.test(desc)) {
                try {
                    const order = desc.split('\n').slice(1, 6)
                        .map(l => l.replace(/^`|`$/g, '').trim()).filter(Boolean);
                    log('info', `[MINIGAME] Repeat order — waiting 6s (${order.join(' → ')})`);
                    await sleep(6000);
                    let updated = msg;
                    try { updated = await channel.messages.fetch(msg.id); } catch {}
                    const btnMap = Object.fromEntries(getButtons(updated).map(b => [b.label, b]));
                    for (const word of order) {
                        const btn = btnMap[word];
                        if (btn) {
                            log('info', `[MINIGAME] Order → clicking '${word}'`);
                            try { await updated.clickButton(btn.customId); } catch (e) { log('warn', `[MINIGAME] Order click: ${e.message}`); }
                            await sleep(500);
                        }
                    }
                } catch (e) { log('warn', `[MINIGAME] Repeat order error: ${e.message}`); }
                return;
            }

            // Attack boss: spam the first button 16 times
            if (desc.includes('Attack the boss by clicking')) {
                log('info', '[MINIGAME] Attack boss — spamming click');
                const btns = getButtons(msg);
                if (btns.length) {
                    for (let i = 0; i < 16; i++) {
                        try { await msg.clickButton(btns[0].customId); } catch {}
                        await sleep(500);
                    }
                }
                return;
            }

            // F in the chat
            if (desc.trim() === 'F') {
                log('info', '[MINIGAME] F in the chat');
                const btns = getButtons(msg);
                if (btns.length) try { await msg.clickButton(btns[0].customId); } catch {}
                return;
            }
        }
    });

    Promise.all([
        configReloadLoop(), heartbeatLoop(),
        cycleLoop(),
        begLoop(), searchLoop(), digLoop(), huntLoop(), crimeLoop(), hlLoop(), pmLoop(),
        advLoop(),
        fishLoop(), transferLoop(),
        dailyLoop(), workLoop(), depositLoop(),
        triviaLoop(), streamLoop(), petLoop(),
        marketSniperLoop(), mothershipMarketLoop(),
        studyMarketView(),
    ]).catch(e => log('error', `Fatal: ${e.message}`));
});

client.login(TOKEN);
