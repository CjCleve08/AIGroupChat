import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  getMultiFactorResolver,
  TotpMultiFactorGenerator,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const socket = io();

const ui = {
  appShell: document.getElementById("appShell"),
  signInScreen: document.getElementById("signInScreen"),
  googleSignInBtn: document.getElementById("googleSignInBtn"),
  emailSignInForm: document.getElementById("emailSignInForm"),
  emailInput: document.getElementById("emailInput"),
  passwordInput: document.getElementById("passwordInput"),
  mfaPrompt: document.getElementById("mfaPrompt"),
  mfaCodeInput: document.getElementById("mfaCodeInput"),
  emailSignUpForm: document.getElementById("emailSignUpForm"),
  signUpEmailInput: document.getElementById("signUpEmailInput"),
  signUpPasswordInput: document.getElementById("signUpPasswordInput"),
  profileBtn: document.getElementById("profileBtn"),
  searchBtn: document.getElementById("searchBtn"),
  sidebarToggleBtn: document.getElementById("sidebarToggleBtn"),
  profileModal: document.getElementById("profileModal"),
  profileForm: document.getElementById("profileForm"),
  profileNameInput: document.getElementById("profileNameInput"),
  profileAvatarInput: document.getElementById("profileAvatarInput"),
  cancelProfileBtn: document.getElementById("cancelProfileBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
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
  aiDescriptionInput: document.getElementById("aiDescriptionInput"),
  generatePersonalityBtn: document.getElementById("generatePersonalityBtn"),
  aiPersonaInput: document.getElementById("aiPersonaInput"),
  aiPersonalityInput: document.getElementById("aiPersonalityInput"),
  aiTextingStyleInput: document.getElementById("aiTextingStyleInput"),
  aiGroupRoleInput: document.getElementById("aiGroupRoleInput"),
  aiRulesInput: document.getElementById("aiRulesInput"),
  aiRelationshipsInput: document.getElementById("aiRelationshipsInput"),
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

let firebaseAuth = null;
let authProvider = null;
let pendingMfaResolver = null;
let currentUserId = "";
let currentUsername = "";
let currentAvatarUrl = "";
let activeGroupId = null;
let activeGroupName = "";
let activeGroupOwner = "";
let activeGroupOwnerId = "";
let inviteGroupId = new URLSearchParams(window.location.search).get("group") || "";
let groupSearchQuery = "";
const typingNames = new Set();
let humanTypingActive = false;
let typingStopTimer = null;
let activeDialogResolver = null;
refreshUiForName();
syncProfileUi();
setAuthUiVisibility(false);

ui.googleSignInBtn?.addEventListener("click", async () => {
  await startGoogleSignIn();
});

ui.switchToSignUpBtn = document.getElementById("switchToSignUpBtn");
ui.switchToSignInBtn = document.getElementById("switchToSignInBtn");

ui.switchToSignUpBtn?.addEventListener("click", () => {
  ui.emailSignInForm?.classList.add("hidden");
  ui.emailSignUpForm?.classList.remove("hidden");
  resetMfaState();
});

ui.switchToSignInBtn?.addEventListener("click", () => {
  ui.emailSignUpForm?.classList.add("hidden");
  ui.emailSignInForm?.classList.remove("hidden");
  resetMfaState();
});

ui.emailSignInForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await handleEmailSignIn();
});

ui.emailSignUpForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await handleEmailSignUp();
});

ui.profileBtn?.addEventListener("click", () => {
  if (!ensureAuth()) return;
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
  if (!ensureAuth()) return;

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

  const nextName = newName.slice(0, 32);
  const nextAvatar = String(ui.profileAvatarInput?.value || "").trim();
  await updateProfile(firebaseAuth.currentUser, {
    displayName: nextName,
    photoURL: nextAvatar || null
  });
  await firebaseAuth.currentUser.getIdToken(true);
  currentUsername = nextName;
  currentAvatarUrl = nextAvatar;

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

ui.signOutBtn?.addEventListener("click", async () => {
  if (!firebaseAuth) return;
  await signOut(firebaseAuth);
  closeProfileModal();
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
  if (!ensureAuth()) return;
  try {
    const generatedName = `New Group ${Date.now().toString().slice(-4)}`;
    const group = await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: generatedName })
    });
    await loadGroups(group.id);
  } catch (error) {
    await showDialog({
      title: "Unable to Create Group",
      message: error?.message || "Please verify Firebase/Firestore setup and try again.",
      mode: "alert",
      confirmText: "OK"
    });
  }
});

ui.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensureAuth() || !activeGroupId) return;
  stopHumanTyping();
  const text = ui.messageInput.value.trim();
  if (!text) return;
  await api(`/api/groups/${encodeURIComponent(activeGroupId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, displayName: currentUsername })
  });
  ui.messageInput.value = "";
});

ui.generatePersonalityBtn?.addEventListener("click", async () => {
  if (!ensureAuth()) return;
  const name = ui.aiNameInput?.value?.trim() || "";
  if (!name) {
    await showDialog({
      title: "Name required",
      message: "Enter the AI name first, then click Generate personality.",
      mode: "alert",
      confirmText: "OK"
    });
    return;
  }
  const description = ui.aiDescriptionInput?.value?.trim() || "";
  if (ui.generatePersonalityBtn) ui.generatePersonalityBtn.disabled = true;
  try {
    const data = await api("/api/generate-personality", {
      method: "POST",
      body: JSON.stringify({ name, description })
    });
    if (data.personality && ui.aiPersonalityInput) ui.aiPersonalityInput.value = data.personality;
    if (data.textingStyle && ui.aiTextingStyleInput) ui.aiTextingStyleInput.value = data.textingStyle;
    if (data.groupRole && ui.aiGroupRoleInput) ui.aiGroupRoleInput.value = data.groupRole;
    if (data.rules && ui.aiRulesInput) ui.aiRulesInput.value = data.rules;
    if (data.persona && ui.aiPersonaInput) ui.aiPersonaInput.value = data.persona;
  } catch (error) {
    await showDialog({
      title: "Generation failed",
      message: error?.message || "Could not generate personality. Try again.",
      mode: "alert",
      confirmText: "OK"
    });
  } finally {
    if (ui.generatePersonalityBtn) ui.generatePersonalityBtn.disabled = false;
  }
});

ui.addAiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensureAuth() || !activeGroupId) return;

  const name = ui.aiNameInput.value.trim();
  const persona = ui.aiPersonaInput.value.trim();
  const personality = ui.aiPersonalityInput?.value?.trim() || "";
  const textingStyle = ui.aiTextingStyleInput?.value?.trim() || "";
  const groupRole = ui.aiGroupRoleInput?.value?.trim() || "";
  const rules = ui.aiRulesInput?.value?.trim() || "";
  const relationships = ui.aiRelationshipsInput?.value?.trim() || "";
  const model = ui.aiModelInput.value.trim();
  const temperature = Number(ui.aiTemperatureInput.value);

  if (!persona && !personality) {
    await showDialog({
      title: "Persona or personality required",
      message: "Fill in Persona and/or Personality so the AI has a character.",
      mode: "alert",
      confirmText: "OK"
    });
    return;
  }

  await api(`/api/groups/${encodeURIComponent(activeGroupId)}/ai-members`, {
    method: "POST",
    body: JSON.stringify({
      name,
      persona,
      personality,
      textingStyle,
      groupRole,
      rules,
      relationships,
      model,
      temperature
    })
  });

  ui.aiNameInput.value = "";
  ui.aiPersonaInput.value = "";
  if (ui.aiPersonalityInput) ui.aiPersonalityInput.value = "";
  if (ui.aiTextingStyleInput) ui.aiTextingStyleInput.value = "";
  if (ui.aiGroupRoleInput) ui.aiGroupRoleInput.value = "";
  if (ui.aiRulesInput) ui.aiRulesInput.value = "";
  if (ui.aiRelationshipsInput) ui.aiRelationshipsInput.value = "";
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
  if (!ensureAuth({ silent: true })) {
    ui.groupList.innerHTML = "";
    return;
  }

  const groups = await api("/api/groups");
  const visibleGroups = groups.filter((g) => g.name.toLowerCase().includes(groupSearchQuery));
  ui.groupList.innerHTML = "";
  for (const group of visibleGroups) {
    const li = document.createElement("li");
    li.classList.toggle("active", group.id === activeGroupId);
    const canManageGroup = String(group.ownerId || "") === currentUserId;
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
        if (!ensureAuth()) return;
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
          body: JSON.stringify({ name: clean })
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
        if (!ensureAuth()) return;
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
          body: JSON.stringify({})
        });

        if (activeGroupId === group.id) {
          socket.emit("group:leave-room", group.id);
          activeGroupId = null;
          activeGroupName = "";
          activeGroupOwner = "";
          activeGroupOwnerId = "";
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
  activeGroupOwnerId = String(group.ownerId || "");
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

  ui.messageList.innerHTML = "";
  ui.messageList.classList.add("loading");
  showMessageListLoading(true);

  if (previousGroupId && previousGroupId !== group.id) {
    socket.emit("group:leave-room", previousGroupId);
  }
  socket.emit("group:join-room", group.id);

  const switchedGroupId = group.id;
  await Promise.all([
    joinActiveGroupIfNeeded(),
    loadMessages(switchedGroupId),
    loadAiMembers(switchedGroupId)
  ]);

  if (activeGroupId === switchedGroupId) {
    showMessageListLoading(false);
    ui.messageList.classList.remove("loading");
  }
  loadGroups().catch(() => {});
}

async function joinActiveGroupIfNeeded() {
  if (!activeGroupId || !ensureAuth({ silent: true })) return;
  try {
    await api(`/api/groups/${encodeURIComponent(activeGroupId)}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: currentUsername })
    });
  } catch (_error) {
    // Group could be deleted; UI refresh handles consistency.
  }
}

async function joinGroupFromInvite(groupId) {
  if (!ensureAuth()) return;
  await api(`/api/groups/${encodeURIComponent(groupId)}/join`, {
    method: "POST",
    body: JSON.stringify({ displayName: currentUsername })
  });
  inviteGroupId = "";
  const url = new URL(window.location.href);
  url.searchParams.delete("group");
  window.history.replaceState({}, "", url.toString());
  await loadGroups(groupId);
}

function showMessageListLoading(show) {
  if (!ui.messageList) return;
  const existing = ui.messageList.querySelector(".message-list-loading");
  if (existing) existing.remove();
  if (show) {
    const el = document.createElement("div");
    el.className = "message-list-loading";
    el.textContent = "Loading...";
    ui.messageList.appendChild(el);
  }
}

async function loadMessages(groupId) {
  const messages = await api(`/api/groups/${encodeURIComponent(groupId)}/messages`);
  if (activeGroupId !== groupId) return;
  ui.messageList.innerHTML = "";
  for (const message of messages) appendMessage(message);
}

async function loadAiMembers(groupId) {
  await api(`/api/groups/${encodeURIComponent(groupId)}/ai-members`);
}

function appendMessage(message) {
  const isMe =
    message.senderType === "human" &&
    ((message.senderId && message.senderId === currentUserId) ||
      (currentUsername && message.senderName?.toLowerCase() === currentUsername.toLowerCase()));
  const initials = getInitials(message.senderName);
  const cleanText =
    message.senderType === "ai"
      ? sanitizeIncomingAiMessageText(message.senderName, message.text)
      : String(message.text || "");
  const row = document.createElement("div");
  row.className = `message ${isMe ? "me" : ""}`;
  const created = new Date(message.createdAt);
  const time = Number.isNaN(created.getTime()) ? "" : created.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
  if (!activeGroupId || !currentUsername || !ensureAuth({ silent: true })) return;

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
  const hasAuth = Boolean(currentUserId);
  ui.messageForm.classList.toggle("hidden", !hasName || !activeGroupId || !hasAuth);
  ui.addAiBtn.disabled = !hasName || !activeGroupId || !hasAuth || !isGroupOwner();
  if (ui.addPersonBtn) ui.addPersonBtn.disabled = !hasName || !activeGroupId || !hasAuth;
  if (ui.addAiModalBtn) {
    const allowAiButton = hasName && hasAuth && !!activeGroupId && isGroupOwner();
    ui.addAiModalBtn.disabled = !allowAiButton;
    ui.addAiModalBtn.classList.toggle("hidden", !allowAiButton);
  }
}

function ensureAuth(options = {}) {
  const { silent = false } = options;
  if (currentUserId && firebaseAuth?.currentUser) return true;
  if (!silent) {
    setAuthUiVisibility(false);
  }
  return false;
}

async function api(url, options = {}) {
  const skipAuth = Boolean(options.skipAuth);
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (!skipAuth) {
    if (!ensureAuth()) throw new Error("Please sign in first.");
    const token = await firebaseAuth.currentUser.getIdToken();
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    headers,
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

function syncProfileUi() {
  if (ui.profileNameInput) ui.profileNameInput.value = currentUsername;
  if (ui.profileAvatarInput) ui.profileAvatarInput.value = currentAvatarUrl;
  if (ui.signOutBtn) ui.signOutBtn.classList.toggle("hidden", !currentUserId);
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
  ui.membersModal?.classList.remove("hidden");
  if (ui.memberList) {
    ui.memberList.innerHTML = "<li class=\"members-loading\">Loading...</li>";
  }

  let payload;
  try {
    payload = await api(`/api/groups/${encodeURIComponent(activeGroupId)}/participants`);
  } catch (_err) {
    if (ui.memberList) ui.memberList.innerHTML = "<li class=\"members-loading\">Could not load members.</li>";
    return;
  }

  activeGroupOwner = String(payload.ownerName || activeGroupOwner || "");
  activeGroupOwnerId = String(payload.ownerId || activeGroupOwnerId || "");
  const canManageGroup = isGroupOwner();

  if (ui.memberList) {
    ui.memberList.innerHTML = "";
    const unified = [
      ...(payload.members || []).map((member) => ({
        id: `human:${member.uid}`,
        uid: member.uid,
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
            await removeMember(member.uid, member.name);
          } else {
            await removeAiMember(member.aiId, member.name);
          }
        });
      }
      ui.memberList.appendChild(li);
    }
  }
}

function closeMembersModal() {
  ui.membersModal?.classList.add("hidden");
}

async function removeMember(memberId, memberName) {
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
    body: JSON.stringify({ memberId })
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
    body: JSON.stringify({ aiId })
  });
  await loadGroups(activeGroupId);
  await openMembersModal();
}

function isGroupOwner() {
  return Boolean(currentUserId) && String(activeGroupOwnerId || "") === String(currentUserId);
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

function setAuthUiVisibility(isSignedIn) {
  ui.appShell?.classList.toggle("hidden", !isSignedIn);
  ui.signInScreen?.classList.toggle("hidden", isSignedIn);
}

async function initAuthAndData() {
  try {
    const firebaseConfig = await api("/api/firebase-config", { skipAuth: true });
    if (!firebaseConfig?.projectId || !firebaseConfig?.apiKey) {
      throw new Error("Firebase web config is missing on the server.");
    }

    const firebaseApp = initializeApp(firebaseConfig);
    firebaseAuth = getAuth(firebaseApp);
    authProvider = new GoogleAuthProvider();

    onAuthStateChanged(firebaseAuth, async (user) => {
      if (!user) {
        resetMfaState();
        currentUserId = "";
        currentUsername = "";
        currentAvatarUrl = "";
        activeGroupId = null;
        activeGroupName = "";
        activeGroupOwner = "";
        activeGroupOwnerId = "";
        typingNames.clear();
        ui.groupList.innerHTML = "";
        ui.messageList.innerHTML = "";
        ui.activeGroupTitle.textContent = "Select a conversation";
        ui.activeGroupSubtext.textContent = "Choose a group to start chatting";
        closeProfileModal();
        closeAiModal();
        closeMembersModal();
        refreshUiForName();
        syncProfileUi();
        setAuthUiVisibility(false);
        return;
      }

      currentUserId = user.uid;
      currentUsername = String(user.displayName || user.email || "User").slice(0, 32);
      currentAvatarUrl = String(user.photoURL || "");
      setAuthUiVisibility(true);
      refreshUiForName();
      syncProfileUi();

      try {
        await loadGroups(inviteGroupId || activeGroupId || undefined);
        if (inviteGroupId) {
          await joinGroupFromInvite(inviteGroupId);
        }
      } catch (error) {
        await showDialog({
          title: "Firebase Setup Required",
          message: error?.message || "Unable to load groups from Firestore.",
          mode: "alert",
          confirmText: "OK"
        });
      }
    });
  } catch (error) {
    await showDialog({
      title: "Firebase Setup Required",
      message: error.message || "Unable to initialize Firebase.",
      mode: "alert",
      confirmText: "OK"
    });
  }
}

function resetMfaState() {
  pendingMfaResolver = null;
  ui.mfaPrompt?.classList.add("hidden");
  if (ui.mfaCodeInput) ui.mfaCodeInput.value = "";
  const submitBtn = ui.emailSignInForm?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = "Sign in";
}

async function handleEmailSignIn() {
  if (!firebaseAuth) return;
  if (pendingMfaResolver) {
    await handleMfaVerification();
    return;
  }
  const email = String(ui.emailInput?.value || "").trim();
  const password = String(ui.passwordInput?.value || "");
  if (!email || !password) return;
  const btn = ui.emailSignInForm?.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    await signInWithEmailAndPassword(firebaseAuth, email, password);
    resetMfaState();
  } catch (error) {
    if (error?.code === "auth/multi-factor-auth-required") {
      pendingMfaResolver = getMultiFactorResolver(firebaseAuth, error);
      const totpHint = pendingMfaResolver.hints?.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
      if (totpHint) {
        ui.mfaPrompt?.classList.remove("hidden");
        ui.mfaCodeInput?.focus();
        const submitBtn = ui.emailSignInForm?.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.textContent = "Verify";
      } else {
        await showDialog({
          title: "2FA Required",
          message: "Your account uses a second factor not supported here (e.g. SMS). Please use Google sign-in or an authenticator app if you have TOTP enabled.",
          mode: "alert",
          confirmText: "OK"
        });
        pendingMfaResolver = null;
      }
    } else {
      await showDialog({
        title: "Sign In Failed",
        message: error?.message || "Invalid email or password.",
        mode: "alert",
        confirmText: "OK"
      });
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleMfaVerification() {
  if (!pendingMfaResolver) return;
  const code = String(ui.mfaCodeInput?.value || "").replace(/\D/g, "");
  if (!code || code.length < 6) {
    await showDialog({
      title: "Invalid Code",
      message: "Please enter the 6-digit code from your authenticator app.",
      mode: "alert",
      confirmText: "OK"
    });
    return;
  }
  const totpHint = pendingMfaResolver.hints?.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  if (!totpHint) {
    resetMfaState();
    return;
  }
  const btn = ui.emailSignInForm?.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const assertion = TotpMultiFactorGenerator.assertionForSignIn(totpHint.uid, code);
    await pendingMfaResolver.resolveSignIn(assertion);
    resetMfaState();
  } catch (error) {
    await showDialog({
      title: "Verification Failed",
      message: error?.message || "Invalid or expired code. Please try again.",
      mode: "alert",
      confirmText: "OK"
    });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleEmailSignUp() {
  if (!firebaseAuth) return;
  const email = String(ui.signUpEmailInput?.value || "").trim();
  const password = String(ui.signUpPasswordInput?.value || "");
  if (!email || !password || password.length < 6) {
    await showDialog({
      title: "Invalid Input",
      message: "Email and password (min 6 characters) are required.",
      mode: "alert",
      confirmText: "OK"
    });
    return;
  }
  const btn = ui.emailSignUpForm?.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    await createUserWithEmailAndPassword(firebaseAuth, email, password);
    ui.emailSignUpForm?.classList.add("hidden");
    ui.emailSignInForm?.classList.remove("hidden");
    ui.emailInput.value = email;
    ui.passwordInput.value = "";
  } catch (error) {
    await showDialog({
      title: "Sign Up Failed",
      message: error?.message || "Unable to create account.",
      mode: "alert",
      confirmText: "OK"
    });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function startGoogleSignIn() {
  if (!firebaseAuth || !authProvider) return;
  if (ui.googleSignInBtn) ui.googleSignInBtn.disabled = true;
  try {
    await signInWithPopup(firebaseAuth, authProvider);
    resetMfaState();
  } catch (error) {
    await showDialog({
      title: "Sign In Failed",
      message: error?.message || "Unable to sign in with Google right now.",
      mode: "alert",
      confirmText: "OK"
    });
  } finally {
    if (ui.googleSignInBtn) ui.googleSignInBtn.disabled = false;
  }
}

initAuthAndData();
