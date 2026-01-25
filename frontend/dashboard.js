const { ipcRenderer } = require("electron");

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

limitOrderState = {
  active: false,
  isEdit: false, // NEW
  editTicket: null, // NEW
  type: 'BUY', 
  entryPrice: 0,
  tpPrice: 0,
  slPrice: 0,
  lines: { entry: null, tp: null, sl: null }
};
let pendingOrderLines = {};

// NEW: Missing State Variables Fixed
let isSidebarCollapsed = false;

// --- COLORS ---
const COL_BUY = "#2962ff";
const COL_SELL = "#ff5555";
const COL_TP = "#00b894";
const COL_SL = "#d35400";

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

    fetchAccounts();
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

function togglePassword() {
  const inp = document.getElementById("inp-pass");
  if (inp.type === "password") {
    inp.type = "text";
  } else {
    inp.type = "password";
  }
}

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
  const col = document.getElementById("stats-column");
  if (!col) return;

  if (col.classList.contains("hidden")) {
    col.classList.remove("hidden");
  } else {
    col.classList.add("hidden");
  }
  triggerResize();
}

function triggerResize() {
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
    
    // --- [NEW] SAVE TO GLOBAL STATE ---
    window.SYSTEM_STATE = data;
    // Ensure orders array exists
    if (!window.SYSTEM_STATE.orders) window.SYSTEM_STATE.orders = [];

    // --- STATS POPULATION (Existing) ---
    const balEl = document.getElementById("val-balance");
    if (balEl) balEl.innerText = `$${data.balance.toFixed(2)}`;

    const eqEl = document.getElementById("val-equity");
    if (eqEl) eqEl.innerText = `$${data.equity.toFixed(2)}`;

    const fsBal = document.getElementById("fs-val-bal");
    if (fsBal) fsBal.innerText = `$${data.balance.toFixed(2)}`;

    const fsEq = document.getElementById("fs-val-equity");
    if (fsEq) fsEq.innerText = `$${data.equity.toFixed(2)}`;

    const plEl = document.getElementById("val-pl");
    if (plEl) {
      plEl.innerText = `$${data.profit.toFixed(2)}`;
      plEl.className =
        data.profit >= 0 ? "stat-value text-green" : "stat-value text-red";
    }

    const powerEl = document.getElementById("val-power");
    if (powerEl) powerEl.innerText = `$${data.margin_free.toFixed(2)}`;

    const usedMargin = data.balance - data.margin_free;
    const usagePct = data.balance > 0 ? (usedMargin / data.balance) * 100 : 0;
    const bar = document.querySelector(".progress-fill");
    if (bar) bar.style.width = `${usagePct}%`;

    // ... (Rest of update) ...
    if (data.prices) updateWatchlistPrices(data.prices);
    renderPositions(data.positions);
    renderHistory(data.history);

    if (specificTradeView) {
      refreshSpecificView(data.positions);
    } else {
      updateChartPositions(data.positions);
    }
    
    // --- [NEW] RENDER PENDING ORDERS ---
    // Pass the orders explicitly
    renderPendingOrders(data.orders);

  } catch (e) {
    console.log("Network Error:", e);
  }
}

function updateWatchlistPrices(priceMap) {
  for (let sym in priceMap) {
    const el = document.getElementById(`wl-price-${sym}`);
    // ROUNDING FIX
    if (el) el.innerText = Number(priceMap[sym].bid).toFixed(2);
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
  // Check if we are still on the correct symbol to avoid fighting with user navigation
  if (found && found.symbol.startsWith(currentSymbol)) {
    viewSpecificTrade(found, null);
  } else {
    clearSpecificView();
  }
}

function renderSlTpCell(targetPrice, type, ticket, symbol, entryPrice, volume, direction) {
  if (!targetPrice || targetPrice <= 0) return "-";

  const safeEntry = parseFloat(entryPrice) || 0;
  const plValue = calculatePL(symbol, direction, volume, safeEntry, targetPrice);
  const plClass = parseFloat(plValue) >= 0 ? "text-green" : "text-red";
  const plSign = parseFloat(plValue) >= 0 ? "+" : "";
  const color = type === "sl" ? "#ff9f43" : "#00b894";

  // [REQ] Bigger Close Icon for Table
  // Increased font-size to 20px and added padding for touch target
  return `
        <div style="display:flex; flex-direction:column; line-height:1.2;">
            <div style="display:flex; align-items:center;">
                <span style="color:${color}; font-weight:700;">${Number(targetPrice).toFixed(2)}</span>
                <span class="remove-x" 
                      style="font-size: 20px; padding: 0 6px; cursor: pointer; color: #888; transition: color 0.2s;" 
                      onmouseover="this.style.color='#ff5555'" 
                      onmouseout="this.style.color='#888'"
                      onclick="removeLevel('${ticket}', '${type}'); event.stopPropagation();">×</span>
            </div>
            <span style="font-size:13px; font-weight:700;" class="${plClass}">(${plSign}$${Number(plValue).toFixed(2)})</span>
        </div>`;
}

function renderPositions(positions) {
  const tbody = document.querySelector("#positions-table tbody");
  if (!tbody) return;

  // Track active tickets to handle removals
  const activeRowIds = new Set();
  let hasPositions = false;

  positions.forEach((pos) => {
    hasPositions = true;
    const masterId = `row-master-${pos.ticket}`;
    activeRowIds.add(masterId);

    const openPrice = pos.price_open !== undefined ? pos.price_open : pos.price || 0;
    
    // --- 1. RENDER/UPDATE MASTER ROW ---
    let masterRow = document.getElementById(masterId);
    
    // Generate SL/TP HTML (Re-generating this cell is okay as it's small)
    let slHtml = renderSlTpCell(pos.sl, "sl", pos.ticket, pos.symbol, openPrice, pos.volume, pos.type);
    let tpHtml = renderSlTpCell(pos.tp, "tp", pos.ticket, pos.symbol, openPrice, pos.volume, pos.type);
    
    // Class for Profit Color
    const profitClass = pos.profit >= 0 ? "text-green" : "text-red";
    const isExpanded = expandedTickets.has(pos.ticket);

    if (!masterRow) {
        // CREATE NEW ROW
        masterRow = document.createElement('tr');
        masterRow.id = masterId;
        masterRow.className = "master-row";
        masterRow.onclick = (e) => handleRowClick(pos.ticket, e, masterRow);
        
        masterRow.innerHTML = `
            <td class="symbol-cell">
                <span class="toggle-icon ${isExpanded ? "expanded" : ""}">▶</span>
                <div style="margin-left:5px;">
                    <div class="symbol-name">${pos.symbol}</div>
                    <div class="symbol-desc"><span class="${pos.type === "BUY" ? "badge-buy" : "badge-sell"}">${pos.type}</span></div>
                </div>
            </td>
            <td class="col-vol"><strong>${Number(pos.volume).toFixed(2)}</strong></td>
            <td class="col-open">${Number(openPrice).toFixed(2)}</td>
            <td class="col-curr">${Number(pos.price_current).toFixed(2)}</td>
            <td class="col-sl">${slHtml}</td>
            <td class="col-tp">${tpHtml}</td>
            <td class="col-pl ${profitClass}">$${Number(pos.profit).toFixed(2)}</td>
            <td>
                <button class="btn-close-trade" onclick="closeTrade('${pos.ticket}', this); event.stopPropagation();">Close All</button>
            </td>`;
        tbody.appendChild(masterRow);
    } else {
        // UPDATE EXISTING ROW (Only values)
        masterRow.querySelector('.toggle-icon').className = `toggle-icon ${isExpanded ? "expanded" : ""}`;
        masterRow.querySelector('.col-vol strong').innerText = Number(pos.volume).toFixed(2);
        masterRow.querySelector('.col-open').innerText = Number(openPrice).toFixed(2);
        masterRow.querySelector('.col-curr').innerText = Number(pos.price_current).toFixed(2);
        masterRow.querySelector('.col-sl').innerHTML = slHtml;
        masterRow.querySelector('.col-tp').innerHTML = tpHtml;
        
        const plCell = masterRow.querySelector('.col-pl');
        plCell.className = `col-pl ${profitClass}`;
        plCell.innerText = `$${Number(pos.profit).toFixed(2)}`;
    }

    // --- 2. RENDER/UPDATE CHILD ROWS ---
    if (pos.sub_positions && pos.sub_positions.length > 0) {
      pos.sub_positions.forEach((sub) => {
        const childId = `row-child-${sub.ticket}`;
        activeRowIds.add(childId);
        
        const subDataStr = JSON.stringify(sub).replace(/"/g, "&quot;");
        let subSlHtml = renderSlTpCell(sub.sl, "sl", sub.ticket, sub.symbol, sub.price, sub.volume, sub.type);
        let subTpHtml = renderSlTpCell(sub.tp, "tp", sub.ticket, sub.symbol, sub.price, sub.volume, sub.type);
        const subProfitClass = sub.profit >= 0 ? "text-green" : "text-red";

        let childRow = document.getElementById(childId);
        
        if (!childRow) {
            childRow = document.createElement('tr');
            childRow.id = childId;
            childRow.className = `child-row child-of-${pos.ticket}`;
            childRow.style.display = isExpanded ? "table-row" : "none";
            childRow.onclick = (event) => viewSpecificTrade(sub, event); // Pass object directly if possible, or use string trick
            
            // Re-attach data attribute for safe keeping if needed, or just bind click above
            // NOTE: viewSpecificTrade needs the object. We bind it directly in the click handler above to avoid stringify issues.

            childRow.innerHTML = `
                <td class="child-account-name">↳ ${sub.account_name}</td>
                <td class="child-text col-vol">${Number(sub.volume).toFixed(2)}</td>
                <td class="child-text col-open">${Number(sub.price).toFixed(2)}</td>
                <td class="child-text">-</td>
                <td class="child-text col-sl">${subSlHtml}</td>
                <td class="child-text col-tp">${subTpHtml}</td>
                <td class="child-text col-pl ${subProfitClass}">$${Number(sub.profit).toFixed(2)}</td>
                <td style="vertical-align: middle;">
                    <button class="btn-remove-level" style="height:22px; line-height:22px; padding:0 10px; font-family:'Inter', sans-serif;" onclick="closeTrade('${sub.ticket}', this); event.stopPropagation();">Close</button>
                </td>`;
            
            // Insert after master row or previous child
            // Simple append to tbody works because we loop in order, but for strictness:
            tbody.appendChild(childRow);
        } else {
            // Update Child
            childRow.style.display = isExpanded ? "table-row" : "none";
            childRow.querySelector('.col-vol').innerText = Number(sub.volume).toFixed(2);
            childRow.querySelector('.col-open').innerText = Number(sub.price).toFixed(2);
            childRow.querySelector('.col-sl').innerHTML = subSlHtml;
            childRow.querySelector('.col-tp').innerHTML = subTpHtml;
            
            const subPl = childRow.querySelector('.col-pl');
            subPl.className = `child-text col-pl ${subProfitClass}`;
            subPl.innerText = `$${Number(sub.profit).toFixed(2)}`;
        }
      });
    }
  });

  // --- 3. CLEANUP REMOVED ROWS ---
  // If a position was closed, it won't be in activeRowIds, so remove it from DOM
  Array.from(tbody.children).forEach(row => {
      if (row.id && !activeRowIds.has(row.id) && row.id !== 'no-pos-msg') {
          row.remove();
      }
  });

  // Show "No positions" message if empty
  if (!hasPositions) {
      if (!document.getElementById('no-pos-msg')) {
          tbody.innerHTML = '<tr id="no-pos-msg"><td colspan="8" style="text-align:center; padding:20px; color:#555;">No open positions</td></tr>';
      }
  } else {
      const msg = document.getElementById('no-pos-msg');
      if (msg) msg.remove();
  }
}

// frontend/dashboard.js

function updateMainButtonText(type) {
    const buyBtn = document.querySelector('.btn-buy');
    const sellBtn = document.querySelector('.btn-sell');
    
    if (type === 'BUY') {
        if(buyBtn) {
            buyBtn.innerText = "PLACE LIMIT";
            buyBtn.classList.add("btn-limit-active");
            // FORCE ENABLE
            buyBtn.style.opacity = "1";
            buyBtn.style.pointerEvents = "auto";
        }
        if(sellBtn) {
            sellBtn.style.opacity = "0.3"; 
            sellBtn.style.pointerEvents = "none";
        }
    } else {
        if(sellBtn) {
            sellBtn.innerText = "PLACE LIMIT";
            sellBtn.classList.add("btn-limit-active");
            // FORCE ENABLE
            sellBtn.style.opacity = "1";
            sellBtn.style.pointerEvents = "auto";
        }
        if(buyBtn) {
            buyBtn.style.opacity = "0.3";
            buyBtn.style.pointerEvents = "none";
        }
    }
}

// 2. UPDATE resetMainButtonText (Complete Reset)
function resetMainButtonText() {
    const buyBtn = document.querySelector('.btn-buy');
    const sellBtn = document.querySelector('.btn-sell');
    
    if(buyBtn) {
        buyBtn.innerText = "BUY";
        buyBtn.classList.remove("btn-limit-active");
        buyBtn.style.opacity = "1";
        buyBtn.style.pointerEvents = "auto";
    }
    if(sellBtn) {
        sellBtn.innerText = "SELL";
        sellBtn.classList.remove("btn-limit-active");
        sellBtn.style.opacity = "1";
        sellBtn.style.pointerEvents = "auto";
    }
}

function renderHistory(history) {
  const tbody = document.querySelector("#history-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  history.forEach((deal) => {
    const profitClass = deal.profit >= 0 ? "text-green" : "text-red";
    const badgeClass = deal.type === "BUY" ? "badge-buy" : "badge-sell";
    
    // Handle missing entry price gracefully
    const entryPrice = deal.entry_price ? deal.entry_price : "-";
    
    tbody.innerHTML += `
            <tr>
                <td class="time-cell">${deal.time}</td>
                <td style="font-weight: 700;">${deal.symbol}<div class="history-account-name">${deal.account}</div></td>
                <td><span class="${badgeClass}">${deal.type}</span></td>
                <td>${deal.volume.toFixed(2)}</td>
                <td>${entryPrice}</td> <td>${deal.price}</td> <td class="${profitClass}">$${deal.profit.toFixed(2)}</td>
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

function renderPendingOrders(orders) {
    // 1. Get Aggregated List
    const rawOrders = orders || (window.SYSTEM_STATE ? window.SYSTEM_STATE.orders : []);
    const aggregatedOrders = aggregateOrders(rawOrders);

    if (!candleSeries) return;

    // 2. Clear & Redraw Lines
    for (let t in pendingOrderLines) {
        if(pendingOrderLines[t]) candleSeries.removePriceLine(pendingOrderLines[t]);
    }
    pendingOrderLines = {};

    aggregatedOrders.forEach(o => {
        // Hide if currently editing this specific group
        if (limitOrderState.active && limitOrderState.isEdit) {
             if (limitOrderState.editTickets && o.tickets.some(t => limitOrderState.editTickets.includes(t))) return;
        }

        const key = o.tickets[0]; // Use first ticket as ID for the line map

        pendingOrderLines[key] = candleSeries.createPriceLine({
            price: o.price_open,
            color: o.type === 'BUY' ? COL_BUY : COL_SELL,
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: "", // Title handled by custom label
        });
    });

    // 3. Render Labels
    renderPendingOrderLabels(aggregatedOrders);
}

// frontend/dashboard.js

function renderPendingOrderLabels(aggregatedOrders) {
    const container = document.getElementById("trade-labels-left");
    if (!container) return;
    
    // Cleanup old labels
    const existingLabels = container.querySelectorAll('.pending-order-label');
    existingLabels.forEach(el => el.remove());

    aggregatedOrders.forEach(o => {
        // Hide this label if we are currently editing this specific order group
        if (limitOrderState.active && limitOrderState.isEdit) {
            if (limitOrderState.editTickets && o.tickets.some(t => limitOrderState.editTickets.includes(t))) return;
        }

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
        
        const bgColor = o.type === 'BUY' ? COL_BUY : COL_SELL;
        div.style.backgroundColor = bgColor; 
        div.style.color = "white";
        div.style.border = `1px solid ${bgColor}`;
        div.style.fontSize = "12px";
        div.style.padding = "4px 8px";
        div.style.cursor = "pointer";
        div.style.pointerEvents = "auto";
        
        // [FIX] Use direct JS function property instead of setAttribute string
        // This ensures 'startEditOrder' is found and 'o' is passed correctly
        div.onclick = (e) => {
            e.stopPropagation(); 
            startEditOrder(o); 
        };

        const qtyText = parseFloat(o.volume.toFixed(2));
        const textSpan = document.createElement("span");
        textSpan.innerText = `⏳ ${o.type} ${qtyText} @ ${o.price_open}`;
        div.appendChild(textSpan);

        // --- CANCEL BUTTON ---
        const closeSpan = document.createElement("span");
        closeSpan.innerHTML = "×";
        closeSpan.style.fontWeight = "bold";
        closeSpan.style.fontSize = "16px";
        closeSpan.style.marginLeft = "4px";
        closeSpan.style.cursor = "pointer";
        
        // [FIX] Direct JS handler for Cancel as well
        closeSpan.onclick = async (e) => {
            e.stopPropagation(); // Critical: Stop bubbling so we don't trigger Edit Mode
            
            if(confirm(`Cancel ${o.count} pending order(s)?`)) {
                closeSpan.innerHTML = ""; 
                closeSpan.className = "loader-spinner-small";
                closeSpan.style.borderColor = "white transparent transparent transparent"; 
                
                await cancelPendingOrder(o.tickets);
            }
        };
        
        div.appendChild(closeSpan);
        container.appendChild(div);
    });
}

// 6. NEW: submitOrderModification
async function submitOrderModification() {
    const tickets = limitOrderState.editTickets || [limitOrderState.editTicket];
    
    // [FIX] Set Flag & UI
    limitOrderState.isSubmitting = true;
    updateLeftLabels();
    
    try {
        const promises = tickets.map(ticket => {
            const payload = {
                user_id: currentUserId,
                ticket: ticket,
                price: limitOrderState.entryPrice,
                tp: limitOrderState.tpPrice,
                sl: limitOrderState.slPrice
            };
            return fetch("http://127.0.0.1:5000/api/order/modify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            }).then(res => res.json());
        });

        const results = await Promise.all(promises);
        const anySuccess = results.some(r => r.success);
        
        if(anySuccess) {
            // [FIX] Fetch first, then close
            await fetchDashboardData(); 
            cancelLimitMode(); 
        } else {
            const firstError = results.find(r => !r.success);
            showError("Modification Failed", firstError ? firstError.message : "Unknown error");
            limitOrderState.isSubmitting = false;
            updateLeftLabels();
        }
    } catch(e) {
        showError("Error", e.message);
        limitOrderState.isSubmitting = false;
        updateLeftLabels();
    }
}

async function cancelPendingOrder(tickets) {
    try {
        const promises = tickets.map(ticket => {
             return fetch("http://127.0.0.1:5000/api/order/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id: currentUserId, ticket: ticket })
            }).then(res => res.json());
        });

        const results = await Promise.all(promises);
        const failures = results.filter(r => !r.success);
        
        if(failures.length > 0) {
            showError("Cancel Error", failures.map(f => f.message).join('\n'));
        }
        
        // Refresh
        await fetchDashboardData();

    } catch (e) {
        showError("Network Error", e.message);
    }
}

function aggregateOrders(orders) {
    if (!orders) return [];

    // 1. Filter by Current Symbol
    let targetOrders = orders.filter(o => o.symbol.startsWith(currentSymbol));

    // 2. Filter by Specific View (if active)
    if (specificTradeView) {
        // Filter orders belonging to the specific account being viewed
        targetOrders = targetOrders.filter(o => 
            (o.account && o.account === specificTradeView.account_name) || 
            (o.account_login && o.account_login == specificTradeView.account_login)
        );
    }

    // 3. Aggregate
    const grouped = {};
    targetOrders.forEach(o => {
        // Key: Type + Price (rounded to 5 decimals to group same-price orders)
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
  
  // CONFIRMATION REMOVED
  
  const payload = { ticket: ticket, user_id: currentUserId };
  
  if (normType === "sl") payload.sl = 0.0;
  if (normType === "tp") payload.tp = 0.0;
  
  try {
    const res = await fetch("http://127.0.0.1:5000/api/modify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // ... rest of error handling ...
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
      fontSize: 20, // Price scale font size
      fontFamily: "Inter, sans-serif",
    },
    grid: {
      vertLines: { color: "rgba(255, 255, 255, 0.05)" },
      horzLines: { color: "rgba(255, 255, 255, 0.05)" },
    },
    localization: {
      locale: "en-IN",
      // Crosshair Label (IST)
      timeFormatter: (timestamp) => {
        return new Date(timestamp * 1000).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: '2-digit', hour12: false
        }).replace(',', '');
      },
    },
    rightPriceScale: { visible: true },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: {
      timeVisible: true,
      borderColor: "rgba(255, 255, 255, 0.1)",
      rightOffset: 20,
      // [REQ 6] Force IST for the Time Scale Axis
      tickMarkFormatter: (time, tickMarkType, locale) => {
        const date = new Date(time * 1000);
        const options = { timeZone: "Asia/Kolkata" };
        
        // 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
        if (tickMarkType < 3) {
            // Show Date (e.g., "22 Jan")
            return date.toLocaleDateString("en-IN", { ...options, day: 'numeric', month: 'short' });
        } else {
            // Show Time (e.g., "14:30")
            return date.toLocaleTimeString("en-IN", { ...options, hour: '2-digit', minute: '2-digit', hour12: false });
        }
      }
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
      lastHoveredTime = param.time; // TRACK HOVERED TIME
      const data = param.seriesData.get(candleSeries);
      if (data) updateLegend(data);
    } else {
      lastHoveredTime = null; // CLEARED
      if (latestCandle) updateLegend(latestCandle);
    }
    updateLeftLabels();
  });

  container.addEventListener("mouseleave", () => {
    lastHoveredTime = null;
    if (latestCandle) updateLegend(latestCandle);
  });

  // Sync Left Labels on Scroll/Zoom
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    updateLeftLabels();
  });

  // Close hover menu when clicking on chart background
  container.addEventListener("mousedown", () => {
    document.getElementById("hover-menu").style.display = "none";
  });

  container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      
      // Get Price from Click
      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const price = candleSeries.coordinateToPrice(y);
      
      if (price) {
          showContextMenu(e.clientX, e.clientY, price);
      }
  });

  // 2. Hide Menu on Click elsewhere
  document.addEventListener('click', () => {
      const menu = document.getElementById('custom-ctx-menu');
      if (menu) menu.style.display = 'none';
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

// Creates/Shows the Context Menu
function showContextMenu(x, y, price) {
    let menu = document.getElementById('custom-ctx-menu');
    
    // Create if doesn't exist
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'custom-ctx-menu';
        menu.className = 'custom-context-menu';
        document.body.appendChild(menu);
    }

    // Update Content
    menu.innerHTML = `
        <div class="ctx-menu-item" onclick="initLimitFromContextMenu('BUY', ${price})">Buy Limit @ ${price.toFixed(2)}</div>
        <div class="ctx-menu-item" onclick="initLimitFromContextMenu('SELL', ${price})">Sell Limit @ ${price.toFixed(2)}</div>
    `;

    // Position
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = 'block';
}

// Triggered by Menu Selection
function initLimitFromContextMenu(type, price) {
    // Hide Menu
    const menu = document.getElementById('custom-ctx-menu');
    if (menu) menu.style.display = 'none';

    // Start Limit Mode with Custom Price
    startLimitModeCustom(type, price);
}

// --- LEFT SIDE LABEL RENDERING ---
function updateLeftLabels() {
  const container = document.getElementById("trade-labels-left");
  if (!container) return;

  const activeLabelIds = new Set();

  // 1. Process Active Positions
  if (candleSeries) {
      for (let t in priceLines) {
        const group = priceLines[t];
        const data = group.data;
        
        // Render MAIN
        if (group.main) {
            renderSingleLabel(container, t, "MAIN", data.price_open || data.price, data);
            activeLabelIds.add(`lbl-${t}-MAIN`);
        }

        // Render TP/SL (Only if not in Limit Mode)
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

  // 2. Process Pending Orders
  if (window.SYSTEM_STATE && window.SYSTEM_STATE.orders) {
      const aggOrders = aggregateOrders(window.SYSTEM_STATE.orders);
      renderPendingOrderLabels(aggOrders);
  }

  // 3. Process Limit Order Mode Labels
  if (limitOrderState.active) {
      try {
        renderLimitLabels(container);
      } catch (e) {
        console.error("Error rendering limit labels:", e);
      }
  } else {
      // Clean up Limit labels
      ['limit-lbl-ENTRY', 'limit-lbl-TP', 'limit-lbl-SL'].forEach(id => {
          const el = document.getElementById(id);
          if(el) el.remove();
      });
  }

  // 4. Cleanup Old Position Labels
  Array.from(container.children).forEach(child => {
      // Remove only if it's a position label (starts with lbl-) and not active
      if (child.id && child.id.startsWith('lbl-') && !activeLabelIds.has(child.id)) {
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
      if (div) div.style.display = 'none';
      return;
  }

  // --- CONTENT GENERATION ---
  let pl;
  if (type === "MAIN" && data.profit !== undefined) {
      pl = Number(data.profit).toFixed(2);
  } else {
      const target = type === "MAIN" ? data.price_current : price;
      pl = calculatePL(data.symbol, data.type, data.volume, data.price_open, target);
  }

  const sign = parseFloat(pl) >= 0 ? "+" : "";
  const plColor = parseFloat(pl) >= 0 ? "#00b894" : "#ff5555"; 
  const finalPlColor = type === "MAIN" ? plColor : "#ffffff";
  const plHtml = `(<span style="color:${finalPlColor}; font-weight:700;">${sign}$${pl}</span>)`;
  const typeColor = data.type === "BUY" ? "#2962ff" : "#ff5555";

  // Define Content HTML
  let contentHtml = "";
  
  if (type === "MAIN") {
      let coreText = `${data.type} ${data.volume} @ ${data.price_open.toFixed(2)}`;
      if (data.account_name) coreText = `${data.account_name} | ${coreText}`;
      contentHtml = `<span class="label-content">${coreText} ${plHtml}</span>`;
  } else {
      // TP/SL: Label + Input + P/L
      // [NEW] Added Input Field
      const inputHtml = `<input type="number" step="0.01" class="limit-price-input no-drag" 
          value="${price.toFixed(2)}" 
          onmousedown="event.stopPropagation()"
          onkeydown="if(event.key === 'Enter') handlePositionInput('${ticket}', '${type}', this.value)"
          onblur="handlePositionInput('${ticket}', '${type}', this.value)" 
      />`;
      
      contentHtml = `<span class="label-content" style="display:flex; align-items:center;">${type} ${inputHtml} ${plHtml}</span>`;
  }

  // --- CREATE OR UPDATE DOM ---
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

      // Insert Content Placeholder
      const contentSpan = document.createElement("span");
      contentSpan.className = "label-wrapper"; // Wrapper for innerHTML
      div.appendChild(contentSpan);

      // Close Button
      const closeSpan = document.createElement("span");
      closeSpan.className = "label-close";
      closeSpan.style.marginLeft = "8px";
      closeSpan.style.cursor = "pointer";
      closeSpan.style.fontWeight = "bold";
      closeSpan.style.fontSize = "22px";
      closeSpan.style.lineHeight = "1";
      closeSpan.innerHTML = "×";
      
      closeSpan.onmousedown = (e) => { e.stopPropagation(); };

      closeSpan.onclick = async (e) => {
          e.stopPropagation(); e.preventDefault();
          closeSpan.innerHTML = ""; 
          closeSpan.className = "loader-spinner-small";
          
          if (type === 'MAIN') {
              closeSpan.style.border = "2px solid rgba(0,0,0,0.1)"; 
              closeSpan.style.borderTop = `2px solid ${typeColor}`; 
          } else {
              closeSpan.style.border = "2px solid rgba(255,255,255,0.3)";
              closeSpan.style.borderTop = "2px solid white";
          }

          try {
              if (type === 'MAIN') await closeTrade(ticket);
              else await removeLevel(ticket, type);
          } catch (err) {
              closeSpan.className = "label-close"; 
              closeSpan.style.border = "none";     
              closeSpan.innerHTML = "×";
          }
      };
      div.appendChild(closeSpan);
      
      // Event Listeners
      if (type === "MAIN") {
         div.onmouseenter = () => {
            if (menuHideTimer) clearTimeout(menuHideTimer);
            showHoverMenuFixed(ticket, type, y, div);
         };
         div.onmouseleave = () => {
            menuHideTimer = setTimeout(() => {
                document.getElementById("hover-menu").style.display = "none";
            }, 150);
         };
      } else {
         div.style.cursor = "ns-resize";
         div.onmousedown = (e) => { 
             // Allow dragging unless clicking the input
             if (e.target.tagName === 'INPUT') return;
             e.preventDefault(); e.stopPropagation(); 
             startDrag(ticket, type, price); 
         };
      }

      container.appendChild(div);
  } else {
      div.style.display = 'flex';
  }

  // --- UPDATE CONTENT (Anti-Flicker) ---
  const wrapper = div.querySelector('.label-wrapper');
  
  // Check if user is typing in this specific label
  const activeInput = document.activeElement;
  const isInputFocused = activeInput && div.contains(activeInput) && activeInput.tagName === 'INPUT';

  if (!isInputFocused) {
      wrapper.innerHTML = contentHtml;
  }

  // --- STYLING ---
  div.style.top = `${y}px`;
  
  if (type === "MAIN") {
      div.style.backgroundColor = "#ffffff"; 
      div.style.color = typeColor; 
      div.style.fontWeight = "800";
      div.style.border = `2px solid ${typeColor}`;
      div.querySelector('.label-close').style.color = typeColor;
  } else {
      const bg = type === "TP" ? COL_TP : COL_SL;
      div.style.backgroundColor = bg;
      div.style.color = "#ffffff"; 
      div.style.fontWeight = "400"; 
      div.style.border = "none";
      div.querySelector('.label-close').style.color = "white";
  }
}

async function handlePositionInput(ticketId, type, priceStr) {
    const newPrice = parseFloat(priceStr);
    if (isNaN(newPrice) || newPrice <= 0) return;

    // Identify Targets (Handle Aggregates)
    let targets = [];
    if (priceLines[ticketId] && priceLines[ticketId].data && priceLines[ticketId].data.tickets) {
        targets = priceLines[ticketId].data.tickets; // All tickets in group
    } else {
        targets = [ticketId]; // Single ticket
    }

    // Call API for each target
    const promises = targets.map(t => {
        const payload = { 
            ticket: t, 
            user_id: currentUserId, 
            symbol: currentSymbol 
        };
        
        if (type === 'TP') payload.tp = newPrice;
        if (type === 'SL') payload.sl = newPrice;
        
        return fetch("http://127.0.0.1:5000/api/modify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    });

    try {
        await Promise.all(promises);
        await fetchDashboardData(); // Refresh chart
        
        // Remove focus to show update
        if(document.activeElement) document.activeElement.blur();
        
    } catch (err) {
        showError("Modification Failed", err.message);
    }
}

// 2. UPDATE showHoverMenuFixed (Allow Menu for Aggregates)
function showHoverMenuFixed(ticket, type, y, labelElem) {
  const menu = document.getElementById("hover-menu");
  if (!priceLines[ticket]) return;
  const pos = priceLines[ticket].data;

  let html = "";
  
  if (type === "MAIN") {
      // [FIX] Only show buttons if TP/SL are MISSING or INCONSISTENT (value <= 0)
      if (!pos.tp || pos.tp <= 0)
        html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'TP', ${pos.price_current})">+ TP</button>`;
      
      if (!pos.sl || pos.sl <= 0)
        html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', 'SL', ${pos.price_current})">+ SL</button>`;
      
      // Removed "Close" button from menu since Label has 'x'
  } else if (type === "TP" || type === "SL") {
     // Menu for existing lines (Move)
     html += `<button class="hover-btn" onmousedown="startDrag('${ticket}', '${type}', ${type === "TP" ? pos.tp : pos.sl})">Move</button>`;
  }

  // If no buttons needed (e.g. both TP and SL are set on Main), Hide Menu
  if (!html) {
      menu.style.display = "none";
      return;
  }

  menu.innerHTML = html;
  menu.style.display = "flex";
  
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
    // FIX 1: Navigation Lock - Reset specific view when user manually changes symbol
    specificTradeView = null;
  }

  for (let t in priceLines) {
    const group = priceLines[t];
    if (group.main) candleSeries.removePriceLine(group.main);
    if (group.tp) candleSeries.removePriceLine(group.tp);
    if (group.sl) candleSeries.removePriceLine(group.sl);
  }
  priceLines = {};

  // Re-set data just in case
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

      // FIX: Only update legend if NOT hovering history OR if hovering current candle
      if (!lastHoveredTime || lastHoveredTime === latest.time) {
        updateLegend(latest);
      }

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
        <span style="color:white">O:</span><span style="color:${valColor}">${Number(data.open).toFixed(2)}</span>
        <span style="color:white">H:</span><span style="color:${valColor}">${Number(data.high).toFixed(2)}</span>
        <span style="color:white">L:</span><span style="color:${valColor}">${Number(data.low).toFixed(2)}</span>
        <span style="color:white">C:</span><span style="color:${valColor}">${Number(data.close).toFixed(2)}</span>
    `;
}

function startLimitModeCustom(type, price) {
    // 1. Safety Check (Opposing Orders)
    if (window.SYSTEM_STATE && window.SYSTEM_STATE.orders) {
        const opposingType = type === 'BUY' ? 'SELL' : 'BUY';
        const hasOpposing = window.SYSTEM_STATE.orders.some(o => 
            o.symbol.startsWith(currentSymbol) && o.type === opposingType
        );
        if (hasOpposing) {
            showError("Action Blocked", `Cannot place ${type} Limit. You have pending ${opposingType} orders.`);
            return;
        }
    }

    limitOrderState.active = true;
    limitOrderState.type = type;
    limitOrderState.entryPrice = price;
    limitOrderState.isSubmitting = false;

    // 2. Calculate 0.3% Margin (Reverted to simple logic)
    const margin = price * 0.002; 
    
    if (type === 'BUY') {
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
  limitOrderState.isSubmitting = false; // [Reset]
  limitOrderState.editTicket = null;
  limitOrderState.editTickets = null;
  
  if (limitOrderState.lines.entry) candleSeries.removePriceLine(limitOrderState.lines.entry);
  if (limitOrderState.lines.tp) candleSeries.removePriceLine(limitOrderState.lines.tp);
  if (limitOrderState.lines.sl) candleSeries.removePriceLine(limitOrderState.lines.sl);
  
  limitOrderState.lines = { entry: null, tp: null, sl: null };
  setExistingLinesStyle(LightweightCharts.LineStyle.Solid);
  
  document.querySelectorAll('.btn-buy-limit, .btn-sell-limit').forEach(b => b.classList.remove('active'));
  updateLeftLabels();
}

function drawLimitLines() {
    // Colors
    const entryColor = limitOrderState.type === 'BUY' ? COL_BUY : COL_SELL;
    
    // Create Entry Line
    limitOrderState.lines.entry = candleSeries.createPriceLine({
        price: limitOrderState.entryPrice,
        color: entryColor,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid, 
        axisLabelVisible: true,
        title: 'LIMIT ENTRY',
    });

    // Create TP Line (Solid, per request to avoid dashed/hidden look)
    limitOrderState.lines.tp = candleSeries.createPriceLine({
        price: limitOrderState.tpPrice,
        color: COL_TP,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: 'LIMIT TP',
    });

    // Create SL Line (Solid)
    limitOrderState.lines.sl = candleSeries.createPriceLine({
        price: limitOrderState.slPrice,
        color: COL_SL,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: 'LIMIT SL',
    });
}

function setExistingLinesStyle(style) {
    for (let t in priceLines) {
        const group = priceLines[t];
        // Apply style to TP and SL lines only
        if (group.tp) group.tp.applyOptions({ lineStyle: style });
        if (group.sl) group.sl.applyOptions({ lineStyle: style });
    }
}

function startEditOrder(order) {
    // 1. Set State
    limitOrderState.active = true;
    limitOrderState.isEdit = true;
    limitOrderState.isSubmitting = false; // Reset loading state
    
    // 2. Load Order Data
    // Support both single ticket and aggregated tickets
    limitOrderState.editTickets = order.tickets || [order.ticket];
    limitOrderState.editTicket = order.ticket;
    
    limitOrderState.type = order.type;
    limitOrderState.entryPrice = order.price_open;
    limitOrderState.tpPrice = order.tp;
    limitOrderState.slPrice = order.sl;
    
    // 3. Defaults if TP/SL are 0 (Set to ~1% away just for visualization)
    if (!limitOrderState.tpPrice || limitOrderState.tpPrice === 0) {
        limitOrderState.tpPrice = order.type === 'BUY' ? order.price_open * 1.01 : order.price_open * 0.99;
    }
    if (!limitOrderState.slPrice || limitOrderState.slPrice === 0) {
        limitOrderState.slPrice = order.type === 'BUY' ? order.price_open * 0.99 : order.price_open * 1.01;
    }

    // 4. Draw Lines & Update UI
    drawLimitLines(); 
    setExistingLinesStyle(LightweightCharts.LineStyle.Dashed);
    updateLeftLabels();
}

function handleLimitInput(type, valueStr) {
    // [FIX] Blur immediately to allow the UI to refresh cleanly
    if (document.activeElement) {
        document.activeElement.blur();
    }

    const newPrice = parseFloat(valueStr);
    if (isNaN(newPrice) || newPrice <= 0) return;

    // 1. Update State
    if (type === 'ENTRY') {
        limitOrderState.entryPrice = newPrice;
    } 
    else if (type === 'TP') {
        limitOrderState.tpPrice = newPrice;
    } 
    else if (type === 'SL') {
        limitOrderState.slPrice = newPrice;
    }

    // 2. Update Lines on Chart (Move lines instantly)
    if (limitOrderState.lines.entry) limitOrderState.lines.entry.applyOptions({ price: limitOrderState.entryPrice });
    if (limitOrderState.lines.tp) limitOrderState.lines.tp.applyOptions({ price: limitOrderState.tpPrice });
    if (limitOrderState.lines.sl) limitOrderState.lines.sl.applyOptions({ price: limitOrderState.slPrice });

    // 3. Re-render Labels (Update P/L Text)
    // Because we blurred above, renderLimitLabels will now update the HTML
    updateLeftLabels();
}

function renderLimitLabels(container) {
    let totalVol = 0;

    // 1. Get Total Volume from Active Accounts (Config)
    const accounts = window.allAccounts || [];
    const sym = window.currentSymbol || currentSymbol;

    if (accounts.length > 0 && sym) {
        const rawSym = sym.toUpperCase();
        
        accounts.forEach(acc => {
            if (acc.IS_ACTIVE && acc.SYMBOL_CONFIG) {
                const configKey = Object.keys(acc.SYMBOL_CONFIG).find(k => {
                    const confSym = k.toUpperCase();
                    return rawSym === confSym || rawSym.startsWith(confSym);
                });

                if (configKey) {
                    const vol = parseFloat(acc.SYMBOL_CONFIG[configKey].VOLUME);
                    if (!isNaN(vol)) totalVol += vol;
                }
            }
        });
    }

    // Fallback: If no account config volume found, default to 1 (so we don't multiply by 0)
    if (totalVol === 0) totalVol = 1;

    // 2. [UPDATED] Get Multiplier from the Input Box (between Buy/Sell buttons)
    const qtyInput = document.getElementById('trade-qty');
    const inputMultiplier = qtyInput ? (parseFloat(qtyInput.value) || 1) : 1;

    const definitions = [
        { type: 'ENTRY', price: limitOrderState.entryPrice, color: limitOrderState.type === 'BUY' ? COL_BUY : COL_SELL },
        { type: 'TP', price: limitOrderState.tpPrice, color: COL_TP },
        { type: 'SL', price: limitOrderState.slPrice, color: COL_SL }
    ];

    definitions.forEach(def => {
        const id = `limit-lbl-${def.type}`;
        let div = document.getElementById(id);
        const y = candleSeries.priceToCoordinate(def.price);

        if (y === null) {
            if(div) div.remove();
            return;
        }

        // --- CONTENT GENERATION ---
        const inputHtml = `<input type="number" step="0.01" class="limit-price-input no-drag" 
            value="${def.price.toFixed(2)}" 
            onmousedown="event.stopPropagation()"
            onkeyup="if(event.key === 'Enter') handleLimitInput('${def.type}', this.value)"
            onblur="handleLimitInput('${def.type}', this.value)" 
        />`;

        let contentHtml = "";

        if (def.type === 'ENTRY') {
             const isEdit = limitOrderState.isEdit;
             const isSubmitting = limitOrderState.isSubmitting;
             
             let btnText = isEdit ? "UPDATE" : "PLACE";
             let btnAction = isEdit ? "submitOrderModification()" : "confirmLimitOrderFromLabel()";
             let btnStyle = "";

             if (isSubmitting) {
                 btnText = "...";
                 btnAction = "";
                 btnStyle = "opacity:0.7; pointer-events:none;";
             }

             contentHtml = `
                <span style="margin-right:2px;">Entry</span>
                ${inputHtml}
                <button class="btn-label-place no-drag" style="${btnStyle}" onmousedown="event.stopPropagation(); ${btnAction}">${btnText}</button>
                <span class="no-drag" style="margin-left:8px; cursor:pointer; font-size:16px;" onmousedown="event.stopPropagation(); cancelLimitMode()">×</span>
             `;
        } else {
             // --- P/L CALCULATION ---
             // Formula: Distance * Total Config Volume * Input Box Multiplier
             const dist = Math.abs(def.price - limitOrderState.entryPrice);
             const plVal = dist * totalVol * inputMultiplier;

             const sign = plVal >= 0 ? "+" : "-";
             const absPl = Math.abs(plVal).toFixed(2);
             
             contentHtml = `${def.type} ${inputHtml} (${sign}$${absPl})`;
        }

        // --- DOM UPDATES ---
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
            
            div.onmousedown = (e) => { 
                if (e.target.classList.contains('no-drag') || e.target.tagName === 'INPUT') return;
                e.preventDefault(); e.stopPropagation(); 
                startDrag('LIMIT', def.type, def.price); 
            };
            container.appendChild(div);
        } else {
            const activeInput = document.activeElement;
            const isInputFocused = activeInput && div.contains(activeInput) && activeInput.tagName === 'INPUT';
            if (!isInputFocused) {
                 div.innerHTML = contentHtml;
            }
        }

        div.style.top = `${y}px`;
        div.style.backgroundColor = def.color;
        div.style.color = "white";
        if(!div.innerHTML) div.innerHTML = contentHtml; 
    });
}

async function confirmLimitOrderFromLabel() {
    const qtyInput = document.getElementById("trade-qty");
    const qty = qtyInput ? parseFloat(qtyInput.value) : 1;
    
    // [FIX] Set Flag & update UI immediately
    limitOrderState.isSubmitting = true;
    updateLeftLabels(); // Forces button to show "..."

    const payload = {
        user_id: currentUserId,
        mobile: currentMobile,
        symbol: currentSymbol,
        type: limitOrderState.type, 
        volume: qty,
        order_type: 'LIMIT',
        price: limitOrderState.entryPrice,
        sl: limitOrderState.slPrice,
        tp: limitOrderState.tpPrice
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
            const fails = (data.details || []).filter(d => !d.includes("Done") && !d.includes("Success"));
            if (fails.length > 0) {
                showError("Trade Errors", fails.join("\n"));
            }
            // [FIX] Fetch Data FIRST (Button stays "...")
            await fetchDashboardData();
            
            // THEN remove the lines (New order lines will have appeared by now)
            cancelLimitMode();
        }
    } catch (e) {
        showError("Order Failed", e.message);
        limitOrderState.isSubmitting = false;
        updateLeftLabels();
    }
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
  if (ticket === 'LIMIT') {
      draggingLine = {
        ticket: 'LIMIT',
        type: type, // 'ENTRY', 'TP', 'SL'
        startPrice: currentPrice
      };
      
      // We don't need a temporary drag line because we update the actual limit lines in real-time
      // But to keep consistency with existing logic, let's just use the global cursor
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
  const container = document.getElementById("chart-container");
  const rect = container.getBoundingClientRect();
  let price = candleSeries.coordinateToPrice(e.clientY - rect.top);
  
  if (!price) return;

  // 1. LIMIT ORDER DRAG LOGIC
  if (draggingLine && draggingLine.ticket === 'LIMIT') {
      
      // --- CONSTRAINTS (Entry Price Basis) ---
      const entry = limitOrderState.entryPrice;

      if (limitOrderState.type === 'BUY') {
          // BUY LIMIT RULES
          if (draggingLine.type === 'TP') {
              // TP cannot go below Entry
              if (price < entry) price = entry; 
          } 
          else if (draggingLine.type === 'SL') {
              // SL cannot go above Entry
              if (price > entry) price = entry; 
          }
      } 
      else {
          // SELL LIMIT RULES
          if (draggingLine.type === 'TP') {
              // TP cannot go above Entry
              if (price > entry) price = entry; 
          } 
          else if (draggingLine.type === 'SL') {
              // SL cannot go below Entry
              if (price < entry) price = entry; 
          }
      }

      // --- APPLY UPDATES ---
      if (draggingLine.type === 'ENTRY') {
           // Move Entry: Shift TP/SL by same amount
           const delta = price - limitOrderState.entryPrice;
           limitOrderState.entryPrice = price; 
           limitOrderState.tpPrice += delta;
           limitOrderState.slPrice += delta;

           // Update all lines
           if (limitOrderState.lines.entry) limitOrderState.lines.entry.applyOptions({ price: limitOrderState.entryPrice });
           if (limitOrderState.lines.tp) limitOrderState.lines.tp.applyOptions({ price: limitOrderState.tpPrice });
           if (limitOrderState.lines.sl) limitOrderState.lines.sl.applyOptions({ price: limitOrderState.slPrice });
      } 
      else {
           // Move TP or SL (Constrained)
           if (draggingLine.type === 'TP') {
               limitOrderState.tpPrice = price;
               if (limitOrderState.lines.tp) limitOrderState.lines.tp.applyOptions({ price: price });
           } 
           else if (draggingLine.type === 'SL') {
               limitOrderState.slPrice = price;
               if (limitOrderState.lines.sl) limitOrderState.lines.sl.applyOptions({ price: price });
           }
      }
      
      updateLeftLabels();
      return;
  }

  // 2. POSITION DRAG LOGIC (Existing)
  if (!draggingLine || !dragPriceLine) return;

  const entry = draggingLine.startPrice;
  const isBuy = draggingLine.direction === "BUY";
  
  // Get Robust Current Price
  let currentCmp = entry;
  if (priceLines[draggingLine.ticket] && priceLines[draggingLine.ticket].data && priceLines[draggingLine.ticket].data.price_current) {
      currentCmp = priceLines[draggingLine.ticket].data.price_current;
  } else if (latestCandle) {
      currentCmp = latestCandle.close;
  }

  // --- CONSTRAINTS (Current Price Basis) ---
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

  if (draggingLine && draggingLine.ticket === 'LIMIT') {
      draggingLine = null;
      return;
  }

  if (!draggingLine) return;

  const rect = document.getElementById("chart-container").getBoundingClientRect();
  const finalPrice = candleSeries.coordinateToPrice(e.clientY - rect.top);

  if (!finalPrice) {
    cancelDrag();
    return;
  }

  // Identify Targets
  let targets = [];
  const ticketId = draggingLine.ticket;
  
  // Check if it's an aggregate (starts with AGG or ACC, or has 'tickets' array)
  if (priceLines[ticketId] && priceLines[ticketId].data && priceLines[ticketId].data.tickets) {
      targets = priceLines[ticketId].data.tickets; // All underlying tickets
  } else {
      targets = [ticketId];
  }

  // Iterate and Modify All
  // (In a production app, you'd want a bulk API endpoint, but loop works for now)
  for (let t of targets) {
      const payload = { 
          ticket: t, 
          user_id: currentUserId,
          symbol: currentSymbol 
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

  // Cleanup
  if (dragPriceLine) {
      candleSeries.removePriceLine(dragPriceLine);
      dragPriceLine = null;
  }
  draggingLine = null;
  
  // Refresh
  await fetchDashboardData();
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

// frontend/dashboard.js

// frontend/dashboard.js

function updateChartPositions(positions) {
  let targetPositions = positions;
  
  if (specificTradeView) {
      targetPositions = positions.filter(p => p.account_login == specificTradeView || p.ticket == specificTradeView);
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
      'BUY': { vol: 0, priceProd: 0, profit: 0, tickets: [], tps: [], sls: [] },
      'SELL': { vol: 0, priceProd: 0, profit: 0, tickets: [], tps: [], sls: [] }
  };

  currentPositions.forEach(pos => {
      const side = pos.type; 
      aggregates[side].vol += pos.volume;
      aggregates[side].priceProd += (pos.price_open * pos.volume);
      aggregates[side].profit += pos.profit;
      aggregates[side].tickets.push(pos.ticket);
      aggregates[side].tps.push(pos.tp);
      aggregates[side].sls.push(pos.sl);
  });

  ['BUY', 'SELL'].forEach(side => {
      const agg = aggregates[side];
      if (agg.vol > 0) {
          const avgPrice = agg.priceProd / agg.vol; 
          
          // [FIX] Generate ID compatible with Backend Parser: SYMBOL_TYPE_LOGIN
          // Global: XAUUSD_BUY
          // Specific: XAUUSD_BUY_12345
          const aggTicket = specificTradeView 
              ? `${currentSymbol}_${side}_${specificTradeView}` 
              : `${currentSymbol}_${side}`;
          
          const mainColor = side === "BUY" ? COL_BUY : COL_SELL;
          
          // Consistency Checks
          const firstTP = agg.tps[0];
          const isTPConsistent = agg.tps.every(val => Math.abs(val - firstTP) < 0.001);
          const finalTP = (isTPConsistent && firstTP > 0) ? firstTP : 0;

          const firstSL = agg.sls[0];
          const isSLConsistent = agg.sls.every(val => Math.abs(val - firstSL) < 0.001);
          const finalSL = (isSLConsistent && firstSL > 0) ? firstSL : 0;

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
                is_aggregate: true 
            }
          };

          if (finalTP > 0) {
              priceLines[aggTicket].tp = candleSeries.createPriceLine({
                  price: finalTP, color: COL_TP, lineWidth: 2,
                  lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: false, title: "",
              });
          }
          if (finalSL > 0) {
              priceLines[aggTicket].sl = candleSeries.createPriceLine({
                  price: finalSL, color: COL_SL, lineWidth: 2,
                  lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: false, title: "",
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

  const mainLine = candleSeries.createPriceLine({
    price: parseFloat(subPos.price),
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
      price_current: subPos.price_current || subPos.price,
      symbol: subPos.symbol,
      volume: subPos.volume,
      sl: subPos.sl,
      tp: subPos.tp,
      account_name: subPos.account_name,
      // --- FIX: Pass the profit value here so the label can display it ---
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
  fetchDashboardData();
}

async function placeOrder(type) {
  const qtyInput = document.getElementById("trade-qty");
  const qty = qtyInput ? parseFloat(qtyInput.value) : 1;
  
  // Loading State
  const btn = document.querySelector(type === "BUY" ? ".btn-buy" : ".btn-sell");
  if (btn) btn.classList.add("btn-loading");

  // Construct Base Payload
  let payload = {
    user_id: currentUserId,
    mobile: currentMobile,
    symbol: currentSymbol,
    type: type,
    volume: qty,
    order_type: 'MARKET' // Default
  };

  // --- LIMIT ORDER LOGIC ---
  if (limitOrderState.active) {
      // Safety Check: Prevent placing a SELL order while in BUY LIMIT mode
      if (limitOrderState.type !== type) {
          showError("Mode Mismatch", `You are currently in ${limitOrderState.type} Limit Mode. Please cancel it before placing a ${type} order.`);
          if (btn) btn.classList.remove("btn-loading");
          return;
      }

      payload.order_type = 'LIMIT';
      payload.price = limitOrderState.entryPrice;
      
      // Only attach SL/TP if they are set (validity check)
      if (limitOrderState.slPrice > 0) payload.sl = limitOrderState.slPrice;
      if (limitOrderState.tpPrice > 0) payload.tp = limitOrderState.tpPrice;
  }
  // -------------------------

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
      
      // Success! If we were in limit mode, close it now.
      if (limitOrderState.active) {
          cancelLimitMode();
      }
      
      await fetchDashboardData();
    }
  } catch (e) {
    showError("Order Failed", e.message);
  } finally {
    if (btn) btn.classList.remove("btn-loading");
  }
}

async function closeTrade(ticket, btnElem) {
  // LOADING: Toggle loading class
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
      await fetchDashboardData();
    }
  } catch (e) {
    showError("Network Error", e.message);
  } finally {
    // LOADING: Remove loading class
    if (btnElem) btnElem.classList.remove("btn-loading");
  }
}

function toggleFullscreen() {
  const col = document.querySelector(".chart-col");
  const btn = document.getElementById("btn-fullscreen");
  
  if (col) {
    col.classList.toggle("fullscreen-mode");
    
    // [FIX] Toggle Icon
    if (col.classList.contains("fullscreen-mode")) {
        if(btn) btn.innerText = "✖"; // Exit Icon
    } else {
        if(btn) btn.innerText = "⛶"; // Enter Icon
    }

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
      
      container.innerHTML += `
                <div class="account-card" style="opacity: ${acc.IS_ACTIVE ? 1 : 0.5}; padding: 20px;">
                    <div style="display:flex; align-items:center;">
                        <div style="transform: scale(1.2); transform-origin: left center; margin-right: 10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" ${checked} onchange="toggleAccountActive('${acc.ID}', this.checked)">
                                <span class="slider"></span>
                            </label>
                        </div>

                        <div style="margin-left:10px;">
                            <div style="font-weight:700; color:white; font-size: 20px;">
                                ${acc.NAME || "Account"} 
                                <span style="font-weight:400; color:#8a94a6; font-size:16px; margin-left: 8px;">(${acc.USER})</span>
                            </div>
                            <div style="font-size:15px; color:#8a94a6; margin-top: 6px;">${configSummary}</div>
                        </div>
                    </div>
                    <div style="display:flex; gap:12px; align-items: center;">
                        <button class="btn-secondary" onclick='editAccount("${acc.ID}")' style="font-size:15px; padding:8px 18px;">Edit</button>
                        <button class="btn-remove-level" onclick="deleteAccount('${acc.ID}')" style="font-size:26px; width:36px; height:36px; line-height: 34px;">×</button>
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
  let current = parseFloat(input.value) || 0;
  
  // [FIX] Force step to be 1 or -1, ignoring the 0.5 from HTML
  const step = delta >= 0 ? 1 : -1;
  
  let val = current + step;

  // Enforce minimum of 1
  if (val < 1) val = 1;
  
  // [FIX] Remove decimals (Integer only)
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
window.viewSpecificTrade = viewSpecificTrade;
window.closeTrade = closeTrade;
window.toggleSidebar = toggleSidebar;
window.toggleHeader = toggleHeader;
window.updateDrag = updateDrag;
window.openHistoryModal = openHistoryModal;
window.closeHistoryModal = closeHistoryModal;
window.initLimitFromContextMenu = initLimitFromContextMenu;
window.confirmLimitOrderFromLabel = confirmLimitOrderFromLabel;
window.submitOrderModification = submitOrderModification;
window.startEditOrder = startEditOrder;
window.handleLimitInput = handleLimitInput;
window.handlePositionInput = handlePositionInput;