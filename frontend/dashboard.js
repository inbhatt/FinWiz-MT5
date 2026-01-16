const { ipcRenderer } = require('electron');

// --- GLOBAL STATE ---
let currentMobile = localStorage.getItem("userMobile");
let currentSymbol = 'XAUUSD'; // Default Symbol
let chart, candleSeries;
let priceLines = {}; // Stores chart lines: { ticket: { main, tp, sl, data } }
let isErrorOpen = false;
let currentTimeframe = '1H';
let latestCandle = null;
let draggingLine = null; // Stores drag state: { ticket, type, lineObj, direction }

// --- WATCHLIST CONFIGURATION ---
const WATCHLIST = [
    { sym: 'XAUUSD', desc: 'Gold vs US Dollar' },
    { sym: 'BTCUSD', desc: 'Bitcoin vs Dollar' },
    { sym: 'EURUSD', desc: 'Euro vs US Dollar' },
    { sym: 'GBPUSD', desc: 'Great Britain Pound' },
    { sym: 'USDJPY', desc: 'US Dollar vs Yen' },
    { sym: 'US30',   desc: 'Dow Jones 30' },
    { sym: 'NAS100', desc: 'Nasdaq 100' }
];

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (!currentMobile) {
            showError('Auth Error', 'No user logged in.');
            setTimeout(() => window.location.href = 'index.html', 2000);
            return;
        }

        // 1. Setup UI
        renderWatchlist();
        initChart();

        // 2. Initial Data Load
        await fetchDashboardData();
        await loadFullChartHistory(); // Load 2000 candles for default symbol

        // 3. Start Data Loops
        setInterval(fetchDashboardData, 2000);
        setInterval(updateLiveCandle, 250);  // Poll price updates every 1s

        // 4. Bind Timeframe Buttons
        document.querySelectorAll('.chart-controls button').forEach(btn => {
            if(btn.classList.contains('btn-icon')) return;
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.chart-controls button').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                currentTimeframe = e.target.innerText;
                loadFullChartHistory(); // Reload history on change
            });
        });

    } catch (e) {
        showError('Dashboard Crash', e.toString());
    }
});

// ==================================================
// 1. WATCHLIST & SYMBOL LOGIC
// ==================================================

function renderWatchlist() {
    const container = document.getElementById('watchlist-container');
    container.innerHTML = '';

    WATCHLIST.forEach(item => {
        const div = document.createElement('div');
        div.className = `watchlist-item ${item.sym === currentSymbol ? 'active' : ''}`;
        div.onclick = () => changeSymbol(item.sym);
        div.innerHTML = `
            <div>
                <div class="wl-symbol">${item.sym}</div>
                <div class="wl-desc">${item.desc}</div>
            </div>
        `;
        container.appendChild(div);
    });
}

async function changeSymbol(newSym) {
    if(currentSymbol === newSym) return;

    // 1. Update State
    currentSymbol = newSym;
    document.getElementById('chart-symbol-name').innerText = currentSymbol;

    // 2. Update Sidebar UI
    renderWatchlist();

    // 3. Clear Chart Data & Lines
    candleSeries.setData([]);
    latestCandle = null;
    clearAllChartLines(); // Remove old trade lines

    // 4. Reload Data
    await loadFullChartHistory();
    fetchDashboardData(); // Re-fetch trades to draw lines for new symbol
}

// ==================================================
// 2. CHARTING ENGINE
// ==================================================

function initChart() {
    const container = document.getElementById('chart-container');
    const legend = document.getElementById('chart-legend');

    // Legend Styles (Already Big, keeping it)
    legend.style.fontSize = '16px';
    legend.style.top = '15px';
    legend.style.left = '15px';

    chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
            background: { type: 'solid', color: '#151a30' },
            textColor: '#8a94a6',
            fontSize: 16, // <--- INCREASED TO 16PX (Axis Labels)
            fontFamily: 'Inter, sans-serif'
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' }
        },
        localization: {
            locale: 'en-IN',
            // Update Crosshair Date Format as well
            timeFormatter: (timestamp) => formatDateTime(timestamp)
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        timeScale: {
            timeVisible: true,
            borderColor: 'rgba(255, 255, 255, 0.1)',
            rightOffset: 20,
            tickMarkFormatter: (time, tickMarkType, locale) => {
                // Keep axis simple (Day/Month or Time) to prevent crowding
                const date = new Date(time * 1000);
                if (tickMarkType < 3) {
                    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
                } else {
                    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
                }
            }
        }
    });
    // ... (Rest of initChart remains the same: addSeries, listeners, resizeObserver) ...
    candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: '#36d7b7', downColor: '#ff5555',
        borderVisible: false, wickUpColor: '#36d7b7', wickDownColor: '#ff5555',
    });

    chart.subscribeCrosshairMove(param => {
        if (param.time) {
            const data = param.seriesData.get(candleSeries);
            if(data) updateLegend(data);
        } else {
            if (latestCandle) updateLegend(latestCandle);
        }
    });

    container.addEventListener('click', (e) => { if(draggingLine) commitDrag(e); });
    container.addEventListener('mousemove', (e) => { if(draggingLine) updateDrag(e); });

    new ResizeObserver(entries => {
        if (entries.length === 0 || !entries[0].contentRect) return;
        const newRect = entries[0].contentRect;
        chart.applyOptions({ width: newRect.width, height: newRect.height });
    }).observe(container);
}

function formatDateTime(timestamp) {
    if(!timestamp) return '';
    // If timestamp is seconds (Unix), convert to MS. If it's a string, leave it.
    // MT5 usually sends Unix seconds.
    const d = new Date(typeof timestamp === 'number' ? timestamp * 1000 : timestamp);

    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2); // Get last 2 digits
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');

    return `${day}-${month}-${year} ${hours}:${mins}`;
}

// 2. UPDATE ZOOM LOGIC (Fix "Too Zoomed Out")
async function loadFullChartHistory() {
    try {
        const url = `http://127.0.0.1:5000/api/candles?symbol=${currentSymbol}&timeframe=${currentTimeframe}&limit=2000`;
        const response = await fetch(url);
        const data = await response.json();

        if (data && data.length > 0) {
            candleSeries.setData(data);
            latestCandle = data[data.length - 1];
            updateLegend(latestCandle);

            // --- ZOOM FIX: Show only last 100 candles ---
            const totalCandles = data.length;

            // "to" is slightly past the end to give whitespace on the right
            // "from" is 100 candles back
            chart.timeScale().setVisibleLogicalRange({
                from: totalCandles - 100,
                to: totalCandles + 5
            });

            // Reset scale so the candles aren't flat
            chart.priceScale('right').applyOptions({
                autoScale: true,
            });
        }
    } catch (e) {
        console.error("Chart history load failed", e);
    }
}


function updateLegend(data) {
    const legend = document.getElementById('chart-legend');
    if (!data) return;
    const color = data.close >= data.open ? '#36d7b7' : '#ff5555';
    legend.innerHTML = `<span style="color:${color}">O ${data.open.toFixed(2)} H ${data.high.toFixed(2)} L ${data.low.toFixed(2)} C ${data.close.toFixed(2)}</span>`;
}

// ==================================================
// 3. DATA FETCHING
// ==================================================

// LOAD HISTORY (2000 Candles)
async function loadFullChartHistory() {
    try {
        const url = `http://127.0.0.1:5000/api/candles?symbol=${currentSymbol}&timeframe=${currentTimeframe}&limit=2000`;
        const response = await fetch(url);
        const data = await response.json();

        if (data && data.length > 0) {
            candleSeries.setData(data);
            latestCandle = data[data.length - 1];
            updateLegend(latestCandle);

            // --- FIX 2: FORCE RESET SCALE ---
            // 1. Reset Price Scale to Auto Mode (in case user scrolled)
            chart.priceScale('right').applyOptions({
                autoScale: true,
            });
        }
    } catch (e) {
        console.error("Chart history load failed", e);
    }
}

// LIVE UPDATE (2 Candles)
async function updateLiveCandle() {
    try {
        // 1. Add timestamp to prevent caching
        const url = `http://127.0.0.1:5000/api/candles?symbol=${currentSymbol}&timeframe=${currentTimeframe}&limit=2&_=${Date.now()}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data && data.length > 0) {
            // 2. Get the VERY LATEST candle (The one currently moving)
            const latest = data[data.length - 1];

            // 3. Update Chart
            candleSeries.update(latest);

            // 4. Update Global State & Legend
            latestCandle = latest;
            updateLegend(latest);

            // DEBUG: Uncomment this line to see the price in your browser console (F12)
            // console.log("Live Update:", latest.close);
        }
    } catch (e) {
        console.error("Live update failed", e);
    }
}

// DASHBOARD STATS & TRADES
async function fetchDashboardData() {
    try {
        const response = await fetch(`http://127.0.0.1:5000/api/dashboard?mobile=${currentMobile}`);
        const data = await response.json();

        if(data.error) throw new Error(data.error);

        // Update Stats
        document.getElementById('val-balance').innerText = `$${data.balance.toFixed(2)}`;
        const plEl = document.getElementById('val-pl');
        plEl.innerText = `$${data.profit.toFixed(2)}`;
        plEl.className = data.profit >= 0 ? "stat-value text-green" : "stat-value text-red";
        document.getElementById('val-power').innerText = `$${data.margin_free.toFixed(2)}`;

        // Progress Bar
        const usedMargin = data.balance - data.margin_free;
        const usagePct = data.balance > 0 ? (usedMargin / data.balance) * 100 : 0;
        const bar = document.querySelector('.progress-fill');
        if(bar) bar.style.width = `${usagePct}%`;

        // Tables & Lines
        renderPositions(data.positions);
        renderHistory(data.history);
        updateChartPositions(data.positions);

    } catch (e) { console.log(e); }
}

// ==================================================
// 4. TRADING & INTERACTION
// ==================================================

// PLACE ORDER
async function placeOrder(type) {
    const qty = document.getElementById('trade-qty').value;
    try {
        const res = await fetch('http://127.0.0.1:5000/api/trade', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                mobile: currentMobile,
                symbol: currentSymbol,
                type: type,
                volume: parseFloat(qty)
            })
        });

        const data = await res.json();
        if(data.error) throw new Error(data.error);

        fetchDashboardData(); // Refresh UI immediately

    } catch (e) {
        showError('Order Failed', e.message);
    }
}

// VISUALIZE TRADES ON CHART
function updateChartPositions(positions) {
    const activeTickets = new Set(positions.map(p => p.ticket));

    // 1. Clean up closed trades
    for (let t in priceLines) {
        if (!activeTickets.has(parseInt(t))) {
            candleSeries.removePriceLine(priceLines[t].main);
            delete priceLines[t];
        }
    }

    // 2. Add new active trades (Only for Current Symbol)
    positions.forEach(pos => {
        // Only draw if it matches current symbol AND doesn't exist yet
        if (pos.symbol === currentSymbol && !priceLines[pos.ticket]) {
            const color = pos.type === 'BUY' ? '#36d7b7' : '#ff5555';
            const line = candleSeries.createPriceLine({
                price: pos.price_open,
                color: color,
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title: `${pos.type} ${pos.volume}`,
            });
            priceLines[pos.ticket] = { main: line, data: pos };
        }
    });
}

function clearAllChartLines() {
    for (let t in priceLines) {
        candleSeries.removePriceLine(priceLines[t].main);
    }
    priceLines = {};
}

// DRAG & DROP TP/SL
function startDrag(ticket, type, startPrice) {
    if(draggingLine) return; // Prevent multiple drags

    const color = type === 'TP' ? '#36d7b7' : '#ff5555';
    const ghost = candleSeries.createPriceLine({
        price: startPrice,
        color: color,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `Set ${type}`,
    });

    // Find direction to calc P/L preview
    // We look in priceLines, but if symbol changed it might not be there.
    // Fallback to 'BUY' if not found (just affects P/L calc sign)
    const direction = priceLines[ticket] ? priceLines[ticket].data.type : 'BUY';

    draggingLine = { ticket, type, lineObj: ghost, direction, startPrice };
}

function updateDrag(e) {
    if(!draggingLine) return;

    const price = candleSeries.coordinateToPrice(e.offsetY);
    if(price) {
        draggingLine.lineObj.applyOptions({ price: price });

        // P/L Preview
        const diff = draggingLine.direction === 'BUY' ? (price - draggingLine.startPrice) : (draggingLine.startPrice - price);
        // Approx $ value (simplified)
        const profit = (diff * 100).toFixed(2);
        draggingLine.lineObj.applyOptions({ title: `${draggingLine.type} (Click to set)` });
    }
}

async function commitDrag(e) {
    if(!draggingLine) return;

    const finalPrice = candleSeries.coordinateToPrice(e.offsetY);
    if(!finalPrice) return;

    const reqBody = {
        mobile: currentMobile,
        ticket: draggingLine.ticket,
        sl: draggingLine.type === 'SL' ? finalPrice : 0,
        tp: draggingLine.type === 'TP' ? finalPrice : 0
    };

    candleSeries.removePriceLine(draggingLine.lineObj);
    draggingLine = null;

    try {
        await fetch('http://127.0.0.1:5000/api/modify', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(reqBody)
        });
        fetchDashboardData();
    } catch (err) {
        showError('Modify Failed', err.message);
    }
}

// ==================================================
// 5. RENDER TABLES
// ==================================================

function renderPositions(positions) {
    const tbody = document.querySelector('#positions-table tbody');
    if(!tbody) return;
    tbody.innerHTML = '';

    positions.forEach(pos => {
        // 1. Profit Color Logic
        const profitClass = pos.profit >= 0 ? 'text-green' : 'text-red';
        const profitSign = pos.profit >= 0 ? '+' : ''; // Add '+' for positive numbers

        // 2. Badge Logic
        const badgeClass = pos.type === 'BUY' ? 'badge-buy' : 'badge-sell';

        tbody.innerHTML += `
            <tr>
                <td class="symbol-cell">
                    <div class="symbol-icon">${pos.symbol.substring(0,1)}</div>
                    <div>
                        <div class="symbol-name">${pos.symbol}</div>
                        <div class="symbol-desc"><span class="${badgeClass}">${pos.type}</span></div>
                    </div>
                </td>
                <td><strong>${pos.volume}</strong></td>
                <td>${pos.price_open}</td>
                <td>${pos.price_current}</td>
                <td class="${profitClass}">${profitSign}$${pos.profit.toFixed(2)}</td>
                <td>
                    <button style="font-size:10px; padding:4px 8px; background:rgba(54,215,183,0.1); color:#36d7b7; border:1px solid rgba(54,215,183,0.3); border-radius:4px; cursor:pointer;" onclick="startDrag(${pos.ticket}, 'TP', ${pos.price_current})">TP</button>
                    <button style="font-size:10px; padding:4px 8px; background:rgba(255,85,85,0.1); color:#ff5555; border:1px solid rgba(255,85,85,0.3); border-radius:4px; cursor:pointer; margin-left:5px;" onclick="startDrag(${pos.ticket}, 'SL', ${pos.price_current})">SL</button>
                </td>
            </tr>`;
    });
}

// --- RENDER HISTORY (Closed Trades) ---
function renderHistory(history) {
    const tbody = document.querySelector('#history-table tbody');
    if(!tbody) return;
    tbody.innerHTML = '';

    history.slice(0, 10).forEach(deal => {
        const profitClass = deal.profit >= 0 ? 'text-green' : 'text-red';
        const profitSign = deal.profit >= 0 ? '+' : '';
        const badgeClass = deal.type === 'BUY' ? 'badge-buy' : 'badge-sell';

        // Use the new formatter here
        // Note: backend 'timestamp' is usually raw int. 'time' string might be pre-formatted.
        // Best to use raw 'timestamp' if available, or parse 'time'.
        // Let's assume deal.timestamp exists (we added it to backend earlier).
        // If not, use deal.time but ensure it parses correctly.
        const timeStr = deal.timestamp ? formatDateTime(deal.timestamp) : deal.time;

        tbody.innerHTML += `
            <tr>
                <td class="time-cell">${timeStr}</td> <td style="font-weight: 700;">${deal.symbol}</td>
                <td><span class="${badgeClass}">${deal.type}</span></td>
                <td>${deal.volume}</td>
                <td>${deal.price}</td>
                <td class="${profitClass}">${profitSign}$${deal.profit.toFixed(2)}</td>
            </tr>`;
    });
}

// ==================================================
// 6. UTILITIES (Helpers)
// ==================================================

function adjustQty(delta) {
    const input = document.getElementById('trade-qty');
    let val = parseFloat(input.value) + delta;
    if(val < 0.01) val = 0.01;
    input.value = val.toFixed(2);
}

function resetChart() {
    if(chart) chart.timeScale().scrollToRealTime();
}

function toggleFullscreen() {
    const container = document.querySelector('.chart-col');
    const isFullscreen = container.classList.toggle('fullscreen-mode');

    // FORCE RESIZE
    setTimeout(() => {
        if (isFullscreen) {
            // Explicitly set dimensions to match the CSS calculation
            const w = window.innerWidth;
            const h = window.innerHeight - 60; // 60 is header height
            chart.applyOptions({ width: w, height: h });
        } else {
            // Trigger ResizeObserver for normal mode
            window.dispatchEvent(new Event('resize'));
        }
    }, 50); // Small delay to allow CSS class to apply
}

function showError(title, message) {
    if (isErrorOpen) return;
    isErrorOpen = true;
    const modal = document.getElementById('error-modal');
    document.getElementById('modal-title').innerText = title;
    document.getElementById('modal-message').value = message;
    modal.style.display = 'flex';
}

function closeModal() {
    isErrorOpen = false;
    document.getElementById('error-modal').style.display = 'none';
}

// --- EXPOSE GLOBALS FOR HTML ---
window.closeModal = closeModal;
window.toggleFullscreen = toggleFullscreen;
window.resetChart = resetChart;
window.placeOrder = placeOrder;
window.adjustQty = adjustQty;
window.startDrag = startDrag;
window.changeSymbol = changeSymbol;