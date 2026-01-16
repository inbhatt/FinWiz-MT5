const { ipcRenderer } = require('electron');

// Global State
let currentMobile = localStorage.getItem("userMobile") || "9876543210";
let chart;
let candleSeries;

// --- 1. INITIALIZATION & REMEMBER ME CHECK ---
document.addEventListener('DOMContentLoaded', () => {
    // A. Check for Saved Credentials (REMEMBER ME)
    const savedMobile = localStorage.getItem('savedMobile');
    const savedPass = localStorage.getItem('savedPass');
    const rememberCheckbox = document.getElementById('rememberMe');

    if (savedMobile && savedPass) {
        document.getElementById('mobile').value = savedMobile;
        document.getElementById('password').value = savedPass;
        if (rememberCheckbox) rememberCheckbox.checked = true;
    }

    // B. Initialize Chart (Only if we are on dashboard)
    if (document.getElementById('chart-container')) {
        initChart();
        fetchDashboardData();
        // ... (rest of dashboard init code)
    }

    // C. Setup Password Toggle (Only if on login screen)
    const eyeIcon = document.querySelector('.eye-icon');
    if (eyeIcon) {
        eyeIcon.addEventListener('click', togglePassword);
    }
});

// --- TOGGLE PASSWORD VISIBILITY ---
function togglePassword() {
    const passwordInput = document.getElementById('password');
    const eyeIcon = document.querySelector('.eye-icon');

    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        eyeIcon.textContent = '🔒';
        eyeIcon.style.color = '#36d7b7';
    } else {
        passwordInput.type = 'password';
        eyeIcon.textContent = '👁';
        eyeIcon.style.color = '#8a94a6';
    }
}

// --- LOGIN LOGIC WITH REMEMBER ME ---
async function attemptLogin() {
    const mobile = document.getElementById('mobile').value;
    const password = document.getElementById('password').value;
    const rememberMe = document.getElementById('rememberMe').checked;

    const btn = document.getElementById('loginBtn');
    const btnText = document.getElementById('btnText');
    const status = document.getElementById('statusMsg');

    btn.disabled = true;
    btnText.innerText = "Connecting...";
    status.innerText = "";

    try {
        const response = await fetch('http://127.0.0.1:5000/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile: mobile, password: password })
        });

        // 1. Get the raw text first (in case it's not JSON)
        const rawText = await response.text();
        let data;

        try {
            data = JSON.parse(rawText);
        } catch (e) {
            // If it crashed and returned HTML error page, show that
            ipcRenderer.invoke('show-alert', 'CRITICAL ERROR', rawText.substring(0, 500));
            resetBtn();
            return;
        }

        // 2. CHECK STATUS & SHOW DIALOG
        if (response.ok) {

            // ... (Your existing Save/Redirect logic) ...
            if (rememberMe) {
                localStorage.setItem('savedMobile', mobile);
                localStorage.setItem('savedPass', password);
            }
            localStorage.setItem("userMobile", mobile);
            window.location.href = "dashboard.html";

        } else {
            // FAIL DIALOG
            // Show exactly what the Python backend said was wrong
            const errorMsg = data.message || data.error || "Unknown Error";
            await ipcRenderer.invoke('show-alert', 'Login Failed', errorMsg);

            status.innerText = errorMsg;
            resetBtn();
        }

    } catch (error) {
        // NETWORK DIALOG
        await ipcRenderer.invoke('show-alert', 'Network Error', error.toString());
        console.error(error);
        resetBtn();
    }
}

function resetBtn() {
    const btn = document.getElementById('loginBtn');
    const btnText = document.getElementById('btnText');
    btn.disabled = false;
    btnText.innerText = "Secure Login";
}

// Allow pressing "Enter" key
document.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        attemptLogin();
    }
});

// ... (Keep the Dashboard Chart/Table logic functions below if they are in the same file) ...