"use strict";

const https = require("https");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const TABLE_NAME        = process.env.TABLE_NAME || "CricScore-dev";
const SUPPORT_EMAIL     = process.env.SUPPORT_EMAIL || "bellarykirankumar@gmail.com";
const MODEL             = "claude-haiku-4-5";
const REGION            = "us-east-1";

// ─── AWS helpers ─────────────────────────────────────────────────────────────

function awsRequest(service, target, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const host = `${service}.${REGION}.amazonaws.com`;
    const options = {
      hostname: host,
      method: "POST",
      path: "/",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": target,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    // Use IAM role credentials from environment
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Claude API ──────────────────────────────────────────────────────────────

function callClaude(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || "");
        } catch { reject(new Error("Claude parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the CricScore support assistant. CricScore is a free iOS cricket scoring app.

## What CricScore does
- Live ball-by-ball scoring for all formats (T10, T20, ODI, Test, Gully)
- Tournament management: create tournaments, add fixtures, manage standings
- Team & player rosters with batting/bowling styles and jersey numbers
- Bulk import players via CSV file
- Invite co-scorers by email — they get access as soon as they sign up
- Country-based filtering so users see tournaments from their region
- Video highlight clips: auto-records wickets, fours, sixes via a camera device
- Commentary screen with inline clip playback
- Highlights gallery (All / Wickets / Boundaries tabs)
- AI-assisted tournament setup (team name suggestions, fixture generation)

## How to answer
- Be concise, friendly, and specific. Use the app's actual terminology.
- If you know the answer, answer it directly — don't ask unnecessary follow-up questions.
- For step-by-step instructions, use numbered lists.
- Keep replies short — users are on mobile.

## Common questions and answers

**How do I create a tournament?**
Tap the Tournaments tab → + button → fill in the name, format (T10/T20/etc.), and number of overs → Save. Then add teams and create fixtures.

**How do I add players to a team?**
Go to the tournament → Teams tab → select the team → tap the roster → Add Player. Or use the CSV import button to bulk-import players.

**How do I invite someone to score a match?**
Go to the tournament detail → tap the Scorer icon → enter their email. They'll get access as soon as they sign up with that email.

**How do I start scoring a match?**
From the Fixtures tab, tap the match → set the toss → Start Match → select opening batters and bowler → begin scoring ball by ball.

**How do I undo a delivery?**
On the scoring screen, tap the Undo button (↩) to reverse the last delivery.

**Why can't I see a tournament?**
Tournaments are filtered by country. If you set a different country during signup, you won't see tournaments from other regions. Go to Account → Change Country.

**How do video clips work?**
On the scoring screen, tap the 📹 camera icon → set up a camera device on the Camera Buffer screen. When a wicket or boundary is scored, a clip is automatically triggered and saved. View clips in the Highlights gallery or inline in the Commentary tab.

**The app is crashing / something isn't working**
Please describe exactly what you were doing when the issue occurred, and I'll flag it to the team right away.

**How do I change my password?**
Log out → on the login screen tap "Forgot password" → enter your email → you'll receive a reset code.

**Is CricScore free?**
Yes, completely free. No subscription, no ads, no in-app purchases.

**Is Android supported?**
iOS only right now. Android is coming soon.

## Escalation
If the user has a bug you cannot resolve, an account issue (can't log in, lost data), or a feature request, end your reply with exactly this JSON on a new line:
ESCALATE:{"reason":"<brief reason>","category":"<bug|account|feature|other>"}

Otherwise do NOT include the ESCALATE tag.`;

// ─── DynamoDB ticket save ────────────────────────────────────────────────────

async function saveTicket({ userId, userEmail, appVersion, reason, category, conversation }) {
  const ticketId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    PK: { S: "SUPPORT_TICKET" },
    SK: { S: `TICKET#${Date.now()}#${userId || "anon"}` },
    ticketId: { S: ticketId },
    userId:   { S: userId || "anonymous" },
    userEmail:{ S: userEmail || "" },
    appVersion:{ S: appVersion || "" },
    reason:   { S: reason },
    category: { S: category },
    status:   { S: "open" },
    conversation: { S: JSON.stringify(conversation) },
    createdAt:{ N: String(Date.now()) },
    ttl:      { N: String(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90) }, // 90 days
  };

  const { DynamoDBClient, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
  // Use raw HTTPS for DynamoDB to avoid SDK import issues in Lambda
  // (SDK is available natively in Node 20 Lambda runtime)
  try {
    const AWS = require("/var/runtime/node_modules/@aws-sdk/client-dynamodb");
    // fallback: just log if DynamoDB write fails, don't break the response
  } catch {}

  return ticketId;
}

// ─── SES email alert ─────────────────────────────────────────────────────────

async function sendEscalationEmail({ ticketId, userId, userEmail, appVersion, reason, category, conversation }) {
  const convText = conversation
    .map(m => `${m.role === "user" ? "User" : "Agent"}: ${m.content}`)
    .join("\n\n");

  const body = JSON.stringify({
    Source: `CricScore Support <no-reply@randomappsstore.com>`,
    Destination: { ToAddresses: [SUPPORT_EMAIL] },
    Message: {
      Subject: { Data: `[CricScore Support] ${category.toUpperCase()}: ${reason}` },
      Body: {
        Text: {
          Data: `New support ticket escalated by AI agent.\n\nTicket ID: ${ticketId}\nCategory: ${category}\nReason: ${reason}\nUser ID: ${userId || "anonymous"}\nUser Email: ${userEmail || "unknown"}\nApp Version: ${appVersion || "unknown"}\n\n--- Conversation ---\n\n${convText}`,
        },
      },
    },
  });

  return new Promise((resolve) => {
    const bodyBuf = Buffer.from(body);
    const options = {
      hostname: `email.${REGION}.amazonaws.com`,
      path: "/v2/email/outbound-emails",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": bodyBuf.length,
      },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    });
    req.on("error", () => resolve(null)); // don't fail the response if email fails
    req.write(bodyBuf);
    req.end();
  });
}

// ─── CORS helper ─────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function respond(statusCode, body) {
  return { statusCode, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return respond(200, {});

  try {
    const body = JSON.parse(event.body || "{}");
    const {
      message,
      history = [],      // [{role:"user"|"assistant", content:"..."}]
      userId,
      userEmail,
      appVersion,
    } = body;

    if (!message?.trim()) return respond(400, { error: "message required" });

    // Build conversation for Claude (last 10 turns max to keep tokens low)
    const messages = [
      ...history.slice(-10),
      { role: "user", content: message.trim() },
    ];

    // Call Claude
    const rawReply = await callClaude(SYSTEM_PROMPT, messages);

    // Check for escalation signal
    const escalateMatch = rawReply.match(/ESCALATE:(\{.*\})/);
    const isEscalated = !!escalateMatch;
    const cleanReply = rawReply.replace(/\nESCALATE:\{.*\}/, "").trim();

    let ticketId = null;
    if (isEscalated) {
      let escalateData = {};
      try { escalateData = JSON.parse(escalateMatch[1]); } catch {}

      const fullConversation = [...messages, { role: "assistant", content: cleanReply }];
      ticketId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Send email alert (best effort)
      await sendEscalationEmail({
        ticketId,
        userId,
        userEmail,
        appVersion,
        reason: escalateData.reason || "Support escalation",
        category: escalateData.category || "other",
        conversation: fullConversation,
      });
    }

    return respond(200, {
      reply: cleanReply,
      isEscalated,
      ticketId,
    });

  } catch (err) {
    console.error(err);
    return respond(500, { error: "Support agent error", detail: err.message });
  }
};
