const { ipcRenderer } = require("electron");

document.addEventListener("DOMContentLoaded", () => {
  const mobInput = document.getElementById("mobile");
  const passInput = document.getElementById("password");
  const btn = document.getElementById("loginBtn");

  if (mobInput) mobInput.disabled = false;
  if (passInput) passInput.disabled = false;
  if (btn) btn.disabled = false;

  const savedMobile = localStorage.getItem("savedMobile");
  const savedPass = localStorage.getItem("savedPass");
  const rememberCheckbox = document.getElementById("rememberMe");

  if (savedMobile && savedPass) {
    if (mobInput) mobInput.value = savedMobile;
    if (passInput) passInput.value = savedPass;
    if (rememberCheckbox) rememberCheckbox.checked = true;
  }

  const eyeIcon = document.querySelector(".eye-icon");
  if (eyeIcon) eyeIcon.addEventListener("click", togglePassword);
});

window.addEventListener("pageshow", () => {
  const mobInput = document.getElementById("mobile");
  const passInput = document.getElementById("password");
  if (mobInput) mobInput.disabled = false;
  if (passInput) passInput.disabled = false;
});

function togglePassword() {
  const passwordInput = document.getElementById("password");
  const eyeIcon = document.querySelector(".eye-icon");
  if (passwordInput.type === "password") {
    passwordInput.type = "text";
    eyeIcon.textContent = "🔒";
    eyeIcon.style.color = "#36d7b7";
  } else {
    passwordInput.type = "password";
    eyeIcon.textContent = "👁";
    eyeIcon.style.color = "#8a94a6";
  }
}

async function attemptLogin() {
  const mobileIn = document.getElementById("mobile");
  const passIn = document.getElementById("password");
  const btn = document.getElementById("loginBtn");
  const btnText = document.getElementById("btnText");
  const status = document.getElementById("statusMsg");
  const rememberMe = document.getElementById("rememberMe").checked;

  btn.disabled = true;
  btnText.innerText = "Connecting...";
  status.innerText = "";

  try {
    // --- FIX: Updated URL to /api/login ---
    const response = await fetch("http://127.0.0.1:5000/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobile: mobileIn.value, password: passIn.value }),
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      throw new Error("Server Error: " + rawText.substring(0, 100));
    }

    if (response.ok) {
      if (rememberMe) {
        localStorage.setItem("savedMobile", mobileIn.value);
        localStorage.setItem("savedPass", passIn.value);
      }
      localStorage.setItem("userMobile", mobileIn.value);
      localStorage.setItem("userId", data.user_id);
      window.location.href = "dashboard.html";
    } else {
      status.innerText = data.message || data.error || "Login Failed";
      resetBtn();
    }
  } catch (error) {
    status.innerText = "Network Error: Is the server running?";
    console.error(error);
    resetBtn();
  }
}

function resetBtn() {
  const btn = document.getElementById("loginBtn");
  const btnText = document.getElementById("btnText");
  if (btn) btn.disabled = false;
  if (btnText) btnText.innerText = "Secure Login";
}

document.addEventListener("keypress", function (e) {
  if (e.key === "Enter") attemptLogin();
});
