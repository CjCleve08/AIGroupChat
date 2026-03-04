const socket = io();

const ui = {
  usernameInput: document.getElementById("usernameInput"),
  saveNameBtn: document.getElementById("saveNameBtn"),
  createGroupForm: document.getElementById("createGroupForm"),
  groupNameInput: document.getElementById("groupNameInput"),
  groupList: document.getElementById("groupList"),
  activeGroupTitle: document.getElementById("activeGroupTitle"),
  activeGroupSubtext: document.getElementById("activeGroupSubtext"),
  messageList: document.getElementById("messageList"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  addAiForm: document.getElementById("addAiForm"),
  addAiBtn: document.getElementById("addAiBtn"),
  aiNameInput: document.getElementById("aiNameInput"),
  aiPersonaInput: document.getElementById("aiPersonaInput"),
  aiModelInput: document.getElementById("aiModelInput"),
  aiTemperatureInput: document.getElementById("aiTemperatureInput"),
  aiDelayInput: document.getElementById("aiDelayInput"),
  aiMemberList: document.getElementById("aiMemberList"),
  profileName: document.getElementById("profileName"),
  searchInput: document.getElementById("searchInput"),
  copyInviteBtn: document.getElementById("copyInviteBtn"),
  leaveGroupBtn: document.getElementById("leaveGroupBtn")
};

let currentUsername = localStorage.getItem("aigc_username") || "";
let activeGroupId = null;
let activeGroupName = "";
let inviteGroupId = new URLSearchParams(window.location.search).get("group") || "";
ui.usernameInput.value = currentUsername;
refreshUiForName();
loadGroups(inviteGroupId || undefined);

ui.saveNameBtn.addEventListener("click", () => {
  const newName = ui.usernameInput.value.trim();
  if (!newName) {
    window.alert("Please enter a name.");
    return;
  }
  currentUsername = newName.slice(0, 32);
  localStorage.setItem("aigc_username", currentUsername);
  refreshUiForName();
  if (ui.profileName) ui.profileName.textContent = currentUsername;
  if (activeGroupId) {
    joinActiveGroupIfNeeded();
  } else if (inviteGroupId) {
    joinGroupFromInvite(inviteGroupId).catch((error) => {
      window.alert(error.message || "Unable to join invite link.");
    });
  }
});

ui.createGroupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensureName()) return;
  const name = ui.groupNameInput.value.trim();
  if (!name) return;
  const group = await api("/api/groups", {
    method: "POST",
    body: JSON.stringify({ name, username: currentUsername })
  });
  ui.groupNameInput.value = "";
  await loadGroups(group.id);
});

ui.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensureName() || !activeGroupId) return;
  const text = ui.messageInput.value.trim();
  if (!text) return;
  await api(`/api/groups/${encodeURIComponent(activeGroupId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ username: currentUsername, text })
  });
  ui.messageInput.value = "";
});

ui.addAiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensureName() || !activeGroupId) return;

  const name = ui.aiNameInput.value.trim();
  const persona = ui.aiPersonaInput.value.trim();
  const model = ui.aiModelInput.value.trim();
  const temperature = Number(ui.aiTemperatureInput.value);
  const responseDelayMs = Number(ui.aiDelayInput.value);

  await api(`/api/groups/${encodeURIComponent(activeGroupId)}/ai-members`, {
    method: "POST",
    body: JSON.stringify({
      ownerName: currentUsername,
      name,
      persona,
      model,
      temperature,
      responseDelayMs
    })
  });

  ui.aiNameInput.value = "";
  ui.aiPersonaInput.value = "";
  await loadAiMembers(activeGroupId);
});

ui.copyInviteBtn?.addEventListener("click", async () => {
  if (!activeGroupId) return;
  const inviteUrl = `${window.location.origin}/?group=${encodeURIComponent(activeGroupId)}`;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    ui.copyInviteBtn.textContent = "Copied";
    setTimeout(() => {
      ui.copyInviteBtn.textContent = "Copy Invite Link";
    }, 1200);
  } catch (_error) {
    window.prompt("Copy this invite link:", inviteUrl);
  }
});

ui.leaveGroupBtn?.addEventListener("click", async () => {
  if (!ensureName() || !activeGroupId) return;
  const confirmed = window.confirm(`Leave "${activeGroupName}"?`);
  if (!confirmed) return;

  await api(`/api/groups/${encodeURIComponent(activeGroupId)}/leave`, {
    method: "POST",
    body: JSON.stringify({ username: currentUsername })
  });

  socket.emit("group:leave-room", activeGroupId);
  activeGroupId = null;
  activeGroupName = "";
  ui.messageList.innerHTML = "";
  ui.aiMemberList.innerHTML = "";
  ui.activeGroupTitle.textContent = "Select a conversation";
  ui.activeGroupSubtext.textContent = "Choose a group to start chatting";
  refreshUiForName();
  await loadGroups();
});

socket.on("message:new", (payload) => {
  if (!activeGroupId) return;
  if (!payload || payload.groupId !== activeGroupId) return;
  appendMessage(payload.message);
});

async function loadGroups(preferredGroupId) {
  const query = currentUsername ? `?username=${encodeURIComponent(currentUsername)}` : "";
  const groups = await api(`/api/groups${query}`);
  const search = String(ui.searchInput?.value || "").trim().toLowerCase();
  const visibleGroups = groups.filter((g) => g.name.toLowerCase().includes(search));
  ui.groupList.innerHTML = "";
  for (const group of visibleGroups) {
    const li = document.createElement("li");
    li.classList.toggle("active", group.id === activeGroupId);
    li.innerHTML = `
      <div class="title">${escapeHtml(group.name)}</div>
      <span class="subline">${group.memberCount} members | ${group.aiCount} AI</span>
    `;
    li.addEventListener("click", () => selectGroup(group));
    ui.groupList.appendChild(li);
  }

  if (preferredGroupId) {
    const preferred = groups.find((g) => g.id === preferredGroupId);
    if (preferred) {
      await selectGroup(preferred);
      return;
    }
  }
  if (!activeGroupId && visibleGroups[0]) await selectGroup(visibleGroups[0]);
}

async function selectGroup(group) {
  const previousGroupId = activeGroupId;
  activeGroupId = group.id;
  activeGroupName = group.name;
  ui.activeGroupTitle.textContent = group.name;
  ui.activeGroupSubtext.textContent = `${group.memberCount} members | ${group.aiCount} AI`;
  ui.messageForm.classList.remove("hidden");
  ui.addAiBtn.disabled = false;
  if (ui.copyInviteBtn) ui.copyInviteBtn.disabled = false;
  if (ui.leaveGroupBtn) ui.leaveGroupBtn.disabled = false;

  if (previousGroupId && previousGroupId !== group.id) {
    socket.emit("group:leave-room", previousGroupId);
  }
  socket.emit("group:join-room", group.id);
  await joinActiveGroupIfNeeded();
  await loadMessages(group.id);
  await loadAiMembers(group.id);
  await loadGroups();
}

async function joinActiveGroupIfNeeded() {
  if (!activeGroupId || !currentUsername) return;
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroupId)}/join`, {
      method: "POST",
      body: JSON.stringify({ username: currentUsername })
    });
  } catch (_error) {
    // Group could be deleted; UI refresh handles consistency.
  }
}

async function joinGroupFromInvite(groupId) {
  if (!ensureName()) return;
  await api(`/api/groups/${encodeURIComponent(groupId)}/join`, {
    method: "POST",
    body: JSON.stringify({ username: currentUsername })
  });
  inviteGroupId = "";
  const url = new URL(window.location.href);
  url.searchParams.delete("group");
  window.history.replaceState({}, "", url.toString());
  await loadGroups(groupId);
}

async function loadMessages(groupId) {
  const messages = await api(`/api/groups/${encodeURIComponent(groupId)}/messages`);
  ui.messageList.innerHTML = "";
  for (const message of messages) appendMessage(message);
}

async function loadAiMembers(groupId) {
  const aiMembers = await api(`/api/groups/${encodeURIComponent(groupId)}/ai-members`);
  ui.aiMemberList.innerHTML = "";
  for (const aiMember of aiMembers) {
    const li = document.createElement("li");
    li.textContent = `${aiMember.name} - ${aiMember.model}`;
    ui.aiMemberList.appendChild(li);
  }
}

function appendMessage(message) {
  const isMe =
    message.senderType === "human" &&
    currentUsername &&
    message.senderName?.toLowerCase() === currentUsername.toLowerCase();
  const initials = String(message.senderName || "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const row = document.createElement("div");
  row.className = `message ${isMe ? "me" : ""}`;
  const created = new Date(message.createdAt);
  const time = Number.isNaN(created.getTime()) ? "" : created.toLocaleTimeString();
  const aiBadge = message.senderType === "ai" ? `<span class="badge-ai">AI</span>` : "";
  row.innerHTML = `
    ${isMe ? "" : `<div class="message-avatar ${message.senderType === "ai" ? "ai" : ""}">${escapeHtml(initials)}</div>`}
    <div class="message-body">
      <div class="meta">
        <span class="sender">${escapeHtml(message.senderName)}</span>
        ${aiBadge}
        <span>${escapeHtml(time)}</span>
      </div>
      <div class="bubble ${message.senderType === "ai" ? "ai" : "human"}">${escapeHtml(message.text || "")}</div>
    </div>
  `;
  ui.messageList.appendChild(row);
  ui.messageList.scrollTop = ui.messageList.scrollHeight;
}

function refreshUiForName() {
  const hasName = Boolean(currentUsername);
  ui.saveNameBtn.textContent = hasName ? "Update" : "Save";
  ui.messageForm.classList.toggle("hidden", !hasName || !activeGroupId);
  ui.addAiBtn.disabled = !hasName || !activeGroupId;
  if (ui.copyInviteBtn) ui.copyInviteBtn.disabled = !hasName || !activeGroupId;
  if (ui.leaveGroupBtn) ui.leaveGroupBtn.disabled = !hasName || !activeGroupId;
  if (ui.profileName && hasName) ui.profileName.textContent = currentUsername;
}

function ensureName() {
  if (currentUsername) return true;
  window.alert("Set your name first.");
  return false;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    let message = "Request failed";
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch (_error) {}
    throw new Error(message);
  }

  return response.json();
}

if (ui.searchInput) {
  ui.searchInput.addEventListener("input", () => {
    loadGroups(activeGroupId).catch(() => {});
  });
}

if (inviteGroupId && currentUsername) {
  joinGroupFromInvite(inviteGroupId).catch(() => {});
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
