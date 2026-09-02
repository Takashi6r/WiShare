const socket = io();

let myDeviceId = null;
let myDeviceName = null;

const $ = id => document.getElementById(id);
const nameCard = $("nameCard");
const workspace = $("workspace");
const deviceNameInput = $("deviceName");
const joinBtn = $("joinBtn");
const connectionText = $("connectionText");
const statusDot = document.querySelector(".status-dot");
const devicesContainer = $("devices");
const deviceCount = $("deviceCount");
const fileInput = $("fileInput");
const chooseFiles = $("chooseFiles");
const dropZone = $("dropZone");
const messageInput = $("messageInput");
const sendMessage = $("sendMessage");
const activity = $("activity");
const clearActivity = $("clearActivity");
const toastContainer = $("toastContainer");
// ===============================
// QR CODE JOIN
// ===============================

const openQrButton = document.getElementById("openQrButton");
const qrModal = document.getElementById("qrModal");
const qrBackdrop = document.getElementById("qrBackdrop");
const qrClose = document.getElementById("qrClose");
const qrCode = document.getElementById("qrCode");
const qrUrl = document.getElementById("qrUrl");
const copyQrUrl = document.getElementById("copyQrUrl");
const shareQrUrl = document.getElementById("shareQrUrl");

function getWiShareUrl() {
  return window.location.origin + window.location.pathname;
}

function generateQRCode() {
  const url = getWiShareUrl();

  qrUrl.textContent = url;
  qrCode.innerHTML = "";

  new QRCode(qrCode, {
    text: url,
    width: 220,
    height: 220,
    colorDark: "#07100e",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });
}

function openQRModal() {
  generateQRCode();

  qrModal.classList.add("active");

  document.body.classList.add("qr-open");
}

function closeQRModal() {
  qrModal.classList.remove("active");

  document.body.classList.remove("qr-open");
}

openQrButton?.addEventListener("click", openQRModal);

qrClose?.addEventListener("click", closeQRModal);

qrBackdrop?.addEventListener("click", closeQRModal);

copyQrUrl?.addEventListener("click", async () => {
  const url = getWiShareUrl();

  try {
    await navigator.clipboard.writeText(url);

    copyQrUrl.textContent = "Copied ✓";

    setTimeout(() => {
      copyQrUrl.textContent = "Copy Link";
    }, 1800);

  } catch (error) {
    console.error("Unable to copy URL:", error);
  }
});

shareQrUrl?.addEventListener("click", async () => {
  const url = getWiShareUrl();

  if (navigator.share) {
    try {
      await navigator.share({
        title: "Join my WiShare",
        text: "Join my WiShare room",
        url: url
      });
    } catch (error) {
      console.log("Share cancelled");
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);

      shareQrUrl.textContent = "Link Copied ✓";

      setTimeout(() => {
        shareQrUrl.textContent = "Share Link";
      }, 1800);

    } catch (error) {
      console.error("Unable to share URL:", error);
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeQRModal();
  }
});

const savedName = localStorage.getItem("wishare_device_name");
if (savedName) deviceNameInput.value = savedName;

socket.on("connect", () => {
  connectionText.textContent = "Connected";
  statusDot.style.background = "#64e6a4";
  statusDot.style.boxShadow = "0 0 10px rgba(100,230,164,.7)";
  if (myDeviceName) joinNetwork();
});

socket.on("disconnect", () => {
  connectionText.textContent = "Disconnected";
  statusDot.style.background = "#ef6b73";
  statusDot.style.boxShadow = "0 0 10px rgba(239,107,115,.7)";
});

joinBtn.addEventListener("click", joinNetwork);
deviceNameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") joinNetwork();
});

function joinNetwork() {
  const name = deviceNameInput.value.trim();
  if (!name) return showToast("Please enter a device name.");

  myDeviceName = name;
  localStorage.setItem("wishare_device_name", name);
  socket.emit("device:join", name);
  nameCard.hidden = true;
  workspace.hidden = false;
}

socket.on("device:ready", device => {
  myDeviceId = device.id;
  myDeviceName = device.name;
});

socket.on("devices:update", renderDevices);

function renderDevices(devices) {
  devicesContainer.innerHTML = "";
  deviceCount.textContent = devices.length;

  if (!devices.length) {
    devicesContainer.innerHTML = `<div class="empty-state"><div>📡</div><p>No devices connected</p></div>`;
    return;
  }

  devices.forEach(device => {
    const element = document.createElement("div");
    element.className = "device" + (device.id === myDeviceId ? " me" : "");
    element.innerHTML = `
      <div class="device-avatar">${device.id === myDeviceId ? "💻" : "📱"}</div>
      <div class="device-details">
        <div class="device-name">${escapeHTML(device.name)}</div>
        <div class="device-status">${device.id === myDeviceId ? "You • " : "Joined • "}${escapeHTML(device.ip || "Local network")}</div>
        <div class="device-joined">${device.joinedAt ? `Joined ${formatTime(device.joinedAt)}` : "Online now"}</div>
      </div>`;
    devicesContainer.appendChild(element);
  });
}

sendMessage.addEventListener("click", sendTextMessage);
messageInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});

function sendTextMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit("message:send", { text });
  messageInput.value = "";
}

socket.on("message:receive", message => {
  addMessage(message, false);
  showToast(`${message.senderName} sent a message`);
});

socket.on("message:sent", message => addMessage(message, true));

chooseFiles.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", e => {
  uploadFiles(Array.from(e.target.files));
  fileInput.value = "";
});

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));

dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("dragging");
  uploadFiles(Array.from(e.dataTransfer.files));
});

async function uploadFiles(files) {
  for (const file of files) {
    try {
      showToast(`Uploading ${file.name}...`);

      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/upload", {
        method: "POST",
        body: formData
      });

      if (!response.ok) throw new Error("Upload failed");

      const result = await response.json();

      socket.emit("file:send", {
        fileName: result.file.originalName,
        fileSize: result.file.size,
        fileType: result.file.mimeType,
        fileUrl: result.file.url
      });
    } catch (error) {
      console.error(error);
      showToast(`Failed to upload ${file.name}`);
    }
  }
}

socket.on("file:receive", file => {
  addFile(file, false);
  showToast(`${file.senderName} sent ${file.fileName}`);
});

socket.on("file:sent", file => addFile(file, true));

function addMessage(message, mine) {
  removeEmptyState();

  const element = document.createElement("div");
  element.className = "activity-item";
  element.innerHTML = `
    <div class="activity-avatar">💬</div>
    <div class="activity-content">
      <div class="activity-header">
        <span class="activity-name">${mine ? "You" : escapeHTML(message.senderName)}</span>
        <span class="activity-time">${formatTime(message.time)}</span>
      </div>
      <div class="activity-text">${escapeHTML(message.text)}</div>
    </div>`;
  activity.prepend(element);
}

function addFile(file, mine) {
  removeEmptyState();

  const element = document.createElement("div");
  element.className = "activity-item";
  element.innerHTML = `
    <div class="activity-avatar">📁</div>
    <div class="activity-content">
      <div class="activity-header">
        <span class="activity-name">${mine ? "You" : escapeHTML(file.senderName)}</span>
        <span class="activity-time">${formatTime(file.time)}</span>
      </div>
      <div class="file-item">
        <div class="file-icon">${getFileIcon(file.fileType)}</div>
        <div class="activity-content">
          <div class="file-name">${escapeHTML(file.fileName)}</div>
          <div class="file-size">${formatBytes(file.fileSize)}</div>
        </div>
        <a class="download-button" href="${file.fileUrl}" download="${escapeHTML(file.fileName)}">Download</a>
      </div>
    </div>`;
  activity.prepend(element);
}

function removeEmptyState() {
  const empty = activity.querySelector(".empty-state");
  if (empty) empty.remove();
}

clearActivity.addEventListener("click", () => {
  activity.innerHTML = `<div class="empty-state"><div>💬</div><p>Nothing shared yet</p></div>`;
});

function formatBytes(bytes) {
  if (!bytes) return "0 Bytes";
  const units = ["Bytes", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(1)} ${units[index]}`;
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getFileIcon(type) {
  if (!type) return "📄";
  if (type.startsWith("image/")) return "🖼️";
  if (type.startsWith("video/")) return "🎬";
  if (type.startsWith("audio/")) return "🎵";
  if (type.includes("pdf")) return "📕";
  if (type.includes("zip") || type.includes("compressed")) return "🗜️";
  if (type.includes("word") || type.includes("document")) return "📝";
  if (type.includes("spreadsheet") || type.includes("excel")) return "📊";
  return "📄";
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
// ===============================
// WI-FI DEVICES + ROOM MEMBERS
// ===============================
const openNetworkButton = $("openNetworkButton");
const networkModal = $("networkModal");
const networkBackdrop = $("networkBackdrop");
const networkClose = $("networkClose");
const refreshNetwork = $("refreshNetwork");
const networkDevicesContainer = $("networkDevices");
const networkDeviceCount = $("networkDeviceCount");
const networkSubnet = $("networkSubnet");

function openNetworkModal() {
  networkModal.classList.add("active");
  networkModal.setAttribute("aria-hidden", "false");
  scanNetwork();
}

function closeNetworkModal() {
  networkModal.classList.remove("active");
  networkModal.setAttribute("aria-hidden", "true");
}

openNetworkButton?.addEventListener("click", openNetworkModal);
networkClose?.addEventListener("click", closeNetworkModal);
networkBackdrop?.addEventListener("click", closeNetworkModal);
refreshNetwork?.addEventListener("click", scanNetwork);

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeNetworkModal();
});

async function scanNetwork() {
  if (!networkDevicesContainer) return;

  networkDevicesContainer.innerHTML = `
    <div class="network-loading">
      <span class="spinner"></span>
      Scanning local network...
    </div>`;
  refreshNetwork.disabled = true;
  refreshNetwork.textContent = "Scanning...";

  try {
    const response = await fetch("/api/network-info", { cache: "no-store" });
    if (!response.ok) throw new Error("Network scan failed");

    const result = await response.json();
    const found = Array.isArray(result.devices) ? result.devices : [];

    networkDeviceCount.textContent = found.length;
    networkSubnet.textContent = result.subnet || "Unknown";
    renderNetworkDevices(found);
  } catch (error) {
    console.error(error);
    networkDeviceCount.textContent = "0";
    networkSubnet.textContent = "Unavailable";
    networkDevicesContainer.innerHTML = `
      <div class="network-empty">
        <div>⚠️</div>
        <strong>Could not scan the network</strong>
        <p>Make sure WiShare is running on the local computer and try again.</p>
      </div>`;
  } finally {
    refreshNetwork.disabled = false;
    refreshNetwork.textContent = "↻ Refresh";
  }
}

function renderNetworkDevices(list) {
  networkDevicesContainer.innerHTML = "";

  if (!list.length) {
    networkDevicesContainer.innerHTML = `
      <div class="network-empty">
        <div>📡</div>
        <strong>No devices detected</strong>
        <p>Your router may have device isolation enabled.</p>
      </div>`;
    return;
  }

  list.forEach(device => {
    const element = document.createElement("div");
    element.className = "network-device" + (device.isServer ? " network-server" : "");
    element.innerHTML = `
      <div class="network-device-icon">${device.isServer ? "💻" : "📱"}</div>
      <div class="network-device-details">
        <div class="network-device-name">${escapeHTML(device.name || "Unknown device")}</div>
        <div class="network-device-ip">IP: ${escapeHTML(device.ip)}${device.mac ? ` • MAC: ${escapeHTML(device.mac)}` : ""}</div>
        <div class="network-device-source">${escapeHTML(device.nameSource || "")}</div>
      </div>
      <div class="network-device-badge">${device.isServer ? "This PC" : "On Wi-Fi"}</div>`;
    networkDevicesContainer.appendChild(element);
  });
}
