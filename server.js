require("dotenv").config();

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
  const payload = Array.from(groups.values()).map(toGroupSummary);
  res.json(payload);
});

app.post("/api/groups", (req, res) => {
  const { name, username } = req.body || {};
  const cleanName = String(name || "").trim();
  const cleanUser = String(username || "").trim();
  if (!cleanName || !cleanUser) {
    return res.status(400).json({ error: "name and username are required" });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const group = {
    id,
    name: cleanName,
    ownerName: cleanUser,
    createdAt: now,
    members: new Set([cleanUser]),
    aiMembers: [],
    messages: []
  };
  groups.set(id, group);
  res.status(201).json(toGroupSummary(group));
});

app.post("/api/groups/:groupId/join", (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: "group not found" });

  const username = String(req.body?.username || "").trim();
  if (!username) return res.status(400).json({ error: "username is required" });
  group.members.add(username);
  res.json(toGroupSummary(group));
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
  triggerAiReplies(group, message).catch((error) => {
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
    temperature = 1,
    responseDelayMs = 1200
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
    responseDelayMs: clampNumber(responseDelayMs, 0, 15000, 1200),
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
});

server.listen(PORT, () => {
  console.log(`AI Group Chat listening on port ${PORT}`);
  if (!OPENROUTER_API_KEY) {
    console.warn("OPENROUTER_API_KEY is missing. AI replies are disabled.");
  }
});

function toGroupSummary(group) {
  return {
    id: group.id,
    name: group.name,
    ownerName: group.ownerName,
    createdAt: group.createdAt,
    memberCount: group.members.size,
    aiCount: group.aiMembers.length
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

async function triggerAiReplies(group, humanMessage) {
  if (!group.aiMembers.length) return;
  if (!OPENROUTER_API_KEY) return;

  const context = group.messages
    .slice(-30)
    .map((m) => `${m.senderName} [${m.senderType}]: ${m.text}`)
    .join("\n");

  await Promise.all(
    group.aiMembers.map(async (aiMember) => {
      const prompt = [
        `You are "${aiMember.name}" in a private friend group chat.`,
        "You are an AI roleplaying as a normal participant with this persona:",
        aiMember.persona,
        "",
        "Rules:",
        "- Reply naturally and conversationally.",
        "- Keep to 1-4 sentences unless more detail is requested.",
        "- Stay in-character.",
        "",
        "Recent conversation:",
        context,
        "",
        `Latest message from ${humanMessage.senderName}: ${humanMessage.text}`,
        "",
        "Return only your next reply message."
      ].join("\n");

      const reply = await requestOpenRouterCompletion({
        model: aiMember.model,
        temperature: aiMember.temperature,
        prompt
      });
      if (!reply) return;

      await sleep(aiMember.responseDelayMs);
      const aiMessage = {
        id: randomUUID(),
        senderType: "ai",
        senderName: aiMember.name,
        text: reply.slice(0, 4000),
        createdAt: new Date().toISOString()
      };
      pushMessage(group, aiMessage);
      emitGroupMessage(group.id, aiMessage);
    })
  );
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
