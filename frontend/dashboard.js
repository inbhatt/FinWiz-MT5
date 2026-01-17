const { ipcRenderer } = require('electron');

// --- GLOBAL STATE ---
// Preserved localStorage logic
let currentMobile = localStorage.getItem("userMobile") || "9876543210";
let currentSymbol = 'XAUUSD';
let chart, candleSeries;
let priceLines = {};
let isErrorOpen = false;
let currentTimeframe = '1H';
let latestCandle = null;
let draggingLine = null; // { ticket, type, startPrice, direction }
let dragPriceLine = null;
let activeHoverTicket = null;
let dragStartTime = 0;

// --- COLORS ---
const COL_BUY  = '#2962ff'; // Blue
const COL_SELL = '#ff5555'; // Red
const COL_TP   = '#00b894'; // Green
const COL_SL   = '#ff9f43'; // Orange
const COL_TXT  = '#8a94a6';

// --- WATCHLIST ---
const WATCHLIST = [
    { sym: 'XAUUSD', desc: 'Gold vs US Dollar' },
    { sym: 'BTCUSDT', desc: 'Bitcoin vs Dollar' },
    { sym: 'EURUSD', desc: 'Euro vs US Dollar' },
    { sym: 'GBPUSD', desc: 'Great Britain Pound' },
    { sym: 'USDJPY', desc: 'US Dollar vs Yen' },
    { sym: 'US30',   desc: 'Dow Jones 30' },
];

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (!currentMobile) {
            // Optional: Redirect if strict auth needed
            console.warn("No User Logged In");
        }

        renderWatchlist();
        initChart();

        // Initial Load
        await fetchDashboardData();
        await loadFullChartHistory();

        // Loops
        setInterval(fetchDashboardData, 2000);
        setInterval(updateLiveCandle, 250);

        // Timeframe Buttons
        document.querySelectorAll('.chart-controls button').forEach(btn => {
            if(btn.classList.contains('btn-icon')) return;
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.chart-controls button').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                currentTimeframe = e.target.innerText;
                loadFullChartHistory();
            });
        });

    } catch (e) {
        showError('Dashboard Crash', e.toString());
    }
});


// ==================================================
// 1. CHARTING ENGINE & INTERACTION
// ==================================================

function initChart() {
    const container = document.getElementById('chart-container');
    const legend = document.getElementById('chart-legend');

    legend.style.fontSize = '16px';
    legend.style.top = '15px';
    legend.style.left = '15px';

    chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
            background: { type: 'solid', color: '#151a30' },
            textColor: '#8a94a6',
            fontSize: 16,
            fontFamily: 'Inter, sans-serif'
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' }
        },
        localization: {
            locale: 'en-IN',
            timeFormatter: (timestamp) => formatDateTime(timestamp)
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        timeScale: {
            timeVisible: true, borderColor: 'rgba(255, 255, 255, 0.1)', rightOffset: 20,
            tickMarkFormatter: (time, tickMarkType) => {
                const date = new Date(time * 1000);
                if (tickMarkType < 3) return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
                return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
            }
        }
    });

    candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: '#36d7b7', downColor: '#ff5555',
        borderVisible: false, wickUpColor: '#36d7b7', wickDownColor: '#ff5555',
    });

    chart.subscribeCrosshairMove(param => {
        if (param.time) {
            const data = param.seriesData.get(candleSeries);
            if(data) updateLegend(data);
        } else if (latestCandle) updateLegend(latestCandle);
    });

    // --- INTERACTION LOGIC ---
    const hoverMenu = document.getElementById('hover-menu');

    // 1. MOUSE MOVE (Hover Menu + Drag Update)
    container.addEventListener('mousemove', (e) => {
        if (draggingLine) {
            updateDrag(e);
            hoverMenu.style.display = 'none';
            return;
        }

        if (e.target.closest('.chart-hover-menu')) return;

        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const x = e.clientX - rect.left;

        let found = null;
        for(let t in priceLines) {
            const group = priceLines[t];
            const checkLine = (linePrice, type) => {
                const lineY = candleSeries.priceToCoordinate(linePrice);
                if(lineY && Math.abs(y - lineY) < 15) return { type, ticket: t, y: lineY };
                return null;
            };
            found = checkLine(group.data.price_open, 'MAIN') ||
                    (group.tp ? checkLine(group.data.tp, 'TP') : null) ||
                    (group.sl ? checkLine(group.data.sl, 'SL') : null);
            if(found) break;
        }

        if(found) {
            if (activeHoverTicket !== found.ticket + found.type || hoverMenu.style.display === 'none') {
                showHoverMenu(found, x, found.y);
                activeHoverTicket = found.ticket + found.type;
            }
        } else {
            hoverMenu.style.display = 'none';
            activeHoverTicket = null;
        }
    });

    // 2. MOUSE UP (Commit Drag)
    document.addEventListener('mouseup', (e) => {
        if (draggingLine) {
            commitDrag(e);
        }
    });

    new ResizeObserver(entries => {
        if (entries.length === 0 || !entries[0].contentRect) return;
        const newRect = entries[0].contentRect;
        chart.applyOptions({ width: newRect.width, height: newRect.height });
    }).observe(container);
}

// --- DRAG LOGIC ---

function startDrag(ticket, type, currentPrice) {
    const pos = priceLines[ticket].data; // Get full position data

    draggingLine = {
        ticket,
        type,
        startPrice: pos.price_open,
        direction: pos.type,
        volume: pos.volume,
        symbol: pos.symbol
    };

    dragStartTime = Date.now();

    const color = type === 'TP' ? COL_TP : COL_SL;

    dragPriceLine = candleSeries.createPriceLine({
        price: currentPrice,
        color: color,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true,
        title: `Set ${type}`, // Initial Title
    });

    document.body.style.cursor = 'ns-resize';
    document.getElementById('hover-menu').style.display = 'none';
}

function updateDrag(e) {
    if(!draggingLine || !dragPriceLine) return;

    const rect = document.getElementById('chart-container').getBoundingClientRect();
    let price = candleSeries.coordinateToPrice(e.clientY - rect.top);

    if(!price) return;

    // --- 1. ENFORCE CONSTRAINTS (Request #2) ---
    const entry = draggingLine.startPrice;
    const isBuy = draggingLine.direction === 'BUY';
    const mode = draggingLine.type; // 'TP' or 'SL'

    if (isBuy) {
        if (mode === 'TP') {
            // Buy TP must be ABOVE entry
            if (price < entry) price = entry;
        } else {
            // Buy SL must be BELOW entry
            if (price > entry) price = entry;
        }
    } else {
        // SELL
        if (mode === 'TP') {
            // Sell TP must be BELOW entry
            if (price > entry) price = entry;
        } else {
            // Sell SL must be ABOVE entry
            if (price < entry) price = entry;
        }
    }

    // Apply the constrained price
    dragPriceLine.applyOptions({ price: price });

    // --- 2. CALCULATE P/L PREVIEW (Request #3 - Part A) ---
    const plValue = calculatePL(
        draggingLine.symbol,
        draggingLine.direction,
        draggingLine.volume,
        entry,
        price
    );

    const sign = plValue >= 0 ? '+' : '';
    dragPriceLine.applyOptions({
        title: `${mode}: ${sign}$${plValue}`
    });
}

async function commitDrag(e) {
    if (!draggingLine) return;

    const rect = document.getElementById('chart-container').getBoundingClientRect();
    const finalPrice = candleSeries.coordinateToPrice(e.clientY - rect.top);

    // Cancel if invalid
    if (!finalPrice) { cancelDrag(); return; }

    // Prepare API Payload
    const payload = {
        mobile: currentMobile,
        ticket: draggingLine.ticket
    };

    if (draggingLine.type === 'TP') payload.tp = finalPrice;
    if (draggingLine.type === 'SL') payload.sl = finalPrice;

    try {
        const response = await fetch('http://127.0.0.1:5000/api/modify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const res = await response.json();

        if (res.error) showError('Modify Failed', res.error);
        else console.log("Modification Success");

    } catch (err) {
        console.error(err);
    }

    cancelDrag();
}

async function cancelLevel(ticket, type) {
    // payload: { ticket: 123, tp: 0 } OR { ticket: 123, sl: 0 }
    const payload = {
        mobile: currentMobile,
        ticket: ticket
    };

    if (type === 'TP') payload.tp = 0.0;
    if (type === 'SL') payload.sl = 0.0;

    try {
        const response = await fetch('http://127.0.0.1:5000/api/modify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const res = await response.json();

        if (res.error) showError('Remove Failed', res.error);
        else console.log(`${type} Removed`);

        // Hide menu immediately
        document.getElementById('hover-menu').style.display = 'none';

    } catch (e) {
        showError('Network Error', e.message);
    }
}

function cancelDrag() {
    if (dragPriceLine) {
        candleSeries.removePriceLine(dragPriceLine);
        dragPriceLine = null;
    }
    draggingLine = null;
    document.body.style.cursor = 'default';
}


// ==================================================
// 2. VISUALIZATION & TABLES
// ==================================================

function updateChartPositions(positions) {
    // 1. Filter for Current Symbol
    const currentPositions = positions.filter(p => p.symbol === currentSymbol);

    // Note: p.ticket is now a STRING (e.g. "BTCUSD_BUY")
    const activeTickets = new Set(currentPositions.map(p => p.ticket));

    // 2. Cleanup (Use string keys)
    for (let t in priceLines) {
        // Remove parseInt here! Compare string directly.
        if (!activeTickets.has(t)) {
            const group = priceLines[t];
            if(group.main) candleSeries.removePriceLine(group.main);
            if(group.tp) candleSeries.removePriceLine(group.tp);
            if(group.sl) candleSeries.removePriceLine(group.sl);
            delete priceLines[t];
        }
    }

    // 3. Draw/Update
    currentPositions.forEach(pos => {
        const mainColor = pos.type === 'BUY' ? COL_BUY : COL_SELL;

        // Show "Avg Price" in the label
        const mainTitle = `${pos.type} ${pos.volume} [Avg] ($${pos.profit.toFixed(2)})`;

        // ENTRY LINE
        if (!priceLines[pos.ticket]) {
            const mainLine = candleSeries.createPriceLine({
                price: pos.price_open, color: mainColor, lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true,
                title: mainTitle,
            });
            priceLines[pos.ticket] = { main: mainLine, tp: null, sl: null, data: pos };
        } else {
            const group = priceLines[pos.ticket];
            group.main.applyOptions({ price: pos.price_open, title: mainTitle });
            group.data = pos;
        }

        const group = priceLines[pos.ticket];

        // TP LINE
        if (pos.tp > 0) {
            const pl = calculatePL(pos.symbol, pos.type, pos.volume, pos.price_open, pos.tp);
            const title = `TP: +$${pl}`;
            if (!group.tp) {
                group.tp = candleSeries.createPriceLine({
                    price: pos.tp, color: COL_TP, lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: title,
                });
            } else { group.tp.applyOptions({ price: pos.tp, title: title }); }
        } else if (group.tp) { candleSeries.removePriceLine(group.tp); group.tp = null; }

        // SL LINE
        if (pos.sl > 0) {
            const pl = calculatePL(pos.symbol, pos.type, pos.volume, pos.price_open, pos.sl);
            const title = `SL: $${pl}`;
            if (!group.sl) {
                group.sl = candleSeries.createPriceLine({
                    price: pos.sl, color: COL_SL, lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: title,
                });
            } else { group.sl.applyOptions({ price: pos.sl, title: title }); }
        } else if (group.sl) { candleSeries.removePriceLine(group.sl); group.sl = null; }
    });
}

function renderPositions(positions) {
    const tbody = document.querySelector('#positions-table tbody');
    if(!tbody) return;
    tbody.innerHTML = '';

    positions.forEach(pos => {
        const profitClass = pos.profit >= 0 ? 'text-green' : 'text-red';
        const badgeClass = pos.type === 'BUY' ? 'badge-buy' : 'badge-sell';

        // --- SL CELL CONTENT ---
        let slHtml = '<span style="color:#8a94a6;">-</span>';
        if(pos.sl > 0) {
            const pl = calculatePL(pos.symbol, pos.type, pos.volume, pos.price_open, pos.sl);
            // NOTICE THE QUOTES AROUND ${pos.ticket} below:
            slHtml = `
                <div style="display:flex; align-items:center; gap:5px;">
                    <div style="display:flex; flex-direction:column; line-height:1.2;">
                        <span style="color:${COL_SL}; font-weight:700;">${pos.sl.toFixed(2)}</span>
                        <span style="font-size:14px; font-weight:700; color:#ff5555;">${pl}</span>
                    </div>
                    <button class="btn-remove-level" onclick="cancelLevel('${pos.ticket}', 'SL')">×</button>
                </div>`;
        }

        // --- TP CELL CONTENT ---
        let tpHtml = '<span style="color:#8a94a6;">-</span>';
        if(pos.tp > 0) {
            const pl = calculatePL(pos.symbol, pos.type, pos.volume, pos.price_open, pos.tp);
            // NOTICE THE QUOTES AROUND ${pos.ticket} below:
            tpHtml = `
                <div style="display:flex; align-items:center; gap:5px;">
                    <div style="display:flex; flex-direction:column; line-height:1.2;">
                        <span style="color:${COL_TP}; font-weight:700;">${pos.tp.toFixed(2)}</span>
                        <span style="font-size:14px; font-weight:700; color:#00b894;">+${pl}</span>
                    </div>
                    <button class="btn-remove-level" onclick="cancelLevel('${pos.ticket}', 'TP')">×</button>
                </div>`;
        }

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

                <td>${slHtml}</td>
                <td>${tpHtml}</td>

                <td class="${profitClass}">$${pos.profit.toFixed(2)}</td>

                <td>
                    <button class="btn-close-trade" onclick="closeTrade('${pos.ticket}')">Close</button>
                </td>
            </tr>`;
    });
}

function renderHistory(history) {
    const tbody = document.querySelector('#history-table tbody');
    if(!tbody) return;
    tbody.innerHTML = '';

    history.slice(0, 10).forEach(deal => {
        const profitClass = deal.profit >= 0 ? 'text-green' : 'text-red';
        const badgeClass = deal.type === 'BUY' ? 'badge-buy' : 'badge-sell';
        const timeStr = deal.timestamp ? formatDateTime(deal.timestamp) : deal.time;

        tbody.innerHTML += `
            <tr>
                <td class="time-cell">${timeStr}</td>
                <td style="font-weight: 700;">${deal.symbol}</td>
                <td><span class="${badgeClass}">${deal.type}</span></td>
                <td>${deal.volume}</td>
                <td>${deal.price}</td>
                <td class="${profitClass}">$${deal.profit.toFixed(2)}</td>
            </tr>`;
    });
}

// ==================================================
// 3. UTILITIES & DATA
// ==================================================

function showHoverMenu(target, x, y) {
    const menu = document.getElementById('hover-menu');
    const container = document.getElementById('chart-container');
    const ticket = target.ticket; // This is a string now (e.g. "BTCUSD_BUY")
    const pos = priceLines[ticket].data;

    let html = '';
    const styleBlue = `color:${COL_BUY}; border-color:${COL_BUY}; background:rgba(41, 98, 255, 0.15)`;
    const styleRed  = `color:${COL_SELL}; border-color:${COL_SELL}; background:rgba(255, 85, 85, 0.15)`;

    // --- Helper for P/L HTML ---
    const getPlHtml = (targetPrice) => {
        if (!targetPrice) return '';
        const pl = calculatePL(pos.symbol, pos.type, pos.volume, pos.price_open, targetPrice);
        const colorClass = pl >= 0 ? 'pl-green' : 'pl-red';
        return `<span class="pl-preview ${colorClass}">${pl >= 0 ? '+' : ''}$${pl}</span>`;
    };

    // --- NOTICE QUOTES ADDED TO ALL startDrag AND cancelLevel CALLS ---

    if (target.type === 'MAIN') {
        const labelStyle = pos.type === 'BUY' ? styleBlue : styleRed;
        html += `<span style="font-size:12px; margin-right:8px; font-weight:700; border:1px solid; padding:4px 8px; border-radius:4px; ${labelStyle}">#${ticket}</span>`;

        if (!pos.tp || pos.tp <= 0) {
            html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'TP', ${pos.price_current})">+ TP</button>`;
        }
        if (!pos.sl || pos.sl <= 0) {
            html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'SL', ${pos.price_current})">+ SL</button>`;
        }
    }
    else if (target.type === 'TP') {
        html += `<span style="color:${COL_TP}; font-weight:800; font-size:15px;">TP</span>`;
        html += getPlHtml(pos.tp);
        html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'TP', ${pos.tp})">Move</button>`;
        html += `<button class="btn-remove-level" onclick="cancelLevel('${ticket}', 'TP')" title="Remove TP">×</button>`;
    }
    else if (target.type === 'SL') {
        html += `<span style="color:${COL_SL}; font-weight:800; font-size:15px;">SL</span>`;
        html += getPlHtml(pos.sl);
        html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'SL', ${pos.sl})">Move</button>`;
        html += `<button class="btn-remove-level" onclick="cancelLevel('${ticket}', 'SL')" title="Remove SL">×</button>`;
    }

    menu.innerHTML = html;
    menu.style.display = 'flex';
    menu.style.alignItems = 'center';

    const containerWidth = container.clientWidth;
    const menuWidth = menu.offsetWidth;
    const axisWidth = 60;
    const buffer = 10;
    const fixedLeft = containerWidth - axisWidth - menuWidth - buffer;

    menu.style.left = fixedLeft + 'px';
    menu.style.top = (y - 20) + 'px';
}

function calculatePL(symbol, type, volume, entryPrice, targetPrice) {
    let diff = 0;

    // 1. Calculate Point Difference
    if (type === 'BUY') {
        diff = targetPrice - entryPrice;
    } else {
        diff = entryPrice - targetPrice; // Short selling
    }

    // 2. Estimate Contract Size (Approximation)
    // Gold ~ 100, BTC ~ 1, Forex ~ 100000 (standard lot)
    let contractSize = 100000;
    if (symbol.includes('XAU')) contractSize = 100;
    if (symbol.includes('BTC')) contractSize = 1;
    if (symbol.includes('US30') || symbol.includes('DJ30')) contractSize = 10; // Indices often differ

    return (diff * volume * contractSize).toFixed(2);
}

async function fetchDashboardData() {
    try {
        const response = await fetch(`http://127.0.0.1:5000/api/dashboard?mobile=${currentMobile}`);
        const data = await response.json();
        if(data.error) return;

        // Stats
        document.getElementById('val-balance').innerText = `$${data.balance.toFixed(2)}`;
        const plEl = document.getElementById('val-pl');
        plEl.innerText = `$${data.profit.toFixed(2)}`;
        plEl.className = data.profit >= 0 ? "stat-value text-green" : "stat-value text-red";
        document.getElementById('val-power').innerText = `$${data.margin_free.toFixed(2)}`;

        const usedMargin = data.balance - data.margin_free;
        const usagePct = data.balance > 0 ? (usedMargin / data.balance) * 100 : 0;
        const bar = document.querySelector('.progress-fill');
        if(bar) bar.style.width = `${usagePct}%`;

        renderPositions(data.positions);
        renderHistory(data.history);
        updateChartPositions(data.positions);
    } catch (e) { console.log(e); }
}

async function updateLiveCandle() {
    try {
        const url = `http://127.0.0.1:5000/api/candles?symbol=${currentSymbol}&timeframe=${currentTimeframe}&limit=2&_=${Date.now()}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data && data.length > 0) {
            const latest = data[data.length - 1];
            candleSeries.update(latest);
            latestCandle = latest;
            updateLegend(latest);
        }
    } catch (e) { console.error(e); }
}

async function loadFullChartHistory() {
    try {
        const url = `http://127.0.0.1:5000/api/candles?symbol=${currentSymbol}&timeframe=${currentTimeframe}&limit=2000`;
        const response = await fetch(url);
        const data = await response.json();

        if (data && data.length > 0) {
            candleSeries.setData(data);
            latestCandle = data[data.length - 1];
            updateLegend(latestCandle);
            const total = data.length;
            chart.timeScale().setVisibleLogicalRange({ from: total - 100, to: total + 5 });
            chart.priceScale('right').applyOptions({ autoScale: true });
        }
    } catch (e) { console.error(e); }
}

// Watchlist
function renderWatchlist() {
    const container = document.getElementById('watchlist-container');
    container.innerHTML = '';
    WATCHLIST.forEach(item => {
        const div = document.createElement('div');
        div.className = `watchlist-item ${item.sym === currentSymbol ? 'active' : ''}`;
        div.onclick = () => changeSymbol(item.sym);
        div.innerHTML = `<div><div class="wl-symbol">${item.sym}</div><div class="wl-desc">${item.desc}</div></div>`;
        container.appendChild(div);
    });
}

async function changeSymbol(newSym) {
    if(currentSymbol === newSym) return;

    // 1. CLEAR OLD LINES (Fix #1)
    // We must remove them from the chart series, not just the object
    for (let t in priceLines) {
        const group = priceLines[t];
        if(group.main) candleSeries.removePriceLine(group.main);
        if(group.tp)   candleSeries.removePriceLine(group.tp);
        if(group.sl)   candleSeries.removePriceLine(group.sl);
    }
    priceLines = {}; // Reset the storage object

    // 2. Update State
    currentSymbol = newSym;
    document.getElementById('chart-symbol-name').innerText = currentSymbol;

    // 3. Reset Data
    candleSeries.setData([]);
    latestCandle = null;

    // 4. Update UI
    renderWatchlist();

    // 5. Reload
    await loadFullChartHistory();
    fetchDashboardData();
}

function updateLegend(data) {
    const legend = document.getElementById('chart-legend');
    if (!data) return;

    // Determine color based on candle direction
    const valColor = data.close >= data.open ? '#36d7b7' : '#ff5555'; // Green or Red
    const titleColor = '#ffffff'; // Always White

    legend.innerHTML = `
        <div style="font-size: 14px; display: flex; gap: 12px; font-family: 'Inter', monospace;">
            <span>
                <span style="color:${titleColor}">O</span>
                <span style="color:${valColor}">${data.open.toFixed(2)}</span>
            </span>
            <span>
                <span style="color:${titleColor}">H</span>
                <span style="color:${valColor}">${data.high.toFixed(2)}</span>
            </span>
            <span>
                <span style="color:${titleColor}">L</span>
                <span style="color:${valColor}">${data.low.toFixed(2)}</span>
            </span>
            <span>
                <span style="color:${titleColor}">C</span>
                <span style="color:${valColor}">${data.close.toFixed(2)}</span>
            </span>
        </div>`;
}

function formatDateTime(timestamp) {
    if(!timestamp) return '';
    const d = new Date(typeof timestamp === 'number' ? timestamp * 1000 : timestamp);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${mins}`;
}

// --- ORDERS ---
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
        if(data.error) showError('Order Failed', data.error);
        else fetchDashboardData();
    } catch (e) { showError('Order Failed', e.message); }
}

// Helpers
function adjustQty(delta) {
    const input = document.getElementById('trade-qty');
    let val = parseFloat(input.value) + delta;
    if(val < 0.01) val = 0.01;
    input.value = val.toFixed(2);
}

function toggleFullscreen() {
    const container = document.querySelector('.chart-col');
    container.classList.toggle('fullscreen-mode');
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        if(chart) chart.timeScale().scrollToRealTime();
    }, 10);
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
async function closeTrade(ticket) {
    // Optional: Add confirmation if you want
    // if(!confirm('Close Trade?')) return;

    try {
        const res = await fetch('http://127.0.0.1:5000/api/close', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                mobile: currentMobile,
                ticket: ticket
            })
        });

        const data = await res.json();

        if(data.error) {
            showError('Close Failed', data.error);
        } else {
            console.log("Trade Closed");
            // Refresh data immediately
            fetchDashboardData();
        }

    } catch (e) {
        showError('Network Error', e.message);
    }
}

function resetChart() {
    if (!chart) return;

    // 1. Jump to the current time (Right side)
    chart.timeScale().scrollToRealTime();

    // 2. Reset the Vertical Price Scale to "Auto"
    // (This fixes the chart if you dragged the price axis manually)
    chart.priceScale('right').applyOptions({
        autoScale: true
    });
}

// Global Exports
window.closeModal = closeModal;
window.toggleFullscreen = toggleFullscreen;
window.placeOrder = placeOrder;
window.adjustQty = adjustQty;
window.startDrag = startDrag;
window.changeSymbol = changeSymbol;
window.cancelLevel = cancelLevel;