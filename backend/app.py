from flask import Flask, jsonify, request
from flask_cors import CORS
import MetaTrader5 as mt5
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timedelta
import sys
import os
import threading
import time

app = Flask(__name__)
CORS(app)

# --- GLOBAL CACHE SYSTEM ---
SYSTEM_STATE = {
    "accounts": {},
    "prices": {},
    "master_path": None
}

lock = threading.Lock()


# --- ROBUST PATH FINDER ---
def get_resource_path(filename):
    # 1. If running as compiled EXE (PyInstaller)
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, filename)

    # 2. Check current working directory (Root)
    if os.path.exists(filename):
        return filename

    # 3. Check the folder where app.py lives (backend/)
    current_dir = os.path.dirname(os.path.abspath(__file__))
    file_in_dir = os.path.join(current_dir, filename)
    if os.path.exists(file_in_dir):
        return file_in_dir

    # 4. Fallback
    return os.path.join(os.path.abspath("."), filename)


# --- FIREBASE SETUP ---
if not firebase_admin._apps:
    try:
        cred_path = get_resource_path("serviceAccountKey.json")
        if not os.path.exists(cred_path):
            print(f"CRITICAL ERROR: Key not found at {cred_path}")
        else:
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred)
            print(f"Firebase initialized from: {cred_path}")
    except Exception as e:
        print(f"Firebase Init Error: {e}")

db = firestore.client()


# --- HELPER: CONTEXT SWITCHING ---
def switch_context(path):
    try:
        if not path or not os.path.exists(path):
            return False
        mt5.shutdown()
        if not mt5.initialize(path=path):
            return False
        return True
    except Exception as e:
        print(f"Context Switch Error: {e}")
        return False


# --- CORE: SYNC WORKER ---
def sync_all_accounts_data(user_id):
    global SYSTEM_STATE
    if not user_id: return

    # Prevent stacking syncs
    if lock.locked(): return

    try:
        accs_ref = db.collection('USERS').document(user_id).collection('ACCOUNTS')
        docs = accs_ref.where('IS_ACTIVE', '==', True).get()
        db_accounts = [dict(d.to_dict(), ID=d.id) for d in docs]

        if not db_accounts: return

        with lock:
            SYSTEM_STATE["last_update"] = time.time()  # Update timestamp

            for acc in db_accounts:
                path = acc.get('TERMINAL_PATH')
                if not path: continue

                if switch_context(path):
                    if SYSTEM_STATE["master_path"] is None:
                        SYSTEM_STATE["master_path"] = path

                    info = mt5.account_info()
                    raw_pos = mt5.positions_get()

                    # Fix for History: Check 30 days back to 2 days future
                    from_date = datetime.now() - timedelta(days=30)
                    to_date = datetime.now() + timedelta(days=2)
                    raw_deals = mt5.history_deals_get(from_date, to_date)

                    if info:
                        acc_login = int(info.login)
                        pos_list = []
                        if raw_pos:
                            for p in raw_pos:
                                sym_info = mt5.symbol_info(p.symbol)
                                c_size = sym_info.trade_contract_size if sym_info else 100000.0
                                pos_list.append({
                                    "ticket": p.ticket, "symbol": p.symbol, "type": "BUY" if p.type == 0 else "SELL",
                                    "volume": p.volume, "price_open": p.price_open, "sl": p.sl, "tp": p.tp,
                                    "profit": p.profit, "swap": p.swap, "contract_size": c_size,
                                    "account": acc.get('NAME')
                                })
                                SYSTEM_STATE["prices"][p.symbol] = p.price_current

                        hist_list = []
                        if raw_deals:
                            for d in raw_deals:
                                if d.entry == mt5.DEAL_ENTRY_OUT:
                                    hist_list.append({
                                        "time": datetime.fromtimestamp(d.time).strftime('%Y-%m-%d %H:%M'),
                                        "timestamp": int(d.time), "symbol": d.symbol,
                                        "type": "BUY" if d.type == 1 else "SELL",
                                        "volume": d.volume, "price": d.price,
                                        "profit": d.profit + d.swap + d.commission,
                                        "account": acc.get('NAME')
                                    })

                        SYSTEM_STATE["accounts"][acc_login] = {
                            "name": acc.get('NAME'), "balance": info.balance, "margin_used": info.margin,
                            "positions": pos_list, "history": hist_list, "path": path,
                            "config": acc.get('SYMBOL_CONFIG', {})
                        }

            if SYSTEM_STATE["master_path"]:
                switch_context(SYSTEM_STATE["master_path"])
    except Exception as e:
        print(f"Sync Error: {e}")


# --- ENDPOINT: DASHBOARD ---
@app.route('/api/dashboard', methods=['GET'])
def get_dashboard_data():
    user_id = request.args.get('user_id')

    # NEW: Auto-refresh if data is stale (> 1.5 seconds old)
    # This ensures charts update when TP/SL is hit automatically
    if time.time() - SYSTEM_STATE["last_update"] > 1.5:
        threading.Thread(target=sync_all_accounts_data, args=(user_id,)).start()

    total_balance = 0.0
    total_equity = 0.0
    total_margin_used = 0.0
    master_map = {}
    all_history = []

    active_symbols = set()
    if SYSTEM_STATE["accounts"]:
        for acc in SYSTEM_STATE["accounts"].values():
            for p in acc['positions']: active_symbols.add(p['symbol'])

    # Get live prices for active symbols + watchlist (if needed)
    # Note: request.args.get('watchlist') handling can be added here if not already present
    watchlist_str = request.args.get('watchlist', '')
    if watchlist_str:
        for w in watchlist_str.split(','):
            if w.strip(): active_symbols.add(w.strip())

    current_prices = {}  # Send to frontend

    # Context switch might be needed for prices if using master path,
    # but usually symbol_info_tick works if initialized.
    # To be safe, we assume Sync Worker updates SYSTEM_STATE["prices"] mostly,
    # but we can try to fetch live if we are in a valid context.

    for sym in active_symbols:
        tick = mt5.symbol_info_tick(sym)
        if tick:
            SYSTEM_STATE["prices"][sym] = tick.bid
            current_prices[sym] = {"bid": tick.bid, "ask": tick.ask}
        else:
            current_prices[sym] = {"bid": SYSTEM_STATE["prices"].get(sym, 0.0), "ask": 0.0}

    # ... (Rest of aggregation logic remains same) ...
    for login, acc_data in SYSTEM_STATE["accounts"].items():
        total_balance += acc_data['balance']
        total_margin_used += acc_data.get('margin_used', 0.0)
        all_history.extend(acc_data.get('history', []))

        acc_floating_pl = 0.0
        account_groups = {}

        for pos in acc_data['positions']:
            current_price = SYSTEM_STATE["prices"].get(pos['symbol'], pos['price_open'])
            multiplier = 1 if pos['type'] == 'BUY' else -1
            contract_size = pos.get('contract_size', 100000.0)
            diff = (current_price - pos['price_open']) * multiplier
            live_profit = (diff * pos['volume'] * contract_size) + pos.get('swap', 0)
            acc_floating_pl += live_profit

            group_key = f"{pos['symbol']}_{pos['type']}"
            if group_key not in account_groups:
                account_groups[group_key] = {
                    "symbol": pos['symbol'], "type": pos['type'], "volume": 0.0, "price_prod": 0.0, "profit": 0.0,
                    "sl": pos['sl'], "tp": pos['tp'], "sl_consistent": True, "tp_consistent": True,
                    "account_name": acc_data['name'], "account_login": login, "ticket": f"{group_key}_{login}"
                }
            g = account_groups[group_key]
            g['volume'] += pos['volume']
            g['price_prod'] += (pos['price_open'] * pos['volume'])
            g['profit'] += live_profit
            if abs(g['sl'] - pos['sl']) > 0.001: g['sl_consistent'] = False
            if abs(g['tp'] - pos['tp']) > 0.001: g['tp_consistent'] = False

        total_equity += (acc_data['balance'] + acc_floating_pl)

        for key, g in account_groups.items():
            avg_price = g['price_prod'] / g['volume'] if g['volume'] > 0 else 0
            child = {
                "ticket": g['ticket'], "symbol": g['symbol'], "type": g['type'], "volume": round(g['volume'], 2),
                "price": round(avg_price, 5), "sl": g['sl'] if g['sl_consistent'] else 0,
                "tp": g['tp'] if g['tp_consistent'] else 0, "profit": g['profit'], "account_name": g['account_name'],
                "account_login": g['account_login']
            }
            if key not in master_map:
                master_map[key] = {
                    "ticket": key, "symbol": g['symbol'], "type": g['type'], "volume": 0.0, "price_prod": 0.0,
                    "profit": 0.0,
                    "sl": child['sl'], "tp": child['tp'], "sl_consistent": True, "tp_consistent": True,
                    "sub_positions": []
                }
            m = master_map[key]
            m['volume'] += child['volume']
            m['price_prod'] += (child['price'] * child['volume'])
            m['profit'] += child['profit']
            m['sub_positions'].append(child)
            if abs(m['sl'] - child['sl']) > 0.001: m['sl_consistent'] = False
            if abs(m['tp'] - child['tp']) > 0.001: m['tp_consistent'] = False

    final_positions = []
    for key, m in master_map.items():
        avg_price = m['price_prod'] / m['volume'] if m['volume'] > 0 else 0
        m['price_open'] = round(avg_price, 5)
        m['price_current'] = SYSTEM_STATE["prices"].get(m['symbol'], 0)
        m['sub_positions'].sort(key=lambda x: x['account_name'])
        final_positions.append(m)

    all_history.sort(key=lambda x: x['timestamp'], reverse=True)

    return jsonify({
        "balance": round(total_balance, 2), "equity": round(total_equity, 2),
        "margin_free": round(total_equity - total_margin_used, 2),
        "margin_used": round(total_margin_used, 2),
        "profit": round(total_equity - total_balance, 2),
        "positions": final_positions, "history": all_history[:50],
        "prices": current_prices
    })


# --- ENDPOINT: TRADE EXECUTION ---
@app.route('/api/trade', methods=['POST'])
def place_trade():
    data = request.json
    user_id = data.get('user_id')
    symbol = data.get('symbol')
    action = data.get('type')
    mult = float(data.get('volume', 1.0))
    results = []

    docs = db.collection('USERS').document(user_id).collection('ACCOUNTS').where('IS_ACTIVE', '==', True).get()

    opposing = 1 if action == 'BUY' else 0
    blocked = False
    with lock:
        for doc in docs:
            acc = doc.to_dict()
            if switch_context(acc.get('TERMINAL_PATH')):
                for p in mt5.positions_get(symbol=symbol) or []:
                    if p.type == opposing: blocked = True
            if blocked: break

        if blocked:
            if SYSTEM_STATE["master_path"]: switch_context(SYSTEM_STATE["master_path"])
            return jsonify({"message": "Blocked", "details": [], "blocked": True})

        target_type = 0 if action == 'BUY' else 1
        for doc in docs:
            acc = doc.to_dict()
            if not switch_context(acc.get('TERMINAL_PATH')):
                results.append(f"{acc.get('NAME')}: Connect Fail");
                continue

            auto_sl, auto_tp = 0.0, 0.0
            for p in mt5.positions_get(symbol=symbol) or []:
                if p.type == target_type: auto_sl, auto_tp = p.sl, p.tp; break

            config = acc.get('SYMBOL_CONFIG', {})
            base = float(config[symbol]['VOLUME']) if symbol in config else 0.01
            if symbol not in config:
                s_info = mt5.symbol_info(symbol)
                if s_info: base = s_info.volume_min

            vol = round(base * mult, 2)
            tick = mt5.symbol_info_tick(symbol)
            if not tick: continue

            req = {
                "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": vol,
                "type": mt5.ORDER_TYPE_BUY if action == 'BUY' else mt5.ORDER_TYPE_SELL,
                "price": tick.ask if action == 'BUY' else tick.bid, "magic": 234000,
                "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_FOK
            }
            if auto_sl > 0: req['sl'] = auto_sl
            if auto_tp > 0: req['tp'] = auto_tp

            res = mt5.order_send(req)

            # --- FIX: Only record Errors ---
            if res.retcode != mt5.TRADE_RETCODE_DONE:
                results.append(f"{acc.get('NAME')}: {res.comment}")

    time.sleep(1.5)
    sync_all_accounts_data(user_id)
    return jsonify({"message": "Done", "details": results, "blocked": False})


@app.route('/api/close', methods=['POST'])
def close_trade():
    data = request.json
    user_id = data.get('user_id')
    req_ticket = str(data.get('ticket'))

    parts = req_ticket.split('_')
    symbol = parts[0]
    p_type = 0 if parts[1] == 'BUY' else 1
    target_login = int(parts[2]) if len(parts) > 2 else None

    accs_ref = db.collection('USERS').document(user_id).collection('ACCOUNTS')
    docs = accs_ref.where('IS_ACTIVE', '==', True).get()

    results = []
    with lock:
        for doc in docs:
            acc = doc.to_dict()
            acc_login = int(acc.get('USER'))
            if target_login and acc_login != target_login: continue

            path = acc.get('TERMINAL_PATH')
            if switch_context(path):
                positions = mt5.positions_get(symbol=symbol)
                if positions:
                    for pos in positions:
                        if pos.type == p_type:
                            tick = mt5.symbol_info_tick(symbol)
                            req = {
                                "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": pos.volume,
                                "type": mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY,
                                "position": pos.ticket, "price": tick.bid if pos.type == 0 else tick.ask,
                                "magic": 234000
                            }
                            res = mt5.order_send(req)
                            if res.retcode != mt5.TRADE_RETCODE_DONE:
                                results.append(f"Close Failed on {acc_login}: {res.comment}")

    time.sleep(1.5)
    sync_all_accounts_data(user_id)
    return jsonify({"message": "Closed", "details": results})


@app.route('/api/modify', methods=['POST'])
def modify_trade():
    data = request.json
    user_id = data.get('user_id')
    req_ticket = str(data.get('ticket'))

    parts = req_ticket.split('_')
    symbol = parts[0]
    p_type = 0 if parts[1] == 'BUY' else 1
    target_login = int(parts[2]) if len(parts) > 2 else None

    req_sl = data.get('sl')
    req_tp = data.get('tp')

    accs_ref = db.collection('USERS').document(user_id).collection('ACCOUNTS')
    docs = accs_ref.where('IS_ACTIVE', '==', True).get()
    results = []

    with lock:
        for doc in docs:
            acc = doc.to_dict()
            acc_login = int(acc.get('USER'))
            if target_login and acc_login != target_login: continue

            path = acc.get('TERMINAL_PATH')
            if switch_context(path):
                positions = mt5.positions_get(symbol=symbol)
                if positions:
                    for pos in positions:
                        if pos.type == p_type:
                            final_sl = float(req_sl) if req_sl is not None else pos.sl
                            final_tp = float(req_tp) if req_tp is not None else pos.tp
                            req = {"action": mt5.TRADE_ACTION_SLTP, "position": pos.ticket, "sl": final_sl,
                                   "tp": final_tp}
                            res = mt5.order_send(req)
                            if res.retcode != mt5.TRADE_RETCODE_DONE:
                                results.append(f"Modify Failed on {acc_login}: {res.comment}")

    sync_all_accounts_data(user_id)
    return jsonify({"message": "Modified", "details": results})


@app.route('/api/candles', methods=['GET'])
def get_candles():
    if not mt5.terminal_info():
        if SYSTEM_STATE["master_path"]:
            switch_context(SYSTEM_STATE["master_path"])
        else:
            mt5.initialize()

    symbol = request.args.get('symbol', 'XAUUSD')
    timeframe = request.args.get('timeframe', '1H')
    tf_map = {'1H': mt5.TIMEFRAME_H1, '4H': mt5.TIMEFRAME_H4, '1D': mt5.TIMEFRAME_D1, '1M': mt5.TIMEFRAME_M1,
              '15M': mt5.TIMEFRAME_M15}
    rates = mt5.copy_rates_from_pos(symbol, tf_map.get(timeframe, mt5.TIMEFRAME_H1), 0, 1000)
    if rates is None: return jsonify([])
    data = [{"time": int(x['time']), "open": x['open'], "high": x['high'], "low": x['low'], "close": x['close']} for x
            in rates]
    tick = mt5.symbol_info_tick(symbol)
    if tick and data:
        data[-1]['close'] = tick.bid
        data[-1]['high'] = max(data[-1]['high'], tick.bid)
        data[-1]['low'] = min(data[-1]['low'], tick.bid)
    return jsonify(data)


@app.route('/api/accounts', methods=['GET'])
def get_accounts():
    user_id = request.args.get('user_id')
    docs = db.collection('USERS').document(user_id).collection('ACCOUNTS').get()
    return jsonify([dict(d.to_dict(), ID=d.id) for d in docs])


@app.route('/api/accounts', methods=['POST'])
def save_account():
    d = request.json
    data = {
        "NAME": d['NAME'], "USER": int(d['USER']), "PASS": d['PASS'], "SERVER": d['SERVER'],
        "TERMINAL_PATH": d.get('TERMINAL_PATH', ''), "IS_ACTIVE": d.get('IS_ACTIVE', True),
        "SYMBOL_CONFIG": d.get('SYMBOL_CONFIG', {})
    }
    db.collection('USERS').document(d['user_id']).collection('ACCOUNTS').document(d.get('ID') or None).set(data,
                                                                                                           merge=True)
    return jsonify({"message": "Saved"})


@app.route('/api/accounts/delete', methods=['POST'])
def delete_account():
    d = request.json
    db.collection('USERS').document(d['user_id']).collection('ACCOUNTS').document(d['ID']).delete()
    return jsonify({"message": "Deleted"})


@app.route('/api/accounts/toggle', methods=['POST'])
def toggle_account():
    d = request.json
    db.collection('USERS').document(d['user_id']).collection('ACCOUNTS').document(d['ID']).update(
        {"IS_ACTIVE": d['IS_ACTIVE']})
    return jsonify({"message": "Updated"})


@app.route('/login', methods=['POST'])
def login():
    try:
        data = request.json
        docs = db.collection('USERS').where('MOBILE', '==', data.get('mobile')).get()
        if not docs: return jsonify({"error": "User not found"}), 404
        user_doc = docs[0]
        if user_doc.to_dict().get('PASS') == data.get('password'):
            threading.Thread(target=sync_all_accounts_data, args=(user_doc.id,)).start()
            return jsonify({"status": "success", "user_id": user_doc.id})
        return jsonify({"error": "Invalid Password"}), 401
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    app.run(port=5000, debug=True, use_reloader=False, threaded=True)