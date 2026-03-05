const socket = io();

const ui = {
  profileBtn: document.getElementById("profileBtn"),
  searchBtn: document.getElementById("searchBtn"),
  sidebarToggleBtn: document.getElementById("sidebarToggleBtn"),
  profileModal: document.getElementById("profileModal"),
  profileForm: document.getElementById("profileForm"),
  profileNameInput: document.getElementById("profileNameInput"),
  profileAvatarInput: document.getElementById("profileAvatarInput"),
  cancelProfileBtn: document.getElementById("cancelProfileBtn"),
  createGroupForm: document.getElementById("createGroupForm"),
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
  aiModal: document.getElementById("aiModal"),
  cancelAiModalBtn: document.getElementById("cancelAiModalBtn"),
  addPersonBtn: document.getElementById("addPersonBtn"),
  addAiModalBtn: document.getElementById("addAiModalBtn"),
  dialogModal: document.getElementById("dialogModal"),
  dialogTitle: document.getElementById("dialogTitle"),
  dialogMessage: document.getElementById("dialogMessage"),
  dialogInput: document.getElementById("dialogInput"),
  dialogConfirmBtn: document.getElementById("dialogConfirmBtn"),
  dialogCancelBtn: document.getElementById("dialogCancelBtn"),
  membersModal: document.getElementById("membersModal"),
  memberList: document.getElementById("memberList"),
  closeMembersModalBtn: document.getElementById("closeMembersModalBtn")
};

let currentUsername = localStorage.getItem("aigc_username") || "";
let currentAvatarUrl = localStorage.getItem("aigc_avatar_url") || "";
let activeGroupId = null;
let activeGroupName = "";
let activeGroupOwner = "";
let inviteGroupId = new URLSearchParams(window.location.search).get("group") || "";
let groupSearchQuery = "";
const typingNames = new Set();
let humanTypingActive = false;
let typingStopTimer = null;
let activeDialogResolver = null;
refreshUiForName();
loadGroups(inviteGroupId || undefined);
syncProfileUi();

ui.profileBtn?.addEventListener("click", () => {
  openProfileModal();
});

ui.cancelProfileBtn?.addEventListener("click", () => {
  closeProfileModal();
});

ui.profileModal?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeModal === "true") {
    closeProfileModal();
  }
});

ui.aiModal?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeAiModal === "true") {
    closeAiModal();
  }
});

ui.cancelAiModalBtn?.addEventListener("click", () => {
  closeAiModal();
});

ui.membersModal?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeMembersModal === "true") {
    closeMembersModal();
  }
});

ui.closeMembersModalBtn?.addEventListener("click", () => {
  closeMembersModal();
});

ui.dialogModal?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeDialog === "true") {
    closeDialog(false);
  }
});

ui.dialogConfirmBtn?.addEventListener("click", () => closeDialog(true));
ui.dialogCancelBtn?.addEventListener("click", () => closeDialog(false));

ui.profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const newName = String(ui.profileNameInput?.value || "").trim();
  if (!newName) {
    await showDialog({
      title: "Missing Name",
      message: "Please enter a display name.",
      mode: "alert",
      confirmText: "OK"
    });
    return;
  }
  currentUsername = newName.slice(0, 32);
  currentAvatarUrl = String(ui.profileAvatarInput?.value || "").trim();
  localStorage.setItem("aigc_username", currentUsername);
  localStorage.setItem("aigc_avatar_url", currentAvatarUrl);
  closeProfileModal();
  refreshUiForName();
  syncProfileUi();
  if (activeGroupId) {
    await joinActiveGroupIfNeeded();
  } else if (inviteGroupId) {
    joinGroupFromInvite(inviteGroupId).catch((error) => {
      showDialog({
        title: "Invite Error",
        message: error.message || "Unable to join invite link.",
        mode: "alert",
        confirmText: "OK"
      });
    });
  }
  await loadGroups(activeGroupId || undefined);
});

ui.searchBtn?.addEventListener("click", async () => {
  const result = await showDialog({
    title: "Search Groups",
    message: "Enter a group name keyword.",
    mode: "prompt",
    defaultValue: groupSearchQuery,
    confirmText: "Search",
    cancelText: "Cancel",
    placeholder: "Type group name..."
  });
  if (!result.confirmed) return;
  groupSearchQuery = String(result.value || "").trim().toLowerCase();
  await loadGroups(activeGroupId || undefined);
});

ui.sidebarToggleBtn?.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  if (ui.sidebarToggleBtn) {
    ui.sidebarToggleBtn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    ui.sidebarToggleBtn.setAttribute("title", collapsed ? "Expand sidebar" : "Collapse sidebar");
  }
});

ui.createGroupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensureName()) return;
  const generatedName = `New Group ${Date.now().toString().slice(-4)}`;
  const group = await api("/api/groups", {
    method: "POST",
    body: JSON.stringify({ username: currentUsername, name: generatedName })
  });
  await loadGroups(group.id);
});

ui.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensureName() || !activeGroupId) return;
  stopHumanTyping();
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

  await api(`/api/groups/${encodeURIComponent(activeGroupId)}/ai-members`, {
    method: "POST",
    body: JSON.stringify({
      ownerName: currentUsername,
      name,
      persona,
      model,
      temperature
    })
  });

  ui.aiNameInput.value = "";
  ui.aiPersonaInput.value = "";
  await loadAiMembers(activeGroupId);
  await loadGroups(activeGroupId);
  closeAiModal();
});

ui.messageInput?.addEventListener("input", () => {
  handleHumanTypingInput();
});

ui.messageInput?.addEventListener("blur", () => {
  stopHumanTyping();
});

ui.addPersonBtn?.addEventListener("click", async () => {
  if (!activeGroupId) return;
  const inviteUrl = `${window.location.origin}/?group=${encodeURIComponent(activeGroupId)}`;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    await showDialog({
      title: "Invite Link Copied",
      message: "Share the invite link with a friend to add them to this group.",
      mode: "alert",
      confirmText: "OK"
    });
  } catch (_error) {
    await showDialog({
      title: "Share Invite Link",
      message: "Copy this invite link manually.",
      mode: "prompt",
      defaultValue: inviteUrl,
      confirmText: "Close",
      cancelText: "",
      placeholder: ""
    });
  }
});

ui.addAiModalBtn?.addEventListener("click", () => {
  if (!activeGroupId) return;
  if (!isGroupOwner()) return;
  openAiModal();
});

ui.activeGroupSubtext?.addEventListener("click", async () => {
  if (!activeGroupId) return;
  await openMembersModal();
});

socket.on("message:new", (payload) => {
  if (!activeGroupId) return;
  if (!payload || payload.groupId !== activeGroupId) return;
  typingNames.delete(payload.message?.senderName || "");
  renderTypingStatus();
  appendMessage(payload.message);
});

socket.on("typing:start", (payload) => {
  if (!activeGroupId) return;
  if (!payload || payload.groupId !== activeGroupId) return;
  const name = String(payload.senderName || "").trim();
  if (!name) return;
  typingNames.add(name);
  renderTypingStatus();
});

socket.on("typing:stop", (payload) => {
  if (!activeGroupId) return;
  if (!payload || payload.groupId !== activeGroupId) return;
  const name = String(payload.senderName || "").trim();
  if (!name) return;
  typingNames.delete(name);
  renderTypingStatus();
});

async function loadGroups(preferredGroupId) {
  const query = currentUsername ? `?username=${encodeURIComponent(currentUsername)}` : "";
  const groups = await api(`/api/groups${query}`);
  const visibleGroups = groups.filter((g) => g.name.toLowerCase().includes(groupSearchQuery));
  ui.groupList.innerHTML = "";
  for (const group of visibleGroups) {
    const li = document.createElement("li");
    li.classList.toggle("active", group.id === activeGroupId);
    const canManageGroup = isOwnerName(group.ownerName);
    li.innerHTML = `
      <div class="title">${escapeHtml(group.name)}</div>
      <span class="subline">${getTotalCount(group)}</span>
      ${canManageGroup ? '<button class="group-edit-btn" type="button" aria-label="Rename group" title="Rename group">✎</button>' : ""}
      <button class="group-leave-btn" type="button" aria-label="Leave group" title="Leave group">⎋</button>
    `;
    const editBtn = li.querySelector(".group-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!ensureName()) return;
        const result = await showDialog({
          title: "Rename Group",
          message: "Enter a new group name.",
          mode: "prompt",
          defaultValue: group.name,
          confirmText: "Save",
          cancelText: "Cancel",
          placeholder: "Group name"
        });
        if (!result.confirmed) return;
        const clean = String(result.value || "").trim();
        if (!clean) return;

        await api(`/api/groups/${encodeURIComponent(group.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ username: currentUsername, name: clean })
        });
        if (activeGroupId === group.id) {
          activeGroupName = clean;
          ui.activeGroupTitle.textContent = clean;
        }
        await loadGroups(group.id);
      });
    }
    const leaveBtn = li.querySelector(".group-leave-btn");
    if (leaveBtn) {
      leaveBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!ensureName()) return;
        const confirmation = await showDialog({
          title: "Leave Group",
          message: `Leave "${group.name}"?`,
          mode: "confirm",
          confirmText: "Leave",
          cancelText: "Cancel"
        });
        if (!confirmation.confirmed) return;

        await api(`/api/groups/${encodeURIComponent(group.id)}/leave`, {
          method: "POST",
          body: JSON.stringify({ username: currentUsername })
        });

        if (activeGroupId === group.id) {
          socket.emit("group:leave-room", group.id);
          activeGroupId = null;
          activeGroupName = "";
          activeGroupOwner = "";
          typingNames.clear();
          stopHumanTyping();
          closeMembersModal();
          ui.messageList.innerHTML = "";
          ui.activeGroupTitle.textContent = "Select a conversation";
          ui.activeGroupSubtext.textContent = "Choose a group to start chatting";
          renderTypingStatus();
          refreshUiForName();
        }
        await loadGroups();
      });
    }
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
  activeGroupOwner = String(group.ownerName || "");
  typingNames.clear();
  stopHumanTyping();
  ui.activeGroupTitle.textContent = group.name;
  ui.activeGroupSubtext.textContent = `${getTotalCount(group)} people`;
  ui.messageForm.classList.remove("hidden");
  const canManageGroup = isGroupOwner();
  ui.addAiBtn.disabled = !canManageGroup;
  if (ui.addPersonBtn) ui.addPersonBtn.disabled = false;
  if (ui.addAiModalBtn) {
    ui.addAiModalBtn.disabled = !canManageGroup;
    ui.addAiModalBtn.classList.toggle("hidden", !canManageGroup);
  }
  renderTypingStatus();

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
  await api(`/api/groups/${encodeURIComponent(groupId)}/ai-members`);
}

function appendMessage(message) {
  const isMe =
    message.senderType === "human" &&
    currentUsername &&
    message.senderName?.toLowerCase() === currentUsername.toLowerCase();
  const initials = getInitials(message.senderName);
  const cleanText =
    message.senderType === "ai"
      ? sanitizeIncomingAiMessageText(message.senderName, message.text)
      : String(message.text || "");
  const row = document.createElement("div");
  row.className = `message ${isMe ? "me" : ""}`;
  const created = new Date(message.createdAt);
  const time = Number.isNaN(created.getTime()) ? "" : created.toLocaleTimeString();
  row.innerHTML = `
    ${isMe ? "" : `<div class="message-avatar ${message.senderType === "ai" ? "ai" : ""}">${escapeHtml(initials)}</div>`}
    <div class="message-body">
      <div class="meta">
        <span class="sender">${escapeHtml(message.senderName)}</span>
        <span>${escapeHtml(time)}</span>
      </div>
      <div class="bubble ${message.senderType === "ai" ? "ai" : "human"}">${escapeHtml(cleanText)}</div>
    </div>
  `;
  ui.messageList.appendChild(row);
  renderTypingStatus();
  ui.messageList.scrollTop = ui.messageList.scrollHeight;
}

function renderTypingStatus() {
  if (!ui.messageList) return;

  const existing = ui.messageList.querySelectorAll(".typing-row");
  for (const node of existing) node.remove();

  const visibleTypingNames = Array.from(typingNames).filter(
    (name) => String(name || "").toLowerCase() !== String(currentUsername || "").toLowerCase()
  );
  if (!visibleTypingNames.length) return;

  for (const name of visibleTypingNames) {
    const row = document.createElement("div");
    row.className = "message typing-row";
    row.innerHTML = `
      <div class="message-avatar ai">${escapeHtml(getInitials(name))}</div>
      <div class="message-body">
        <div class="meta">
          <span class="sender">${escapeHtml(name)}</span>
        </div>
        <div class="bubble ai typing-bubble">
          <span class="typing-dots"><span></span><span></span><span></span></span>
        </div>
      </div>
    `;
    ui.messageList.appendChild(row);
  }
  ui.messageList.scrollTop = ui.messageList.scrollHeight;
}

function handleHumanTypingInput() {
  if (!activeGroupId || !currentUsername) return;

  if (!humanTypingActive) {
    humanTypingActive = true;
    socket.emit("typing:start", {
      groupId: activeGroupId,
      senderName: currentUsername
    });
  }

  if (typingStopTimer) clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    stopHumanTyping();
  }, 1200);
}

function stopHumanTyping() {
  if (typingStopTimer) {
    clearTimeout(typingStopTimer);
    typingStopTimer = null;
  }
  if (!humanTypingActive || !activeGroupId || !currentUsername) {
    humanTypingActive = false;
    return;
  }
  humanTypingActive = false;
  socket.emit("typing:stop", {
    groupId: activeGroupId,
    senderName: currentUsername
  });
}

function getTotalCount(group) {
  if (Number.isFinite(group?.totalCount)) return group.totalCount;
  const members = Number(group?.memberCount || 0);
  const ai = Number(group?.aiCount || 0);
  return members + ai;
}

function getInitials(name) {
  return String(name || "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function sanitizeIncomingAiMessageText(senderName, text) {
  return stripSpeakerPrefix(String(text || ""), String(senderName || ""));
}

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSpeakerPrefix(input, senderName = "") {
  let value = String(input || "").trim();
  if (!value) return "";

  const escapedName = escapeForRegex(String(senderName || ""));
  const genericLabel = "[A-Za-z0-9 _.'’-]{1,60}";
  const wrappers = '(?:\\s*(?:["\'`]+)?\\s*(?:\\*\\*)?\\s*)';
  const suffix = '(?:\\s*(?:\\*\\*)?\\s*(?:["\'`]+)?\\s*)';

  const patterns = [
    escapedName
      ? new RegExp(
          `^\\s*(?:[-*]\\s*)?${wrappers}${escapedName}${suffix}(?:\\[(?:ai|bot|assistant)\\])?\\s*[:\\-–—]\\s*`,
          "i"
        )
      : null,
    new RegExp(
      `^\\s*(?:[-*]\\s*)?${wrappers}${genericLabel}${suffix}\\[(?:ai|bot|assistant)\\]\\s*[:\\-–—]\\s*`,
      "i"
    ),
    new RegExp(
      `^\\s*(?:[-*]\\s*)?${wrappers}${genericLabel}${suffix}\\s*[:\\-–—]\\s*`,
      "i"
    ),
    /^(?:ai|bot|assistant)\s*[:\-–—]\s*/i
  ].filter(Boolean);

  let changed = true;
  let guard = 0;
  while (changed && guard < 6) {
    changed = false;
    guard += 1;
    for (const pattern of patterns) {
      if (pattern.test(value)) {
        value = value.replace(pattern, "").trim();
        changed = true;
      }
    }
  }
  return value;
}

function refreshUiForName() {
  const hasName = Boolean(currentUsername);
  ui.messageForm.classList.toggle("hidden", !hasName || !activeGroupId);
  ui.addAiBtn.disabled = !hasName || !activeGroupId || !isGroupOwner();
  if (ui.addPersonBtn) ui.addPersonBtn.disabled = !hasName || !activeGroupId;
  if (ui.addAiModalBtn) {
    const allowAiButton = hasName && !!activeGroupId && isGroupOwner();
    ui.addAiModalBtn.disabled = !allowAiButton;
    ui.addAiModalBtn.classList.toggle("hidden", !allowAiButton);
  }
}

function ensureName() {
  if (currentUsername) return true;
  openProfileModal();
  showDialog({
    title: "Profile Needed",
    message: "Set your profile name first.",
    mode: "alert",
    confirmText: "OK"
  });
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

function syncProfileUi() {
  if (ui.profileNameInput) ui.profileNameInput.value = currentUsername;
  if (ui.profileAvatarInput) ui.profileAvatarInput.value = currentAvatarUrl;
  if (ui.profileBtn) {
    ui.profileBtn.classList.add("profile-avatar");
    if (currentAvatarUrl) {
      ui.profileBtn.style.backgroundImage = `url("${currentAvatarUrl}")`;
      ui.profileBtn.textContent = "";
    } else {
      ui.profileBtn.style.backgroundImage = "";
      ui.profileBtn.textContent = getInitials(currentUsername || "ME");
    }
  }
}

function openProfileModal() {
  syncProfileUi();
  ui.profileModal?.classList.remove("hidden");
  ui.profileNameInput?.focus();
}

function closeProfileModal() {
  ui.profileModal?.classList.add("hidden");
}

function openAiModal() {
  ui.aiModal?.classList.remove("hidden");
  ui.aiNameInput?.focus();
}

function closeAiModal() {
  ui.aiModal?.classList.add("hidden");
}

async function openMembersModal() {
  const payload = await api(`/api/groups/${encodeURIComponent(activeGroupId)}/participants`);
  activeGroupOwner = String(payload.ownerName || activeGroupOwner || "");
  const canManageGroup = isGroupOwner();

  if (ui.memberList) {
    ui.memberList.innerHTML = "";
    const unified = [
      ...(payload.members || []).map((member) => ({
        id: `human:${member.name}`,
        name: member.name,
        isOwner: Boolean(member.isOwner),
        type: "human"
      })),
      ...(payload.aiMembers || []).map((ai) => ({
        id: `ai:${ai.id}`,
        aiId: ai.id,
        name: ai.name,
        isOwner: false,
        type: "ai"
      }))
    ].sort((a, b) => a.name.localeCompare(b.name));

    for (const member of unified) {
      const li = document.createElement("li");
      const ownerBadge = member.isOwner ? `<span class="badge">Owner</span>` : "";
      const removeBtn =
        canManageGroup && !member.isOwner
          ? `<button class="btn-danger remove-btn" data-participant-id="${escapeHtml(member.id)}">Remove</button>`
          : "";
      li.innerHTML = `
        <div>
          <span class="name">${escapeHtml(member.name)}</span>
          ${ownerBadge}
        </div>
        ${removeBtn}
      `;
      const button = li.querySelector("[data-participant-id]");
      if (button) {
        button.addEventListener("click", async () => {
          if (member.type === "human") {
            await removeMember(member.name);
          } else {
            await removeAiMember(member.aiId, member.name);
          }
        });
      }
      ui.memberList.appendChild(li);
    }
  }

  ui.membersModal?.classList.remove("hidden");
}

function closeMembersModal() {
  ui.membersModal?.classList.add("hidden");
}

async function removeMember(memberName) {
  if (!isGroupOwner()) return;
  closeMembersModal();
  const confirmation = await showDialog({
    title: "Remove Member",
    message: `Remove "${memberName}" from the group?`,
    mode: "confirm",
    confirmText: "Remove",
    cancelText: "Cancel"
  });
  if (!confirmation.confirmed) {
    await openMembersModal();
    return;
  }

  await api(`/api/groups/${encodeURIComponent(activeGroupId)}/remove-member`, {
    method: "POST",
    body: JSON.stringify({ username: currentUsername, memberName })
  });
  await loadGroups(activeGroupId);
  await openMembersModal();
}

async function removeAiMember(aiId, aiName) {
  if (!isGroupOwner()) return;
  closeMembersModal();
  const confirmation = await showDialog({
    title: "Remove AI",
    message: `Remove AI "${aiName}" from the group?`,
    mode: "confirm",
    confirmText: "Remove",
    cancelText: "Cancel"
  });
  if (!confirmation.confirmed) {
    await openMembersModal();
    return;
  }

  await api(`/api/groups/${encodeURIComponent(activeGroupId)}/remove-ai`, {
    method: "POST",
    body: JSON.stringify({ username: currentUsername, aiId })
  });
  await loadGroups(activeGroupId);
  await openMembersModal();
}

function isOwnerName(ownerName) {
  return String(ownerName || "").toLowerCase() === String(currentUsername || "").toLowerCase();
}

function isGroupOwner() {
  return isOwnerName(activeGroupOwner);
}

function showDialog({
  title = "Notice",
  message = "",
  mode = "alert",
  defaultValue = "",
  confirmText = "OK",
  cancelText = "Cancel",
  placeholder = ""
}) {
  return new Promise((resolve) => {
    activeDialogResolver = resolve;
    if (ui.dialogTitle) ui.dialogTitle.textContent = title;
    if (ui.dialogMessage) ui.dialogMessage.textContent = message;
    if (ui.dialogConfirmBtn) ui.dialogConfirmBtn.textContent = confirmText || "OK";
    if (ui.dialogCancelBtn) ui.dialogCancelBtn.textContent = cancelText || "Cancel";

    const promptMode = mode === "prompt";
    if (ui.dialogInput) {
      ui.dialogInput.classList.toggle("hidden", !promptMode);
      ui.dialogInput.value = String(defaultValue || "");
      ui.dialogInput.placeholder = placeholder || "";
      ui.dialogInput.readOnly = !promptMode && defaultValue !== "";
    }

    const showCancel = mode === "confirm" || (mode === "prompt" && cancelText !== "");
    if (ui.dialogCancelBtn) ui.dialogCancelBtn.classList.toggle("hidden", !showCancel);

    ui.dialogModal?.classList.remove("hidden");
    if (promptMode) ui.dialogInput?.focus();
  });
}

function closeDialog(confirmed) {
  if (!activeDialogResolver) return;
  const resolver = activeDialogResolver;
  activeDialogResolver = null;
  const value = ui.dialogInput ? ui.dialogInput.value : "";
  ui.dialogModal?.classList.add("hidden");
  resolver({ confirmed, value });
}
