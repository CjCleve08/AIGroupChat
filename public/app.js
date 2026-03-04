const socket = io();

const ui = {
  usernameInput: document.getElementById("usernameInput"),
  saveNameBtn: document.getElementById("saveNameBtn"),
  createGroupForm: document.getElementById("createGroupForm"),
  groupNameInput: document.getElementById("groupNameInput"),
  joinGroupForm: document.getElementById("joinGroupForm"),
  joinGroupIdInput: document.getElementById("joinGroupIdInput"),
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
  aiMemberList: document.getElementById("aiMemberList")
};

let currentUsername = localStorage.getItem("aigc_username") || "";
let activeGroupId = null;
ui.usernameInput.value = currentUsername;
refreshUiForName();
loadGroups();

ui.saveNameBtn.addEventListener("click", () => {
  const newName = ui.usernameInput.value.trim();
  if (!newName) {
    window.alert("Please enter a name.");
    return;
  }
  currentUsername = newName.slice(0, 32);
  localStorage.setItem("aigc_username", currentUsername);
  refreshUiForName();
  if (activeGroupId) joinActiveGroupIfNeeded();
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

ui.joinGroupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensureName()) return;
  const groupId = ui.joinGroupIdInput.value.trim();
  if (!groupId) return;
  await api(`/api/groups/${encodeURIComponent(groupId)}/join`, {
    method: "POST",
    body: JSON.stringify({ username: currentUsername })
  });
  ui.joinGroupIdInput.value = "";
  await loadGroups(groupId);
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

socket.on("message:new", (payload) => {
  if (!activeGroupId) return;
  if (!payload || payload.groupId !== activeGroupId) return;
  appendMessage(payload.message);
});

async function loadGroups(preferredGroupId) {
  const groups = await api("/api/groups");
  ui.groupList.innerHTML = "";
  for (const group of groups) {
    const li = document.createElement("li");
    li.classList.toggle("active", group.id === activeGroupId);
    li.innerHTML = `
      <strong>${escapeHtml(group.name)}</strong>
      <span class="subline">${escapeHtml(group.id)} | ${group.memberCount} members | ${group.aiCount} AI</span>
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
  if (!activeGroupId && groups[0]) await selectGroup(groups[0]);
}

async function selectGroup(group) {
  const previousGroupId = activeGroupId;
  activeGroupId = group.id;
  ui.activeGroupTitle.textContent = group.name;
  ui.activeGroupSubtext.textContent = `Group ID: ${group.id}`;
  ui.messageForm.classList.remove("hidden");
  ui.addAiBtn.disabled = false;

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
  const row = document.createElement("div");
  row.className = "message";
  const created = new Date(message.createdAt);
  const time = Number.isNaN(created.getTime()) ? "" : created.toLocaleTimeString();
  row.innerHTML = `
    <div class="meta">
      <span>${escapeHtml(message.senderName)} (${escapeHtml(message.senderType)})</span>
      <span>${escapeHtml(time)}</span>
    </div>
    <div>${escapeHtml(message.text || "")}</div>
  `;
  ui.messageList.appendChild(row);
  ui.messageList.scrollTop = ui.messageList.scrollHeight;
}

function refreshUiForName() {
  const hasName = Boolean(currentUsername);
  ui.saveNameBtn.textContent = hasName ? "Update" : "Save";
  ui.messageForm.classList.toggle("hidden", !hasName || !activeGroupId);
  ui.addAiBtn.disabled = !hasName || !activeGroupId;
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

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
