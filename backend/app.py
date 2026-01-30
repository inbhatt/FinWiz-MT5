import time
import sys
import os
import json
import threading
import uuid
import logging
import MetaTrader5 as mt5
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import multiprocessing
from multiprocessing import Process, Manager, Queue
from db_manager import get_db

# --- LOGGING SETUP ---
logging.basicConfig(
    filename='debug.log',
    level=logging.INFO,
    format='%(asctime)s %(levelname)s: %(message)s'
)

# --- CONFIG ---
app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# --- SHARED STATE ---
manager = None
SHARED_DATA = {}
RESPONSE_DICT = {}
TRADE_RESULTS = {}  # For aggregating trade responses
COMMAND_QUEUES = {}
WORKER_PROCESSES = {}
ACCOUNT_CONFIGS = {}


def get_resource_path(filename):
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, filename)
    if os.path.exists(filename):
        return filename
    current_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(current_dir, filename)


# --- WORKER PROCESS ---
def account_worker_loop(account_data, cmd_queue, shared_dict, response_dict, trade_results, global_symbols):
    # Re-configure logging for this process
    logging.basicConfig(filename='debug.log', level=logging.INFO, format='[WORKER] %(asctime)s: %(message)s')

    acc_id = str(account_data.get('ID', 'UNKNOWN'))
    acc_name = account_data.get('NAME', acc_id)

    try:
        login = int(account_data['USER'])
        password = account_data['PASS']
        server = account_data['SERVER']
        path = account_data.get('TERMINAL_PATH', '').strip()

        # Init MT5
        initialized = False
        if path and os.path.exists(path):
            initialized = mt5.initialize(path=path, login=login, password=password, server=server)
        else:
            initialized = mt5.initialize(login=login, password=password, server=server)

        if not initialized:
            err = mt5.last_error()
            shared_dict[acc_id] = {'status': 'ERROR', 'error': str(err)}
            logging.error(f"[{acc_name}] MT5 Init Failed: {err}")
            return

        # --- FIX: Watch ALL Symbols (Configured + Global Watchlist) ---
        watched_symbols = set(['XAUUSD'])

        # 1. Add symbols from Account Config
        if 'SYMBOL_CONFIG' in account_data:
            for s in account_data['SYMBOL_CONFIG']:
                watched_symbols.add(s)

        # 2. Add symbols from Global Database List (passed in args)
        for s in global_symbols:
            watched_symbols.add(s)

        # 3. Select them in MT5
        for s in watched_symbols:
            mt5.symbol_select(s, True)

        logging.info(f"[{acc_name}] Worker Started. Watching {len(watched_symbols)} symbols.")

        while True:
            # --- COMMAND PROCESSING ---
            while not cmd_queue.empty():
                cmd = cmd_queue.get()
                action = cmd.get('action')
                req_id = cmd.get('req_id')

                try:
                    if action == 'GET_CANDLES':
                        symbol = cmd['symbol']
                        tf_str = cmd['timeframe']
                        limit = cmd['limit']
                        mt5.symbol_select(symbol, True)
                        tf_map = {"1M": mt5.TIMEFRAME_M1, "3M": mt5.TIMEFRAME_M3, "5M": mt5.TIMEFRAME_M5,
                                  "15M": mt5.TIMEFRAME_M15, "30M": mt5.TIMEFRAME_M30, "1H": mt5.TIMEFRAME_H1,
                                  "4H": mt5.TIMEFRAME_H4, "1D": mt5.TIMEFRAME_D1, "1W": mt5.TIMEFRAME_W1}
                        rates = mt5.copy_rates_from_pos(symbol, tf_map.get(tf_str, mt5.TIMEFRAME_M1), 0, limit)
                        result = []
                        if rates is not None and len(rates) > 0:
                            for r in rates:
                                result.append(
                                    {"time": int(r['time']), "open": float(r['open']), "high": float(r['high']),
                                     "low": float(r['low']), "close": float(r['close'])})
                        if req_id: response_dict[req_id] = result

                    elif action == 'TRADE':
                        req = cmd['payload']
                        symbol = req['symbol']
                        if not mt5.symbol_select(symbol, True):
                            if req_id: trade_results[f"{req_id}_{acc_id}"] = f"{acc_name}: Symbol Error"
                            continue

                        # Filling Mode Logic
                        filling_mode = mt5.ORDER_FILLING_RETURN
                        s_info = mt5.symbol_info(symbol)
                        if s_info:
                            if s_info.filling_mode & 1:
                                filling_mode = mt5.ORDER_FILLING_FOK
                            elif s_info.filling_mode & 2:
                                filling_mode = mt5.ORDER_FILLING_IOC
                        req["type_filling"] = filling_mode

                        # Price Logic
                        if req['action'] == mt5.TRADE_ACTION_DEAL:
                            tick = mt5.symbol_info_tick(symbol)
                            if tick:
                                if req['type'] == mt5.ORDER_TYPE_BUY:
                                    req['price'] = tick.ask
                                elif req['type'] == mt5.ORDER_TYPE_SELL:
                                    req['price'] = tick.bid
                            else:
                                if req_id: trade_results[f"{req_id}_{acc_id}"] = f"{acc_name}: No Price"
                                continue

                        res = mt5.order_send(req)
                        msg = f"{acc_name}: Success" if res and res.retcode == mt5.TRADE_RETCODE_DONE else f"{acc_name}: Error {res.comment if res else 'None'}"
                        if req_id: trade_results[f"{req_id}_{acc_id}"] = msg

                    elif action == 'MODIFY':
                        req = cmd['payload']
                        ticket = int(req['position'])
                        positions = mt5.positions_get(ticket=ticket)
                        if positions:
                            pos = positions[0]
                            val_sl = float(req['sl']) if 'sl' in req else pos.sl
                            val_tp = float(req['tp']) if 'tp' in req else pos.tp
                            mod_req = {"action": mt5.TRADE_ACTION_SLTP, "position": ticket, "symbol": pos.symbol,
                                       "sl": val_sl, "tp": val_tp}
                            mt5.order_send(mod_req)

                    elif action == 'ORDER_MODIFY':
                        req = cmd['payload']
                        req["action"] = mt5.TRADE_ACTION_MODIFY
                        mt5.order_send(req)

                    elif action == 'ORDER_CANCEL':
                        req = cmd['payload']
                        req["action"] = mt5.TRADE_ACTION_REMOVE
                        mt5.order_send(req)

                    elif action == 'CLOSE':
                        ticket = int(cmd['payload']['position'])
                        positions = mt5.positions_get(ticket=ticket)
                        if positions:
                            pos = positions[0]
                            mt5.symbol_select(pos.symbol, True)
                            tick = mt5.symbol_info_tick(pos.symbol)
                            close_price = tick.bid if pos.type == 0 else tick.ask

                            f_mode = mt5.ORDER_FILLING_RETURN
                            s_info = mt5.symbol_info(pos.symbol)
                            if s_info:
                                if s_info.filling_mode & 1:
                                    f_mode = mt5.ORDER_FILLING_FOK
                                elif s_info.filling_mode & 2:
                                    f_mode = mt5.ORDER_FILLING_IOC

                            close_req = {"action": mt5.TRADE_ACTION_DEAL, "position": ticket, "symbol": pos.symbol,
                                         "volume": pos.volume, "type": 1 if pos.type == 0 else 0, "price": close_price,
                                         "deviation": 20, "type_filling": f_mode}
                            mt5.order_send(close_req)

                except Exception as e:
                    logging.error(f"[{acc_name}] Cmd Error: {e}")

            # --- FETCH DATA & PRICES ---
            acc_info = mt5.account_info()
            if acc_info:
                # 1. Fetch Positions
                positions = mt5.positions_get()
                pos_list = []
                if positions:
                    for p in positions:
                        pos_list.append({
                            "ticket": p.ticket, "symbol": p.symbol, "volume": p.volume,
                            "type": "BUY" if p.type == 0 else "SELL",
                            "price_open": p.price_open, "price_current": p.price_current,
                            "sl": p.sl, "tp": p.tp, "profit": p.profit,
                            "account_name": acc_name, "account_login": login
                        })

                # 2. Fetch Orders
                orders = mt5.orders_get()
                ord_list = []
                if orders:
                    for o in orders:
                        is_buy = o.type in [mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP,
                                            mt5.ORDER_TYPE_BUY_STOP_LIMIT]
                        ord_list.append({
                            "ticket": o.ticket, "symbol": o.symbol, "volume": o.volume_current,
                            "type": "BUY" if is_buy else "SELL",
                            "price_open": o.price_open, "sl": o.sl, "tp": o.tp, "account": acc_name
                        })

                # 3. Fetch Prices for ALL Watched Symbols
                price_map = {}
                for sym in watched_symbols:
                    tick = mt5.symbol_info_tick(sym)
                    if tick:
                        price_map[sym] = {'bid': tick.bid, 'ask': tick.ask}

                # Update Shared State
                shared_dict[acc_id] = {
                    'ID': acc_id, 'balance': acc_info.balance, 'equity': acc_info.equity,
                    'margin_free': acc_info.margin_free, 'positions': pos_list,
                    'orders': ord_list, 'prices': price_map, 'status': 'ONLINE'
                }
            else:
                # Lost connection to account
                shared_dict[acc_id] = {'status': 'CONNECTING', 'error': 'Account Info Null'}

            time.sleep(0.05)

    except Exception as e:
        logging.critical(f"[{acc_name}] CRASH: {e}")
        shared_dict[acc_id] = {'status': 'CRASHED', 'error': str(e)}


# --- PROCESS MANAGER ---
def start_worker_for_account(acc_data):
    acc_id = str(acc_data['ID'])
    if acc_id in WORKER_PROCESSES: return

    logging.info(f"Spawning Worker for {acc_id}")
    ACCOUNT_CONFIGS[acc_id] = acc_data.get('SYMBOL_CONFIG', {})

    # --- FETCH GLOBAL SYMBOLS ---
    # This ensures the worker watches all symbols in the dashboard watchlist
    global_symbols = []
    try:
        db = get_db()
        docs = db.collection('SYMBOLS').stream()
        global_symbols = [doc.id for doc in docs]
    except Exception as e:
        logging.error(f"Failed to fetch global symbols: {e}")
        global_symbols = ['XAUUSD'] # Fallback

    q = Queue()
    COMMAND_QUEUES[acc_id] = q
    # Pass global_symbols to worker
    p = Process(target=account_worker_loop, args=(acc_data, q, SHARED_DATA, RESPONSE_DICT, TRADE_RESULTS, global_symbols))
    p.daemon = True
    p.start()
    WORKER_PROCESSES[acc_id] = p


def stop_worker_for_account(acc_id):
    acc_id = str(acc_id)
    if acc_id in WORKER_PROCESSES:
        p = WORKER_PROCESSES[acc_id]
        p.terminate()
        p.join()
        del WORKER_PROCESSES[acc_id]
        if acc_id in COMMAND_QUEUES: del COMMAND_QUEUES[acc_id]
        if acc_id in ACCOUNT_CONFIGS: del ACCOUNT_CONFIGS[acc_id] # Clean up
        if acc_id in SHARED_DATA:
            d = SHARED_DATA[acc_id]
            d['status'] = 'OFFLINE'
            SHARED_DATA[acc_id] = d


# --- BROADCASTER ---
def broadcast_loop():
    while True:
        try:
            total_bal = 0.0
            total_eq = 0.0
            total_margin_free = 0.0
            all_positions = []
            all_orders = []
            combined_prices = {}

            data_snapshot = SHARED_DATA.copy()
            active_count = 0

            for acc_id, data in data_snapshot.items():
                if data.get('status') == 'ONLINE':
                    active_count += 1
                    total_bal += float(data.get('balance', 0))
                    total_eq += float(data.get('equity', 0))
                    total_margin_free += float(data.get('margin_free', 0))
                    all_positions.extend(data.get('positions', []))
                    all_orders.extend(data.get('orders', []))

                    # Merge Prices
                    if 'prices' in data:
                        combined_prices.update(data['prices'])

            payload = {
                'balance': total_bal, 'equity': total_eq, 'margin_free': total_margin_free,
                'profit': total_eq - total_bal, 'positions': all_positions, 'orders': all_orders,
                'prices': combined_prices, 'active_accounts': active_count
            }
            socketio.emit('dashboard_update', payload)
            socketio.sleep(0.25)
        except Exception as e:
            logging.error(f"Broadcast Error: {e}")
            socketio.sleep(1)


# --- HELPER: USER ACCOUNT SYNC ---
def sync_user_accounts(user_id):
    try:
        db = get_db()
        docs = db.collection('USERS').document(user_id).collection('ACCOUNTS').stream()
        for doc in docs:
            acc = dict(doc.to_dict(), ID=doc.id)
            if acc.get('IS_ACTIVE'):
                start_worker_for_account(acc)
    except Exception as e:
        logging.error(f"Sync User Accounts Error: {e}")


# --- ROUTES ---

@app.route('/api/login', methods=['POST'])
def login():
    try:
        data = request.json
        db = get_db()
        docs = db.collection('USERS').where('MOBILE', '==', data.get('mobile')).get()
        if not docs: return jsonify({"error": "User not found"}), 404
        user_doc = docs[0]
        if user_doc.to_dict().get('PASS') == data.get('password'):
            logging.info(f"Login successful for {user_doc.id}")
            sync_user_accounts(user_doc.id)
            return jsonify({"status": "success", "user_id": user_doc.id})
        return jsonify({"error": "Invalid Password"}), 401
    except Exception as e:
        logging.error(f"Login Exception: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/symbols', methods=['GET'])
def get_symbols():
    try:
        db = get_db()
        docs = db.collection('SYMBOLS').stream()
        symbols = []
        for doc in docs:
            data = doc.to_dict()
            symbols.append({
                "sym": doc.id,
                "desc": data.get("DESC", ""),
                "trail": data.get("TRAIL_AMOUNT", 0.5)
            })
        return jsonify(symbols)
    except Exception as e:
        return jsonify([])


@app.route('/api/candles', methods=['GET'])
def get_candles():
    symbol = request.args.get('symbol', 'XAUUSD')
    timeframe = request.args.get('timeframe', '1M')
    limit = int(request.args.get('limit', 1000))

    # Fail fast if no workers (Frontend will retry in 500ms)
    if not COMMAND_QUEUES:
        return jsonify([])

    target_acc = list(COMMAND_QUEUES.keys())[0]
    q = COMMAND_QUEUES[target_acc]
    req_id = str(uuid.uuid4())

    cmd = {
        'action': 'GET_CANDLES',
        'req_id': req_id,
        'symbol': symbol,
        'timeframe': timeframe,
        'limit': limit
    }
    q.put(cmd)

    # Wait max 3s (down from 8s) to prevent browser hang
    start_t = time.time()
    while time.time() - start_t < 3:
        if req_id in RESPONSE_DICT:
            data = RESPONSE_DICT.pop(req_id)
            return jsonify(data)
        time.sleep(0.01)  # Ultra-fast poll

    return jsonify([])


@app.route('/api/trade', methods=['POST'])
@app.route('/api/trade', methods=['POST'])
def place_trade():
    data = request.json
    symbol = data['symbol']
    action = data['type']
    multiplier = float(data['volume'])  # INPUT IS NOW MULTIPLIER
    is_limit = data.get('order_type') == 'LIMIT'
    price = float(data.get('price', 0))
    sl = float(data.get('sl', 0))
    tp = float(data.get('tp', 0))

    order_type = mt5.ORDER_TYPE_BUY if action == 'BUY' else mt5.ORDER_TYPE_SELL
    if is_limit:
        order_type = mt5.ORDER_TYPE_BUY_LIMIT if action == 'BUY' else mt5.ORDER_TYPE_SELL_LIMIT

    active_accounts = [k for k, v in SHARED_DATA.items() if v.get('status') == 'ONLINE']
    req_id = str(uuid.uuid4())

    dispatched_count = 0
    for acc_id in active_accounts:
        # --- VOLUME CALCULATION LOGIC ---
        base_vol = 0.01  # Default fallback

        # Look up config
        config = ACCOUNT_CONFIGS.get(acc_id, {})

        # Find matching rule (e.g. "XAU" rule matches "XAUUSD" symbol)
        match_key = None
        for key in config:
            if symbol.upper().startswith(key.upper()):
                match_key = key
                break

        if match_key:
            rule = config[match_key]
            # Handle if rule is dict or direct value
            if isinstance(rule, dict):
                base_vol = float(rule.get('VOLUME', 0.01))
            else:
                base_vol = float(rule)

        # Final Volume = Rule Volume * Dashboard Input (Multiplier)
        final_vol = round(base_vol * multiplier, 2)
        if final_vol < 0.01: final_vol = 0.01

        req = {
            "action": mt5.TRADE_ACTION_PENDING if is_limit else mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": final_vol,
            "type": order_type,
            "price": price if is_limit else 0,
            "sl": sl, "tp": tp, "deviation": 20,
            "type_time": mt5.ORDER_TIME_GTC
        }

        if acc_id in COMMAND_QUEUES:
            COMMAND_QUEUES[acc_id].put({'action': 'TRADE', 'payload': req, 'req_id': req_id})
            dispatched_count += 1

    if dispatched_count == 0:
        return jsonify({"message": "No active accounts", "details": []})

    # Wait for Results
    results_list = []
    start_wait = time.time()

    while time.time() - start_wait < 10:
        finished = True
        current_batch_results = []
        for acc_id in active_accounts:
            key = f"{req_id}_{acc_id}"
            if key in TRADE_RESULTS:
                current_batch_results.append(TRADE_RESULTS[key])
            else:
                finished = False

        if finished:
            results_list = current_batch_results
            for acc_id in active_accounts:
                key = f"{req_id}_{acc_id}"
                if key in TRADE_RESULTS: del TRADE_RESULTS[key]
            break
        time.sleep(0.1)

    if not results_list:
        for acc_id in active_accounts:
            key = f"{req_id}_{acc_id}"
            if key in TRADE_RESULTS:
                results_list.append(TRADE_RESULTS[key])
                del TRADE_RESULTS[key]
            else:
                results_list.append(f"Account {acc_id}: Timeout")

    return jsonify({"message": "Done", "details": results_list, "blocked": False})


@app.route('/api/modify', methods=['POST'])
def modify_trade():
    data = request.json
    ticket = data.get('ticket')  # Could be "12345" (int) or "XAUUSD_BUY" (string)
    sl = float(data.get('sl')) if data.get('sl') is not None else None
    tp = float(data.get('tp')) if data.get('tp') is not None else None

    data_snapshot = SHARED_DATA.copy()
    targets = []  # List of { acc_id, real_ticket }

    # 1. Try Finding Exact Ticket Match First
    found_exact = False
    for acc_id, acc_data in data_snapshot.items():
        for pos in acc_data.get('positions', []):
            if str(pos['ticket']) == str(ticket):
                targets.append({'acc': acc_id, 'ticket': pos['ticket']})
                found_exact = True
                break
        if found_exact: break

    # 2. If not exact, check for Master Ticket (Group)
    if not found_exact and isinstance(ticket, str) and "_" in ticket:
        # Expected format: "SYMBOL_TYPE" (e.g. XAUUSD_BUY)
        try:
            parts = ticket.split('_')
            sym = parts[0]
            p_type = parts[1]  # "BUY" or "SELL"

            for acc_id, acc_data in data_snapshot.items():
                for pos in acc_data.get('positions', []):
                    if pos['symbol'] == sym and pos['type'] == p_type:
                        targets.append({'acc': acc_id, 'ticket': pos['ticket']})
        except:
            pass

    if not targets:
        return jsonify({"error": "Position not found"}), 404

    # Dispatch to all targets
    for t in targets:
        cmd = {'action': 'MODIFY', 'payload': {'position': t['ticket']}}
        if sl is not None: cmd['payload']['sl'] = sl
        if tp is not None: cmd['payload']['tp'] = tp

        if t['acc'] in COMMAND_QUEUES:
            COMMAND_QUEUES[t['acc']].put(cmd)

    return jsonify({"status": "queued", "count": len(targets)})


@app.route('/api/close', methods=['POST'])
def close_trade():
    data = request.json
    ticket = data.get('ticket')

    data_snapshot = SHARED_DATA.copy()
    targets = []

    # 1. Exact Match
    found_exact = False
    for acc_id, acc_data in data_snapshot.items():
        for pos in acc_data.get('positions', []):
            if str(pos['ticket']) == str(ticket):
                targets.append({'acc': acc_id, 'ticket': pos['ticket']})
                found_exact = True
                break
        if found_exact: break

    # 2. Master Group Match
    if not found_exact and isinstance(ticket, str) and "_" in ticket:
        try:
            parts = ticket.split('_')
            sym = parts[0]
            p_type = parts[1]
            for acc_id, acc_data in data_snapshot.items():
                for pos in acc_data.get('positions', []):
                    if pos['symbol'] == sym and pos['type'] == p_type:
                        targets.append({'acc': acc_id, 'ticket': pos['ticket']})
        except:
            pass

    if not targets:
        return jsonify({"error": "Position not found"}), 404

    for t in targets:
        if t['acc'] in COMMAND_QUEUES:
            COMMAND_QUEUES[t['acc']].put({'action': 'CLOSE', 'payload': {'position': t['ticket']}})

    return jsonify({"status": "queued", "count": len(targets)})


@app.route('/api/order/modify', methods=['POST'])
def modify_order():
    data = request.json
    ticket = data.get('ticket')
    price = float(data.get('price', 0))
    sl = float(data.get('sl', 0))
    tp = float(data.get('tp', 0))
    target_acc = None
    real_ticket = ticket
    data_snapshot = SHARED_DATA.copy()
    for acc_id, acc_data in data_snapshot.items():
        for order in acc_data.get('orders', []):
            if str(order['ticket']) == str(ticket):
                target_acc = acc_id
                real_ticket = order['ticket']
                break
    if target_acc:
        req = {"order": real_ticket, "price": price, "sl": sl, "tp": tp}
        COMMAND_QUEUES[target_acc].put({'action': 'ORDER_MODIFY', 'payload': req})
        return jsonify({"success": True})
    return jsonify({"success": False, "message": "Order not found"})


@app.route('/api/order/cancel', methods=['POST'])
def cancel_order():
    data = request.json
    ticket = data.get('ticket')
    target_acc = None
    real_ticket = ticket
    data_snapshot = SHARED_DATA.copy()
    for acc_id, acc_data in data_snapshot.items():
        for order in acc_data.get('orders', []):
            if str(order['ticket']) == str(ticket):
                target_acc = acc_id
                real_ticket = order['ticket']
                break
    if target_acc:
        req = {"order": real_ticket}
        COMMAND_QUEUES[target_acc].put({'action': 'ORDER_CANCEL', 'payload': req})
        return jsonify({"success": True})
    return jsonify({"success": False, "message": "Order not found"})


@app.route('/api/accounts', methods=['GET', 'POST'])
def manage_accounts():
    db = get_db()
    if request.method == 'GET':
        user_id = request.args.get('user_id')
        if not user_id: return jsonify([])
        try:
            docs = db.collection('USERS').document(user_id).collection('ACCOUNTS').stream()
            accs = [dict(d.to_dict(), ID=d.id) for d in docs]
            for acc in accs:
                if acc.get('IS_ACTIVE') and str(acc['ID']) not in WORKER_PROCESSES:
                    start_worker_for_account(acc)
            return jsonify(accs)
        except Exception as e:
            return jsonify([])
    if request.method == 'POST':
        data = request.json
        user_id = data.get('user_id')
        doc_id = data.get('ID') or str(uuid.uuid4())
        data['ID'] = doc_id
        db.collection('USERS').document(user_id).collection('ACCOUNTS').document(doc_id).set(data)
        if data.get('IS_ACTIVE'):
            start_worker_for_account(data)
        return jsonify({"status": "saved", "id": doc_id})


@app.route('/api/accounts/delete', methods=['POST'])
def delete_account():
    data = request.json
    user_id = data.get('user_id')
    acc_id = str(data.get('ID'))
    get_db().collection('USERS').document(user_id).collection('ACCOUNTS').document(acc_id).delete()
    stop_worker_for_account(acc_id)
    return jsonify({"status": "deleted"})


@app.route('/api/accounts/toggle', methods=['POST'])
def toggle_account():
    data = request.json
    user_id = data.get('user_id')
    acc_id = str(data.get('ID'))
    is_active = data.get('IS_ACTIVE')
    get_db().collection('USERS').document(user_id).collection('ACCOUNTS').document(acc_id).update(
        {'IS_ACTIVE': is_active})
    if is_active:
        doc = get_db().collection('USERS').document(user_id).collection('ACCOUNTS').document(acc_id).get()
        if doc.exists:
            start_worker_for_account(dict(doc.to_dict(), ID=doc.id))
    else:
        stop_worker_for_account(acc_id)
    return jsonify({"status": "updated"})


if __name__ == '__main__':
    multiprocessing.freeze_support()
    print("Starting Multi-Process Backend (Auto-Fill Fixed)...")

    manager = Manager()
    SHARED_DATA = manager.dict()
    RESPONSE_DICT = manager.dict()
    TRADE_RESULTS = manager.dict()

    socketio.start_background_task(broadcast_loop)

    print("Server Listening on 5000...")
    socketio.run(app, debug=False, port=5000, allow_unsafe_werkzeug=True)