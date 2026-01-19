const { ipcRenderer } = require("electron");

// --- GLOBAL STATE ---
let currentMobile = localStorage.getItem("userMobile");
let currentUserId = localStorage.getItem("userId");
let currentSymbol = "XAUUSD";
let chart, candleSeries;
let priceLines = {};
let isErrorOpen = false;
let currentTimeframe = "1H";
let latestCandle = null;
let draggingLine = null;
let dragPriceLine = null;
let activeHoverTicket = null;
let allAccounts = [];
let expandedTickets = new Set();
let specificTradeView = null;

let menuHideTimer = null;

// NEW: Missing State Variables Fixed
let isSidebarCollapsed = false;
let isHeaderVisible = false;

// --- COLORS ---
const COL_BUY = "#2962ff";
const COL_SELL = "#ff5555";
const COL_TP = "#00695c"; // Darker Teal
const COL_SL = "#e65100"; // Darker Orange

const WATCHLIST = [
  { sym: "XAUUSD", desc: "Gold vs US Dollar" },
  { sym: "BTCUSDT", desc: "Bitcoin vs Dollar" },
  { sym: "EURUSD", desc: "Euro vs US Dollar" },
  { sym: "GBPUSD", desc: "Great Britain Pound" },
  { sym: "USDJPY", desc: "US Dollar vs Yen" },
  { sym: "US30", desc: "Dow Jones 30" },
];

document.addEventListener("DOMContentLoaded", async () => {
  try {
    if (!currentMobile) window.location.href = "index.html";

    renderWatchlist();
    initChart();
    setupMenuListeners();

    await fetchDashboardData();
    await loadFullChartHistory();

    // Intervals
    setInterval(fetchDashboardData, 2000); // Faster polling for live rates
    setInterval(updateLiveCandle, 250);

    // Keyboard Shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.altKey && e.key.toLowerCase() === "b") {
        toggleHeader();
      }
    });

    document.querySelectorAll(".chart-controls button").forEach((btn) => {
      if (btn.classList.contains("btn-icon")) return;
      btn.addEventListener("click", (e) => {
        document
          .querySelectorAll(".chart-controls button")
          .forEach((b) => b.classList.remove("active"));
        e.target.classList.add("active");
        currentTimeframe = e.target.innerText;
        changeSymbol(currentSymbol);
      });
    });
  } catch (e) {
    showError("Dashboard Crash", e.toString());
  }
});

function setupMenuListeners() {
  const menu = document.getElementById("hover-menu");

  // If mouse enters the menu, cancel the hide timer
  menu.addEventListener("mouseenter", () => {
    if (menuHideTimer) clearTimeout(menuHideTimer);
  });

  // If mouse leaves the menu, hide it after delay
  menu.addEventListener("mouseleave", () => {
    menuHideTimer = setTimeout(() => {
      menu.style.display = "none";
    }, 150); // 150ms grace period
  });
}
// --- TOGGLE FUNCTIONS ---

function toggleSidebar() {
  isSidebarCollapsed = !isSidebarCollapsed;
  const container = document.getElementById("app-container");

  if (isSidebarCollapsed) {
    container.classList.add("sidebar-collapsed");
  } else {
    container.classList.remove("sidebar-collapsed");
  }

  // Resize chart after transition (wait 300ms)
  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 310);
}

function toggleHeader() {
  isHeaderVisible = !isHeaderVisible;
  const container = document.getElementById("app-container");

  if (isHeaderVisible) {
    container.classList.add("header-visible");
  } else {
    container.classList.remove("header-visible");
  }

  // Resize chart
  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 310);
}

// --- COLLAPSIBLE SECTION LOGIC ---
window.toggleSection = function (wrapperId, headerElem) {
  const wrapper = document.getElementById(wrapperId);
  if (wrapper.classList.contains("hidden")) {
    wrapper.classList.remove("hidden");
    headerElem.classList.remove("collapsed");
    wrapper.style.height = "auto";
  } else {
    wrapper.classList.add("hidden");
    headerElem.classList.add("collapsed");
  }
};

async function fetchDashboardData() {
  try {
    // Collect Watchlist Symbols to send to backend
    const watchlistStr = WATCHLIST.map((w) => w.sym).join(",");

    const param = currentUserId
      ? `user_id=${currentUserId}&watchlist=${watchlistStr}`
      : `mobile=${currentMobile}&watchlist=${watchlistStr}`;

    const response = await fetch(
      `http://127.0.0.1:5000/api/dashboard?${param}`,
    );
    const data = await response.json();
    if (data.error) {
      console.log("Sync Error:", data.error);
      return;
    }

    // Update Stats
    document.getElementById("val-balance").innerText =
      `$${data.balance.toFixed(2)}`;

    // Equity
    const eqEl = document.getElementById("val-equity");
    if (eqEl) eqEl.innerText = `$${data.equity.toFixed(2)}`;

    // Used Margin
    const usedEl = document.getElementById("val-used");
    if (usedEl) usedEl.innerText = `$${data.margin_used.toFixed(2)}`;

    const plEl = document.getElementById("val-pl");
    plEl.innerText = `$${data.profit.toFixed(2)}`;
    plEl.className =
      data.profit >= 0 ? "stat-value text-green" : "stat-value text-red";

    document.getElementById("val-power").innerText =
      `$${data.margin_free.toFixed(2)}`;

    // Update Progress Bar
    const usedMargin = data.balance - data.margin_free;
    const usagePct = data.balance > 0 ? (usedMargin / data.balance) * 100 : 0;
    const bar = document.querySelector(".progress-fill");
    if (bar) bar.style.width = `${usagePct}%`;

    // NEW: Update Watchlist Prices if available
    if (data.prices) updateWatchlistPrices(data.prices);

    renderPositions(data.positions);
    renderHistory(data.history);

    if (specificTradeView) {
      refreshSpecificView(data.positions);
    } else {
      updateChartPositions(data.positions);
    }
  } catch (e) {
    console.log("Network Error:", e);
  }
}

function updateWatchlistPrices(priceMap) {
  // Helper to find watchlist items and update prices if you added IDs
  // Assuming you might add IDs like 'wl-price-SYMBOL' in renderWatchlist
  // For now, this is a placeholder if you haven't updated renderWatchlist HTML
}

function refreshSpecificView(allPositions) {
  let found = null;
  for (let master of allPositions) {
    if (master.sub_positions) {
      for (let sub of master.sub_positions) {
        if (sub.ticket === specificTradeView.ticket) {
          found = sub;
          break;
        }
      }
    }
    if (found) break;
  }
  if (found) viewSpecificTrade(found, null);
  else clearSpecificView();
}

function renderSlTpCell(
  targetPrice,
  type,
  ticket,
  symbol,
  entryPrice,
  volume,
  direction,
) {
  if (!targetPrice || targetPrice <= 0) return "-";

  const safeEntry = parseFloat(entryPrice) || 0;
  const plValue = calculatePL(
    symbol,
    direction,
    volume,
    safeEntry,
    targetPrice,
  );
  const plClass = parseFloat(plValue) >= 0 ? "text-green" : "text-red";
  const plSign = parseFloat(plValue) >= 0 ? "+" : "";
  const color = type === "sl" ? "#ff9f43" : "#00b894";

  return `
        <div style="display:flex; flex-direction:column; line-height:1.2;">
            <div style="display:flex; align-items:center;">
                <span style="color:${color}; font-weight:700;">${targetPrice}</span>
                <span class="remove-x" onclick="removeLevel('${ticket}', '${type}'); event.stopPropagation();">×</span>
            </div>
            <span style="font-size:13px; font-weight:700;" class="${plClass}">(${plSign}$${plValue})</span>
        </div>
    `;
}

function renderPositions(positions) {
  const tbody = document.querySelector("#positions-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (positions.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" style="text-align:center; padding:20px; color:#555;">No open positions</td></tr>';
    return;
  }

  positions.forEach((pos) => {
    const isExpanded = expandedTickets.has(pos.ticket);
    const openPrice =
      pos.price_open !== undefined ? pos.price_open : pos.price || 0;

    let slHtml = renderSlTpCell(
      pos.sl,
      "sl",
      pos.ticket,
      pos.symbol,
      openPrice,
      pos.volume,
      pos.type,
    );
    let tpHtml = renderSlTpCell(
      pos.tp,
      "tp",
      pos.ticket,
      pos.symbol,
      openPrice,
      pos.volume,
      pos.type,
    );

    const masterRow = `
            <tr class="master-row" onclick="handleRowClick('${pos.ticket}', event, this)">
                <td class="symbol-cell">
                    <span class="toggle-icon ${isExpanded ? "expanded" : ""}">▶</span>
                    <div style="margin-left:5px;">
                        <div class="symbol-name">${pos.symbol}</div>
                        <div class="symbol-desc"><span class="${pos.type === "BUY" ? "badge-buy" : "badge-sell"}">${pos.type}</span></div>
                    </div>
                </td>
                <td><strong>${pos.volume.toFixed(2)}</strong></td>
                <td>${openPrice}</td>
                <td>${pos.price_current}</td>
                <td>${slHtml}</td>
                <td>${tpHtml}</td>
                <td class="${pos.profit >= 0 ? "text-green" : "text-red"}">$${pos.profit.toFixed(2)}</td>
                <td><button class="btn-close-trade" onclick="closeTrade('${pos.ticket}'); event.stopPropagation();">Close All</button></td>
            </tr>`;

    tbody.innerHTML += masterRow;

    if (pos.sub_positions && pos.sub_positions.length > 0) {
      pos.sub_positions.forEach((sub) => {
        const subDataStr = JSON.stringify(sub).replace(/"/g, "&quot;");
        let subSlHtml = renderSlTpCell(
          sub.sl,
          "sl",
          sub.ticket,
          sub.symbol,
          sub.price,
          sub.volume,
          sub.type,
        );
        let subTpHtml = renderSlTpCell(
          sub.tp,
          "tp",
          sub.ticket,
          sub.symbol,
          sub.price,
          sub.volume,
          sub.type,
        );

        const rowHtml = `
                    <tr class="child-row child-of-${pos.ticket}" style="display: ${isExpanded ? "table-row" : "none"};"
                        onclick="viewSpecificTrade(${subDataStr}, event)">
                        <td class="child-account-name">↳ ${sub.account_name}</td>
                        <td class="child-text">${sub.volume.toFixed(2)}</td>
                        <td class="child-text">${sub.price}</td>
                        <td class="child-text">-</td>
                        <td class="child-text">${subSlHtml}</td>
                        <td class="child-text">${subTpHtml}</td>
                        <td class="child-text ${sub.profit >= 0 ? "text-green" : "text-red"}">$${sub.profit.toFixed(2)}</td>
                        <td style="vertical-align: middle;">
                            <button class="btn-remove-level" style="height:22px; line-height:22px; padding:0 10px; font-family:'Inter', sans-serif;" onclick="closeTrade('${sub.ticket}'); event.stopPropagation();">Close</button>
                        </td>
                    </tr>`;
        tbody.innerHTML += rowHtml;
      });
    }
  });
}

function renderHistory(history) {
  const tbody = document.querySelector("#history-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  history.forEach((deal) => {
    const profitClass = deal.profit >= 0 ? "text-green" : "text-red";
    const badgeClass = deal.type === "BUY" ? "badge-buy" : "badge-sell";
    tbody.innerHTML += `
            <tr>
                <td class="time-cell">${deal.time}</td>
                <td style="font-weight: 700;">${deal.symbol}<div class="history-account-name">${deal.account}</div></td>
                <td><span class="${badgeClass}">${deal.type}</span></td>
                <td>${deal.volume.toFixed(2)}</td>
                <td>${deal.price}</td>
                <td class="${profitClass}">$${deal.profit.toFixed(2)}</td>
            </tr>`;
  });
}

window.handleRowClick = function (ticket, event, rowElem) {
  if (event.target.closest("button") || event.target.closest(".remove-x"))
    return;
  clearSpecificView();
  toggleGroup(ticket, event, rowElem);
};

window.toggleGroup = function (ticket, event, rowElem) {
  if (event) event.stopPropagation();
  if (expandedTickets.has(ticket)) expandedTickets.delete(ticket);
  else expandedTickets.add(ticket);
  const rows = document.querySelectorAll(`.child-of-${ticket}`);
  const isNowExpanded = expandedTickets.has(ticket);
  rows.forEach((r) => (r.style.display = isNowExpanded ? "table-row" : "none"));
  if (rowElem) {
    const arrow = rowElem.querySelector(".toggle-icon");
    if (arrow) arrow.classList.toggle("expanded", isNowExpanded);
  }
};

async function removeLevel(ticket, type) {
  // Fix: Convert type to lowercase to handle "TP" (chart) and "tp" (table)
  const normType = type.toLowerCase();
  
  if (!confirm(`Remove ${normType.toUpperCase()}?`)) return;
  
  const payload = { ticket: ticket, user_id: currentUserId };
  
  // Now matches both cases
  if (normType === "sl") payload.sl = 0.0;
  if (normType === "tp") payload.tp = 0.0;
  
  try {
    const res = await fetch("http://127.0.0.1:5000/api/modify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.details && data.details.length > 0) {
      const fails = data.details.filter((d) => !d.includes("Done") && !d.includes("Success"));
      if (fails.length > 0) showError("Modification Error", fails.join("\n"));
    }
    fetchDashboardData();
  } catch (err) {
    showError("Network Error", err.message);
  }
}

// --- CHART INITIALIZATION ---
function initChart() {
  const container = document.getElementById("chart-container");
  const legend = document.getElementById("chart-legend");
  legend.style.fontSize = "16px";
  legend.style.top = "15px";
  legend.style.left = "15px";

  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: "solid", color: "#151a30" },
      textColor: "#8a94a6",
      fontSize: 16,
      fontFamily: "Inter, sans-serif",
    },
    grid: {
      vertLines: { color: "rgba(255, 255, 255, 0.05)" },
      horzLines: { color: "rgba(255, 255, 255, 0.05)" },
    },
    localization: {
      locale: "en-IN",
      timeFormatter: (timestamp) => formatDateTime(timestamp),
    },
    rightPriceScale: {
      visible: true, // Chart price labels stay on right
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: {
      timeVisible: true,
      borderColor: "rgba(255, 255, 255, 0.1)",
      rightOffset: 20,
    },
  });

  candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: "#36d7b7",
    downColor: "#ff5555",
    borderVisible: false,
    wickUpColor: "#36d7b7",
    wickDownColor: "#ff5555",
  });

  // Sync Legend
  chart.subscribeCrosshairMove((param) => {
    if (param.time) {
      const data = param.seriesData.get(candleSeries);
      if (data) updateLegend(data);
    } else if (latestCandle) updateLegend(latestCandle);

    // Also sync left labels on mouse move (optional for smoothness)
    updateLeftLabels();
  });

  // Sync Left Labels on Scroll/Zoom
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    updateLeftLabels();
  });

  // Close hover menu when clicking on chart background
  container.addEventListener("mousedown", () => {
    document.getElementById("hover-menu").style.display = "none";
  });

  document.addEventListener("mouseup", (e) => {
    if (draggingLine) commitDrag(e);
  });

  new ResizeObserver((entries) => {
    if (entries.length === 0 || !entries[0].contentRect) return;
    const newRect = entries[0].contentRect;
    chart.applyOptions({ width: newRect.width, height: newRect.height });
  }).observe(container);
}

// --- LEFT SIDE LABEL RENDERING ---
function updateLeftLabels() {
  const container = document.getElementById("trade-labels-left");
  if (!container) return;
  container.innerHTML = "";

  if (!candleSeries) return;

  for (let t in priceLines) {
    const group = priceLines[t];
    const data = group.data;
    if (group.main)
      renderSingleLabel(
        container,
        t,
        "MAIN",
        data.price_open || data.price,
        data,
      );
    if (group.tp) renderSingleLabel(container, t, "TP", data.tp, data);
    if (group.sl) renderSingleLabel(container, t, "SL", data.sl, data);
  }
}

function renderSingleLabel(container, ticket, type, price, data) {
  if (!price || price <= 0) return;
  const y = candleSeries.priceToCoordinate(price);
  if (y === null) return;

  const div = document.createElement("div");
  div.className = "trade-label-tag";
  div.style.top = `${y}px`;

  let plText = "";
  if (type === "TP" || type === "SL") {
    const pl = calculatePL(
      data.symbol,
      data.type,
      data.volume,
      data.price_open,
      price,
    );
    const sign = pl >= 0 ? "+" : "";
    plText = `($${sign}${pl})`;
  }

  if (type === "MAIN") {
    const color = data.type === "BUY" ? "#2962ff" : "#ff5555";
    div.style.backgroundColor = color;
    let labelText = `${data.type} ${data.volume} @ ${price}`;
    if (data.account_name) labelText = `${data.account_name} | ${labelText}`;
    div.innerText = labelText;
  } else if (type === "TP") {
    div.style.backgroundColor = COL_TP;
    div.innerText = `TP ${price} ${plText}`;
  } else if (type === "SL") {
    div.style.backgroundColor = COL_SL;
    div.innerText = `SL ${price} ${plText}`;
  }

  // Interaction with Timer Logic
  div.onmouseenter = () => {
    if (menuHideTimer) clearTimeout(menuHideTimer);
    showHoverMenuFixed(ticket, type, y, div);
  };

  div.onmouseleave = () => {
    menuHideTimer = setTimeout(() => {
      document.getElementById("hover-menu").style.display = "none";
    }, 150);
  };

  container.appendChild(div);
}

// --- UPDATED HOVER MENU POSITIONING ---
function showHoverMenuFixed(ticket, type, y, labelElem) {
  const menu = document.getElementById("hover-menu");
  if (!priceLines[ticket]) return;
  const pos = priceLines[ticket].data;

  let html = "";
  if (type === "MAIN") {
    html += `<span style="color:#fff; font-weight:700; font-size:12px; margin-right:5px;">#${ticket}</span>`;
    if (!pos.tp || pos.tp <= 0)
      html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'TP', ${pos.price_current})">+ TP</button>`;
    if (!pos.sl || pos.sl <= 0)
      html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'SL', ${pos.price_current})">+ SL</button>`;
  } else if (type === "TP" || type === "SL") {
    const val = type === "TP" ? pos.tp : pos.sl;
    const pl = calculatePL(
      pos.symbol,
      pos.type,
      pos.volume,
      pos.price_open,
      val,
    );
    const colorClass = pl >= 0 ? "pl-green" : "pl-red";
    html += `<span class="pl-preview ${colorClass}">${pl >= 0 ? "+" : ""}$${pl}</span>`;
    html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', '${type}', ${val})">Move</button>`;
    html += `<button class="btn-remove-level" onclick="removeLevel('${ticket}', '${type}')">×</button>`;
  }

  menu.innerHTML = html;
  menu.style.display = "flex";

  menu.style.position = "absolute";

  const wrapper = document.querySelector(".chart-area-wrapper");
  if (wrapper) {
    const wrapperRect = wrapper.getBoundingClientRect();
    const labelRect = labelElem.getBoundingClientRect();
    const leftPos = labelRect.right - wrapperRect.left + 10;
    const topPos = labelRect.top - wrapperRect.top + labelRect.height / 2;

    menu.style.right = "auto";
    menu.style.left = `${leftPos}px`;
    menu.style.top = `${topPos}px`;
    menu.style.transform = "translateY(-50%)";
  }
}

// ... (Rest of existing functions) ...

async function loadFullChartHistory() {
  try {
    const url = `http://127.0.0.1:5000/api/candles?symbol=${currentSymbol}&timeframe=${currentTimeframe}&limit=2000`;
    const response = await fetch(url);
    const data = await response.json();
    if (data && data.length > 0) {
      candleSeries.setData(data);
      latestCandle = data[data.length - 1];
      updateLegend(latestCandle);
      if (data.length > 100)
        chart.timeScale().setVisibleLogicalRange({
          from: data.length - 100,
          to: data.length + 5,
        });
      else chart.timeScale().fitContent();
      chart.priceScale("right").applyOptions({ autoScale: true });
    }
  } catch (e) {
    console.error(e);
  }
}

async function changeSymbol(newSym) {
  if (currentSymbol !== newSym) {
    currentSymbol = newSym;
    document.getElementById("chart-symbol-name").innerText = currentSymbol;
  }
  for (let t in priceLines) {
    const group = priceLines[t];
    if (group.main) candleSeries.removePriceLine(group.main);
    if (group.tp) candleSeries.removePriceLine(group.tp);
    if (group.sl) candleSeries.removePriceLine(group.sl);
  }
  priceLines = {};
  currentSymbol = newSym;
  document.getElementById("chart-symbol-name").innerText = currentSymbol;
  candleSeries.setData([]);
  renderWatchlist();
  await loadFullChartHistory();
  fetchDashboardData();
}

function resetChart() {
  loadFullChartHistory();
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

      // Update custom labels
      updateLeftLabels();
    }
  } catch (e) {
    console.error(e);
  }
}

function updateLegend(data) {
  const legend = document.getElementById("chart-legend");
  if (!data) return;
  const isGreen = data.close >= data.open;
  const valColor = isGreen ? "#36d7b7" : "#ff5555";
  legend.innerHTML = `
        <span style="color:white">O:</span><span style="color:${valColor}">${data.open}</span>
        <span style="color:white">H:</span><span style="color:${valColor}">${data.high}</span>
        <span style="color:white">L:</span><span style="color:${valColor}">${data.low}</span>
        <span style="color:white">C:</span><span style="color:${valColor}">${data.close}</span>
    `;
}

function formatDateTime(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp * 1000);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(-2);
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${day}-${month}-${year} ${hours}:${mins}`;
}

// --- UPDATED PL CALCULATION ---
function calculatePL(symbol, type, volume, entryPrice, targetPrice) {
  let diff =
    type === "BUY" ? targetPrice - entryPrice : entryPrice - targetPrice;
  let contractSize = 100000;
  if (symbol.includes("XAU") || symbol.includes("Gold")) contractSize = 100;
  if (symbol.includes("BTC")) contractSize = 1;
  if (symbol.includes("US30") || symbol.includes("DJ30")) contractSize = 10;
  if (symbol.includes("JPY")) contractSize = 1000;
  return (diff * volume * contractSize).toFixed(2);
}

// --- DRAG LOGIC ---
function startDrag(ticket, type, currentPrice) {
  const pos = priceLines[ticket].data;
  const entry = pos.price || pos.price_open;
  draggingLine = {
    ticket,
    type,
    startPrice: entry,
    direction: pos.type,
    volume: pos.volume,
    symbol: pos.symbol,
  };

  // FIX: Use the darker constant colors instead of hardcoded bright ones
  const color = type === "TP" ? COL_TP : COL_SL;

  dragPriceLine = candleSeries.createPriceLine({
    price: currentPrice,
    color: color,
    lineWidth: 3,
    lineStyle: LightweightCharts.LineStyle.Dotted,
    axisLabelVisible: true,
    title: `Set ${type}`,
  });

  document.body.style.cursor = "ns-resize";
  document.getElementById("hover-menu").style.display = "none";

  document.addEventListener("mousemove", updateDrag);
}

function updateDrag(e) {
  if (!draggingLine || !dragPriceLine) return;
  const rect = document
    .getElementById("chart-container")
    .getBoundingClientRect();
  let price = candleSeries.coordinateToPrice(e.clientY - rect.top);
  if (!price) return;

  const entry = draggingLine.startPrice;
  const isBuy = draggingLine.direction === "BUY";

  // Validate constraints (TP/SL relative to entry)
  if (isBuy) {
    if (draggingLine.type === "TP" && price < entry) price = entry;
    if (draggingLine.type === "SL" && price > entry) price = entry;
  } else {
    if (draggingLine.type === "TP" && price > entry) price = entry;
    if (draggingLine.type === "SL" && price < entry) price = entry;
  }

  dragPriceLine.applyOptions({ price: price });
  const pl = calculatePL(
    draggingLine.symbol,
    draggingLine.direction,
    draggingLine.volume,
    entry,
    price,
  );
  dragPriceLine.applyOptions({
    title: `${draggingLine.type}: ${pl >= 0 ? "+" : ""}$${pl}`,
  });
}

async function commitDrag(e) {
  // Remove listener
  document.removeEventListener("mousemove", updateDrag);

  if (!draggingLine) return;
  const rect = document
    .getElementById("chart-container")
    .getBoundingClientRect();
  const finalPrice = candleSeries.coordinateToPrice(e.clientY - rect.top);

  if (!finalPrice) {
    cancelDrag();
    return;
  }

  const payload = { ticket: draggingLine.ticket, user_id: currentUserId };
  if (draggingLine.type === "TP") payload.tp = finalPrice;
  if (draggingLine.type === "SL") payload.sl = finalPrice;

  try {
    const res = await fetch("http://127.0.0.1:5000/api/modify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // ... handle response ...
    fetchDashboardData();
  } catch (err) {
    showError("Network Error", err.message);
  }
  cancelDrag();
}

function cancelDrag() {
  document.removeEventListener("mousemove", updateDrag); // Clean up
  if (dragPriceLine) {
    candleSeries.removePriceLine(dragPriceLine);
    dragPriceLine = null;
  }
  draggingLine = null;
  document.body.style.cursor = "default";
}

function updateChartPositions(positions) {
  const currentPositions = positions.filter((p) => p.symbol === currentSymbol);
  const activeTickets = new Set(currentPositions.map((p) => p.ticket));

  // Cleanup old lines
  for (let t in priceLines) {
    if (!activeTickets.has(t)) {
      const group = priceLines[t];
      if (group.main) candleSeries.removePriceLine(group.main);
      if (group.tp) candleSeries.removePriceLine(group.tp);
      if (group.sl) candleSeries.removePriceLine(group.sl);
      delete priceLines[t];
    }
  }

  currentPositions.forEach((pos) => {
    const mainColor = pos.type === "BUY" ? COL_BUY : COL_SELL;
    const mainTitle = "";

    if (!priceLines[pos.ticket]) {
      const mainLine = candleSeries.createPriceLine({
        price: pos.price_open,
        color: mainColor,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: false,
        title: mainTitle,
      });
      priceLines[pos.ticket] = {
        main: mainLine,
        tp: null,
        sl: null,
        data: pos,
      };
    } else {
      const group = priceLines[pos.ticket];
      group.main.applyOptions({ price: pos.price_open, title: mainTitle });
      group.data = pos;
    }

    const group = priceLines[pos.ticket];

    // TP Line
    if (pos.tp > 0) {
      if (!group.tp) {
        group.tp = candleSeries.createPriceLine({
          price: pos.tp,
          color: COL_TP,
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: false,
          title: "",
        });
      } else {
        group.tp.applyOptions({ price: pos.tp });
      }
    } else if (group.tp) {
      candleSeries.removePriceLine(group.tp);
      group.tp = null;
    }

    // SL Line
    if (pos.sl > 0) {
      if (!group.sl) {
        group.sl = candleSeries.createPriceLine({
          price: pos.sl,
          color: COL_SL,
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: false,
          title: "",
        });
      } else {
        group.sl.applyOptions({ price: pos.sl });
      }
    } else if (group.sl) {
      candleSeries.removePriceLine(group.sl);
      group.sl = null;
    }
  });

  // Trigger HTML Label Update
  updateLeftLabels();
}

function viewSpecificTrade(subPos, event) {
  if (event) event.stopPropagation();
  specificTradeView = subPos;

  if (subPos.symbol !== currentSymbol) changeSymbol(subPos.symbol);

  // Clear all existing lines
  for (let t in priceLines) {
    const group = priceLines[t];
    if (group.main) candleSeries.removePriceLine(group.main);
    if (group.tp) candleSeries.removePriceLine(group.tp);
    if (group.sl) candleSeries.removePriceLine(group.sl);
  }
  priceLines = {};

  const mainColor = subPos.type === "BUY" ? COL_BUY : COL_SELL;

  // Create invisible chart line (we use custom label)
  const mainLine = candleSeries.createPriceLine({
    price: subPos.price,
    color: mainColor,
    lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Solid,
    axisLabelVisible: false,
    title: "",
  });

  priceLines[subPos.ticket] = {
    main: mainLine,
    tp: null,
    sl: null,
    data: {
      ticket: subPos.ticket,
      type: subPos.type,
      price_open: subPos.price,
      price: subPos.price,
      price_current: subPos.price,
      symbol: subPos.symbol,
      volume: subPos.volume,
      sl: subPos.sl,
      tp: subPos.tp,
      account_name: subPos.account_name,
    },
  };

  if (subPos.sl > 0) {
    priceLines[subPos.ticket].sl = candleSeries.createPriceLine({
      price: subPos.sl,
      color: COL_SL,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: false,
      title: "",
    });
  }
  if (subPos.tp > 0) {
    priceLines[subPos.ticket].tp = candleSeries.createPriceLine({
      price: subPos.tp,
      color: COL_TP,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: false,
      title: "",
    });
  }

  updateLeftLabels();
}

function clearSpecificView() {
  specificTradeView = null;
  fetchDashboardData();
}

async function placeOrder(type) {
  const qty = document.getElementById("trade-qty").value;
  try {
    const res = await fetch("http://127.0.0.1:5000/api/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: currentUserId,
        mobile: currentMobile,
        symbol: currentSymbol,
        type: type,
        volume: parseFloat(qty),
      }),
    });
    const data = await res.json();

    if (data.blocked) {
      showError(
        "Trade Blocked",
        "Cannot enter reverse trade. Please close the opposing position first.",
      );
    } else if (data.error) {
      showError("Order Failed", data.error);
    } else {
      const fails = (data.details || []).filter(
        (d) => !d.includes("Done") && !d.includes("Success"),
      );
      if (fails.length > 0) {
        showError("Trade Errors", fails.join("\n"));
      }
      fetchDashboardData();
    }
  } catch (e) {
    showError("Order Failed", e.message);
  }
}

async function closeTrade(ticket) {
  try {
    const res = await fetch("http://127.0.0.1:5000/api/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: currentUserId, ticket: ticket }),
    });
    const data = await res.json();
    if (data.error) {
      showError("Close Failed", data.error);
    } else {
      const fails = (data.details || []).filter(
        (d) => !d.includes("Done") && !d.includes("Success"),
      );
      if (fails.length > 0) {
        showError("Close Errors", fails.join("\n"));
      }
      fetchDashboardData();
    }
  } catch (e) {
    showError("Network Error", e.message);
  }
}

function toggleFullscreen() {
  const col = document.querySelector(".chart-col");
  if (col) {
    col.classList.toggle("fullscreen-mode");
    setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 100);
  }
}

function renderWatchlist() {
  const container = document.getElementById("watchlist-container");
  container.innerHTML = "";
  WATCHLIST.forEach((item) => {
    const div = document.createElement("div");
    div.className = `watchlist-item ${item.sym === currentSymbol ? "active" : ""}`;
    div.onclick = () => changeSymbol(item.sym);
    div.innerHTML = `<div><div class="wl-symbol">${item.sym}</div><div class="wl-desc">${item.desc}</div></div>`;
    container.appendChild(div);
  });
}

function openAccountModal() {
  document.getElementById("account-modal").style.display = "flex";
  hideAccountForm();
  fetchAccounts();
}
function closeAccountModal() {
  document.getElementById("account-modal").style.display = "none";
}
function logout() {
  if (confirm("Logout?")) {
    localStorage.clear();
    window.location.href = "index.html?t=" + Date.now();
  }
}

async function fetchAccounts() {
  try {
    if (!currentUserId) return;
    const res = await fetch(
      `http://127.0.0.1:5000/api/accounts?user_id=${currentUserId}`,
    );
    const accounts = await res.json();
    allAccounts = accounts;
    const container = document.getElementById("account-list-container");
    container.innerHTML = "";
    if (accounts.length === 0) {
      container.innerHTML =
        '<div style="text-align:center; color:#8a94a6; padding:20px;">No accounts linked.</div>';
      return;
    }
    accounts.forEach((acc) => {
      let configSummary = Object.keys(acc.SYMBOL_CONFIG || {})
        .map((s) => `${s}: ${acc.SYMBOL_CONFIG[s].VOLUME}`)
        .join(", ");
      if (!configSummary) configSummary = "No rules";
      const checked = acc.IS_ACTIVE ? "checked" : "";
      container.innerHTML += `
                <div class="account-card" style="opacity: ${acc.IS_ACTIVE ? 1 : 0.5}">
                    <div style="display:flex; align-items:center;">
                        <label class="toggle-switch">
                            <input type="checkbox" ${checked} onchange="toggleAccountActive('${acc.ID}', this.checked)">
                            <span class="slider"></span>
                        </label>
                        <div style="margin-left:8px;">
                            <div style="font-weight:700; color:white;">${acc.NAME || "Account"} <span style="font-weight:400; color:#8a94a6; font-size:12px;">(${acc.USER})</span></div>
                            <div style="font-size:11px; color:#8a94a6;">${configSummary}</div>
                        </div>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <button class="btn-secondary" onclick='editAccount("${acc.ID}")' style="font-size:11px; padding:4px 10px;">Edit</button>
                        <button class="btn-remove-level" onclick="deleteAccount('${acc.ID}')" style="font-size:16px; width:24px; height:24px;">×</button>
                    </div>
                </div>`;
    });
  } catch (e) {
    showError("Account Fetch Error", e.message);
  }
}

async function toggleAccountActive(id, isActive) {
  try {
    await fetch("http://127.0.0.1:5000/api/accounts/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: currentUserId,
        ID: id,
        IS_ACTIVE: isActive,
      }),
    });
    fetchAccounts();
  } catch (e) {
    showError("Update Error", e.message);
  }
}

async function saveAccountToDb() {
  const id = document.getElementById("inp-acc-id").value;
  const configMap = {};
  document.querySelectorAll(".config-row").forEach((row) => {
    const sym = row.querySelector(".inp-sym").value.toUpperCase();
    const vol = parseFloat(row.querySelector(".inp-vol").value);
    if (sym && vol) configMap[sym] = { VOLUME: vol };
  });
  const payload = {
    user_id: currentUserId,
    ID: id || null,
    NAME: document.getElementById("inp-name").value,
    USER: document.getElementById("inp-login").value,
    PASS: document.getElementById("inp-pass").value,
    SERVER: document.getElementById("inp-server").value,
    TERMINAL_PATH: document.getElementById("inp-path")
      ? document.getElementById("inp-path").value.trim()
      : "",
    IS_ACTIVE: true,
    SYMBOL_CONFIG: configMap,
  };

  try {
    await fetch("http://127.0.0.1:5000/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    hideAccountForm();
    fetchAccounts();
  } catch (e) {
    showError("Save Failed", e.message);
  }
}

function showAddAccountForm() {
  document.getElementById("account-list-container").style.display = "none";
  document.querySelector(".btn-add-main").style.display = "none";
  document.getElementById("account-form").style.display = "block";
  document.getElementById("inp-acc-id").value = "";
  document.getElementById("inp-name").value = "";
  document.getElementById("inp-login").value = "";
  document.getElementById("inp-pass").value = "";
  document.getElementById("inp-server").value = "";
  if (document.getElementById("inp-path"))
    document.getElementById("inp-path").value = "";
  document.getElementById("symbol-config-list").innerHTML = "";
  addSymbolConfigRow();
}

function hideAccountForm() {
  document.getElementById("account-form").style.display = "none";
  document.getElementById("account-list-container").style.display = "block";
  document.querySelector(".btn-add-main").style.display = "block";
}

function addSymbolConfigRow(sym = "", vol = "") {
  const list = document.getElementById("symbol-config-list");
  const div = document.createElement("div");
  div.className = "config-row";

  // Create Select Dropdown
  const select = document.createElement("select");
  select.className = "styled-input inp-sym";
  select.style.flex = "1";
  select.onchange = function () {
    validateConfigSymbol(this);
  };

  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.text = "Select Symbol";
  defOpt.disabled = true;
  if (!sym) defOpt.selected = true;
  select.appendChild(defOpt);

  let foundSaved = false;
  WATCHLIST.forEach((w) => {
    const opt = document.createElement("option");
    opt.value = w.sym;
    opt.text = w.sym;
    select.appendChild(opt);
    if (sym && w.sym === sym) foundSaved = true;
  });

  if (sym && !foundSaved) {
    const opt = document.createElement("option");
    opt.value = sym;
    opt.text = `${sym} (Custom)`;
    select.appendChild(opt);
  }

  if (sym) select.value = sym;

  // Create Volume Input
  const input = document.createElement("input");
  input.type = "number";
  input.placeholder = "Vol";
  input.className = "styled-input inp-vol";
  input.step = "0.01";
  input.style.width = "80px";
  input.value = vol;

  const btn = document.createElement("button");
  btn.className = "btn-remove-level";
  btn.innerText = "×";
  btn.style.cssText = "width:30px; height:40px; margin:0;";
  btn.onclick = function () {
    div.remove();
  };

  div.appendChild(select);
  div.appendChild(input);
  div.appendChild(btn);
  list.appendChild(div);
}

function validateConfigSymbol(selectEl) {
  const val = selectEl.value;
  if (!val) return;

  const all = document.querySelectorAll(".inp-sym");
  let count = 0;
  all.forEach((el) => {
    if (el.value === val) count++;
  });

  if (count > 1) {
    alert("Rule for " + val + " already exists.");
    selectEl.value = "";
  }
}

function getAccProp(acc, key) {
  if (!acc) return "";
  return acc[key] || acc[key.toLowerCase()] || "";
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function editAccount(id) {
  const acc = allAccounts.find((a) => String(a.ID) === String(id));
  if (!acc) return;

  showAddAccountForm();
  document.getElementById("form-title").innerText = "Edit Account";

  setVal("inp-acc-id", acc.ID || "");
  setVal("inp-name", getAccProp(acc, "NAME"));
  setVal("inp-login", getAccProp(acc, "USER"));
  setVal("inp-server", getAccProp(acc, "SERVER"));
  setVal("inp-pass", getAccProp(acc, "PASS"));
  setVal("inp-path", getAccProp(acc, "TERMINAL_PATH"));

  const list = document.getElementById("symbol-config-list");
  list.innerHTML = "";

  const config = getAccProp(acc, "SYMBOL_CONFIG");

  if (config && Object.keys(config).length > 0) {
    Object.keys(config).forEach((symbolKey) => {
      let vol = 0.01;
      const data = config[symbolKey];
      if (typeof data === "object" && data.VOLUME) {
        vol = data.VOLUME;
      } else if (typeof data === "number") {
        vol = data;
      } else if (typeof data === "string") {
        vol = parseFloat(data);
      }
      addSymbolConfigRow(symbolKey, vol);
    });
  } else {
    addSymbolConfigRow();
  }
}

async function deleteAccount(id) {
  if (!confirm("Delete?")) return;
  try {
    await fetch("http://127.0.0.1:5000/api/accounts/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: currentUserId, ID: id }),
    });
    fetchAccounts();
  } catch (e) {
    showError("Delete Error", e.message);
  }
}
function adjustQty(delta) {
  const input = document.getElementById("trade-qty");
  let val = parseFloat(input.value) + delta;
  if (val < 0.01) val = 0.01;
  input.value = val.toFixed(2);
}
function showError(title, message) {
  if (isErrorOpen) return;
  isErrorOpen = true;
  const modal = document.getElementById("error-modal");
  document.getElementById("modal-title").innerText = title;
  document.getElementById("modal-message").value = message;
  modal.style.display = "flex";
}
function closeModal() {
  isErrorOpen = false;
  document.getElementById("error-modal").style.display = "none";
}

// Global Exports
window.openAccountModal = openAccountModal;
window.closeAccountModal = closeAccountModal;
window.logout = logout;
window.showAddAccountForm = showAddAccountForm;
window.hideAccountForm = hideAccountForm;
window.addSymbolConfigRow = addSymbolConfigRow;
window.validateConfigSymbol = validateConfigSymbol;
window.saveAccountToDb = saveAccountToDb;
window.editAccount = editAccount;
window.deleteAccount = deleteAccount;
window.closeModal = closeModal;
window.toggleFullscreen = toggleFullscreen;
window.placeOrder = placeOrder;
window.adjustQty = adjustQty;
window.startDrag = startDrag;
window.changeSymbol = changeSymbol;
window.toggleAccountActive = toggleAccountActive;
window.resetChart = resetChart;
window.removeLevel = removeLevel;
window.handleRowClick = handleRowClick;
window.viewSpecificTrade = viewSpecificTrade;
window.closeTrade = closeTrade;
window.toggleSidebar = toggleSidebar;
window.toggleHeader = toggleHeader;
window.updateDrag = updateDrag;
