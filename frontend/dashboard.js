const { ipcRenderer } = require("electron");

// --- 1. SOCKET IO SAFETY CHECK ---
if (typeof io === "undefined") {
  alert("CRITICAL ERROR: Socket.IO script is missing in index.html!");
  throw new Error("Socket.IO missing");
}

// Connect with specific transports to avoid CORS/Firewall issues
const socket = io("http://127.0.0.1:5000", {
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: 5,
});

// --- GLOBAL STATE ---
let currentMobile = localStorage.getItem("userMobile");
let currentUserId = localStorage.getItem("userId");
var currentSymbol = "XAUUSD";
let chart, candleSeries;
let priceLines = {};
let isErrorOpen = false;
let currentTimeframe = "1M";
let latestCandle = null;
let draggingLine = null;
let dragPriceLine = null;
let activeHoverTicket = null;
var allAccounts = [];
let expandedTickets = new Set();
let specificTradeView = null;
let lastHoveredTime = null;
let menuHideTimer = null;
let WATCHLIST = [];
let SYMBOL_MAP = {};
let stepValuesCache = {};
let limitOrderState = {
  active: false,
  isEdit: false,
  editTicket: null,
  type: "BUY",
  entryPrice: 0,
  tpPrice: 0,
  slPrice: 0,
  lines: { entry: null, tp: null, sl: null },
};
let pendingOrderLines = {};
let isSidebarCollapsed = false;

// --- COLORS ---
const COL_BUY = "#2962ff";
const COL_SELL = "#ff5555";
const COL_TP = "#00b894";
const COL_SL = "#d35400";

const TF_SECONDS = {
  "1M": 60,
  "3M": 180,
  "5M": 300,
  "15M": 900,
  "30M": 1800,
  "1H": 3600,
  "4H": 14400,
  "1D": 86400,
  "1W": 604800,
};

let currentPriceLine = null; // Stores the reference to the price line
let lastKnownPrice = 0;

document.addEventListener("DOMContentLoaded", async () => {
  try {
    if (!currentMobile) window.location.href = "index.html";
    console.log("Dashboard initializing...");

    // 1. Fetch Symbols
    await fetchSymbols();

    // 2. Fetch Accounts
    fetchAccounts();

    // 3. Initialize Chart
    initChart();

    // 4. Load History (With Retry)
    loadFullChartHistoryWithRetry(3);

    setupMenuListeners();

    // --- SOCKET LISTENERS ---
    socket.on("connect", () => {
      console.log("✅ Socket Connected:", socket.id);
      const ind = document.getElementById("connection-indicator");
      if (ind) ind.style.color = "#00b894"; // Green
    });

    socket.on("disconnect", () => {
      console.warn("⚠️ Socket Disconnected");
    });

    socket.on("dashboard_update", (data) => {
      // console.log("🔥 Data Update:", data); // Uncomment to debug data flow
      updateDashboardUI(data);
    });

    // 5. Candle Polling (Keep separate from socket for now)
    setInterval(updateLiveCandle, 500);

    // 6. Force Window Focus
    setTimeout(() => ipcRenderer.invoke("focus-window"), 4000);

    // Events
    document.addEventListener("keydown", (e) => {
      if (e.altKey && e.key.toLowerCase() === "b") toggleHeader();
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
    console.error("Dashboard Init Error:", e);
    showError("Dashboard Error", e.message);
  }
});

// --- NEW HELPER: GROUP POSITIONS (Fixes Bug 2) ---
function groupPositions(flatPositions) {
  const grouped = {};
  const masterList = [];

  if (!flatPositions) return [];

  flatPositions.forEach((pos) => {
    // Key: Symbol + Direction (e.g., XAUUSD_BUY)
    const key = `${pos.symbol}_${pos.type}`;

    if (!grouped[key]) {
      grouped[key] = {
        ticket: key, // Master Ticket ID
        symbol: pos.symbol,
        type: pos.type,
        volume: 0,
        priceProd: 0,
        profit: 0,
        sub_positions: [],
        // Aggregated Fields for labels
        sl: pos.sl,
        tp: pos.tp,
        sl_consistent: true,
        tp_consistent: true,
      };
      masterList.push(grouped[key]);
    }

    const master = grouped[key];

    // Aggregate Math
    master.volume += pos.volume;
    master.priceProd += pos.price_open * pos.volume;
    master.profit += pos.profit;
    master.sub_positions.push(pos);

    // Consistency Check (If child SL differs from Master SL)
    if (Math.abs(master.sl - pos.sl) > 0.001) master.sl_consistent = false;
    if (Math.abs(master.tp - pos.tp) > 0.001) master.tp_consistent = false;
  });

  // Finalize Master Fields
  masterList.forEach((m) => {
    if (m.volume > 0) {
      m.price_open = m.priceProd / m.volume;
      // Use current price from first child (approx)
      m.price_current = m.sub_positions[0].price_current;
    }
    // If SL/TP inconsistent, set to 0 (or handle visually)
    if (!m.sl_consistent) m.sl = 0;
    if (!m.tp_consistent) m.tp = 0;
  });

  return masterList;
}

// --- UPDATED SOCKET LISTENER ---
function updateDashboardUI(data) {
  if (!data) return;

  // Group Positions
  const masterPositions = groupPositions(data.positions);
  window.SYSTEM_STATE = { ...data, positions: masterPositions };
  if (!window.SYSTEM_STATE.orders) window.SYSTEM_STATE.orders = [];

  cleanupStepCache();

  // --- 1. Update Main Dashboard Stats ---
  const balEl = document.getElementById("val-balance");
  if (balEl) balEl.innerText = `$${data.balance.toFixed(2)}`;

  const eqEl = document.getElementById("val-equity");
  if (eqEl) eqEl.innerText = `$${data.equity.toFixed(2)}`;

  const plEl = document.getElementById("val-pl");
  if (plEl) {
    plEl.innerText = `$${data.profit.toFixed(2)}`;
    // Color coding for P/L
    plEl.className =
      data.profit >= 0 ? "stat-value text-green" : "stat-value text-red";
  }

  const powerEl = document.getElementById("val-power");
  if (powerEl) powerEl.innerText = `$${data.margin_free.toFixed(2)}`;

  // Update Progress Bar
  const usedMargin = data.balance - data.margin_free;
  const usagePct = data.balance > 0 ? (usedMargin / data.balance) * 100 : 0;
  const bar = document.querySelector(".progress-fill");
  if (bar) bar.style.width = `${usagePct}%`;

  // --- 2. Update Fullscreen Stats (Fix for Req #1) ---
  const fsBal = document.getElementById("fs-val-bal");
  if (fsBal) fsBal.innerText = `$${data.balance.toFixed(2)}`;

  const fsEq = document.getElementById("fs-val-equity");
  if (fsEq) fsEq.innerText = `$${data.equity.toFixed(2)}`;

  const fsPl = document.getElementById("fs-val-pl");
  if (fsPl) {
    fsPl.innerText = `$${data.profit.toFixed(2)}`;
    fsPl.className =
      data.profit >= 0 ? "fs-value text-green" : "fs-value text-red";
  }

  const fsMar = document.getElementById("fs-val-margin");
  if (fsMar) fsMar.innerText = `$${data.margin_free.toFixed(2)}`;

  // --- 3. Update Watchlist Prices (Fix for Req #2) ---
  if (data.prices) {
    updateWatchlistPrices(data.prices);
  }

  // --- 4. Render Tables & Charts ---
  renderPositions(window.SYSTEM_STATE.positions);

  if (specificTradeView) {
    refreshSpecificView(window.SYSTEM_STATE.positions);
  } else {
    updateChartPositions(window.SYSTEM_STATE.positions);
  }
  renderPendingOrders(data.orders);
}

// --- UPDATED LIMIT LABELS (Fixes Bug 4 - P/L Calc) ---
function renderLimitLabels(container) {
  let totalVol = 0;
  const accounts = window.allAccounts || [];
  const sym = window.currentSymbol || currentSymbol;

  // Calculate Volume based on Active Accounts + Config
  if (accounts.length > 0 && sym) {
    const rawSym = sym.toUpperCase();
    accounts.forEach((acc) => {
      if (acc.IS_ACTIVE) {
        let accVol = 0.01; // Default minimum

        // Check if account has specific config for this symbol
        if (acc.SYMBOL_CONFIG) {
          const configKey = Object.keys(acc.SYMBOL_CONFIG).find((k) => {
            const confSym = k.toUpperCase();
            return rawSym === confSym || rawSym.startsWith(confSym);
          });
          if (configKey) {
            const v = parseFloat(acc.SYMBOL_CONFIG[configKey].VOLUME);
            if (!isNaN(v)) accVol = v;
          }
        }
        totalVol += accVol;
      }
    });
  }

  // Fallback if no accounts active (to avoid 0 division or weird display)
  if (totalVol === 0) totalVol = 0.01;

  const qtyInput = document.getElementById("trade-qty");
  const inputMultiplier = qtyInput ? parseFloat(qtyInput.value) || 1 : 1;
  const finalVol = totalVol * inputMultiplier;

  const definitions = [
    {
      type: "ENTRY",
      price: limitOrderState.entryPrice,
      color: limitOrderState.type === "BUY" ? COL_BUY : COL_SELL,
    },
    { type: "TP", price: limitOrderState.tpPrice, color: COL_TP },
    { type: "SL", price: limitOrderState.slPrice, color: COL_SL },
  ];
  definitions.forEach((def) => {
    const id = `limit-lbl-${def.type}`;
    let div = document.getElementById(id);
    const y = candleSeries.priceToCoordinate(def.price);
    if (y === null) {
      if (div) div.remove();
      return;
    }
    const inputHtml = `<input type="number" step="0.01" class="limit-price-input no-drag" value="${def.price.toFixed(2)}" onmousedown="this.focus(); event.stopPropagation();" onclick="this.focus(); event.stopPropagation();" onkeyup="if(event.key === 'Enter') handleLimitInput('${def.type}', this.value)" onblur="handleLimitInput('${def.type}', this.value)" />`;
    let contentHtml = "";
    if (def.type === "ENTRY") {
      const isEdit = limitOrderState.isEdit;
      const isSubmitting = limitOrderState.isSubmitting;
      let btnText = isEdit ? "UPDATE" : "PLACE";
      let btnAction = isEdit
        ? "submitOrderModification()"
        : "confirmLimitOrderFromLabel()";
      let btnStyle = "";
      if (isSubmitting) {
        btnText = "...";
        btnAction = "";
        btnStyle = "opacity:0.7; pointer-events:none;";
      }
      contentHtml = `<span style="margin-right:2px;">Entry</span> ${inputHtml} <button class="btn-label-place no-drag" style="${btnStyle}" onmousedown="event.stopPropagation(); ${btnAction}">${btnText}</button> <span class="no-drag" style="margin-left:8px; cursor:pointer; font-size:16px;" onmousedown="event.stopPropagation(); cancelLimitMode()">×</span>`;
    } else {
      // Pass finalVol here for accurate P/L
      const plVal = calculatePL(
        currentSymbol,
        limitOrderState.type,
        finalVol,
        limitOrderState.entryPrice,
        def.price,
      );
      const plNum = parseFloat(plVal);
      const sign = plNum >= 0 ? "+" : "";
      const plColor = "#ffffff";
      contentHtml = `${def.type} ${inputHtml} (<span style="color:${plColor}">${sign}$${plVal}</span>)`;
    }
    if (!div) {
      div = document.createElement("div");
      div.id = id;
      div.className = "trade-label-tag limit-label";
      div.style.position = "absolute";
      div.style.left = "0px";
      div.style.fontSize = "14px";
      div.style.padding = "6px 12px";
      div.style.display = "flex";
      div.style.alignItems = "center";
      div.style.fontWeight = "700";
      div.style.cursor = "ns-resize";
      div.style.zIndex = "61";
      div.style.pointerEvents = "auto";
      div.addEventListener("mouseenter", () => {
        div.style.zIndex = "1000";
      });
      div.addEventListener("mouseleave", () => {
        div.style.zIndex = "61";
      });
      div.onmousedown = (e) => {
        if (
          e.target.classList.contains("no-drag") ||
          e.target.tagName === "INPUT"
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        startDrag("LIMIT", def.type, def.price);
      };
      container.appendChild(div);
    }
    const activeInput = document.activeElement;
    const isFocusedHere =
      activeInput &&
      div.contains(activeInput) &&
      activeInput.tagName === "INPUT";
    if (!isFocusedHere) {
      div.innerHTML = contentHtml;
    }
    div.style.top = `${y}px`;
    div.style.backgroundColor = def.color;
    div.style.color = "white";
    if (!div.innerHTML.trim()) div.innerHTML = contentHtml;
  });
}

function updateDashboardUI(data) {
  if (!data) return;

  // Group Positions
  const masterPositions = groupPositions(data.positions);
  window.SYSTEM_STATE = { ...data, positions: masterPositions };
  if (!window.SYSTEM_STATE.orders) window.SYSTEM_STATE.orders = [];

  cleanupStepCache();

  // 1. Update Main Dashboard Stats
  try {
    const balEl = document.getElementById("val-balance");
    if (balEl) balEl.innerText = `$${(data.balance || 0).toFixed(2)}`;

    const eqEl = document.getElementById("val-equity");
    if (eqEl) eqEl.innerText = `$${(data.equity || 0).toFixed(2)}`;

    const plEl = document.getElementById("val-pl");
    if (plEl) {
      const prof = data.profit || 0;
      plEl.innerText = `$${prof.toFixed(2)}`;
      plEl.className =
        prof >= 0 ? "stat-value text-green" : "stat-value text-red";
    }

    const powerEl = document.getElementById("val-power");
    if (powerEl) powerEl.innerText = `$${(data.margin_free || 0).toFixed(2)}`;

    const usedMargin = (data.balance || 0) - (data.margin_free || 0);
    const usagePct =
      (data.balance || 0) > 0 ? (usedMargin / data.balance) * 100 : 0;
    const bar = document.querySelector(".progress-fill");
    if (bar) bar.style.width = `${usagePct}%`;

    // 2. Update Fullscreen Stats
    const fsBal = document.getElementById("fs-val-bal");
    if (fsBal) fsBal.innerText = `$${(data.balance || 0).toFixed(2)}`;

    const fsEq = document.getElementById("fs-val-equity");
    if (fsEq) fsEq.innerText = `$${(data.equity || 0).toFixed(2)}`;

    const fsPl = document.getElementById("fs-val-pl");
    if (fsPl) {
      const prof = data.profit || 0;
      fsPl.innerText = `$${prof.toFixed(2)}`;
      fsPl.className = prof >= 0 ? "fs-value text-green" : "fs-value text-red";
    }

    const fsMar = document.getElementById("fs-val-margin");
    if (fsMar) fsMar.innerText = `$${(data.margin_free || 0).toFixed(2)}`;
  } catch (e) {
    console.error("Error updating stats:", e);
  }

  // 3. Update Watchlist Prices
  if (data.prices) {
    updateWatchlistPrices(data.prices);
  }

  // 4. Render Tables & Charts
  renderPositions(window.SYSTEM_STATE.positions);

  if (specificTradeView) {
    refreshSpecificView(window.SYSTEM_STATE.positions);
  } else {
    updateChartPositions(window.SYSTEM_STATE.positions);
  }
  renderPendingOrders(data.orders);
}

// --- DATA FETCHING ---
async function fetchSymbols() {
  try {
    const res = await fetch("http://127.0.0.1:5000/api/symbols");
    if (!res.ok) throw new Error("Symbol fetch failed");

    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      WATCHLIST = data;
      SYMBOL_MAP = {};
      data.forEach((s) => {
        SYMBOL_MAP[s.sym] = s;
      });
      if (!SYMBOL_MAP[currentSymbol]) {
        currentSymbol = WATCHLIST[0].sym;
      }
    } else {
      console.warn("No symbols in DB, using defaults.");
      WATCHLIST = [{ sym: "XAUUSD", desc: "Gold", trail: 0.5 }];
    }
    renderWatchlist();
  } catch (e) {
    console.error("Symbol Error:", e);
    // Fallback so UI doesn't break
    WATCHLIST = [{ sym: "XAUUSD", desc: "Gold", trail: 0.5 }];
    renderWatchlist();
  }
}

async function loadFullChartHistoryWithRetry(attempts = 10) {
  // Increased attempts
  console.log("Fetching Chart History...");
  for (let i = 0; i < attempts; i++) {
    const success = await loadFullChartHistory();
    if (success) return;

    // Retry every 500ms instead of 2000ms for snappier feel
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("Chart data not available yet.");
}

// --- FIX: CHART LOAD (100 Candles + Space) ---
// --- FIX 1: Initial Chart Load (25 Candles Buffer) ---
async function loadFullChartHistory() {
  try {
    const url = `http://127.0.0.1:5000/api/candles?symbol=${currentSymbol}&timeframe=${currentTimeframe}&limit=2000`;
    const response = await fetch(url);
    const data = await response.json();

    if (data && data.length > 0) {
      candleSeries.setData(data);
      latestCandle = data[data.length - 1];
      updateLegend(latestCandle);

      // LOGIC: Show last 100 candles + 25 empty space
      const visiblePoints = 100;
      const totalPoints = data.length;
      const fromIndex = Math.max(0, totalPoints - visiblePoints);

      chart.timeScale().setVisibleLogicalRange({
        from: fromIndex,
        to: totalPoints + 25, // Increased buffer
      });

      chart.priceScale("right").applyOptions({ autoScale: true });
      return true;
    }
    return false;
  } catch (e) {
    console.error("Chart Load Error:", e);
    return false;
  }
}

// --- FIX 2: Reset Button (Matches Initial View) ---
function resetChart() {
  if (chart && candleSeries) {
    const data = candleSeries.data();
    if (data.length > 0) {
      const visiblePoints = 100;
      const totalPoints = data.length;
      const fromIndex = Math.max(0, totalPoints - visiblePoints);

      // Snap back to end with SAME buffer
      chart.timeScale().setVisibleLogicalRange({
        from: fromIndex,
        to: totalPoints + 25, // Increased buffer
      });

      // Ensure auto-scaling is active
      chart.priceScale("right").applyOptions({ autoScale: true });
    }
  }
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
      if (!lastHoveredTime || lastHoveredTime === latest.time) {
        updateLegend(latest);
      }
      if (latestCandle) {
        lastKnownPrice = latestCandle.close;
        // Trigger immediate update so line doesn't lag
        updateCountdownOnPriceLine(); 
      }
      updateLeftLabels();
    }
  } catch (e) {
    // Silent fail for polling to avoid log spam
  }
}

// --- STANDARD UI FUNCTIONS (Rest of your original code) ---
function initChart() {
  const container = document.getElementById("chart-container");
  if (!container) return;
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
      fontSize: 20,
      fontFamily: "Inter, sans-serif",
    },
    grid: {
      vertLines: { color: "rgba(255, 255, 255, 0.05)" },
      horzLines: { color: "rgba(255, 255, 255, 0.05)" },
    },
    localization: {
      locale: "en-IN",
      timeFormatter: (timestamp) => {
        return new Date(timestamp * 1000)
          .toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            day: "2-digit",
            month: "2-digit",
            year: "2-digit",
            hour12: false,
          })
          .replace(",", "");
      },
    },
    rightPriceScale: { visible: true },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: {
      timeVisible: true,
      borderColor: "rgba(255, 255, 255, 0.1)",
      rightOffset: 20,
      tickMarkFormatter: (time, tickMarkType, locale) => {
        const date = new Date(time * 1000);
        const options = { timeZone: "Asia/Kolkata" };
        if (tickMarkType < 3) {
          return date.toLocaleDateString("en-IN", {
            ...options,
            day: "numeric",
            month: "short",
          });
        } else {
          return date.toLocaleTimeString("en-IN", {
            ...options,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
        }
      },
    },
  });
  candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: "#36d7b7",
    downColor: "#ff5555",
    borderVisible: false,
    wickUpColor: "#36d7b7",
    wickDownColor: "#ff5555",
  });

  chart.subscribeCrosshairMove((param) => {
    if (param.time) {
      lastHoveredTime = param.time;
      const data = param.seriesData.get(candleSeries);
      if (data) updateLegend(data);
    } else {
      lastHoveredTime = null;
      if (latestCandle) updateLegend(latestCandle);
    }
    updateLeftLabels();
  });
  container.addEventListener("mouseleave", () => {
    lastHoveredTime = null;
    if (latestCandle) updateLegend(latestCandle);
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    updateLeftLabels();
  });
  container.addEventListener("mousedown", () => {
    document.getElementById("hover-menu").style.display = "none";
  });
  container.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const price = candleSeries.coordinateToPrice(y);
    if (price) {
      showContextMenu(e.clientX, e.clientY, price);
    }
  });
  document.addEventListener("click", () => {
    const menu = document.getElementById("custom-ctx-menu");
    if (menu) menu.style.display = "none";
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

function renderWatchlist() {
  const container = document.getElementById("watchlist-container");
  container.innerHTML = "";
  WATCHLIST.forEach((item) => {
    const div = document.createElement("div");
    div.className = `watchlist-item ${item.sym === currentSymbol ? "active" : ""}`;
    div.onclick = () => changeSymbol(item.sym);
    div.innerHTML = `
        <div class="wl-row-top">
            <div class="wl-symbol">${item.sym}</div>
            <div id="wl-price-${item.sym}" class="wl-price">--</div>
        </div>
        <div class="wl-desc">${item.desc}</div>`;
    container.appendChild(div);
  });
}

async function changeSymbol(newSym) {
  if (currentSymbol !== newSym) {
    currentSymbol = newSym;
    document.getElementById("chart-symbol-name").innerText = currentSymbol;
    specificTradeView = null;
  }
  for (let t in priceLines) {
    const group = priceLines[t];
    if (group.main) candleSeries.removePriceLine(group.main);
    if (group.tp) candleSeries.removePriceLine(group.tp);
    if (group.sl) candleSeries.removePriceLine(group.sl);
  }
  priceLines = {};
  candleSeries.setData([]);
  renderWatchlist();
  loadFullChartHistoryWithRetry(2);
}

function updateWatchlistPrices(priceMap) {
  for (let sym in priceMap) {
    const el = document.getElementById(`wl-price-${sym}`);
    if (el) el.innerText = Number(priceMap[sym].bid).toFixed(2);
  }
}

// ... [Keep ALL your existing Helper Functions below exactly as they were] ...
// (refreshSpecificView, renderSlTpCell, renderPositions, handleRowClick, toggleGroup, etc.)
// Make sure to paste the rest of your original functions here.
// For brevity in this answer, I am ensuring the CORE LOGIC above is replaced.

function cleanupStepCache() {
  if (
    !stepValuesCache ||
    !window.SYSTEM_STATE ||
    !window.SYSTEM_STATE.positions
  )
    return;
  const activeKeys = new Set();
  window.SYSTEM_STATE.positions.forEach((master) => {
    activeKeys.add(String(master.ticket));
    if (master.sub_positions) {
      master.sub_positions.forEach((sub) => activeKeys.add(String(sub.ticket)));
    }
  });
  Object.keys(stepValuesCache).forEach((key) => {
    if (!activeKeys.has(String(key))) {
      delete stepValuesCache[key];
    }
  });
}
function updateStepCache(ticket, value) {
  if (ticket) stepValuesCache[ticket] = parseFloat(value);
}
function getStepValueForTicket(ticket) {
  const id = `lbl-${ticket}-SL`;
  const div = document.getElementById(id);
  if (div) {
    const stepInput = div.querySelector(".step-input");
    if (stepInput) {
      const val = parseFloat(stepInput.value);
      if (!isNaN(val)) return val;
    }
  }
  if (stepValuesCache && stepValuesCache[ticket])
    return stepValuesCache[ticket];
  return 0.5;
}
function togglePassword() {
  const inp = document.getElementById("inp-pass");
  inp.type = inp.type === "password" ? "text" : "password";
}
function setupMenuListeners() {
  const menu = document.getElementById("hover-menu");
  menu.addEventListener("mouseenter", () => {
    if (menuHideTimer) clearTimeout(menuHideTimer);
  });
  menu.addEventListener("mouseleave", () => {
    menuHideTimer = setTimeout(() => {
      menu.style.display = "none";
    }, 150);
  });
}
function toggleSidebar() {
  isSidebarCollapsed = !isSidebarCollapsed;
  const container = document.getElementById("app-container");
  if (isSidebarCollapsed) {
    container.classList.add("sidebar-collapsed");
  } else {
    container.classList.remove("sidebar-collapsed");
  }
  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 310);
}
function toggleHeader() {
  // Fix for Req #4: Toggle fullscreen stats visibility too
  const col = document.getElementById("stats-column");
  const fsStats = document.getElementById("fs-stats");

  let isHidden = false;

  if (col) {
    if (col.classList.contains("hidden")) {
      col.classList.remove("hidden");
    } else {
      col.classList.add("hidden");
      isHidden = true;
    }
  }

  // Toggle the fullscreen stats container
  if (fsStats) {
    // If hidden is true, we hide fsStats. If hidden is false, we allow it to follow CSS rules (flex)
    // We use !important to override the .fullscreen-mode display:flex rule when hidden
    fsStats.style.cssText = isHidden ? "display: none !important" : "";
  }

  triggerResize();
}
function triggerResize() {
  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 310);
}
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
  if (found && found.symbol.startsWith(currentSymbol)) {
    viewSpecificTrade(found, null);
  } else {
    clearSpecificView();
  }
}
// --- FIX: Horizontal SL/TP Layout ---
function renderSlTpCell(
  targetPrice,
  type,
  ticket,
  symbol,
  entryPrice,
  volume,
  direction,
) {
  if (!targetPrice || targetPrice <= 0)
    return '<span style="color:#555">-</span>';

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

  // New Structure:
  // [ Price ]   [ x ]
  // [ (PnL) ]
  return `
    <div class="sl-tp-container">
        <div class="sl-tp-info">
            <span class="sl-tp-price" style="color:${color};">${Number(targetPrice).toFixed(2)}</span>
            <span class="sl-tp-pnl ${plClass}">(${plSign}$${Number(plValue).toFixed(2)})</span>
        </div>
        <span class="remove-x" 
              onclick="removeLevel('${ticket}', '${type}'); event.stopPropagation();"
              title="Remove Level">
              ×
        </span>
    </div>`;
}

function renderPositions(positions) {
  const tbody = document.querySelector("#positions-table tbody");
  if (!tbody) return;
  const activeRowIds = new Set();
  let hasPositions = false;

  positions.forEach((pos) => {
    hasPositions = true;
    const masterId = `row-master-${pos.ticket}`;
    activeRowIds.add(masterId);
    const openPrice =
      pos.price_open !== undefined ? pos.price_open : pos.price || 0;
    let masterRow = document.getElementById(masterId);
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
    const profitClass = pos.profit >= 0 ? "text-green" : "text-red";
    const isExpanded = expandedTickets.has(pos.ticket);

    if (!masterRow) {
      masterRow = document.createElement("tr");
      masterRow.id = masterId;
      masterRow.className = "master-row";
      masterRow.onclick = (e) => handleRowClick(pos.ticket, e, masterRow);
      masterRow.innerHTML = `
            <td class="symbol-cell"> <span class="toggle-icon ${isExpanded ? "expanded" : ""}">▶</span> <div style="margin-left:5px;"> <div class="symbol-name">${pos.symbol}</div> <div class="symbol-desc"><span class="${pos.type === "BUY" ? "badge-buy" : "badge-sell"}">${pos.type}</span></div> </div> </td>
            <td class="col-vol"><strong>${Number(pos.volume).toFixed(2)}</strong></td> <td class="col-open">${Number(openPrice).toFixed(2)}</td> <td class="col-curr">${Number(pos.price_current).toFixed(2)}</td> <td class="col-sl">${slHtml}</td> <td class="col-tp">${tpHtml}</td> <td class="col-pl ${profitClass}">$${Number(pos.profit).toFixed(2)}</td>
            <td> <button class="btn-close-trade" onclick="closeTrade('${pos.ticket}', this); event.stopPropagation();">Close All</button> </td>`;
      tbody.appendChild(masterRow);
    } else {
      masterRow.querySelector(".toggle-icon").className =
        `toggle-icon ${isExpanded ? "expanded" : ""}`;
      masterRow.querySelector(".col-vol strong").innerText = Number(
        pos.volume,
      ).toFixed(2);
      masterRow.querySelector(".col-open").innerText =
        Number(openPrice).toFixed(2);
      masterRow.querySelector(".col-curr").innerText = Number(
        pos.price_current,
      ).toFixed(2);
      masterRow.querySelector(".col-sl").innerHTML = slHtml;
      masterRow.querySelector(".col-tp").innerHTML = tpHtml;
      const plCell = masterRow.querySelector(".col-pl");
      plCell.className = `col-pl ${profitClass}`;
      plCell.innerText = `$${Number(pos.profit).toFixed(2)}`;
    }

    if (pos.sub_positions && pos.sub_positions.length > 0) {
      pos.sub_positions.forEach((sub) => {
        const childId = `row-child-${sub.ticket}`;
        activeRowIds.add(childId);
        let subSlHtml = renderSlTpCell(
          sub.sl,
          "sl",
          sub.ticket,
          sub.symbol,
          sub.price_open,
          sub.volume,
          sub.type,
        );
        let subTpHtml = renderSlTpCell(
          sub.tp,
          "tp",
          sub.ticket,
          sub.symbol,
          sub.price_open,
          sub.volume,
          sub.type,
        );
        const subProfitClass = sub.profit >= 0 ? "text-green" : "text-red";
        let childRow = document.getElementById(childId);

        if (!childRow) {
          childRow = document.createElement("tr");
          childRow.id = childId;
          childRow.className = `child-row child-of-${pos.ticket}`;
          childRow.style.display = isExpanded ? "table-row" : "none";
          childRow.onclick = (event) => viewSpecificTrade(sub, event);
          childRow.innerHTML = `
                <td class="child-account-name">↳ ${sub.account_name}</td> <td class="child-text col-vol">${Number(sub.volume).toFixed(2)}</td> 
                <td class="child-text col-open">${Number(sub.price_open).toFixed(2)}</td> 
                <td class="child-text">-</td> <td class="child-text col-sl">${subSlHtml}</td> <td class="child-text col-tp">${subTpHtml}</td> <td class="child-text col-pl ${subProfitClass}">$${Number(sub.profit).toFixed(2)}</td>
                <td style="vertical-align: middle;"> <button class="btn-remove-level" style="height:22px; line-height:22px; padding:0 10px; font-family:'Inter', sans-serif;" onclick="closeTrade('${sub.ticket}', this); event.stopPropagation();">Close</button> </td>`;
          tbody.appendChild(childRow);
        } else {
          childRow.style.display = isExpanded ? "table-row" : "none";
          childRow.querySelector(".col-vol").innerText = Number(
            sub.volume,
          ).toFixed(2);
          childRow.querySelector(".col-open").innerText = Number(
            sub.price_open,
          ).toFixed(2); // FIX
          childRow.querySelector(".col-sl").innerHTML = subSlHtml;
          childRow.querySelector(".col-tp").innerHTML = subTpHtml;
          const subPl = childRow.querySelector(".col-pl");
          subPl.className = `child-text col-pl ${subProfitClass}`;
          subPl.innerText = `$${Number(sub.profit).toFixed(2)}`;
        }
      });
    }
  });

  Array.from(tbody.children).forEach((row) => {
    if (row.id && !activeRowIds.has(row.id) && row.id !== "no-pos-msg") {
      row.remove();
    }
  });
  if (!hasPositions) {
    if (!document.getElementById("no-pos-msg")) {
      tbody.innerHTML =
        '<tr id="no-pos-msg"><td colspan="8" style="text-align:center; padding:20px; color:#555;">No open positions</td></tr>';
    }
  } else {
    const msg = document.getElementById("no-pos-msg");
    if (msg) msg.remove();
  }
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
function renderPendingOrders(orders) {
  const rawOrders =
    orders || (window.SYSTEM_STATE ? window.SYSTEM_STATE.orders : []);
  const aggregatedOrders = aggregateOrders(rawOrders);
  if (!candleSeries) return;
  for (let t in pendingOrderLines) {
    if (pendingOrderLines[t])
      candleSeries.removePriceLine(pendingOrderLines[t]);
  }
  pendingOrderLines = {};
  aggregatedOrders.forEach((o) => {
    if (
      limitOrderState.active &&
      limitOrderState.isEdit &&
      limitOrderState.editTickets &&
      o.tickets.some((t) => limitOrderState.editTickets.includes(t))
    )
      return;
    const key = o.tickets[0];
    pendingOrderLines[key] = candleSeries.createPriceLine({
      price: o.price_open,
      color: o.type === "BUY" ? COL_BUY : COL_SELL,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    });
  });
  renderPendingOrderLabels(aggregatedOrders);
}
function renderPendingOrderLabels(aggregatedOrders) {
  const container = document.getElementById("trade-labels-left");
  if (!container) return;
  const existingLabels = container.querySelectorAll(".pending-order-label");
  existingLabels.forEach((el) => el.remove());
  aggregatedOrders.forEach((o) => {
    if (
      limitOrderState.active &&
      limitOrderState.isEdit &&
      limitOrderState.editTickets &&
      o.tickets.some((t) => limitOrderState.editTickets.includes(t))
    )
      return;
    const y = candleSeries.priceToCoordinate(o.price_open);
    if (y === null) return;
    const div = document.createElement("div");
    div.className = "trade-label-tag pending-order-label";
    div.style.position = "absolute";
    div.style.left = "0px";
    div.style.top = `${y}px`;
    div.style.zIndex = "50";
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.gap = "6px";
    div.addEventListener("mouseenter", () => {
      div.style.zIndex = "1000";
    });
    div.addEventListener("mouseleave", () => {
      div.style.zIndex = "50";
    });
    const bgColor = o.type === "BUY" ? COL_BUY : COL_SELL;
    div.style.backgroundColor = bgColor;
    div.style.color = "white";
    div.style.border = `1px solid ${bgColor}`;
    div.style.fontSize = "12px";
    div.style.padding = "4px 8px";
    div.style.cursor = "pointer";
    div.style.pointerEvents = "auto";
    div.onclick = (e) => {
      e.stopPropagation();
      startEditOrder(o);
    };
    const qtyText = parseFloat(o.volume.toFixed(2));
    div.innerHTML = `<span>⏳ ${o.type} ${qtyText} @ ${o.price_open}</span>`;
    const closeSpan = document.createElement("span");
    closeSpan.innerHTML = "×";
    closeSpan.style.fontWeight = "bold";
    closeSpan.style.fontSize = "16px";
    closeSpan.style.marginLeft = "4px";
    closeSpan.style.cursor = "pointer";
    closeSpan.onclick = async (e) => {
      e.stopPropagation();
      if (confirm(`Cancel ${o.count} pending order(s)?`)) {
        closeSpan.innerHTML = "";
        closeSpan.className = "loader-spinner-small";
        closeSpan.style.borderColor =
          "white transparent transparent transparent";
        await cancelPendingOrder(o.tickets);
      }
    };
    div.appendChild(closeSpan);
    container.appendChild(div);
  });
}
function aggregateOrders(orders) {
  if (!orders) return [];
  let targetOrders = orders.filter((o) => o.symbol.startsWith(currentSymbol));
  if (specificTradeView) {
    targetOrders = targetOrders.filter(
      (o) =>
        (o.account && o.account === specificTradeView.account_name) ||
        (o.account_login && o.account_login == specificTradeView.account_login),
    );
  }
  const grouped = {};
  targetOrders.forEach((o) => {
    const key = `${o.type}_${o.price_open.toFixed(5)}`;
    if (!grouped[key]) {
      grouped[key] = { ...o, volume: 0, count: 0, tickets: [] };
    }
    grouped[key].volume += o.volume;
    grouped[key].count++;
    grouped[key].tickets.push(o.ticket);
  });
  return Object.values(grouped);
}
async function removeLevel(ticket, type) {
  const normType = type.toLowerCase();
  const payload = { ticket: ticket, user_id: currentUserId };
  if (normType === "sl") payload.sl = 0.0;
  if (normType === "tp") payload.tp = 0.0;
  try {
    await fetch("http://127.0.0.1:5000/api/modify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    showError("Network Error", err.message);
  }
}
function showContextMenu(x, y, price) {
  let menu = document.getElementById("custom-ctx-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "custom-ctx-menu";
    menu.className = "custom-context-menu";
    document.body.appendChild(menu);
  }
  menu.innerHTML = `<div class="ctx-menu-item" onclick="initLimitFromContextMenu('BUY', ${price})">Buy Limit @ ${price.toFixed(2)}</div> <div class="ctx-menu-item" onclick="initLimitFromContextMenu('SELL', ${price})">Sell Limit @ ${price.toFixed(2)}</div>`;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = "block";
}
function initLimitFromContextMenu(type, price) {
  const menu = document.getElementById("custom-ctx-menu");
  if (menu) menu.style.display = "none";
  startLimitModeCustom(type, price);
}
function updateLeftLabels() {
  const container = document.getElementById("trade-labels-left");
  if (!container) return;
  const activeLabelIds = new Set();
  if (candleSeries) {
    for (let t in priceLines) {
      const group = priceLines[t];
      const data = group.data;
      if (group.main) {
        renderSingleLabel(
          container,
          t,
          "MAIN",
          data.price_open || data.price,
          data,
        );
        activeLabelIds.add(`lbl-${t}-MAIN`);
      }
      if (!limitOrderState.active) {
        if (group.tp) {
          renderSingleLabel(container, t, "TP", data.tp, data);
          activeLabelIds.add(`lbl-${t}-TP`);
        }
        if (group.sl) {
          renderSingleLabel(container, t, "SL", data.sl, data);
          activeLabelIds.add(`lbl-${t}-SL`);
        }
      }
    }
  }
  if (window.SYSTEM_STATE && window.SYSTEM_STATE.orders) {
    const aggOrders = aggregateOrders(window.SYSTEM_STATE.orders);
    renderPendingOrderLabels(aggOrders);
  }
  if (limitOrderState.active) {
    try {
      renderLimitLabels(container);
    } catch (e) {
      console.error("Error rendering limit labels:", e);
    }
  } else {
    ["limit-lbl-ENTRY", "limit-lbl-TP", "limit-lbl-SL"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }
  Array.from(container.children).forEach((child) => {
    if (
      child.id &&
      child.id.startsWith("lbl-") &&
      !activeLabelIds.has(child.id)
    ) {
      child.remove();
    }
  });
}
function renderSingleLabel(container, ticket, type, price, data) {
  if (!price || price <= 0) return;
  const id = `lbl-${ticket}-${type}`;
  let div = document.getElementById(id);
  const y = candleSeries.priceToCoordinate(price);
  
  if (y === null) {
    if (div) div.style.display = "none";
    return;
  }

  // --- Logic for P/L Colors & Text (Identical to your snippet) ---
  let plText = "";
  let plColor = "#ffffff";
  let sign = "";
  if (type === "MAIN" && data.profit !== undefined) {
    plText = Number(data.profit).toFixed(2);
    plColor = data.profit >= 0 ? "#00b894" : "#ff5555";
    sign = data.profit >= 0 ? "+" : "";
  } else {
    const target = type === "MAIN" ? data.price_current : price;
    const plVal = calculatePL(
      data.symbol,
      data.type,
      data.volume,
      data.price_open,
      target,
    );
    plText = plVal;
    plColor = parseFloat(plVal) >= 0 ? "#00b894" : "#ff5555";
    sign = parseFloat(plVal) >= 0 ? "+" : "";
  }

  const finalPlColor = type === "MAIN" ? plColor : "#ffffff";
  const typeColor = data.type === "BUY" ? "#2962ff" : "#ff5555";
  const bg = type === "MAIN" ? "#ffffff" : type === "TP" ? COL_TP : COL_SL;
  const fg = type === "MAIN" ? typeColor : "#ffffff";
  const border = type === "MAIN" ? `2px solid ${typeColor}` : "none";

  // --- Div Creation (Identical to your snippet) ---
  if (!div) {
    div = document.createElement("div");
    div.id = id;
    div.className = "trade-label-tag";
    div.style.position = "absolute";
    div.style.left = "0px";
    div.style.fontSize = "14px";
    div.style.padding = "6px 12px";
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.gap = "8px";
    div.style.zIndex = "60";
    div.style.cursor = type === "MAIN" ? "default" : "ns-resize";
    
    // Z-Index Logic
    div.addEventListener("mouseenter", () => { div.style.zIndex = "1000"; });
    div.addEventListener("mouseleave", () => { div.style.zIndex = "60"; });

    if (type === "MAIN") {
      div.onmouseenter = () => {
        div.style.zIndex = "1000";
        if (menuHideTimer) clearTimeout(menuHideTimer);
        showHoverMenuFixed(ticket, type, y, div);
      };
      div.onmouseleave = () => {
        div.style.zIndex = "60";
        menuHideTimer = setTimeout(() => {
          const m = document.getElementById("hover-menu");
          if (m) m.style.display = "none";
        }, 150);
      };
    } else {
      div.onmousedown = (e) => {
        if (
          e.target.tagName === "INPUT" ||
          e.target.closest(".sl-modifier-group") ||
          e.target.classList.contains("label-close")
        ) return;
        e.preventDefault();
        e.stopPropagation();
        startDrag(ticket, type, price);
      };
    }

    // --- HTML GENERATION (UPDATED PART) ---
    let innerHTML = "";
    if (type === "MAIN") {
      let coreText = `${data.type} ${data.volume} @ ${data.price_open.toFixed(2)}`;
      if (data.account_name) coreText = `${data.account_name} | ${coreText}`;
      innerHTML += `<span class="label-text" style="font-weight:800; white-space:nowrap;">${coreText}</span>`;
    } else {
      innerHTML += `<span style="font-weight:700; margin-right:4px;">${type}</span> <input type="number" step="0.01" class="limit-price-input no-drag" data-field="price" value="${price.toFixed(2)}" onmousedown="event.stopPropagation()" onkeydown="if(event.key === 'Enter') handlePositionInput('${ticket}', '${type}', this.value)" onblur="handlePositionInput('${ticket}', '${type}', this.value)" />`;
    }

    // [FIX] Apply to BOTH SL and TP now
    if (type !== "MAIN" && !limitOrderState.active) {
      let stepVal = 0.5;
      if (typeof stepValuesCache !== "undefined" && stepValuesCache[ticket]) {
        stepVal = stepValuesCache[ticket];
      } else if (
        typeof SYMBOL_MAP !== "undefined" &&
        data.symbol &&
        SYMBOL_MAP[data.symbol]
      ) {
        stepVal = SYMBOL_MAP[data.symbol].trail || 0.5;
      }
      
      // [FIX] Layout: Arrow Left - Input - Arrow Right
      innerHTML += ` 
      <div class="sl-modifier-group no-drag" onmousedown="event.stopPropagation()"> 
        <div class="arrow-btn" onclick="adjustLevelByStep('${ticket}', '${type}', -1)">-</div> 
        <input type="number" class="step-input" value="${stepVal}" onmousedown="event.stopPropagation()" onclick="this.focus()" oninput="updateStepCache('${ticket}', this.value)" placeholder="Step"> 
        <div class="arrow-btn" onclick="adjustLevelByStep('${ticket}', '${type}', 1)">+</div>
      </div>`;
    }

    innerHTML += `<span class="label-pl" style="font-weight:700; margin-left:4px; color:${finalPlColor}">(${sign}$${plText})</span>`;
    innerHTML += `<span class="label-close" style="margin-left:10px; cursor:pointer; font-weight:bold; fontSize:24px; line-height:1;">×</span>`;
    
    div.innerHTML = innerHTML;
    
    // Close Button Logic (Identical to snippet)
    const closeBtn = div.querySelector(".label-close");
    closeBtn.onmousedown = (e) => e.stopPropagation();
    closeBtn.onclick = async (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeBtn.innerHTML = "";
      closeBtn.className = "loader-spinner-small";
      closeBtn.style.border = type === "MAIN" ? `2px solid ${typeColor}` : "2px solid white";
      closeBtn.style.borderRight = "2px solid transparent";
      try {
        if (type === "MAIN") await closeTrade(ticket);
        else await removeLevel(ticket, type);
      } catch (err) {
        closeBtn.className = "label-close";
        closeBtn.style.border = "none";
        closeBtn.innerHTML = "×";
      }
    };
    container.appendChild(div);
  } else {
    div.style.display = "flex";
  }

  // --- Dynamic Updates (Identical to snippet) ---
  div.style.top = `${y}px`;
  div.style.backgroundColor = bg;
  div.style.color = fg;
  div.style.border = border;
  
  const closeBtn = div.querySelector(".label-close");
  if (closeBtn && !closeBtn.classList.contains("loader-spinner-small")) {
    closeBtn.style.color = type === "MAIN" ? typeColor : "white";
    closeBtn.style.fontSize = "24px";
  }
  const plSpan = div.querySelector(".label-pl");
  if (plSpan) {
    plSpan.style.color = finalPlColor;
    plSpan.innerText = `(${sign}$${plText})`;
  }
  const priceInput = div.querySelector('input[data-field="price"]');
  if (priceInput && document.activeElement !== priceInput) {
    priceInput.value = price.toFixed(2);
  }
  if (type === "MAIN") {
    const textSpan = div.querySelector(".label-text");
    if (textSpan) {
      let coreText = `${data.type} ${data.volume} @ ${data.price_open.toFixed(2)}`;
      if (data.account_name) coreText = `${data.account_name} | ${coreText}`;
      if (textSpan.innerText !== coreText) textSpan.innerText = coreText;
    }
  }
}
async function handlePositionInput(ticketId, type, priceStr) {
  const newPrice = parseFloat(priceStr);
  if (isNaN(newPrice) || newPrice <= 0) return;
  let targets = [];
  if (
    priceLines[ticketId] &&
    priceLines[ticketId].data &&
    priceLines[ticketId].data.tickets
  ) {
    targets = priceLines[ticketId].data.tickets;
  } else {
    targets = [ticketId];
  }
  const promises = targets.map((t) => {
    const payload = {
      ticket: t,
      user_id: currentUserId,
      symbol: currentSymbol,
    };
    if (type === "TP") payload.tp = newPrice;
    if (type === "SL") payload.sl = newPrice;
    return fetch("http://127.0.0.1:5000/api/modify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });
  try {
    await Promise.all(promises);
    if (document.activeElement) document.activeElement.blur();
  } catch (err) {
    showError("Modification Failed", err.message);
  }
}

function adjustLevelByStep(ticket, type, direction) {
    const id = `lbl-${ticket}-${type}`;
    const div = document.getElementById(id);
    if (!div) return;

    // 1. Get Price Input
    const priceInput = div.querySelector('input[data-field="price"]');
    if (!priceInput) return;
    let currentPrice = parseFloat(priceInput.value);

    // 2. Get Step Value
    const stepInput = div.querySelector('.step-input');
    let step = 0.5; // Default
    if (stepInput && stepInput.value) {
        step = parseFloat(stepInput.value);
    }

    // 3. Calculate
    let newPrice = currentPrice + (step * direction);
    newPrice = parseFloat(newPrice.toFixed(2));

    // 4. Update UI & Submit
    priceInput.value = newPrice;
    handlePositionInput(ticket, type, newPrice);
}
function moveSlByStep(ticket, step) {
    adjustLevelByStep(ticket, 'SL', step > 0 ? 1 : -1);
}

function showHoverMenuFixed(ticket, type, y, labelElem) {
  const menu = document.getElementById("hover-menu");
  if (!priceLines[ticket]) return;
  const pos = priceLines[ticket].data;
  let html = "";
  menu.style.display = "flex";
  menu.style.alignItems = "center";
  if (type === "MAIN") {
    if (!pos.tp || pos.tp <= 0)
      html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'TP', ${pos.price_current})">+ TP</button>`;
    if (!pos.sl || pos.sl <= 0)
      html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'SL', ${pos.price_current})">+ SL</button>`;
    let canMove = false;
    let isAggregate = pos.tickets && pos.tickets.length > 1;
    const entryPrice = isAggregate ? pos.price_open : pos.price_open;
    const currentBid = pos.acc_bid || pos.price_current;
    const currentAsk = pos.acc_ask || pos.price_current;
    if (pos.type === "BUY") {
      if (currentBid > entryPrice) canMove = true;
    } else {
      if (currentAsk < entryPrice) canMove = true;
    }
    const currentSl = pos.sl || 0;
    const isAlreadyAtCost =
      Math.abs(currentSl - entryPrice) < entryPrice * 0.0001;
    if (canMove && !isAlreadyAtCost) {
      const btnText = isAggregate ? "All SL to BE" : "SL to Cost";
      html += `<button class="hover-btn" onmousedown="event.stopPropagation(); moveSlToCost('${ticket}', this)">${btnText}</button>`;
    }
    html += `<div style="font-size: 13px; color: #fff; font-weight: 600; margin-left: 10px; white-space: nowrap;"> BE: ${entryPrice.toFixed(2)} </div>`;
  } else if (type === "TP" || type === "SL") {
    html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', '${type}', ${type === "TP" ? pos.tp : pos.sl})">Move</button>`;
  }
  if (!html) {
    menu.style.display = "none";
    return;
  }
  menu.innerHTML = html;
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
async function moveSlToCost(ticket, btnElem) {
  if (!priceLines[ticket]) return;
  const pos = priceLines[ticket].data;
  if (btnElem) {
    btnElem.innerText = "...";
    btnElem.style.opacity = "0.7";
    btnElem.style.pointerEvents = "none";
  }
  let targets = [];
  if (pos.tickets && pos.tickets.length > 0) {
    targets = pos.tickets.map((tId) => {
      let childPrice = pos.price_open;
      if (window.SYSTEM_STATE && window.SYSTEM_STATE.positions) {
        for (const master of window.SYSTEM_STATE.positions) {
          if (master.sub_positions) {
            const found = master.sub_positions.find(
              (sub) => sub.ticket === tId,
            );
            if (found) {
              childPrice = found.price;
              break;
            }
          }
        }
      }
      return { ticket: tId, sl: childPrice };
    });
  } else {
    targets = [{ ticket: ticket, sl: pos.price_open }];
  }
  const promises = targets.map((t) => {
    const payload = { ticket: t.ticket, user_id: currentUserId, sl: t.sl };
    return fetch("http://127.0.0.1:5000/api/modify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });
  try {
    await Promise.all(promises);
  } catch (e) {
    showError("SL Update Failed", e.message);
  } finally {
    document.getElementById("hover-menu").style.display = "none";
  }
}
function updateLegend(data) {
  const legend = document.getElementById("chart-legend");
  if (!data) return;
  const isGreen = data.close >= data.open;
  const valColor = isGreen ? "#36d7b7" : "#ff5555";
  legend.innerHTML = `<span style="color:white">O:</span><span style="color:${valColor}">${Number(data.open).toFixed(2)}</span> <span style="color:white">H:</span><span style="color:${valColor}">${Number(data.high).toFixed(2)}</span> <span style="color:white">L:</span><span style="color:${valColor}">${Number(data.low).toFixed(2)}</span> <span style="color:white">C:</span><span style="color:${valColor}">${Number(data.close).toFixed(2)}</span>`;
}
function startLimitModeCustom(type, price) {
  if (window.SYSTEM_STATE && window.SYSTEM_STATE.orders) {
    const opposingType = type === "BUY" ? "SELL" : "BUY";
    const hasOpposing = window.SYSTEM_STATE.orders.some(
      (o) => o.symbol.startsWith(currentSymbol) && o.type === opposingType,
    );
    if (hasOpposing) {
      showError(
        "Action Blocked",
        `Cannot place ${type} Limit. You have pending ${opposingType} orders.`,
      );
      return;
    }
  }
  limitOrderState.active = true;
  limitOrderState.type = type;
  limitOrderState.entryPrice = price;
  limitOrderState.isSubmitting = false;
  const margin = price * 0.002;
  if (type === "BUY") {
    limitOrderState.tpPrice = price + margin;
    limitOrderState.slPrice = price - margin;
  } else {
    limitOrderState.tpPrice = price - margin;
    limitOrderState.slPrice = price + margin;
  }
  drawLimitLines();
  setExistingLinesStyle(LightweightCharts.LineStyle.Dashed);
  updateLeftLabels();
}
function cancelLimitMode() {
  limitOrderState.active = false;
  limitOrderState.isEdit = false;
  limitOrderState.isSubmitting = false;
  limitOrderState.editTicket = null;
  limitOrderState.editTickets = null;
  if (limitOrderState.lines.entry)
    candleSeries.removePriceLine(limitOrderState.lines.entry);
  if (limitOrderState.lines.tp)
    candleSeries.removePriceLine(limitOrderState.lines.tp);
  if (limitOrderState.lines.sl)
    candleSeries.removePriceLine(limitOrderState.lines.sl);
  limitOrderState.lines = { entry: null, tp: null, sl: null };
  setExistingLinesStyle(LightweightCharts.LineStyle.Solid);
  document
    .querySelectorAll(".btn-buy-limit, .btn-sell-limit")
    .forEach((b) => b.classList.remove("active"));
  ["limit-lbl-ENTRY", "limit-lbl-TP", "limit-lbl-SL"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  updateLeftLabels();
}
function drawLimitLines() {
  // Fix for Req #3: Removed 'title' property to hide text labels
  const entryColor = limitOrderState.type === "BUY" ? COL_BUY : COL_SELL;

  limitOrderState.lines.entry = candleSeries.createPriceLine({
    price: limitOrderState.entryPrice,
    color: entryColor,
    lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Solid,
    axisLabelVisible: true,
    title: "", // Hidden
  });
  limitOrderState.lines.tp = candleSeries.createPriceLine({
    price: limitOrderState.tpPrice,
    color: COL_TP,
    lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Solid,
    axisLabelVisible: true,
    title: "", // Hidden
  });
  limitOrderState.lines.sl = candleSeries.createPriceLine({
    price: limitOrderState.slPrice,
    color: COL_SL,
    lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Solid,
    axisLabelVisible: true,
    title: "", // Hidden
  });
}
function setExistingLinesStyle(style) {
  for (let t in priceLines) {
    const group = priceLines[t];
    if (group.tp) group.tp.applyOptions({ lineStyle: style });
    if (group.sl) group.sl.applyOptions({ lineStyle: style });
  }
}
function startEditOrder(order) {
  limitOrderState.active = true;
  limitOrderState.isEdit = true;
  limitOrderState.isSubmitting = false;
  limitOrderState.editTickets = order.tickets || [order.ticket];
  limitOrderState.editTicket = order.ticket;
  limitOrderState.type = order.type;
  limitOrderState.entryPrice = order.price_open;
  limitOrderState.tpPrice = order.tp;
  limitOrderState.slPrice = order.sl;
  if (!limitOrderState.tpPrice || limitOrderState.tpPrice === 0) {
    limitOrderState.tpPrice =
      order.type === "BUY" ? order.price_open * 1.01 : order.price_open * 0.99;
  }
  if (!limitOrderState.slPrice || limitOrderState.slPrice === 0) {
    limitOrderState.slPrice =
      order.type === "BUY" ? order.price_open * 0.99 : order.price_open * 1.01;
  }
  drawLimitLines();
  setExistingLinesStyle(LightweightCharts.LineStyle.Dashed);
  updateLeftLabels();
}
function handleLimitInput(type, valueStr) {
  if (document.activeElement) {
    document.activeElement.blur();
  }
  const newPrice = parseFloat(valueStr);
  if (isNaN(newPrice) || newPrice <= 0) return;
  if (type === "ENTRY") {
    limitOrderState.entryPrice = newPrice;
  } else if (type === "TP") {
    limitOrderState.tpPrice = newPrice;
  } else if (type === "SL") {
    limitOrderState.slPrice = newPrice;
  }
  if (limitOrderState.lines.entry)
    limitOrderState.lines.entry.applyOptions({
      price: limitOrderState.entryPrice,
    });
  if (limitOrderState.lines.tp)
    limitOrderState.lines.tp.applyOptions({ price: limitOrderState.tpPrice });
  if (limitOrderState.lines.sl)
    limitOrderState.lines.sl.applyOptions({ price: limitOrderState.slPrice });
  updateLeftLabels();
}
function renderLimitLabels(container) {
  let totalVol = 0;
  const accounts = window.allAccounts || [];
  const sym = window.currentSymbol || currentSymbol;

  // Calculate Volume based on Active Accounts + Config
  if (accounts.length > 0 && sym) {
    const rawSym = sym.toUpperCase();
    accounts.forEach((acc) => {
      if (acc.IS_ACTIVE) {
        let accVol = 0.01; // Default minimum

        // Check if account has specific config for this symbol
        if (acc.SYMBOL_CONFIG) {
          const configKey = Object.keys(acc.SYMBOL_CONFIG).find((k) => {
            const confSym = k.toUpperCase();
            return rawSym === confSym || rawSym.startsWith(confSym);
          });
          if (configKey) {
            const v = parseFloat(acc.SYMBOL_CONFIG[configKey].VOLUME);
            if (!isNaN(v)) accVol = v;
          }
        }
        totalVol += accVol;
      }
    });
  }

  // Fallback if no accounts active (to avoid 0 division or weird display)
  if (totalVol === 0) totalVol = 0.01;

  const qtyInput = document.getElementById("trade-qty");
  const inputMultiplier = qtyInput ? parseFloat(qtyInput.value) || 1 : 1;
  const finalVol = totalVol * inputMultiplier;

  const definitions = [
    {
      type: "ENTRY",
      price: limitOrderState.entryPrice,
      color: limitOrderState.type === "BUY" ? COL_BUY : COL_SELL,
    },
    { type: "TP", price: limitOrderState.tpPrice, color: COL_TP },
    { type: "SL", price: limitOrderState.slPrice, color: COL_SL },
  ];
  definitions.forEach((def) => {
    const id = `limit-lbl-${def.type}`;
    let div = document.getElementById(id);
    const y = candleSeries.priceToCoordinate(def.price);
    if (y === null) {
      if (div) div.remove();
      return;
    }
    const inputHtml = `<input type="number" step="0.01" class="limit-price-input no-drag" value="${def.price.toFixed(2)}" onmousedown="this.focus(); event.stopPropagation();" onclick="this.focus(); event.stopPropagation();" onkeyup="if(event.key === 'Enter') handleLimitInput('${def.type}', this.value)" onblur="handleLimitInput('${def.type}', this.value)" />`;
    let contentHtml = "";
    if (def.type === "ENTRY") {
      const isEdit = limitOrderState.isEdit;
      const isSubmitting = limitOrderState.isSubmitting;
      let btnText = isEdit ? "UPDATE" : "PLACE";
      let btnAction = isEdit
        ? "submitOrderModification()"
        : "confirmLimitOrderFromLabel()";
      let btnStyle = "";
      if (isSubmitting) {
        btnText = "...";
        btnAction = "";
        btnStyle = "opacity:0.7; pointer-events:none;";
      }
      contentHtml = `<span style="margin-right:2px;">Entry</span> ${inputHtml} <button class="btn-label-place no-drag" style="${btnStyle}" onmousedown="event.stopPropagation(); ${btnAction}">${btnText}</button> <span class="no-drag" style="margin-left:8px; cursor:pointer; font-size:16px;" onmousedown="event.stopPropagation(); cancelLimitMode()">×</span>`;
    } else {
      // Pass finalVol here for accurate P/L
      const plVal = calculatePL(
        currentSymbol,
        limitOrderState.type,
        finalVol,
        limitOrderState.entryPrice,
        def.price,
      );
      const plNum = parseFloat(plVal);
      const sign = plNum >= 0 ? "+" : "";
      const plColor = "#ffffff";
      contentHtml = `${def.type} ${inputHtml} (<span style="color:${plColor}">${sign}$${plVal}</span>)`;
    }
    if (!div) {
      div = document.createElement("div");
      div.id = id;
      div.className = "trade-label-tag limit-label";
      div.style.position = "absolute";
      div.style.left = "0px";
      div.style.fontSize = "14px";
      div.style.padding = "6px 12px";
      div.style.display = "flex";
      div.style.alignItems = "center";
      div.style.fontWeight = "700";
      div.style.cursor = "ns-resize";
      div.style.zIndex = "61";
      div.style.pointerEvents = "auto";
      div.addEventListener("mouseenter", () => {
        div.style.zIndex = "1000";
      });
      div.addEventListener("mouseleave", () => {
        div.style.zIndex = "61";
      });
      div.onmousedown = (e) => {
        if (
          e.target.classList.contains("no-drag") ||
          e.target.tagName === "INPUT"
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        startDrag("LIMIT", def.type, def.price);
      };
      container.appendChild(div);
    }
    const activeInput = document.activeElement;
    const isFocusedHere =
      activeInput &&
      div.contains(activeInput) &&
      activeInput.tagName === "INPUT";
    if (!isFocusedHere) {
      div.innerHTML = contentHtml;
    }
    div.style.top = `${y}px`;
    div.style.backgroundColor = def.color;
    div.style.color = "white";
    if (!div.innerHTML.trim()) div.innerHTML = contentHtml;
  });
}
async function confirmLimitOrderFromLabel() {
  const qtyInput = document.getElementById("trade-qty");
  const qty = qtyInput ? parseFloat(qtyInput.value) : 1;
  limitOrderState.isSubmitting = true;
  updateLeftLabels();
  const payload = {
    user_id: currentUserId,
    mobile: currentMobile,
    symbol: currentSymbol,
    type: limitOrderState.type,
    volume: qty,
    order_type: "LIMIT",
    price: limitOrderState.entryPrice,
    sl: limitOrderState.slPrice,
    tp: limitOrderState.tpPrice,
  };
  try {
    const res = await fetch("http://127.0.0.1:5000/api/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.blocked) {
      showError("Trade Blocked", "Opposing position exists.");
      limitOrderState.isSubmitting = false;
      updateLeftLabels();
    } else if (data.error) {
      showError("Order Failed", data.error);
      limitOrderState.isSubmitting = false;
      updateLeftLabels();
    } else {
      const fails = (data.details || []).filter(
        (d) => !d.includes("Done") && !d.includes("Success"),
      );
      if (fails.length > 0) {
        showError("Trade Errors", fails.join("\n"));
      }
      cancelLimitMode();
    }
  } catch (e) {
    showError("Order Failed", e.message);
    limitOrderState.isSubmitting = false;
    updateLeftLabels();
  }
}
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
function startDrag(ticket, type, currentPrice) {
  if (ticket === "LIMIT") {
    draggingLine = { ticket: "LIMIT", type: type, startPrice: currentPrice };
    document.body.style.cursor = "ns-resize";
    document.addEventListener("mousemove", updateDrag);
    return;
  }
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
  const container = document.getElementById("chart-container");
  const rect = container.getBoundingClientRect();
  let price = candleSeries.coordinateToPrice(e.clientY - rect.top);
  if (!price) return;
  if (draggingLine && draggingLine.ticket === "LIMIT") {
    const entry = limitOrderState.entryPrice;
    if (limitOrderState.type === "BUY") {
      if (draggingLine.type === "TP") {
        if (price < entry) price = entry;
      } else if (draggingLine.type === "SL") {
        if (price > entry) price = entry;
      }
    } else {
      if (draggingLine.type === "TP") {
        if (price > entry) price = entry;
      } else if (draggingLine.type === "SL") {
        if (price < entry) price = entry;
      }
    }
    if (draggingLine.type === "ENTRY") {
      const delta = price - limitOrderState.entryPrice;
      limitOrderState.entryPrice = price;
      limitOrderState.tpPrice += delta;
      limitOrderState.slPrice += delta;
      if (limitOrderState.lines.entry)
        limitOrderState.lines.entry.applyOptions({
          price: limitOrderState.entryPrice,
        });
      if (limitOrderState.lines.tp)
        limitOrderState.lines.tp.applyOptions({
          price: limitOrderState.tpPrice,
        });
      if (limitOrderState.lines.sl)
        limitOrderState.lines.sl.applyOptions({
          price: limitOrderState.slPrice,
        });
    } else {
      if (draggingLine.type === "TP") {
        limitOrderState.tpPrice = price;
        if (limitOrderState.lines.tp)
          limitOrderState.lines.tp.applyOptions({ price: price });
      } else if (draggingLine.type === "SL") {
        limitOrderState.slPrice = price;
        if (limitOrderState.lines.sl)
          limitOrderState.lines.sl.applyOptions({ price: price });
      }
    }
    updateLeftLabels();
    return;
  }
  if (!draggingLine || !dragPriceLine) return;
  const entry = draggingLine.startPrice;
  const isBuy = draggingLine.direction === "BUY";
  let currentCmp = entry;
  if (
    priceLines[draggingLine.ticket] &&
    priceLines[draggingLine.ticket].data &&
    priceLines[draggingLine.ticket].data.price_current
  ) {
    currentCmp = priceLines[draggingLine.ticket].data.price_current;
  } else if (latestCandle) {
    currentCmp = latestCandle.close;
  }
  if (isBuy) {
    if (draggingLine.type === "TP" && price < entry) price = entry;
    if (draggingLine.type === "SL" && price >= currentCmp) price = currentCmp;
  } else {
    if (draggingLine.type === "TP" && price > entry) price = entry;
    if (draggingLine.type === "SL" && price <= currentCmp) price = currentCmp;
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
  document.removeEventListener("mousemove", updateDrag);
  document.body.style.cursor = "default";
  if (draggingLine && draggingLine.ticket === "LIMIT") {
    draggingLine = null;
    return;
  }
  if (!draggingLine) return;
  const rect = document
    .getElementById("chart-container")
    .getBoundingClientRect();
  const finalPrice = candleSeries.coordinateToPrice(e.clientY - rect.top);
  if (!finalPrice) {
    cancelDrag();
    return;
  }
  let targets = [];
  const ticketId = draggingLine.ticket;
  if (
    priceLines[ticketId] &&
    priceLines[ticketId].data &&
    priceLines[ticketId].data.tickets
  ) {
    targets = priceLines[ticketId].data.tickets;
  } else {
    targets = [ticketId];
  }
  for (let t of targets) {
    const payload = {
      ticket: t,
      user_id: currentUserId,
      symbol: currentSymbol,
    };
    if (draggingLine.type === "TP") payload.tp = finalPrice;
    if (draggingLine.type === "SL") payload.sl = finalPrice;
    try {
      await fetch("http://127.0.0.1:5000/api/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("Modify error for ticket " + t, err);
    }
  }
  if (dragPriceLine) {
    candleSeries.removePriceLine(dragPriceLine);
    dragPriceLine = null;
  }
  draggingLine = null;
}
function cancelDrag() {
  document.removeEventListener("mousemove", updateDrag);
  if (dragPriceLine) {
    candleSeries.removePriceLine(dragPriceLine);
    dragPriceLine = null;
  }
  draggingLine = null;
  document.body.style.cursor = "default";
}
function updateChartPositions(positions) {
  let targetPositions = positions;
  if (specificTradeView) {
    targetPositions = positions.filter((p) => {
      if (p.sub_positions) {
        return p.sub_positions.some(
          (sub) => sub.ticket === specificTradeView.ticket,
        );
      }
      return false;
    });
  }
  const currentPositions = targetPositions.filter((p) =>
    p.symbol.startsWith(currentSymbol),
  );
  for (let t in priceLines) {
    const group = priceLines[t];
    if (group.main) candleSeries.removePriceLine(group.main);
    if (group.tp) candleSeries.removePriceLine(group.tp);
    if (group.sl) candleSeries.removePriceLine(group.sl);
  }
  priceLines = {};
  if (currentPositions.length === 0) {
    updateLeftLabels();
    return;
  }
  let aggregates = {
    BUY: { vol: 0, priceProd: 0, profit: 0, tickets: [], tps: [], sls: [] },
    SELL: { vol: 0, priceProd: 0, profit: 0, tickets: [], tps: [], sls: [] },
  };
  currentPositions.forEach((pos) => {
    const side = pos.type;
    aggregates[side].vol += pos.volume;
    aggregates[side].priceProd += pos.price_open * pos.volume;
    aggregates[side].profit += pos.profit;
    aggregates[side].tickets.push(pos.ticket);
    aggregates[side].tps.push(pos.tp);
    aggregates[side].sls.push(pos.sl);
  });
  ["BUY", "SELL"].forEach((side) => {
    const agg = aggregates[side];
    if (agg.vol > 0) {
      const avgPrice = agg.priceProd / agg.vol;
      let aggTicket = "";
      if (specificTradeView) {
        aggTicket = `${currentSymbol}_${side}_${specificTradeView.ticket || "SPEC"}`;
      } else if (agg.tickets && agg.tickets.length > 0) {
        aggTicket = agg.tickets[0];
      } else {
        aggTicket = `${currentSymbol}_${side}`;
      }
      const mainColor = side === "BUY" ? COL_BUY : COL_SELL;
      const firstTP = agg.tps[0];
      const isTPConsistent = agg.tps.every(
        (val) => Math.abs(val - firstTP) < 0.001,
      );
      const finalTP = isTPConsistent && firstTP > 0 ? firstTP : 0;
      const firstSL = agg.sls[0];
      const isSLConsistent = agg.sls.every(
        (val) => Math.abs(val - firstSL) < 0.001,
      );
      const finalSL = isSLConsistent && firstSL > 0 ? firstSL : 0;
      const mainLine = candleSeries.createPriceLine({
        price: avgPrice,
        color: mainColor,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: false,
        title: "",
      });
      priceLines[aggTicket] = {
        main: mainLine,
        tp: null,
        sl: null,
        data: {
          ticket: aggTicket,
          type: side,
          price_open: avgPrice,
          price: avgPrice,
          price_current: latestCandle ? latestCandle.close : avgPrice,
          symbol: currentSymbol,
          volume: parseFloat(agg.vol.toFixed(2)),
          profit: agg.profit,
          tickets: agg.tickets,
          tp: finalTP,
          sl: finalSL,
          is_aggregate: true,
        },
      };
      if (finalTP > 0) {
        priceLines[aggTicket].tp = candleSeries.createPriceLine({
          price: finalTP,
          color: COL_TP,
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: false,
          title: "",
        });
      }
      if (finalSL > 0) {
        priceLines[aggTicket].sl = candleSeries.createPriceLine({
          price: finalSL,
          color: COL_SL,
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: false,
          title: "",
        });
      }
    }
  });
  updateLeftLabels();
}
function viewSpecificTrade(subPos, event) {
  if (event) event.stopPropagation();
  specificTradeView = subPos;
  if (!subPos.symbol.startsWith(currentSymbol)) {
    const match = WATCHLIST.find((w) => subPos.symbol.startsWith(w.sym));
    changeSymbol(match ? match.sym : subPos.symbol);
  }
  for (let t in priceLines) {
    const group = priceLines[t];
    if (group.main) candleSeries.removePriceLine(group.main);
    if (group.tp) candleSeries.removePriceLine(group.tp);
    if (group.sl) candleSeries.removePriceLine(group.sl);
  }
  priceLines = {};
  const mainColor = subPos.type === "BUY" ? COL_BUY : COL_SELL;

  // FIX: Use price_open
  const mainLine = candleSeries.createPriceLine({
    price: parseFloat(subPos.price_open),
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
      price_open: subPos.price_open,
      price: subPos.price_open,
      price_current: subPos.price_current || subPos.price_open,
      symbol: subPos.symbol,
      volume: subPos.volume,
      sl: subPos.sl,
      tp: subPos.tp,
      account_name: subPos.account_name,
      profit: subPos.profit,
    },
  };
  if (subPos.sl > 0) {
    priceLines[subPos.ticket].sl = candleSeries.createPriceLine({
      price: subPos.sl,
      color: COL_SL,
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: false,
      title: "",
    });
  }
  if (subPos.tp > 0) {
    priceLines[subPos.ticket].tp = candleSeries.createPriceLine({
      price: subPos.tp,
      color: COL_TP,
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: false,
      title: "",
    });
  }
  setTimeout(() => {
    updateLeftLabels();
  }, 100);
}
function clearSpecificView() {
  specificTradeView = null;
}
async function placeOrder(type) {
  const qtyInput = document.getElementById("trade-qty");
  const qty = qtyInput ? parseFloat(qtyInput.value) : 1;
  const btn = document.querySelector(type === "BUY" ? ".btn-buy" : ".btn-sell");
  if (btn) btn.classList.add("btn-loading");
  let payload = {
    user_id: currentUserId,
    mobile: currentMobile,
    symbol: currentSymbol,
    type: type,
    volume: qty,
    order_type: "MARKET",
  };
  if (limitOrderState.active) {
    if (limitOrderState.type !== type) {
      showError(
        "Mode Mismatch",
        `You are currently in ${limitOrderState.type} Limit Mode. Please cancel it before placing a ${type} order.`,
      );
      if (btn) btn.classList.remove("btn-loading");
      return;
    }
    payload.order_type = "LIMIT";
    payload.price = limitOrderState.entryPrice;
    if (limitOrderState.slPrice > 0) payload.sl = limitOrderState.slPrice;
    if (limitOrderState.tpPrice > 0) payload.tp = limitOrderState.tpPrice;
  }
  try {
    const res = await fetch("http://127.0.0.1:5000/api/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
      if (limitOrderState.active) {
        cancelLimitMode();
      }
    }
  } catch (e) {
    showError("Order Failed", e.message);
  } finally {
    if (btn) btn.classList.remove("btn-loading");
  }
}
async function closeTrade(ticket, btnElem) {
  if (btnElem) btnElem.classList.add("btn-loading");
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
    }
  } catch (e) {
    showError("Network Error", e.message);
  } finally {
    if (btnElem) btnElem.classList.remove("btn-loading");
  }
}
function submitOrderModification(ticket, type, value) {
    const val = parseFloat(value);
    if (isNaN(val)) return;

    // Optimistic UI Update (optional, but makes it snappy)
    // We wait for socket update for real change
    
    const payload = {
        ticket: ticket,
        sl: type === 'SL' ? val : null,
        tp: type === 'TP' ? val : null
    };
    
    // Send to backend
    fetch("http://127.0.0.1:5000/api/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }).then(res => res.json())
      .then(d => {
          if (d.error) showError("Modify Failed", d.error);
      });
}
async function cancelPendingOrder(tickets) {
  try {
    const promises = tickets.map((ticket) => {
      return fetch("http://127.0.0.1:5000/api/order/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: currentUserId, ticket: ticket }),
      }).then((res) => res.json());
    });
    const results = await Promise.all(promises);
    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      showError("Cancel Error", failures.map((f) => f.message).join("\n"));
    }
  } catch (e) {
    showError("Network Error", e.message);
  }
}
function toggleFullscreen() {
  const col = document.querySelector(".chart-col");
  const btn = document.getElementById("btn-fullscreen");
  if (col) {
    col.classList.toggle("fullscreen-mode");
    if (col.classList.contains("fullscreen-mode")) {
      if (btn) btn.innerText = "✖";
    } else {
      if (btn) btn.innerText = "⛶";
    }
    setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 100);
  }
}
function openHistoryModal() {
  document.getElementById("history-modal").style.display = "flex";
}
function closeHistoryModal() {
  document.getElementById("history-modal").style.display = "none";
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
    window.allAccounts = accounts;
    allAccounts = accounts;
    const container = document.getElementById("account-list-container");
    container.innerHTML = "";
    if (accounts.length === 0) {
      container.innerHTML =
        '<div style="text-align:center; color:#8a94a6; padding:20px; font-size: 16px;">No accounts linked.</div>';
      return;
    }
    accounts.forEach((acc) => {
      let configSummary = Object.keys(acc.SYMBOL_CONFIG || {})
        .map((s) => `${s}: ${acc.SYMBOL_CONFIG[s].VOLUME}`)
        .join(", ");
      if (!configSummary) configSummary = "No rules";
      const checked = acc.IS_ACTIVE ? "checked" : "";
      container.innerHTML += `<div class="account-card" style="opacity: ${acc.IS_ACTIVE ? 1 : 0.5}; padding: 20px;"> <div style="display:flex; align-items:center;"> <div style="transform: scale(1.2); transform-origin: left center; margin-right: 10px;"> <label class="toggle-switch"> <input type="checkbox" ${checked} onchange="toggleAccountActive('${acc.ID}', this.checked)"> <span class="slider"></span> </label> </div> <div style="margin-left:10px;"> <div style="font-weight:700; color:white; font-size: 20px;"> ${acc.NAME || "Account"} <span style="font-weight:400; color:#8a94a6; font-size:16px; margin-left: 8px;">(${acc.USER})</span> </div> <div style="font-size:15px; color:#8a94a6; margin-top: 6px;">${configSummary}</div> </div> </div> <div style="display:flex; gap:12px; align-items: center;"> <button class="btn-secondary" onclick='editAccount("${acc.ID}")' style="font-size:15px; padding:8px 18px;">Edit</button> <button class="btn-remove-level" onclick="deleteAccount('${acc.ID}')" style="font-size:26px; width:36px; height:36px; line-height: 34px;">×</button> </div> </div>`;
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
    setTimeout(() => {
      ipcRenderer.invoke("focus-window");
    }, 500);
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
    setTimeout(() => {
      ipcRenderer.invoke("focus-window");
    }, 500);
  } catch (e) {
    showError("Save Failed", e.message);
  }
}
function showAddAccountForm() {
  document.getElementById("account-list-container").style.display = "none";
  document.querySelector(".btn-add-main").style.display = "none";
  document.getElementById("account-form").style.display = "flex";
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
  let current = parseFloat(input.value) || 0;
  const step = delta >= 0 ? 1 : -1;
  let val = current + step;
  if (val < 1) val = 1;
  input.value = val.toFixed(0);
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
