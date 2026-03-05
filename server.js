require("dotenv").config({ override: true });

const express = require("express");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");

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

const groups = new Map();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    groups: groups.size,
    aiConfigured: Boolean(OPENROUTER_API_KEY)
  });
});

app.get("/api/groups", (_req, res) => {
  const username = String(_req.query.username || "").trim();
  if (!username) return res.json([]);

  const payload = Array.from(groups.values())
    .filter((group) => {
      return group.members.has(username);
    })
    .map(toGroupSummary);
  res.json(payload);
});

app.post("/api/groups", (req, res) => {
  const { name, username } = req.body || {};
  const cleanName = String(name || "").trim();
  const cleanUser = String(username || "").trim();
  if (!cleanUser) {
    return res.status(400).json({ error: "username is required" });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const group = {
    id,
    name: cleanName || `New Group ${groups.size + 1}`,
    ownerName: cleanUser,
    createdAt: now,
    members: new Set([cleanUser]),
    aiMembers: [],
    messages: []
  };
  groups.set(id, group);
  res.status(201).json(toGroupSummary(group));
});

app.patch("/api/groups/:groupId", (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: "group not found" });

  const username = String(req.body?.username || "").trim();
  const name = String(req.body?.name || "").trim();
  if (!username || !name) {
    return res.status(400).json({ error: "username and name are required" });
  }
  if (!group.members.has(username)) {
    return res.status(403).json({ error: "only members can rename this group" });
  }

  group.name = name.slice(0, 80);
  res.json(toGroupSummary(group));
});

app.post("/api/groups/:groupId/join", (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: "group not found" });

  const username = String(req.body?.username || "").trim();
  if (!username) return res.status(400).json({ error: "username is required" });
  group.members.add(username);
  res.json(toGroupSummary(group));
});

app.post("/api/groups/:groupId/leave", (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: "group not found" });

  const username = String(req.body?.username || "").trim();
  if (!username) return res.status(400).json({ error: "username is required" });
  if (!group.members.has(username)) return res.status(400).json({ error: "not in group" });

  group.members.delete(username);

  if (!group.members.size) {
    groups.delete(group.id);
    return res.json({ removed: true, groupDeleted: true });
  }

  if (group.ownerName === username) {
    group.ownerName = Array.from(group.members).sort()[0];
  }

  return res.json({ removed: true, groupDeleted: false, group: toGroupSummary(group) });
});

app.get("/api/groups/:groupId/messages", (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  res.json(group.messages.slice(-150));
});

app.post("/api/groups/:groupId/messages", async (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: "group not found" });

  const username = String(req.body?.username || "").trim();
  const text = String(req.body?.text || "").trim();
  if (!username || !text) {
    return res.status(400).json({ error: "username and text are required" });
  }
  if (!group.members.has(username)) {
    return res.status(403).json({ error: "join group first" });
  }

  const message = {
    id: randomUUID(),
    senderType: "human",
    senderName: username,
    text: text.slice(0, 4000),
    createdAt: new Date().toISOString()
  };

  pushMessage(group, message);
  emitGroupMessage(group.id, message);
  triggerAiReplies(group, message, { turnsRemaining: MAX_AI_CHAIN_TURNS }).catch((error) => {
    console.error("AI reply generation failed:", error);
  });

  res.status(201).json(message);
});

app.get("/api/groups/:groupId/ai-members", (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: "group not found" });
  res.json(group.aiMembers);
});

app.post("/api/groups/:groupId/ai-members", (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: "group not found" });

  const {
    ownerName,
    name,
    persona,
    model = "openai/gpt-4o-mini",
    temperature = 1
  } = req.body || {};

  if (String(ownerName || "").trim() !== group.ownerName) {
    return res.status(403).json({ error: "only group owner can add AI members" });
  }

  const aiName = String(name || "").trim();
  const aiPersona = String(persona || "").trim();
  const aiModel = String(model || "").trim();
  if (!aiName || !aiPersona || !aiModel) {
    return res.status(400).json({ error: "name, persona, and model are required" });
  }

  const aiMember = {
    id: randomUUID(),
    name: aiName,
    persona: aiPersona,
    model: aiModel,
    temperature: clampNumber(temperature, 0, 2, 1),
    createdAt: new Date().toISOString()
  };

  group.aiMembers.push(aiMember);
  res.status(201).json(aiMember);
});

io.on("connection", (socket) => {
  socket.on("group:join-room", (groupId) => {
    if (!groups.has(groupId)) return;
    socket.join(groupId);
  });

  socket.on("group:leave-room", (groupId) => {
    if (!groupId) return;
    socket.leave(groupId);
  });

  socket.on("typing:start", ({ groupId, senderName } = {}) => {
    const room = String(groupId || "").trim();
    const name = String(senderName || "").trim();
    if (!room || !name || !groups.has(room)) return;
    socket.to(room).emit("typing:start", { groupId: room, senderName: name });
  });

  socket.on("typing:stop", ({ groupId, senderName } = {}) => {
    const room = String(groupId || "").trim();
    const name = String(senderName || "").trim();
    if (!room || !name || !groups.has(room)) return;
    socket.to(room).emit("typing:stop", { groupId: room, senderName: name });
  });
});

server.listen(PORT, () => {
  console.log(`AI Group Chat listening on port ${PORT}`);
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.startsWith("your_")) {
    console.warn("OPENROUTER_API_KEY is missing or placeholder. AI replies are disabled.");
  }
});

function toGroupSummary(group) {
  return {
    id: group.id,
    name: group.name,
    ownerName: group.ownerName,
    createdAt: group.createdAt,
    memberCount: group.members.size,
    aiCount: group.aiMembers.length,
    totalCount: group.members.size + group.aiMembers.length
  };
}

function pushMessage(group, message) {
  group.messages.push(message);
  if (group.messages.length > 300) {
    group.messages.splice(0, group.messages.length - 300);
  }
}

function emitGroupMessage(groupId, message) {
  io.to(groupId).emit("message:new", { groupId, message });
}

async function triggerAiReplies(group, latestMessage, options = {}) {
  if (!group.aiMembers.length) return;
  if (!OPENROUTER_API_KEY) return;
  const turnsRemaining = Number(options.turnsRemaining || 0);
  if (turnsRemaining <= 0) return;

  const context = group.messages
    .slice(-30)
    .map((m) => `${m.senderName} [${m.senderType}]: ${m.text}`)
    .join("\n");

  const responders = await selectRespondingAiMembers({
    aiMembers: group.aiMembers,
    recentContext: context,
    latestMessage: latestMessage.text,
    latestSender: latestMessage.senderName,
    latestSenderType: latestMessage.senderType,
    excludedNames: latestMessage.senderType === "ai" ? [latestMessage.senderName] : []
  });
  const fallbackResponders =
    !responders.length && latestMessage.senderType === "ai"
      ? chooseFallbackAiResponders(group.aiMembers, latestMessage.senderName, latestMessage.text)
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
      emitTyping(group.id, aiMember.name, true);
      await sleep(estimateTypingDurationMs(cleanReply));
      emitTyping(group.id, aiMember.name, false);

      const aiMessage = {
        id: randomUUID(),
        senderType: "ai",
        senderName: aiMember.name,
        text: cleanReply.slice(0, 4000),
        createdAt: new Date().toISOString()
      };
      pushMessage(group, aiMessage);
      emitGroupMessage(group.id, aiMessage);
      lastAiMessage = aiMessage;
    })
  );

  // Allow short AI-to-AI chains so bots can continue/argue naturally.
  if (lastAiMessage && turnsRemaining > 1) {
    await sleep(randomBetween(400, 1400));
    await triggerAiReplies(group, lastAiMessage, { turnsRemaining: turnsRemaining - 1 });
  }
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

  // Remove common speaker prefixes like: Parker:, Parker [ai]:, **Parker**:
  const patterns = [
    new RegExp(
      `^(?:\\*\\*)?${escapeRegExp(aiName)}(?:\\*\\*)?\\s*(?:\\[(?:ai|bot|assistant)\\])?\\s*[:\\-–—]\\s*`,
      "i"
    ),
    /^[A-Za-z0-9 _.'’-]{1,50}\s*\[(?:ai|bot|assistant)\]\s*[:\-–—]\s*/i,
    /^(?:ai|bot|assistant)\s*[:\-–—]\s*/i
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      if (pattern.test(reply)) {
        reply = reply.replace(pattern, "").trim();
        changed = true;
      }
    }
  }
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
  let value = String(line || "").trim();
  const escapedName = escapeRegExp(aiName);
  const linePatterns = [
    new RegExp(
      `^(?:\\*\\*)?${escapedName}(?:\\*\\*)?\\s*(?:\\[(?:ai|bot|assistant)\\])?\\s*[:\\-–—]\\s*`,
      "i"
    ),
    /^[A-Za-z0-9 _.'’-]{1,50}\s*\[(?:ai|bot|assistant)\]\s*[:\-–—]\s*/i
  ];
  for (const pattern of linePatterns) {
    value = value.replace(pattern, "").trim();
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
