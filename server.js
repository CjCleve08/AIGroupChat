require("dotenv").config({ override: true });

const express = require("express");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

initializeFirebaseAdmin();

const db = admin.firestore();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "";
const OPENROUTER_SITE_NAME = process.env.OPENROUTER_SITE_NAME || "AI Group Chat";
const OPENROUTER_ROUTER_MODEL = process.env.OPENROUTER_ROUTER_MODEL || "openai/gpt-4o-mini";
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/firebase-config", (_req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_WEB_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
    appId: process.env.FIREBASE_APP_ID || ""
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(OPENROUTER_API_KEY),
    firebaseConfigured: Boolean(process.env.FIREBASE_PROJECT_ID)
  });
});

app.post("/api/generate-personality", requireAuth, wrapAsync(async (req, res) => {
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.startsWith("your_")) {
    return res.status(503).json({ error: "AI not configured" });
  }
  const name = String(req.body?.name || "").trim();
  const description = String(req.body?.description || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });

  const prompt = [
    "Generate a group-chat character card for someone named \"" + name + "\".",
    description ? "User description: " + description : "Invent a distinct, believable personality.",
    "",
    "Return ONLY a JSON object with these exact keys (short strings, no newlines inside values):",
    "personality (e.g. sarcastic, funny, rarely serious)",
    "textingStyle (e.g. lowercase, short messages, uses lol and bro)",
    "groupRole (e.g. the instigator who makes jokes)",
    "rules (semicolon-separated, e.g. rarely more than 1 sentence; sometimes ignores messages)",
    "persona (one sentence overall description for the AI)"
  ].join("\n");

  const raw = await requestOpenRouterCompletion({
    model: OPENROUTER_ROUTER_MODEL,
    temperature: 0.8,
    prompt
  });

  const parsed = parseGeneratedPersonality(raw);
  if (!parsed) {
    return res.status(502).json({ error: "Could not generate personality" });
  }
  res.json(parsed);
}));

function parseGeneratedPersonality(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  try {
    const json = JSON.parse(trimmed);
    return {
      personality: String(json.personality || "").trim().slice(0, 400),
      textingStyle: String(json.textingStyle || "").trim().slice(0, 400),
      groupRole: String(json.groupRole || "").trim().slice(0, 200),
      rules: String(json.rules || "").trim().slice(0, 800),
      persona: String(json.persona || "").trim().slice(0, 500)
    };
  } catch (_e) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const json = JSON.parse(match[0]);
        return {
          personality: String(json.personality || "").trim().slice(0, 400),
          textingStyle: String(json.textingStyle || "").trim().slice(0, 400),
          groupRole: String(json.groupRole || "").trim().slice(0, 200),
          rules: String(json.rules || "").trim().slice(0, 800),
          persona: String(json.persona || "").trim().slice(0, 500)
        };
      } catch (_e2) {}
    }
  }
  return null;
}

app.get("/api/groups", requireAuth, wrapAsync(async (req, res) => {
  const snapshot = await groupsCollection()
    .where("memberIds", "array-contains", req.user.uid)
    .limit(150)
    .get();
  const rows = snapshot.docs
    .map((doc) => toGroupSummary(doc.id, doc.data()))
    .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
  res.json(rows);
}));

app.post("/api/groups", requireAuth, wrapAsync(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const id = randomUUID();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const displayName = getDisplayName(req, req.user);

  const payload = {
    id,
    name: name || `New Group ${String(nowMs).slice(-4)}`,
    ownerId: req.user.uid,
    ownerName: displayName,
    createdAt: nowIso,
    createdAtMs: nowMs,
    updatedAt: nowIso,
    updatedAtMs: nowMs,
    memberCount: 1,
    aiCount: 0,
    totalCount: 1,
    memberIds: [req.user.uid]
  };

  await groupRef(id).set(payload);
  await memberRef(id, req.user.uid).set({
    uid: req.user.uid,
    name: displayName,
    joinedAt: nowIso,
    joinedAtMs: nowMs,
    isOwner: true
  });

  res.status(201).json(toGroupSummary(id, payload));
}));

app.patch("/api/groups/:groupId", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const cleanName = String(req.body?.name || "").trim().slice(0, 80);
  if (!cleanName) {
    return res.status(400).json({ error: "name is required" });
  }

  const group = await getGroup(groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  if (!group.memberIds.includes(req.user.uid)) {
    return res.status(403).json({ error: "only members can rename this group" });
  }

  await groupRef(groupId).update({
    name: cleanName,
    updatedAt: new Date().toISOString(),
    updatedAtMs: Date.now()
  });

  const updated = await getGroup(groupId);
  res.json(toGroupSummary(groupId, updated));
}));

app.post("/api/groups/:groupId/join", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const displayName = getDisplayName(req, req.user);

  const result = await db.runTransaction(async (tx) => {
    const groupSnap = await tx.get(groupRef(groupId));
    if (!groupSnap.exists) return { status: 404 };
    const group = groupSnap.data();
    const memberDocRef = memberRef(groupId, req.user.uid);
    const memberSnap = await tx.get(memberDocRef);

    tx.set(
      memberDocRef,
      {
        uid: req.user.uid,
        name: displayName,
        joinedAt: memberSnap.exists ? memberSnap.data()?.joinedAt || nowIso : nowIso,
        joinedAtMs: memberSnap.exists ? memberSnap.data()?.joinedAtMs || nowMs : nowMs,
        isOwner: req.user.uid === group.ownerId
      },
      { merge: true }
    );

    if (!memberSnap.exists) {
      tx.update(groupRef(groupId), {
        memberIds: admin.firestore.FieldValue.arrayUnion(req.user.uid),
        memberCount: admin.firestore.FieldValue.increment(1),
        totalCount: admin.firestore.FieldValue.increment(1),
        updatedAt: nowIso,
        updatedAtMs: nowMs
      });
    }
    return { status: 200 };
  });

  if (result.status === 404) return res.status(404).json({ error: "group not found" });

  const group = await getGroup(groupId);
  res.json(toGroupSummary(groupId, group));
}));

app.get("/api/groups/:groupId/participants", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const group = await getGroup(groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  if (!group.memberIds.includes(req.user.uid)) return res.status(403).json({ error: "join group first" });

  const [members, aiMembers] = await Promise.all([listMembers(groupId), listAiMembers(groupId)]);

  res.json({
    ownerId: group.ownerId,
    ownerName: group.ownerName,
    members: members.map((member) => ({
      uid: member.uid,
      name: member.name,
      isOwner: member.uid === group.ownerId
    })),
    aiMembers
  });
}));

app.post("/api/groups/:groupId/remove-member", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const memberId = String(req.body?.memberId || "").trim();
  if (!memberId) return res.status(400).json({ error: "memberId is required" });

  const result = await db.runTransaction(async (tx) => {
    const groupSnap = await tx.get(groupRef(groupId));
    if (!groupSnap.exists) return { status: 404 };
    const group = groupSnap.data();
    if (group.ownerId !== req.user.uid) return { status: 403, error: "only the group owner can remove members" };
    if (group.ownerId === memberId) return { status: 400, error: "owner cannot be removed" };

    const memberDocRef = memberRef(groupId, memberId);
    const memberSnap = await tx.get(memberDocRef);
    if (!memberSnap.exists) return { status: 404, error: "member not found" };

    tx.delete(memberDocRef);
    tx.update(groupRef(groupId), {
      memberIds: admin.firestore.FieldValue.arrayRemove(memberId),
      memberCount: admin.firestore.FieldValue.increment(-1),
      totalCount: admin.firestore.FieldValue.increment(-1),
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now()
    });
    return { status: 200 };
  });

  if (result.status !== 200) return res.status(result.status).json({ error: result.error || "request failed" });

  const group = await getGroup(groupId);
  if (!group) return res.json({ removed: true, groupDeleted: true });
  res.json({ removed: true, group: toGroupSummary(groupId, group) });
}));

app.post("/api/groups/:groupId/remove-ai", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const aiId = String(req.body?.aiId || "").trim();
  if (!aiId) return res.status(400).json({ error: "aiId is required" });

  const group = await getGroup(groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  if (group.ownerId !== req.user.uid) {
    return res.status(403).json({ error: "only the group owner can remove AI members" });
  }

  const aiDocRef = aiMemberRef(groupId, aiId);
  const aiSnap = await aiDocRef.get();
  if (!aiSnap.exists) return res.status(404).json({ error: "ai member not found" });

  await db.runTransaction(async (tx) => {
    tx.delete(aiDocRef);
    tx.update(groupRef(groupId), {
      aiCount: admin.firestore.FieldValue.increment(-1),
      totalCount: admin.firestore.FieldValue.increment(-1),
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now()
    });
  });

  const updated = await getGroup(groupId);
  res.json({ removed: true, group: toGroupSummary(groupId, updated) });
}));

app.post("/api/groups/:groupId/leave", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const uid = req.user.uid;

  const result = await db.runTransaction(async (tx) => {
    const groupDocRef = groupRef(groupId);
    const groupSnap = await tx.get(groupDocRef);
    if (!groupSnap.exists) return { status: 404 };
    const group = groupSnap.data();

    const memberDocRef = memberRef(groupId, uid);
    const memberSnap = await tx.get(memberDocRef);
    if (!memberSnap.exists) return { status: 400, error: "not in group" };

    tx.delete(memberDocRef);
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    const currentMemberCount = Number(group.memberCount || 0);
    if (currentMemberCount <= 1) {
      tx.delete(groupDocRef);
      return { status: 200, deleted: true };
    }

    tx.update(groupDocRef, {
      memberIds: admin.firestore.FieldValue.arrayRemove(uid),
      memberCount: admin.firestore.FieldValue.increment(-1),
      totalCount: admin.firestore.FieldValue.increment(-1),
      updatedAt: nowIso,
      updatedAtMs: nowMs
    });

    return { status: 200, deleted: false, ownerChanged: group.ownerId === uid };
  });

  if (result.status === 404) return res.status(404).json({ error: "group not found" });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error || "request failed" });

  if (result.deleted) {
    await deleteGroupSubcollections(groupId);
    return res.json({ removed: true, groupDeleted: true });
  }

  if (result.ownerChanged) {
    const members = await listMembers(groupId);
    const nextOwner = members.sort((a, b) => String(a.name).localeCompare(String(b.name)))[0];
    if (nextOwner) {
      await groupRef(groupId).update({
        ownerId: nextOwner.uid,
        ownerName: nextOwner.name || "User",
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now()
      });
    }
  }

  const updated = await getGroup(groupId);
  res.json({ removed: true, groupDeleted: false, group: toGroupSummary(groupId, updated) });
}));

app.get("/api/groups/:groupId/messages", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const group = await getGroup(groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  if (!group.memberIds.includes(req.user.uid)) return res.status(403).json({ error: "join group first" });

  const snapshot = await messagesCollection(groupId).orderBy("createdAtMs", "desc").limit(150).get();
  const messages = snapshot.docs.map((doc) => doc.data()).reverse();
  res.json(messages);
}));

app.post("/api/groups/:groupId/messages", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });

  const group = await getGroup(groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  if (!group.memberIds.includes(req.user.uid)) return res.status(403).json({ error: "join group first" });

  const nowMs = Date.now();
  const message = {
    id: randomUUID(),
    senderType: "human",
    senderId: req.user.uid,
    senderName: getDisplayName(req, req.user),
    text: text.slice(0, 4000),
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs
  };

  await messagesCollection(groupId).doc(message.id).set(message);
  await groupRef(groupId).update({
    updatedAt: message.createdAt,
    updatedAtMs: message.createdAtMs
  });

  emitGroupMessage(groupId, message);
  triggerAiReplies(groupId, message, { turnsRemaining: 2 }).catch((error) => {
    console.error("AI reply generation failed:", error);
  });

  res.status(201).json(message);
}));

app.get("/api/groups/:groupId/ai-members", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const group = await getGroup(groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  if (!group.memberIds.includes(req.user.uid)) return res.status(403).json({ error: "join group first" });
  res.json(await listAiMembers(groupId));
}));

app.post("/api/groups/:groupId/ai-members", requireAuth, wrapAsync(async (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const group = await getGroup(groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  if (group.ownerId !== req.user.uid) {
    return res.status(403).json({ error: "only group owner can add AI members" });
  }

  const name = String(req.body?.name || "").trim();
  const persona = String(req.body?.persona || "").trim();
  const personality = String(req.body?.personality || "").trim();
  const textingStyle = String(req.body?.textingStyle || "").trim();
  const groupRole = String(req.body?.groupRole || "").trim();
  const rules = String(req.body?.rules || "").trim();
  const relationships = String(req.body?.relationships || "").trim();
  const model = String(req.body?.model || "").trim() || "openai/gpt-4o-mini";
  const temperature = clampNumber(req.body?.temperature, 0, 2, 1);
  if (!name || !model) {
    return res.status(400).json({ error: "name and model are required" });
  }
  if (!persona && !personality) {
    return res.status(400).json({ error: "persona or personality is required" });
  }

  const nowMs = Date.now();
  const aiMember = {
    id: randomUUID(),
    name: name.slice(0, 40),
    persona: persona.slice(0, 1600),
    personality: personality.slice(0, 400),
    textingStyle: textingStyle.slice(0, 400),
    groupRole: groupRole.slice(0, 200),
    rules: rules.slice(0, 800),
    relationships: relationships.slice(0, 400),
    model,
    temperature,
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs
  };

  await aiMemberRef(groupId, aiMember.id).set(aiMember);
  await groupRef(groupId).update({
    aiCount: admin.firestore.FieldValue.increment(1),
    totalCount: admin.firestore.FieldValue.increment(1),
    updatedAt: aiMember.createdAt,
    updatedAtMs: aiMember.createdAtMs
  });
  res.status(201).json(aiMember);
}));

app.use((error, _req, res, _next) => {
  const code = Number(error?.code);
  if (code === 5) {
    return res.status(500).json({
      error:
        "Firestore not found for this project. Create a Firestore database in Firebase Console (Build -> Firestore Database) and verify FIREBASE_PROJECT_ID/service account match."
    });
  }

  console.error("API error:", error);
  return res.status(500).json({ error: "Internal server error" });
});

io.on("connection", (socket) => {
  socket.on("group:join-room", (groupId) => {
    if (!groupId) return;
    socket.join(String(groupId));
  });

  socket.on("group:leave-room", (groupId) => {
    if (!groupId) return;
    socket.leave(String(groupId));
  });

  socket.on("typing:start", ({ groupId, senderName } = {}) => {
    const room = String(groupId || "").trim();
    const name = String(senderName || "").trim();
    if (!room || !name) return;
    socket.to(room).emit("typing:start", { groupId: room, senderName: name });
  });

  socket.on("typing:stop", ({ groupId, senderName } = {}) => {
    const room = String(groupId || "").trim();
    const name = String(senderName || "").trim();
    if (!room || !name) return;
    socket.to(room).emit("typing:stop", { groupId: room, senderName: name });
  });
});

server.listen(PORT, () => {
  console.log(`AI Group Chat listening on port ${PORT}`);
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.startsWith("your_")) {
    console.warn("OPENROUTER_API_KEY is missing or placeholder. AI replies are disabled.");
  }
  if (!process.env.FIREBASE_PROJECT_ID) {
    console.warn("FIREBASE_PROJECT_ID is missing. Firebase Auth/Firestore calls will fail.");
  }
});

function groupsCollection() {
  return db.collection("groups");
}

function groupRef(groupId) {
  return groupsCollection().doc(groupId);
}

function membersCollection(groupId) {
  return groupRef(groupId).collection("members");
}

function memberRef(groupId, uid) {
  return membersCollection(groupId).doc(uid);
}

function messagesCollection(groupId) {
  return groupRef(groupId).collection("messages");
}

function aiMembersCollection(groupId) {
  return groupRef(groupId).collection("ai_members");
}

function aiMemberRef(groupId, aiId) {
  return aiMembersCollection(groupId).doc(aiId);
}

async function getGroup(groupId) {
  const snap = await groupRef(groupId).get();
  return snap.exists ? snap.data() : null;
}

async function listMembers(groupId) {
  const snapshot = await membersCollection(groupId).orderBy("name", "asc").get();
  return snapshot.docs.map((doc) => doc.data());
}

async function listAiMembers(groupId) {
  const snapshot = await aiMembersCollection(groupId).orderBy("createdAtMs", "asc").get();
  return snapshot.docs.map((doc) => doc.data());
}

async function listRecentMessages(groupId, limit = 30) {
  const snapshot = await messagesCollection(groupId).orderBy("createdAtMs", "desc").limit(limit).get();
  return snapshot.docs.map((doc) => doc.data()).reverse();
}

function toGroupSummary(id, group) {
  const memberCount = Number(group?.memberCount || 0);
  const aiCount = Number(group?.aiCount || 0);
  return {
    id,
    name: group?.name || "Untitled Group",
    ownerId: group?.ownerId || "",
    ownerName: group?.ownerName || "Owner",
    createdAt: group?.createdAt || "",
    createdAtMs: Number(group?.createdAtMs || 0),
    memberCount,
    aiCount,
    totalCount: Number(group?.totalCount || memberCount + aiCount)
  };
}

function emitGroupMessage(groupId, message) {
  io.to(groupId).emit("message:new", { groupId, message });
}

function wrapAsync(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function shouldAiReply(aiMember, latestMessage, recentMessages) {
  const name = String(aiMember?.name || "").trim().toLowerCase();
  if (!name) return false;
  const text = String(latestMessage?.text || "").toLowerCase();
  const mentioned = new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text);
  if (mentioned) return Math.random() < 0.98;
  if (latestMessage?.senderType === "ai") return Math.random() < 0.65;
  return Math.random() < 0.75;
}

function buildCharacterCardPrompt(aiMember, context, latestMessage) {
  const name = aiMember.name || "AI";
  const hasCard =
    aiMember.personality ||
    aiMember.textingStyle ||
    aiMember.groupRole ||
    aiMember.rules ||
    aiMember.relationships;
  const parts = [
    `You are "${name}" in a private friend group chat.`,
    "",
    "You are NOT an AI assistant. You are a normal person in a group chat with friends.",
    "Do not be overly helpful or explain things. Keep responses short, like real texting.",
    "When you reply, actually engage—don't leave people hanging mid-conversation. Keep the chat going.",
    "",
    "Write like a real person texting friends (e.g. teenager or friend group).",
    "Use lowercase sometimes. Keep messages short. Use occasional slang. Sometimes send a single word or two.",
    "Do not sound like an assistant. Do not explain things. Do not be polite like customer support.",
    "Use emojis rarely if at all; most real texts don't have emojis in every message.",
    "",
    "Good: bro what / no way / wait fr?? / lmao / thats wild / nah / rip",
    "Bad (avoid): That's interesting! How was your day today? I'd be happy to help! That's a great question!",
    "",
    "Rules:",
    "- Reply naturally and conversationally. Stay in character.",
    "- Keep to 1-4 sentences unless more is needed.",
    "- You can agree, disagree, or challenge when it fits.",
    "- Reply to humans or other AI like a normal group member.",
    "",
    "Recent conversation:",
    context,
    "",
    `Latest message from ${latestMessage.senderName}: ${latestMessage.text}`,
    "",
    "Return only your next reply as plain text, nothing else."
  ];

  if (hasCard) {
    const card = [];
    if (aiMember.personality) card.push(`Personality: ${aiMember.personality}`);
    if (aiMember.textingStyle) card.push(`Texting style: ${aiMember.textingStyle}`);
    if (aiMember.groupRole) card.push(`Group role: ${aiMember.groupRole}`);
    if (aiMember.rules) card.push(`Your rules:\n${aiMember.rules}`);
    if (aiMember.relationships) card.push(`Your relationships / how you act with others: ${aiMember.relationships}`);
    parts.splice(
      2,
      0,
      "Character card:",
      card.join("\n"),
      ""
    );
  } else if (aiMember.persona) {
    parts.splice(2, 0, "Persona:", aiMember.persona, "");
  }

  return parts.join("\n");
}

async function triggerAiReplies(groupId, latestMessage, options = {}) {
  if (!OPENROUTER_API_KEY) return;
  const turnsRemaining = Number(options.turnsRemaining || 0);
  if (turnsRemaining <= 0) return;

  const [group, aiMembers, recentMessages, humanMembers] = await Promise.all([
    getGroup(groupId),
    listAiMembers(groupId),
    listRecentMessages(groupId, 30),
    listMembers(groupId)
  ]);
  if (!group || !aiMembers.length) return;

  const humanNames = (humanMembers || []).map((m) => m.name).filter(Boolean);
  const aiNames = (aiMembers || []).map((a) => a.name).filter(Boolean);
  const memberList = [...humanNames, ...aiNames].join(", ") || "unknown";
  const conversationContext = recentMessages
    .map((m) => `${m.senderName} [${m.senderType}]: ${m.text}`)
    .join("\n");
  const context = `Group chat members: ${memberList}\n\nRecent conversation:\n${conversationContext}`;

  const lastTwoAiSenders = recentMessages
    .slice(-2)
    .filter((m) => m.senderType === "ai")
    .map((m) => m.senderName);
  const excludedNames =
    latestMessage.senderType === "ai"
      ? [...new Set([latestMessage.senderName, ...lastTwoAiSenders])]
      : lastTwoAiSenders;
  const excludedSet = new Set(excludedNames.map((n) => String(n).toLowerCase().trim()));

  const responders = await selectRespondingAiMembers({
    aiMembers,
    recentContext: context,
    latestMessage: latestMessage.text,
    latestSender: latestMessage.senderName,
    latestSenderType: latestMessage.senderType,
    excludedNames
  });
  const fallbackCandidates = aiMembers.filter(
    (ai) => !excludedSet.has(String(ai.name || "").toLowerCase().trim())
  );
  let fallbackResponders = [];
  if (!responders.length) {
    if (latestMessage.senderType === "ai") {
      fallbackResponders = chooseFallbackAiResponders(fallbackCandidates, latestMessage.senderName, latestMessage.text);
    } else if (fallbackCandidates.length && Math.random() < 0.85) {
      const idx = Math.floor(Math.random() * fallbackCandidates.length);
      fallbackResponders = [fallbackCandidates[idx]];
    }
  }
  let activeResponders = responders.length ? responders : fallbackResponders;
  activeResponders = activeResponders.filter((ai) =>
    shouldAiReply(ai, latestMessage, recentMessages)
  );
  if (activeResponders.length > 2) {
    const shuffled = [...activeResponders].sort(() => Math.random() - 0.5);
    activeResponders = shuffled.slice(0, 2);
  }
  if (!activeResponders.length && latestMessage.senderType === "human" && fallbackCandidates.length) {
    const idx = Math.floor(Math.random() * fallbackCandidates.length);
    activeResponders = [fallbackCandidates[idx]];
  }
  if (!activeResponders.length) return;

  let lastAiMessage = null;
  await Promise.all(
    activeResponders.map(async (aiMember) => {
      const prompt = buildCharacterCardPrompt(aiMember, context, latestMessage);

      const reply = await requestOpenRouterCompletion({
        model: aiMember.model,
        temperature: aiMember.temperature,
        prompt
      });
      const cleanReply = sanitizeAiReply(aiMember.name, reply);
      if (!cleanReply) return;

      await sleep(randomBetween(500, 2400));
      emitTyping(groupId, aiMember.name, true);
      await sleep(estimateTypingDurationMs(cleanReply));
      emitTyping(groupId, aiMember.name, false);

      const nowMs = Date.now();
      const aiMessage = {
        id: randomUUID(),
        senderType: "ai",
        senderName: aiMember.name,
        text: cleanReply.slice(0, 4000),
        createdAt: new Date(nowMs).toISOString(),
        createdAtMs: nowMs
      };
      await messagesCollection(groupId).doc(aiMessage.id).set(aiMessage);
      await groupRef(groupId).update({
        updatedAt: aiMessage.createdAt,
        updatedAtMs: aiMessage.createdAtMs
      });
      emitGroupMessage(groupId, aiMessage);
      lastAiMessage = aiMessage;
    })
  );

  if (lastAiMessage && turnsRemaining > 1) {
    await sleep(randomBetween(400, 1400));
    await triggerAiReplies(groupId, lastAiMessage, { turnsRemaining: turnsRemaining - 1 });
  }
}

async function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "missing auth token" });

  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.user = {
      uid: decoded.uid,
      email: decoded.email || "",
      name: decoded.name || ""
    };
    next();
  } catch (_error) {
    res.status(401).json({ error: "invalid auth token" });
  }
}

function getDisplayName(req, user) {
  const bodyName = String(req.body?.displayName || "").trim();
  if (bodyName) return bodyName.slice(0, 32);
  const tokenName = String(user?.name || "").trim();
  return (tokenName || "User").slice(0, 32);
}

async function deleteGroupSubcollections(groupId) {
  await deleteCollection(membersCollection(groupId));
  await deleteCollection(aiMembersCollection(groupId));
  await deleteCollection(messagesCollection(groupId));
}

async function deleteCollection(collectionRef, batchSize = 250) {
  let hasMore = true;
  while (hasMore) {
    const snapshot = await collectionRef.limit(batchSize).get();
    if (snapshot.empty) {
      hasMore = false;
      continue;
    }
    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    hasMore = snapshot.size === batchSize;
  }
}

function initializeFirebaseAdmin() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  const serviceJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  const serviceBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "";

  let credential = admin.credential.applicationDefault();
  if (serviceJson) {
    credential = admin.credential.cert(JSON.parse(serviceJson));
  } else if (serviceBase64) {
    credential = admin.credential.cert(JSON.parse(Buffer.from(serviceBase64, "base64").toString("utf8")));
  }

  admin.initializeApp({
    credential,
    projectId: projectId || undefined
  });
}

async function selectRespondingAiMembers({
  aiMembers,
  recentContext,
  latestMessage,
  latestSender,
  latestSenderType = "human",
  excludedNames = []
}) {
  const mentionedNames = findMentionedAiNames(latestMessage, aiMembers);
  const excluded = new Set(excludedNames.map((name) => String(name || "").toLowerCase().trim()));
  const roster = aiMembers.map((ai) => ({
    name: ai.name,
    persona: ai.persona
  }));

  const prompt = [
    "You are selecting which chat companions should reply to a new message.",
    "Return JSON only, with format: {\"responders\":[\"Name1\",\"Name2\"]}",
    "Rules:",
    "- When a human sends a message, almost always include at least one responder. Do not leave them without a reply—keep the conversation going.",
    "- When the message is a question, joke, story, or needs a reaction, include at least one responder. When in doubt, include 1 responder.",
    "- Include anyone who would naturally react (laugh, agree, disagree, or have something to add).",
    "- If a specific AI is directly addressed by name, include that AI.",
    "- If the latest sender is AI and the message contains a claim/question/opinion/disagreement, select at least one OTHER AI responder.",
    "- Return an empty array only when the message is truly one that no one would respond to (e.g. a typo correction, very minor aside).",
    "- Prefer 1-2 responders. Use names exactly as listed.",
    "",
    `Latest sender type: ${latestSenderType}`,
    `Latest sender: ${latestSender}`,
    `Latest message: ${latestMessage}`,
    "",
    "AI roster:",
    JSON.stringify(roster),
    "",
    "Recent conversation:",
    recentContext
  ].join("\n");

  const raw = await requestOpenRouterCompletion({
    model: OPENROUTER_ROUTER_MODEL,
    temperature: 0.2,
    prompt
  });

  const names = parseResponderNames(raw);
  const wanted = new Set(
    [...names, ...mentionedNames]
      .map((name) => String(name || "").toLowerCase().trim())
      .filter(Boolean)
  );
  if (!wanted.size) return [];

  return aiMembers.filter((ai) => {
    const normalized = String(ai.name).toLowerCase();
    return wanted.has(normalized) && !excluded.has(normalized);
  });
}

function chooseFallbackAiResponders(aiMembers, latestSender, latestText) {
  const candidates = aiMembers.filter(
    (ai) => String(ai.name || "").toLowerCase() !== String(latestSender || "").toLowerCase()
  );
  if (!candidates.length) return [];

  const signal = getContinuationSignal(latestText, candidates);
  const continueChance = signal.strong ? 0.98 : signal.medium ? 0.88 : 0.45;
  if (Math.random() > continueChance) return [];

  // If strong signal, sometimes allow two AIs to keep momentum.
  const maxPicks = signal.strong && candidates.length > 1 ? 2 : 1;
  const picks = [];
  const remaining = [...candidates];
  const pickCount = randomBetween(1, Math.min(maxPicks, remaining.length));
  for (let i = 0; i < pickCount; i += 1) {
    const idx = randomBetween(0, remaining.length - 1);
    picks.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return picks;
}

function getContinuationSignal(latestText, candidates) {
  const text = String(latestText || "").toLowerCase().trim();
  if (!text) return { strong: false, medium: false };

  const mentionsOtherAi = candidates.some((ai) =>
    text.includes(String(ai.name || "").toLowerCase())
  );
  const question = /[?]/.test(text);
  const disagreement = /\b(but|however|disagree|wrong|actually|no,|not really|counterpoint)\b/i.test(text);
  const opinionOrClaim = /\b(i think|i believe|in my view|should|must|best|because|therefore)\b/i.test(text);
  const longPoint = text.length > 80;
  const hasReactionHook = /\b(lol|omg|haha|wtf|bruh|damn|wild|crazy|same|fr|right)\b/i.test(text) || /[!.]$/.test(text);

  const strong = mentionsOtherAi || question || disagreement || (opinionOrClaim && longPoint);
  const medium = opinionOrClaim || longPoint || hasReactionHook;
  return { strong, medium };
}

function parseResponderNames(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed?.responders)) {
      return parsed.responders
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    }
  } catch (_error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed?.responders)) {
          return parsed.responders
            .map((value) => String(value || "").trim())
            .filter(Boolean);
        }
      } catch (_ignored) {}
    }
  }

  return [];
}

function findMentionedAiNames(message, aiMembers) {
  const text = String(message || "");
  const lowered = text.toLowerCase();
  return aiMembers
    .map((ai) => String(ai.name || "").trim())
    .filter((name) => {
      if (!name) return false;
      const pattern = new RegExp(`\\b${escapeRegExp(name.toLowerCase())}\\b`, "i");
      return pattern.test(lowered);
    });
}

function sanitizeAiReply(aiName, rawReply) {
  let reply = String(rawReply || "").trim();
  if (!reply) return "";

  reply = stripSpeakerPrefix(reply, aiName);
  // Remove prefixed first-line speaker labels in multiline outputs.
  const lines = reply.split("\n");
  if (lines.length) {
    lines[0] = sanitizeFirstLineSpeaker(lines[0], aiName);
    reply = lines.join("\n").trim();
  }
  reply = reply.replace(/^["']+|["']+$/g, "").trim();
  return reply;
}

function sanitizeFirstLineSpeaker(line, aiName) {
  return stripSpeakerPrefix(String(line || ""), aiName);
}

function stripSpeakerPrefix(input, aiName = "") {
  let value = String(input || "").trim();
  if (!value) return "";

  const escapedName = escapeRegExp(String(aiName || ""));
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

function estimateTypingDurationMs(text) {
  const chars = String(text || "").length;
  const cps = randomBetween(4, 8); // characters per second
  const seconds = chars / cps;
  return clampNumber(Math.round(seconds * 1000), 900, 14000, 1800);
}

function emitTyping(groupId, senderName, isTyping) {
  io.to(groupId).emit(isTyping ? "typing:start" : "typing:stop", {
    groupId,
    senderName
  });
}

function randomBetween(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function requestOpenRouterCompletion({ model, temperature, prompt }) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": OPENROUTER_SITE_URL,
      "X-Title": OPENROUTER_SITE_NAME
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    const body = await safeText(response);
    console.error("OpenRouter request failed:", response.status, body);
    return "";
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  return typeof content === "string" ? content.trim() : "";
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function safeText(response) {
  try {
    return await response.text();
  } catch (_error) {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
