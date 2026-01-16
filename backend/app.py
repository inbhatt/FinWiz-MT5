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


@app.route('/api/trade', methods=['POST'])
def place_trade():
    data = request.json
    mobile = data.get('mobile')
    symbol = data.get('symbol', 'XAUUSD')
    action_type = data.get('type')
    volume = float(data.get('volume', 0.01))

    success, msg = connect_to_mt5(mobile)
    if not success: return jsonify({"error": msg}), 400

    order_type = mt5.ORDER_TYPE_BUY if action_type == 'BUY' else mt5.ORDER_TYPE_SELL

    # FORCE SYMBOL SELECTION
    mt5.symbol_select(symbol, True)

    # Get LIVE Tick Price
    tick = mt5.symbol_info_tick(symbol)
    if not tick: return jsonify({"error": "Market Closed or Symbol Invalid"}), 400

    price = tick.ask if action_type == 'BUY' else tick.bid

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
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request_data)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({"error": f"Order Failed: {result.comment}"}), 400

    return jsonify({"message": "Order Placed", "ticket": result.order})


@app.route('/api/modify', methods=['POST'])
def modify_trade():
    data = request.json
    mobile = data.get('mobile')
    ticket = int(data.get('ticket'))
    sl = float(data.get('sl', 0.0))
    tp = float(data.get('tp', 0.0))

    success, msg = connect_to_mt5(mobile)
    if not success: return jsonify({"error": msg}), 400

    request_data = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": ticket,
        "sl": sl,
        "tp": tp
    }

    result = mt5.order_send(request_data)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({"error": f"Modify Failed: {result.comment}"}), 400

    return jsonify({"message": "Position Updated"})


if __name__ == '__main__':
    # Threaded=True allows multiple requests to be processed at once (Fixes blocking)
    app.run(port=5000, debug=True, use_reloader=False, threaded=True)