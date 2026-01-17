from flask import Flask, request, jsonify
from flask_cors import CORS
import MetaTrader5 as mt5
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timedelta

app = Flask(__name__)
CORS(app)

# --- CONFIGURATION ---
MT5_PATH = "C:\\Program Files\\MetaTrader 5\\terminal64.exe"

# --- FIREBASE SETUP ---
if not firebase_admin._apps:
    cred = credentials.Certificate("serviceAccountKey.json")
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


@app.route('/api/dashboard', methods=['GET'])
def get_dashboard_data():
    mobile = request.args.get('mobile')
    if not mobile: return jsonify({"error": "Mobile required"}), 400

    # Uses cached credentials now (Fast)
    success, msg = connect_to_mt5(mobile)
    if not success: return jsonify({"error": msg}), 400

    try:
        info = mt5.account_info()
        if not info: return jsonify({"error": "Failed to fetch info"}), 500

        # Positions
        positions = mt5.positions_get()
        pos_data = []
        if positions:
            for pos in positions:
                pos_data.append({
                    "ticket": pos.ticket,
                    "symbol": pos.symbol,
                    "type": "BUY" if pos.type == 0 else "SELL",
                    "volume": pos.volume,
                    "price_open": pos.price_open,
                    "price_current": pos.price_current,
                    "profit": pos.profit,
                    "sl": pos.sl,
                    "tp": pos.tp
                })

        # History
        from_date = datetime.now() - timedelta(days=30)
        history = mt5.history_deals_get(from_date, datetime.now())
        hist_data = []
        if history:
            for deal in history:
                if deal.entry == 1:
                    hist_data.append({
                        "timestamp": int(deal.time),
                        "time": datetime.fromtimestamp(deal.time).strftime('%Y-%m-%d %H:%M'),
                        "symbol": deal.symbol,
                        "type": "BUY" if deal.type == 0 else "SELL",
                        "volume": deal.volume,
                        "price": deal.price,
                        "profit": deal.profit
                    })
            hist_data.sort(key=lambda x: x['timestamp'], reverse=True)

        return jsonify({
            "balance": info.balance,
            "equity": info.equity,
            "margin_free": info.margin_free,
            "profit": info.profit,
            "positions": pos_data,
            "history": hist_data
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
    data = request.json
    mobile = data.get('mobile')
    symbol = data.get('symbol', 'BTCUSDT')  # Default to what you are using
    action_type = data.get('type')
    volume = float(data.get('volume', 0.01))

    success, msg = connect_to_mt5(mobile)
    if not success: return jsonify({"error": msg}), 400

    # 1. Check Algo Trading
    if not mt5.terminal_info().trade_allowed:
        return jsonify({"error": "Algo Trading is OFF. Enable it in MT5 Terminal."}), 403

    # 2. Select Symbol & Get Price
    if not mt5.symbol_select(symbol, True):
        return jsonify({"error": f"Symbol {symbol} not found"}), 404

    tick = mt5.symbol_info_tick(symbol)
    if not tick: return jsonify({"error": "Market Closed"}), 400

    price = tick.ask if action_type == 'BUY' else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if action_type == 'BUY' else mt5.ORDER_TYPE_SELL

    # 3. GET CORRECT FILLING MODE (The Fix)
    fill_mode = get_filling_mode(symbol)

    request_data = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "deviation": 20,
        "magic": 234000,
        "comment": "Midnight Pro Web",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": fill_mode,  # <--- Updated here
    }

    result = mt5.order_send(request_data)

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        # Debugging: Print exactly what failed to Python console
        print(f"Trade Failed: {result.comment}, RetCode: {result.retcode}")
        return jsonify({"error": f"Order Failed: {result.comment} ({result.retcode})"}), 400

    return jsonify({"message": "Order Placed", "ticket": result.order})


@app.route('/api/modify', methods=['POST'])
def modify_trade():
    data = request.json
    mobile = data.get('mobile')
    try:
        ticket = int(data.get('ticket'))
    except:
        return jsonify({"error": "Invalid Ticket"}), 400

    success, msg = connect_to_mt5(mobile)
    if not success: return jsonify({"error": msg}), 400

    # 1. FETCH CURRENT POSITION (Crucial Step)
    # We need to see what the current SL/TP is so we don't accidentally delete it.
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        return jsonify({"error": "Position not found or already closed"}), 404

    current_pos = positions[0]

    # 2. MERGE NEW VALUES WITH OLD VALUES
    # If 'sl' is in data, use it. Otherwise, keep the old SL.
    # If 'tp' is in data, use it. Otherwise, keep the old TP.

    new_sl = float(data['sl']) if 'sl' in data else current_pos.sl
    new_tp = float(data['tp']) if 'tp' in data else current_pos.tp

    request_data = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": ticket,
        "sl": new_sl,
        "tp": new_tp
    }

    result = mt5.order_send(request_data)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({"error": f"Modify Failed: {result.comment}"}), 400

    return jsonify({"message": "Position Updated", "sl": new_sl, "tp": new_tp})


# ... inside app.py ...

@app.route('/api/close', methods=['POST'])
def close_trade():
    try:
        data = request.json
        mobile = data.get('mobile')
        ticket = int(data.get('ticket'))

        success, msg = connect_to_mt5(mobile)
        if not success: return jsonify({"error": msg}), 400

        # 1. Select Position
        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return jsonify({"error": "Position not found or already closed"}), 404

        pos = positions[0]

        # 2. Get Closing Price
        symbol = pos.symbol
        if not mt5.symbol_select(symbol, True):
            return jsonify({"error": "Symbol select failed"}), 404

        tick = mt5.symbol_info_tick(symbol)
        if not tick: return jsonify({"error": "Market Closed"}), 400

        # Closing logic: Buy -> Sell, Sell -> Buy
        price = tick.bid if pos.type == 0 else tick.ask
        order_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY

        # 3. Filling Mode
        fill_mode = get_filling_mode(symbol)

        # 4. Send Close Order
        request_data = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": pos.volume,
            "type": order_type,
            "position": ticket,
            "price": price,
            "deviation": 20,
            "magic": 234000,
            "comment": "Midnight Pro Close",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": fill_mode,
        }

        result = mt5.order_send(request_data)

        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return jsonify({"error": f"Close Failed: {result.comment}"}), 400

        # FIX: Removed 'result.profit' because it causes the 500 Crash
        return jsonify({"message": "Trade Closed Successfully", "ticket": result.order})

    except Exception as e:
        print(f"CLOSE ERROR: {e}")
        return jsonify({"error": f"Server Error: {str(e)}"}), 500


if __name__ == '__main__':
    # Threaded=True allows multiple requests to be processed at once (Fixes blocking)
    app.run(port=5000, debug=True, use_reloader=False, threaded=True)