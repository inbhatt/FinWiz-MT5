from flask import Flask, request, jsonify
from flask_cors import CORS
import MetaTrader5 as mt5
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timedelta
import sys
import os

app = Flask(__name__)
CORS(app)

# --- CONFIGURATION ---
MT5_PATH = "C:\\Program Files\\MetaTrader 5\\terminal64.exe"

# --- FIREBASE SETUP ---

def get_resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")

    return os.path.join(base_path, relative_path)

if not firebase_admin._apps:
    cred_path = get_resource_path("serviceAccountKey.json")
    cred = credentials.Certificate(cred_path)
    firebase_admin.initialize_app(cred)

db = firestore.client()

# --- OPTIMIZATION: CREDENTIALS CACHE ---
# Stores { "mobile_number": {user, pass, server} }
# Prevents slow Firebase lookups on every request
USER_CACHE = {}


# --- HELPER: MT5 CONNECTION ---
def connect_to_mt5(user_mobile):
    global USER_CACHE

    try:
        # 1. CHECK CACHE FIRST (Super Fast)
        creds = USER_CACHE.get(user_mobile)

        # 2. IF NOT IN CACHE, FETCH FROM FIREBASE (Slow, but done once)
        if not creds:
            print(f"Fetching credentials for {user_mobile} from Firebase...")
            users_ref = db.collection('USERS').where('MOBILE', '==', user_mobile).stream()
            user_doc = next(users_ref, None)

            if not user_doc: return False, "User not found"

            accounts_ref = db.collection('USERS').document(user_doc.id).collection('ACCOUNTS')
            mt5_query = accounts_ref.where('TYPE', '==', 'METATRADER').stream()
            account = next(mt5_query, None)

            if not account: return False, "No MT5 Account linked"

            creds = account.to_dict()
            # Save to Cache
            USER_CACHE[user_mobile] = creds

        # 3. EXTRACT & LOGIN
        mt5_id = creds.get('USER')
        mt5_pass = creds.get('PASS')
        mt5_server = creds.get('SERVER')

        if not mt5_id or not mt5_pass: return False, "Incomplete Credentials"

        # Initialize if needed
        if not mt5.terminal_info():
            if not mt5.initialize(path=MT5_PATH):
                return False, f"MT5 Init Failed: {mt5.last_error()}"

        # Check if already logged in to correct account to avoid re-login overhead
        current_account = mt5.account_info()
        if current_account and current_account.login == int(mt5_id):
            return True, "Connected"

        # Login
        authorized = mt5.login(int(mt5_id), password=mt5_pass, server=mt5_server)
        if authorized:
            return True, "Connected"
        else:
            return False, f"Login Failed: {mt5.last_error()}"

    except Exception as e:
        return False, f"Server Error: {str(e)}"


def ensure_mt5_connection():
    if not mt5.terminal_info():
        if not mt5.initialize(path=MT5_PATH):
            return False
    return True


# --- ENDPOINTS ---

@app.route('/login', methods=['POST'])
def login():
    return jsonify({"status": "success", "message": "Login Authorized"})


def get_aggregated_positions(mobile):
    # Get ALL open positions
    raw_positions = mt5.positions_get()
    if raw_positions is None: return []

    agg_map = {}  # Key: "SYMBOL_TYPE" (e.g. "BTCUSD_0")

    for pos in raw_positions:
        key = f"{pos.symbol}_{pos.type}"  # 0=Buy, 1=Sell

        if key not in agg_map:
            agg_map[key] = {
                "symbol": pos.symbol,
                "type_int": pos.type,
                "type": "BUY" if pos.type == 0 else "SELL",
                "tickets": [],  # List of all real MT5 tickets
                "volume": 0.0,
                "weighted_price_sum": 0.0,
                "profit": 0.0,
                "sl": pos.sl,  # Inherit from first found
                "tp": pos.tp,  # Inherit from first found
                "price_current": pos.price_current
            }

        # Accumulate Data
        data = agg_map[key]
        data["tickets"].append(pos.ticket)
        data["volume"] += pos.volume
        data["weighted_price_sum"] += (pos.price_open * pos.volume)
        data["profit"] += pos.profit + pos.swap  # Include swap in P/L

        # Sync Current Price (Always fresh)
        data["price_current"] = pos.price_current

    # Finalize Averages
    results = []
    for key, data in agg_map.items():
        avg_price = data["weighted_price_sum"] / data["volume"]

        # Create a "Virtual Ticket" string to identify this group
        # Format: "BTCUSD_BUY"
        virtual_ticket = f"{data['symbol']}_{data['type']}"

        results.append({
            "ticket": virtual_ticket,  # <--- STRING ID NOW
            "real_tickets": data["tickets"],  # Keep real IDs for backend use
            "symbol": data["symbol"],
            "type": data["type"],
            "volume": round(data["volume"], 2),
            "price_open": round(avg_price, 5),
            "price_current": data["price_current"],
            "sl": data["sl"],
            "tp": data["tp"],
            "profit": round(data["profit"], 2)
        })

    return results

@app.route('/api/dashboard', methods=['GET'])
def get_dashboard_data():
    mobile = request.args.get('mobile')
    success, msg = connect_to_mt5(mobile)
    if not success: return jsonify({"error": msg}), 400

    account_info = mt5.account_info()
    if not account_info: return jsonify({"error": "Account Info Failed"}), 500

    # 1. Get Open Positions (Aggregated)
    positions = get_aggregated_positions(mobile)

    # 2. Get History (Corrected Logic)
    history = []
    from_date = datetime.now() - timedelta(days=30)
    raw_history = mt5.history_deals_get(from_date, datetime.now())

    if raw_history:
        for deal in raw_history:
            # We only care about exit deals (closing trades)
            if deal.entry == mt5.DEAL_ENTRY_OUT:
                # --- FIX: INVERT THE TYPE ---
                # Closing a BUY requires a SELL deal (Type 1)
                # Closing a SELL requires a BUY deal (Type 0)
                # So if deal.type is 1 (Sell), original trade was BUY.
                trade_type = "BUY" if deal.type == 1 else "SELL"

                history.append({
                    "time": datetime.fromtimestamp(deal.time).strftime('%Y-%m-%d %H:%M'),
                    "symbol": deal.symbol,
                    "type": trade_type,  # <--- Uses corrected type
                    "volume": deal.volume,
                    "price": deal.price,
                    "profit": deal.profit
                })

    # Show newest first
    history.reverse()

    return jsonify({
        "balance": account_info.balance,
        "equity": account_info.equity,
        "margin_free": account_info.margin_free,
        "profit": account_info.profit,
        "positions": positions,
        "history": history
    })


# ... inside backend/app.py ...

@app.route('/api/candles', methods=['GET'])
def get_candles():
    if not ensure_mt5_connection():
        return jsonify({"error": "MT5 Not Connected"}), 500

    symbol = request.args.get('symbol', 'XAUUSD')
    timeframe_str = request.args.get('timeframe', '1H')

    # 1. Force Symbol Selection (Crucial for Live Ticks)
    if not mt5.symbol_select(symbol, True):
        print(f"Failed to select {symbol}")  # Debug print
        return jsonify({"error": f"Symbol {symbol} not found"}), 404

    try:
        limit = int(request.args.get('limit', 2000))
    except:
        limit = 2000

    tf_map = {
        '1M': mt5.TIMEFRAME_M1, '5M': mt5.TIMEFRAME_M5, '15M': mt5.TIMEFRAME_M15,
        '1H': mt5.TIMEFRAME_H1, '4H': mt5.TIMEFRAME_H4, '1D': mt5.TIMEFRAME_D1
    }
    tf = tf_map.get(timeframe_str, mt5.TIMEFRAME_H1)

    # 2. Get Chart History
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, limit)

    if rates is None: return jsonify([])

    data = []
    for rate in rates:
        data.append({
            "time": int(rate['time']),
            "open": rate['open'],
            "high": rate['high'],
            "low": rate['low'],
            "close": rate['close']
        })

    # 3. LIVE TICK OVERWRITE
    # This ensures the chart shows the *exact* current price, not the last saved minute.
    try:
        tick = mt5.symbol_info_tick(symbol)
        if tick and len(data) > 0:
            last_candle = data[-1]

            # Use 'bid' price for the close
            current_price = tick.bid
            last_candle['close'] = current_price

            # Expand High/Low if the live price pushes the candle boundaries
            if current_price > last_candle['high']: last_candle['high'] = current_price
            if current_price < last_candle['low']: last_candle['low'] = current_price

            data[-1] = last_candle

            # Debug Print to Python Console (Check your PyCharm terminal)
            # print(f"Tick {symbol}: {current_price}")
    except Exception as e:
        print(f"Tick update error: {e}")

    return jsonify(data)


def get_filling_mode(symbol):
    symbol_info = mt5.symbol_info(symbol)
    if not symbol_info:
        return mt5.ORDER_FILLING_FOK

    # filling_mode is a bitmask:
    # 1 means FOK is allowed
    # 2 means IOC is allowed

    modes = symbol_info.filling_mode

    # Check for FOK (Fill or Kill) - Preferred for Crypto
    if modes & 1:
        return mt5.ORDER_FILLING_FOK

    # Check for IOC (Immediate or Cancel)
    if modes & 2:
        return mt5.ORDER_FILLING_IOC

    # Fallback
    return mt5.ORDER_FILLING_RETURN

@app.route('/api/trade', methods=['POST'])
def place_trade():
    try:
        data = request.json
        mobile = data.get('mobile')
        symbol = data.get('symbol')
        action_type = data.get('type')  # 'BUY' or 'SELL'
        volume = float(data.get('volume'))

        connect_to_mt5(mobile)

        # --- 1. CHECK EXISTING POSITIONS (Blocking & Syncing) ---
        positions = mt5.positions_get(symbol=symbol)

        target_sl = 0.0
        target_tp = 0.0

        if positions:
            for pos in positions:
                existing_type = "BUY" if pos.type == 0 else "SELL"

                # BLOCKING LOGIC: If opposite type exists, DENY.
                if existing_type != action_type:
                    return jsonify({
                                       "error": f"Cannot {action_type}. Close existing {existing_type} positions on {symbol} first."}), 400

                # INHERIT LOGIC: Grab SL/TP from existing trade
                # We simply take the first one we find
                if pos.sl > 0: target_sl = pos.sl
                if pos.tp > 0: target_tp = pos.tp

        # --- 2. PREPARE ORDER ---
        tick = mt5.symbol_info_tick(symbol)
        price = tick.ask if action_type == 'BUY' else tick.bid
        order_type = mt5.ORDER_TYPE_BUY if action_type == 'BUY' else mt5.ORDER_TYPE_SELL

        request_data = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": volume,
            "type": order_type,
            "price": price,
            "sl": target_sl,  # <--- Auto-Inherited
            "tp": target_tp,  # <--- Auto-Inherited
            "deviation": 20,
            "magic": 234000,
            "comment": "FinWiz",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_FOK,  # Using FOK as safe default
        }

        result = mt5.order_send(request_data)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return jsonify({"error": f"Order Failed: {result.comment}"}), 400

        return jsonify({"message": "Order Placed", "ticket": result.order})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/modify', methods=['POST'])
def modify_trade():
    try:
        data = request.json
        mobile = data.get('mobile')
        # ticket is now "BTCUSD_BUY"
        virtual_ticket = data.get('ticket')

        # Parse Symbol and Type from Virtual ID
        # Format: "SYMBOL_TYPE" (e.g. "BTCUSD_BUY")
        parts = virtual_ticket.split('_')
        symbol = parts[0]
        p_type_str = parts[1]
        p_type_int = 0 if p_type_str == 'BUY' else 1

        connect_to_mt5(mobile)

        # 1. Get ALL real tickets for this symbol & type
        all_positions = mt5.positions_get(symbol=symbol)
        target_positions = [p for p in all_positions if p.type == p_type_int]

        if not target_positions:
            return jsonify({"error": "No positions found to update"}), 404

        # 2. Determine New SL/TP
        # Use new value if provided, else keep existing from the FIRST position
        # (Since we sync them, they should all be the same)
        current_ref = target_positions[0]

        new_sl = float(data['sl']) if 'sl' in data else current_ref.sl
        new_tp = float(data['tp']) if 'tp' in data else current_ref.tp

        # 3. Loop and Update ALL
        errors = []
        for pos in target_positions:
            req = {
                "action": mt5.TRADE_ACTION_SLTP,
                "position": pos.ticket,
                "sl": new_sl,
                "tp": new_tp
            }
            res = mt5.order_send(req)
            if res.retcode != mt5.TRADE_RETCODE_DONE:
                errors.append(f"{pos.ticket}: {res.comment}")

        if errors:
            return jsonify({"error": f"Partial Failure: {', '.join(errors)}"}), 206

        return jsonify({"message": "All Positions Updated"})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ... inside app.py ...

@app.route('/api/close', methods=['POST'])
def close_trade():
    try:
        data = request.json
        mobile = data.get('mobile')
        virtual_ticket = data.get('ticket')  # "BTCUSD_BUY"

        parts = virtual_ticket.split('_')
        symbol = parts[0]
        p_type_str = parts[1]
        p_type_int = 0 if p_type_str == 'BUY' else 1

        connect_to_mt5(mobile)

        # 1. Get positions
        all_positions = mt5.positions_get(symbol=symbol)
        target_positions = [p for p in all_positions if p.type == p_type_int]

        if not target_positions:
            return jsonify({"error": "No positions found"}), 404

        tick = mt5.symbol_info_tick(symbol)
        price = tick.bid if p_type_int == 0 else tick.ask
        order_type = mt5.ORDER_TYPE_SELL if p_type_int == 0 else mt5.ORDER_TYPE_BUY

        # 2. Close ALL
        for pos in target_positions:
            req = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": pos.volume,
                "type": order_type,
                "position": pos.ticket,
                "price": price,
                "deviation": 20,
                "magic": 234000,
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_FOK,
            }
            mt5.order_send(req)

        return jsonify({"message": "Trades Closed"})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    # Threaded=True allows multiple requests to be processed at once (Fixes blocking)
    app.run(port=5000, debug=True, use_reloader=False, threaded=True)