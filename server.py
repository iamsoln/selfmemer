from flask import Flask, jsonify, request, send_from_directory
import json
import os
import collections
import threading
import time
import subprocess

app = Flask(__name__, static_folder="web", static_url_path="")

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

NUMERIC_FIELDS = [
    "cooldown", "search_cooldown", "beg_cooldown", "crime_cooldown",
    "hl_cooldown", "hl_wait_for", "pm_cooldown", "wait_for_response",
    "adv_cooldown",
]
RISK_FIELDS  = ["search_risk", "crime_risk"]
VALID_RISK   = {"low", "medium", "high", "custom"}
COMMAND_KEYS = ["hunt", "dig", "search", "beg", "crime", "hl", "pm", "adv", "fish", "daily", "work", "deposit", "trivia", "stream", "pet"]

VALID_ADV_TYPES = [
    "Pepe Goes to Space",
    "Pepe Goes out West",
    "Pepe Goes Down Under",
    "Pepe Goes on Vacation",
    "Pepe Goes Fishing with Friends",
    "Pepe Goes to the Museum",
    "Pepe goes to Brazil",
]

DEFAULT_ACCOUNT = {
    "cooldown": 20, "search_cooldown": 25, "beg_cooldown": 40,
    "crime_cooldown": 40, "hl_cooldown": 10, "hl_wait_for": 5,
    "pm_cooldown": 20, "wait_for_response": 10,
    "adv_cooldown": 1800,
    "adv_type": "Pepe Goes to Space",
    "search_risk": "medium", "crime_risk": "medium",
    "commands_enabled": {
        "hunt": True, "dig": True, "search": True,
        "beg": True, "crime": True, "hl": True, "pm": True, "adv": False,
                "fish": False, "daily": False, "work": False, "deposit": False,
        "trivia": False, "stream": False, "pet": False,
    },
    # ── Stealth / anti-detection ──────────────────────────────
    "limit_flags":        False,
    "stealth_mode":       "moderate",
    "cycle_uptime_mins":  0,
    "cycle_downtime_mins": 0,
    "search_custom_ranking": [],
    "crime_custom_ranking":  [],
}

# ── Config helpers ─────────────────────────────────────────
_config_lock = threading.Lock()

def load_config():
    with _config_lock:
        with open(CONFIG_PATH) as f:
            return json.load(f)

def save_config(cfg):
    with _config_lock:
        with open(CONFIG_PATH, "w") as f:
            json.dump(cfg, f, indent=4)

def get_accounts():
    return load_config().get("accounts", [])

def find_account(account_id):
    for a in get_accounts():
        if a["id"] == account_id:
            return a
    return None

# ── In-memory log buffer ───────────────────────────────────
_log_lock   = threading.Lock()
_log_buffer = collections.deque(maxlen=500)
_heartbeat  = {}   # source -> unix timestamp

# ── Fish stats ─────────────────────────────────────────────
_fish_stats = {}   # account_id -> {session_start, catches: {name: count}, sells: int, timeline: [...]}
_fish_lock  = threading.Lock()

# ── Market Sniper stats ─────────────────────────────────────
_sniper_stats = {}  # account_id -> {session_start, buys: [{item, price, qty, ts}]}
_sniper_lock  = threading.Lock()

def _make_sniper_state():
    return {"session_start": time.time(), "buys": []}

def _update_sniper_from_log(source, msg):
    parts = source.split(":")
    account_id = parts[-1] if len(parts) >= 2 else None
    if not account_id:
        return
    if not msg.startswith("[SNIPER:BUY] "):
        return
    rest   = msg[len("[SNIPER:BUY] "):]
    tokens = rest.rsplit(None, 2)
    if len(tokens) < 3:
        return
    item = tokens[0]
    try:
        price = int(tokens[1])
        qty   = int(tokens[2])
    except Exception:
        return
    with _sniper_lock:
        if account_id not in _sniper_stats:
            _sniper_stats[account_id] = _make_sniper_state()
        _sniper_stats[account_id]["buys"].append({
            "item": item, "price": price, "qty": qty,
            "ts": int(time.time() * 1000),
        })
        if len(_sniper_stats[account_id]["buys"]) > 200:
            _sniper_stats[account_id]["buys"] = _sniper_stats[account_id]["buys"][-200:]

def _make_fish_state():
    return {"session_start": time.time(), "catches": {}, "sells": 0, "timeline": []}

def _get_fish_stats(account_id):
    with _fish_lock:
        if account_id not in _fish_stats:
            _fish_stats[account_id] = _make_fish_state()
        return dict(_fish_stats[account_id])

def _update_fish_from_log(source, msg):
    # source looks like "MAIN:acc-xxxx"
    parts = source.split(":")
    account_id = parts[-1] if len(parts) >= 2 else None
    if not account_id:
        return
    with _fish_lock:
        if account_id not in _fish_stats:
            _fish_stats[account_id] = _make_fish_state()
        s = _fish_stats[account_id]
        changed = False
        if msg.startswith("[FISH:CATCH] "):
            name = msg[len("[FISH:CATCH] "):].strip()
            if name:
                s["catches"][name] = s["catches"].get(name, 0) + 1
                changed = True
        elif msg.startswith("[FISH:SELL]"):
            s["sells"] += 1
            changed = True
        if changed:
            ts = int(time.time() * 1000)
            s["timeline"].append({"ts": ts, "fish": dict(s["catches"]), "sells": s["sells"]})
            if len(s["timeline"]) > 300:
                s["timeline"] = s["timeline"][-300:]

def _add_log(level, source, msg):
    entry = {"ts": int(time.time() * 1000), "level": level, "source": source, "msg": msg}
    with _log_lock:
        _log_buffer.append(entry)
        _heartbeat[source] = time.time()
    _update_fish_from_log(source, msg)
    _update_sniper_from_log(source, msg)

# ── Routes ─────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("web", "index.html")

# ── Accounts CRUD ──────────────────────────────────────────

@app.route("/api/accounts", methods=["GET"])
def list_accounts():
    return jsonify(get_accounts())

@app.route("/api/accounts", methods=["POST"])
def create_account():
    data = request.get_json(silent=True) or {}
    name       = str(data.get("name", "New Account"))[:50]
    token      = str(data.get("token", ""))
    channel_id = data.get("channel_id", 0)
    bot_id     = data.get("bot_id", 270904126974590976)

    channel_id = str(channel_id).strip() or "0"
    bot_id     = str(bot_id).strip()     or "270904126974590976"

    account_id = "acc-" + str(int(time.time() * 1000))
    account = {**DEFAULT_ACCOUNT,
        "id": account_id, "name": name,
        "token": token, "channel_id": channel_id, "bot_id": bot_id,
        "commands_enabled": dict(DEFAULT_ACCOUNT["commands_enabled"]),
    }

    cfg = load_config()
    cfg.setdefault("accounts", []).append(account)
    save_config(cfg)
    return jsonify({"ok": True, "account": account})

@app.route("/api/accounts/<account_id>", methods=["DELETE"])
def delete_account(account_id):
    cfg = load_config()
    cfg["accounts"] = [a for a in cfg.get("accounts", []) if a["id"] != account_id]
    save_config(cfg)
    bal_path = os.path.join(BASE_DIR, f"balance_{account_id}.json")
    try: os.remove(bal_path)
    except: pass
    return jsonify({"ok": True})

@app.route("/api/accounts/<account_id>", methods=["PUT"])
def update_account(account_id):
    data = request.get_json(silent=True) or {}
    cfg  = load_config()
    for i, account in enumerate(cfg.get("accounts", [])):
        if account["id"] != account_id:
            continue
        if "name"  in data: account["name"]  = str(data["name"])[:50]
        if "token" in data: account["token"] = str(data["token"])
        if "channel_id" in data:
            v = str(data["channel_id"]).strip()
            if v: account["channel_id"] = v
        if "bot_id" in data:
            v = str(data["bot_id"]).strip()
            if v: account["bot_id"] = v
        for key in NUMERIC_FIELDS:
            if key in data and isinstance(data[key], (int, float)) and data[key] > 0:
                account[key] = data[key]
        for key in RISK_FIELDS:
            if key in data and data[key] in VALID_RISK:
                account[key] = data[key]
        if "adv_type" in data and data["adv_type"] in VALID_ADV_TYPES:
            account["adv_type"] = data["adv_type"]
        if "commands_enabled" in data and isinstance(data["commands_enabled"], dict):
            account.setdefault("commands_enabled", {})
            for cmd in COMMAND_KEYS:
                if cmd in data["commands_enabled"]:
                    account["commands_enabled"][cmd] = bool(data["commands_enabled"][cmd])
        if "bal_tracker_enabled" in data:
            account["bal_tracker_enabled"] = bool(data["bal_tracker_enabled"])
        if "fish_sell_currency" in data and data["fish_sell_currency"] in ("coins", "tokens"):
            account["fish_sell_currency"] = data["fish_sell_currency"]
        if "disable_interaction_lock" in data:
            account["disable_interaction_lock"] = bool(data["disable_interaction_lock"])
        if "limit_flags" in data:
            account["limit_flags"] = bool(data["limit_flags"])
        if "stealth_mode" in data and data["stealth_mode"] in ("strict", "moderate", "casual", "fast"):
            account["stealth_mode"] = data["stealth_mode"]
        if "cycle_uptime_mins" in data and isinstance(data["cycle_uptime_mins"], (int, float)):
            account["cycle_uptime_mins"] = max(0, int(data["cycle_uptime_mins"]))
        if "cycle_downtime_mins" in data and isinstance(data["cycle_downtime_mins"], (int, float)):
            account["cycle_downtime_mins"] = max(0, int(data["cycle_downtime_mins"]))
        if "search_custom_ranking" in data and isinstance(data["search_custom_ranking"], list):
            account["search_custom_ranking"] = [str(x)[:120] for x in data["search_custom_ranking"][:300] if isinstance(x, str)]
        if "crime_custom_ranking" in data and isinstance(data["crime_custom_ranking"], list):
            account["crime_custom_ranking"] = [str(x)[:120] for x in data["crime_custom_ranking"][:100] if isinstance(x, str)]
        cfg["accounts"][i] = account
        break
    save_config(cfg)
    return jsonify({"ok": True})

# ── Per-account balance ────────────────────────────────────

@app.route("/api/accounts/<account_id>/balance", methods=["GET"])
def get_account_balance(account_id):
    bal_path = os.path.join(BASE_DIR, f"balance_{account_id}.json")
    try:
        with open(bal_path) as f:
            return jsonify(json.load(f))
    except FileNotFoundError:
        return jsonify([])
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/accounts/<account_id>/balance", methods=["DELETE"])
def reset_account_balance(account_id):
    bal_path = os.path.join(BASE_DIR, f"balance_{account_id}.json")
    with open(bal_path, "w") as f:
        f.write("[]")
    return jsonify({"ok": True})

# ── Logs ───────────────────────────────────────────────────

@app.route("/api/log", methods=["POST"])
def post_log():
    data   = request.get_json(silent=True) or {}
    level  = str(data.get("level",  "info"))[:10]
    source = str(data.get("source", "bot"))[:40]
    msg    = str(data.get("msg",    ""))[:500]
    _add_log(level, source, msg)
    return jsonify({"ok": True})

@app.route("/api/logs", methods=["GET"])
def get_logs():
    since   = request.args.get("since",   0,    type=int)
    account = request.args.get("account", None)
    with _log_lock:
        entries = [e for e in _log_buffer if e["ts"] > since]
    if account:
        entries = [e for e in entries if e.get("source", "").endswith(f":{account}")]
    return jsonify(entries)

# ── Status ─────────────────────────────────────────────────

@app.route("/api/status", methods=["GET"])
def get_status():
    now = time.time()
    with _log_lock:
        hb = dict(_heartbeat)
    result = {}
    for source, last_ts in hb.items():
        result[source] = "online" if (now - last_ts) < 60 else "stale"
    return jsonify(result)

# ── Adventure types ────────────────────────────────────────

@app.route("/api/fish-stats/<account_id>", methods=["GET"])
def get_fish_stats(account_id):
    s = _get_fish_stats(account_id)
    return jsonify({
        "session_start":  s["session_start"],
        "catches":        s["catches"],
        "total_catches":  sum(s["catches"].values()),
        "sells":          s["sells"],
        "timeline":       s.get("timeline", []),
    })

@app.route("/api/fish-stats/<account_id>", methods=["DELETE"])
def reset_fish_stats(account_id):
    with _fish_lock:
        _fish_stats[account_id] = _make_fish_state()
    return jsonify({"ok": True})

@app.route("/api/adv-types", methods=["GET"])
def get_adv_types():
    return jsonify(VALID_ADV_TYPES)

# ── Market Sniper config + stats ─────────────────────────────

@app.route("/api/accounts/<account_id>/market-sniper", methods=["GET"])
def get_market_sniper(account_id):
    acc = find_account(account_id)
    if not acc:
        return jsonify({"ok": False, "error": "Not found"}), 404
    return jsonify({
        "enabled":  acc.get("market_sniper_enabled", False),
        "items":    acc.get("market_sniper_items", []),
        "cooldown": acc.get("market_sniper_cooldown", 60),
    })

@app.route("/api/accounts/<account_id>/market-sniper", methods=["POST"])
def save_market_sniper(account_id):
    data = request.get_json(silent=True) or {}
    cfg  = load_config()
    for i, a in enumerate(cfg.get("accounts", [])):
        if a["id"] != account_id:
            continue
        if "enabled" in data:
            a["market_sniper_enabled"] = bool(data["enabled"])
        if "items" in data and isinstance(data["items"], list):
            a["market_sniper_items"] = [
                {
                    "name":      str(it.get("name", ""))[:50].strip(),
                    "max_price": max(0, int(it.get("max_price", 0))),
                    "buy_qty":   max(1, min(50, int(it.get("buy_qty", 1) or 1))),
                }
                for it in data["items"][:20]
                if str(it.get("name", "")).strip() and int(it.get("max_price", 0)) > 0
            ]
        if "cooldown" in data:
            v = int(data["cooldown"])
            if v >= 5:
                a["market_sniper_cooldown"] = v
        cfg["accounts"][i] = a
        break
    save_config(cfg)
    return jsonify({"ok": True})

@app.route("/api/market-sniper-stats/<account_id>", methods=["GET"])
def get_market_sniper_stats(account_id):
    with _sniper_lock:
        s    = _sniper_stats.get(account_id, _make_sniper_state())
        buys = list(s.get("buys", []))
    total_coins = sum(b["price"] * b["qty"] for b in buys)
    return jsonify({
        "session_start":    s.get("session_start", time.time()),
        "total_buys":       len(buys),
        "total_coins_spent": total_coins,
        "recent_buys":      buys[-10:],
    })

@app.route("/api/accounts/<account_id>/sniper-event", methods=["POST"])
def sniper_event(account_id):
    data  = request.get_json(silent=True) or {}
    item  = str(data.get("item",  ""))[:50]
    price = int(data.get("price", 0))
    qty   = int(data.get("qty",   1))
    if item and price > 0:
        with _sniper_lock:
            if account_id not in _sniper_stats:
                _sniper_stats[account_id] = _make_sniper_state()
            _sniper_stats[account_id]["buys"].append({
                "item": item, "price": price, "qty": qty,
                "ts": int(time.time() * 1000),
            })
            if len(_sniper_stats[account_id]["buys"]) > 200:
                _sniper_stats[account_id]["buys"] = _sniper_stats[account_id]["buys"][-200:]
    return jsonify({"ok": True})

@app.route("/api/market-sniper-stats/<account_id>", methods=["DELETE"])
def reset_market_sniper_stats(account_id):
    with _sniper_lock:
        _sniper_stats[account_id] = _make_sniper_state()
    return jsonify({"ok": True})

# ── Mothership ─────────────────────────────────────────────

@app.route("/api/mothership", methods=["GET"])
def get_mothership():
    cfg = load_config()
    mid = cfg.get("mothership_id")
    acc = find_account(mid) if mid else None
    return jsonify({"mothership_id": mid, "account": acc})

@app.route("/api/mothership", methods=["POST"])
def set_mothership():
    data = request.get_json(silent=True) or {}
    account_id = data.get("account_id")
    cfg = load_config()
    found = any(a["id"] == account_id for a in cfg.get("accounts", []))
    if not found:
        return jsonify({"ok": False, "error": "Account not found"}), 404
    cfg["mothership_id"] = account_id
    save_config(cfg)
    return jsonify({"ok": True})

@app.route("/api/mothership", methods=["DELETE"])
def clear_mothership():
    cfg = load_config()
    cfg["mothership_id"] = None
    save_config(cfg)
    return jsonify({"ok": True})

# ── Balance Tracker toggle ─────────────────────────────────

@app.route("/api/accounts/<account_id>/bal-tracker", methods=["POST"])
def toggle_bal_tracker(account_id):
    data    = request.get_json(silent=True) or {}
    enabled = bool(data.get("enabled", True))
    cfg = load_config()
    for i, a in enumerate(cfg.get("accounts", [])):
        if a["id"] == account_id:
            cfg["accounts"][i]["bal_tracker_enabled"] = enabled
            save_config(cfg)
            return jsonify({"ok": True, "enabled": enabled})
    return jsonify({"ok": False, "error": "Account not found"}), 404

# ── Discord UID (set by bot on login) ──────────────────────

@app.route("/api/accounts/<account_id>/discord_uid", methods=["POST"])
def set_discord_uid(account_id):
    data = request.get_json(silent=True) or {}
    uid  = str(data.get("discord_uid", "")).strip()
    if not uid:
        return jsonify({"ok": False}), 400
    cfg = load_config()
    for i, a in enumerate(cfg.get("accounts", [])):
        if a["id"] == account_id:
            cfg["accounts"][i]["discord_uid"] = uid
            break
    save_config(cfg)
    return jsonify({"ok": True})

# ── Mothership Transfer ─────────────────────────────────────

@app.route("/api/accounts/<account_id>/transfer", methods=["POST"])
def trigger_transfer(account_id):
    data          = request.get_json(silent=True) or {}
    transfer_type = data.get("type")
    if transfer_type not in ("items", "coins", "market_items", "market_coins"):
        return jsonify({"ok": False, "error": "Invalid type"}), 400

    cfg = load_config()
    mid = cfg.get("mothership_id")
    if not mid:
        return jsonify({"ok": False, "error": "No mothership assigned"}), 400
    if mid == account_id:
        return jsonify({"ok": False, "error": "This account IS the mothership"}), 400

    mothership = next((a for a in cfg.get("accounts", []) if a["id"] == mid), None)
    if not mothership:
        return jsonify({"ok": False, "error": "Mothership account not found"}), 400

    muid = mothership.get("discord_uid", "")
    if not muid:
        return jsonify({"ok": False, "error": "Mothership Discord UID not available yet — make sure its bot has logged in at least once"}), 400

    trigger = {
        "type":            transfer_type,
        "mothership_uid":  muid,
        "mothership_name": mothership.get("name", "Mothership"),
        "mothership_id":   mid,
    }
    trigger_path = os.path.join(BASE_DIR, f"transfer_trigger_{account_id}.json")
    with open(trigger_path, "w") as f:
        json.dump(trigger, f)

    # Clear previous status
    status_path = os.path.join(BASE_DIR, f"transfer_status_{account_id}.json")
    with open(status_path, "w") as f:
        json.dump({"status": "Starting...", "ts": int(time.time() * 1000), "done": False}, f)

    return jsonify({"ok": True})

@app.route("/api/accounts/<account_id>/transfer-status", methods=["GET"])
def get_transfer_status(account_id):
    status_path = os.path.join(BASE_DIR, f"transfer_status_{account_id}.json")
    try:
        with open(status_path) as f:
            return jsonify(json.load(f))
    except Exception:
        return jsonify({"status": None, "ts": None, "done": True})

@app.route("/api/overview", methods=["GET"])
def get_overview():
    cfg  = load_config()
    accs = cfg.get("accounts", [])
    result = []
    for acc in accs:
        aid = acc["id"]
        bal_path = os.path.join(BASE_DIR, f"balance_{aid}.json")
        entry = {"wallet": None, "bank": None, "net_worth": None, "ts": None}
        try:
            with open(bal_path) as f:
                data = json.load(f)
            if isinstance(data, list) and data:
                entry = data[-1]
        except Exception:
            pass
        result.append({
            "id":        aid,
            "name":      acc.get("name", "Account"),
            "wallet":    entry.get("wallet"),
            "bank":      entry.get("bank"),
            "net_worth": entry.get("netWorth") or entry.get("net_worth"),
            "ts":        entry.get("ts"),
        })
    return jsonify(result)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
