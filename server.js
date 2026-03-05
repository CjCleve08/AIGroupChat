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
const MAX_AI_CHAIN_TURNS = clampNumber(process.env.MAX_AI_CHAIN_TURNS, 1, 12, 4);

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
  triggerAiReplies(groupId, message, { turnsRemaining: MAX_AI_CHAIN_TURNS }).catch((error) => {
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
  const model = String(req.body?.model || "").trim() || "openai/gpt-4o-mini";
  const temperature = clampNumber(req.body?.temperature, 0, 2, 1);
  if (!name || !persona || !model) {
    return res.status(400).json({ error: "name, persona, and model are required" });
  }

  const nowMs = Date.now();
  const aiMember = {
    id: randomUUID(),
    name: name.slice(0, 40),
    persona: persona.slice(0, 1600),
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

async function triggerAiReplies(groupId, latestMessage, options = {}) {
  if (!OPENROUTER_API_KEY) return;
  const turnsRemaining = Number(options.turnsRemaining || 0);
  if (turnsRemaining <= 0) return;

  const [group, aiMembers, recentMessages] = await Promise.all([
    getGroup(groupId),
    listAiMembers(groupId),
    listRecentMessages(groupId, 30)
  ]);
  if (!group || !aiMembers.length) return;

  const context = recentMessages
    .map((m) => `${m.senderName} [${m.senderType}]: ${m.text}`)
    .join("\n");

  const responders = await selectRespondingAiMembers({
    aiMembers,
    recentContext: context,
    latestMessage: latestMessage.text,
    latestSender: latestMessage.senderName,
    latestSenderType: latestMessage.senderType,
    excludedNames: latestMessage.senderType === "ai" ? [latestMessage.senderName] : []
  });
  const fallbackResponders =
    !responders.length && latestMessage.senderType === "ai"
      ? chooseFallbackAiResponders(aiMembers, latestMessage.senderName, latestMessage.text)
      : [];
  const activeResponders = responders.length ? responders : fallbackResponders;
  if (!activeResponders.length) return;

  let lastAiMessage = null;
  await Promise.all(
    activeResponders.map(async (aiMember) => {
      const prompt = [
        `You are "${aiMember.name}" in a private friend group chat.`,
        "You are an AI roleplaying as a normal participant with this persona:",
        aiMember.persona,
        "",
        "Rules:",
        "- Reply naturally and conversationally.",
        "- Keep to 1-4 sentences unless more detail is requested.",
        "- Stay in-character.",
        "- You can agree, disagree, or challenge points respectfully when it fits.",
        "- You may reply to humans or other AI participants like a normal group member.",
        "",
        "Recent conversation:",
        context,
        "",
        `Latest message from ${latestMessage.senderName}: ${latestMessage.text}`,
        "",
        "Return only your next reply message."
      ].join("\n");

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
    "- Choose only members who should naturally respond now.",
    "- If a specific AI is directly addressed by name, include that AI.",
    "- If the latest sender is AI and the message contains a claim/question/opinion/disagreement, select at least one OTHER AI responder.",
    "- Prefer responders with a different perspective or useful additional context.",
    "- It is valid to return an empty array if no AI should respond.",
    "- Prefer 0-2 responders unless more are clearly needed.",
    "- Use names exactly as listed.",
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
  const continueChance = signal.strong ? 0.98 : signal.medium ? 0.78 : 0.22;
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
  const longPoint = text.length > 120;

  const strong = mentionsOtherAi || question || disagreement || (opinionOrClaim && longPoint);
  const medium = opinionOrClaim || longPoint;
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
