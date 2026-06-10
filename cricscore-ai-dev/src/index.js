"use strict";
const https = require("https");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = "claude-haiku-4-5-20251001";

// Strip markdown code fences that Claude sometimes wraps around JSON
function stripCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
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
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

// ── POST /ai/tournament-setup ──────────────────────────────────
// Parses a natural language description into structured tournament data
async function handleTournamentSetup(body) {
  const { description } = body;
  if (!description) return resp(400, { error: "description required" });

  const system = `You are a cricket tournament setup assistant. Parse the user's description and return a JSON object with these exact fields (use null for anything not mentioned):
{
  "name": string or null,
  "format": one of "T10"|"T20"|"ODI"|"Test"|"Gully" or null,
  "tournamentType": one of "league"|"league_finals"|"knockout"|"group_knockout" or null,
  "numTeams": integer or null,
  "teamNames": array of strings or [],
  "startDate": ISO date string "YYYY-MM-DD" or null,
  "playDays": array containing "saturday"|"sunday" or null,
  "matchesPerDay": integer or null,
  "startTime": "HH:MM" 24h format or null,
  "numWeeks": integer or null
}
Only return valid JSON. No explanation, no markdown, no code blocks.`;

  const text = await callClaude(system, description);
  try {
    const parsed = JSON.parse(stripCodeFences(text));
    return resp(200, { result: parsed });
  } catch {
    return resp(200, { result: {}, raw: text });
  }
}

// ── POST /ai/schedule ─────────────────────────────────────────
// Generates an optimised fixture schedule given constraints
async function handleSchedule(body) {
  const { numTeams, teamNames, tournamentType, startDate, playDays, matchesPerDay, startTime, format } = body;
  if (!numTeams || !startDate) return resp(400, { error: "numTeams and startDate required" });

  const teams = teamNames && teamNames.length === numTeams
    ? teamNames
    : Array.from({ length: numTeams }, (_, i) => `Team ${i + 1}`);

  const system = `You are a cricket fixture scheduler. Generate a complete fixture schedule and return ONLY a JSON array. Each fixture object:
{
  "round": integer starting at 1,
  "stage": "league"|"quarterfinal"|"semifinal"|"final",
  "homeTeam": string,
  "awayTeam": string,
  "date": "YYYY-MM-DD",
  "time": "HH:MM"
}
Rules:
- tournamentType "league": round-robin, every team plays every other once
- tournamentType "league_finals": full league stage then top-4 semis + final (use TBD for team names in knockouts)
- tournamentType "knockout": direct elimination bracket
- tournamentType "group_knockout": split teams into 2 groups, round-robin within group, top 2 per group to semis + final
- Respect playDays (weekends), matchesPerDay limit, startTime
- Space matches across available dates starting from startDate
- Only return the JSON array, no markdown, no explanation.`;

  const userMsg = `Schedule a ${tournamentType || "league"} tournament.
Teams (${numTeams}): ${teams.join(", ")}
Format: ${format || "T20"}
Start date: ${startDate}
Play days: ${(playDays || ["saturday", "sunday"]).join(", ")}
Matches per day: ${matchesPerDay || 2}
Start time: ${startTime || "09:00"}`;

  // Schedule for many teams can be large — use higher token limit
  const text = await callClaude(system, userMsg, 4096);
  try {
    const fixtures = JSON.parse(stripCodeFences(text));
    return resp(200, { fixtures });
  } catch (e) {
    console.error("Schedule parse error:", e.message);
    console.error("Raw text (first 500):", text.substring(0, 500));
    return resp(500, { error: "Failed to parse schedule", raw: text });
  }
}

// ── POST /ai/team-names ───────────────────────────────────────
// Suggests cricket team names based on location/theme
async function handleTeamNames(body) {
  const { location, count = 8, existingNames = [] } = body;

  const system = `You are a creative cricket team naming assistant. Return ONLY a JSON array of team name strings. Names should be catchy, cricket-themed, and fit for a local tournament. No explanation.`;

  const userMsg = `Suggest ${count} cricket team names${location ? ` for teams from ${location}` : ""}.${existingNames.length ? ` Avoid these already used: ${existingNames.join(", ")}.` : ""} Mix styles: some fierce (Warriors, Strikers), some playful (Thunder Ducks), some local. Return JSON array only.`;

  const text = await callClaude(system, userMsg);
  try {
    const names = JSON.parse(stripCodeFences(text));
    return resp(200, { names });
  } catch {
    return resp(200, { names: [], raw: text });
  }
}

// ── POST /ai/commentary ───────────────────────────────────────
async function handleCommentary(body) {
  const { bowler = 'Bowler', batsman = 'Batsman', runs = 0,
          extra, isWicket, dismissal, over = 0, ball = 0,
          teamRuns = 0, teamWickets = 0, target } = body;

  let event;
  if (isWicket)                event = `WICKET! ${dismissal || 'dismissed'}`;
  else if (extra === 'wide')   event = `wide, ${runs} run${runs !== 1 ? 's' : ''}`;
  else if (extra === 'no_ball')event = `no ball, ${runs} run${runs !== 1 ? 's' : ''}`;
  else if (extra === 'leg_bye')event = `leg bye, ${runs} run${runs !== 1 ? 's' : ''}`;
  else if (extra === 'bye')    event = `bye, ${runs} run${runs !== 1 ? 's' : ''}`;
  else if (runs === 0)         event = 'dot ball';
  else if (runs === 4)         event = 'FOUR!';
  else if (runs === 6)         event = 'SIX!';
  else                         event = `${runs} run${runs !== 1 ? 's' : ''}`;

  const situation = target
    ? `Target: ${target}. Need ${target - teamRuns} more.`
    : `Score: ${teamRuns}/${teamWickets}.`;

  const system = `You are a professional cricket ball-by-ball commentator. Write ONE punchy sentence of commentary (maximum 20 words). Be vivid and specific to the delivery. Return only the commentary text, no quotes, no punctuation at start.`;
  const userMsg = `Over ${over}.${ball}: ${bowler} to ${batsman}, ${event}. ${situation}`;

  const text = await callClaude(system, userMsg, 128);
  const clean = text.trim().replace(/^["']|["']$/g, '');
  return resp(200, { commentary: clean });
}

// ── POST /ai/check-feedback ───────────────────────────────────
async function handleCheckFeedback(body) {
  const { text } = body;
  if (!text) return resp(400, { error: 'text required' });

  const features = `
CricScore app features:
- Ball-by-ball live scoring with AI commentary on every delivery
- Voice scoring (say "four" or "wicket" to score)
- Tournaments: create leagues, knockouts, group+knockout formats
- AI-powered fixture schedule generation
- Team management with player rosters, roles, batting/bowling styles
- Player country registry — search players across teams by country
- Import players via CSV file
- Scoring Sheet (Quick Score): lightweight over-by-over tally with ball-by-ball entry, no backend, no login needed — open from the ☰ menu
- AI Support chat — ask anything about the app
- Highlights/clip gallery — auto-captured video clips on wickets and boundaries
- Scorecard, commentary, and match history screens
- Toss management and innings setup
- Today's fixtures view on home screen
- Multi-format support: T10, T20, ODI, Test, Gully/custom overs
`;

  const system = `You are an assistant for the CricScore cricket scoring app. A user has typed a feedback/suggestion. Your job is to check it against the known feature list and respond with JSON only.

Known features:
${features}

Respond with JSON in this exact format:
{
  "type": "exists" | "duplicate" | "new",
  "message": "one or two sentence explanation",
  "howTo": "how to access the feature if type=exists, else null"
}

- "exists": the feature is already in the app
- "duplicate": very similar to something already requested (if you can infer from context)
- "new": genuinely new idea not covered above

Only return valid JSON. No markdown.`;

  const text2 = await callClaude(system, `User suggestion: "${text}"`);
  try {
    const result = JSON.parse(stripCodeFences(text2));
    return resp(200, result);
  } catch {
    return resp(200, { type: 'new', message: 'Could not analyse suggestion automatically.', howTo: null });
  }
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return resp(200, {});
  }

  const path = event.path || "";
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  if (path.endsWith("/ai/tournament-setup") && event.httpMethod === "POST") {
    return handleTournamentSetup(body);
  }
  if (path.endsWith("/ai/schedule") && event.httpMethod === "POST") {
    return handleSchedule(body);
  }
  if (path.endsWith("/ai/team-names") && event.httpMethod === "POST") {
    return handleTeamNames(body);
  }
  if (path.endsWith("/ai/commentary") && event.httpMethod === "POST") {
    return handleCommentary(body);
  }
  if (path.endsWith("/ai/check-feedback") && event.httpMethod === "POST") {
    return handleCheckFeedback(body);
  }

  return resp(404, { error: "Not found" });
};
