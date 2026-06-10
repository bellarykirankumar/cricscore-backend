"use strict";
const { DynamoDBClient, PutItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { randomUUID } = require("crypto");

const REGION      = process.env.AWS_REGION  || "us-east-1";
const TABLE       = process.env.TABLE_NAME  || "cricscore-feedback-dev";
const BUCKET      = process.env.BUCKET_NAME || "cricscore-feedback-screenshots-dev";
const FROM_EMAIL  = process.env.FROM_EMAIL  || "noreply@cricscore.app";
const TO_EMAIL    = process.env.TO_EMAIL    || "bellarykirankumar@gmail.com";

const dynamo = new DynamoDBClient({ region: REGION });
const s3     = new S3Client({ region: REGION });
const ses    = new SESClient({ region: REGION });

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

function now() { return Date.now(); }

// ── POST /feedback/upload-url ─────────────────────────────────
async function handleUploadUrl(event) {
  const key = `screenshots/${randomUUID()}.jpg`;
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: "image/jpeg",
  });
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  const publicUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
  return resp(200, { uploadUrl, publicUrl });
}

// ── POST /feedback ─────────────────────────────────────────────
async function handleSubmit(body, userEmail) {
  const { text, aiCategory, screenshotUrl, submittedAt } = body;
  if (!text) return resp(400, { error: "text required" });

  const id = randomUUID();
  const item = {
    pk:           `FEEDBACK`,
    sk:           `${now()}#${id}`,
    id,
    text,
    userEmail:    userEmail || "anonymous",
    aiCategory:   aiCategory || "unknown",
    screenshotUrl: screenshotUrl || null,
    submittedAt:  submittedAt || new Date().toISOString(),
    createdAt:    now(),
  };

  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall(item, { removeUndefinedValues: true }),
  }));

  // Send email notification
  try {
    const screenshotLine = screenshotUrl
      ? `\n\nScreenshot: ${screenshotUrl}`
      : '';
    await ses.send(new SendEmailCommand({
      Source: FROM_EMAIL,
      Destination: { ToAddresses: [TO_EMAIL] },
      Message: {
        Subject: { Data: `[CricScore Feedback] ${aiCategory || 'New'}: ${text.substring(0, 60)}…` },
        Body: {
          Text: {
            Data: `New feedback from ${userEmail || 'anonymous'}:\n\n${text}${screenshotLine}\n\nCategory: ${aiCategory || 'none'}\nSubmitted: ${submittedAt || 'now'}`
          }
        },
      },
    }));
  } catch (e) {
    console.warn("Email send failed:", e.message);
    // Don't fail the request if email fails
  }

  return resp(200, { id, message: "Feedback submitted. Thank you!" });
}

// ── GET /feedback ─────────────────────────────────────────────
// Admin only — returns last 50 submissions
async function handleList() {
  const result = await dynamo.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: marshall({ ":pk": "FEEDBACK" }),
    ScanIndexForward: false,
    Limit: 50,
  }));
  const items = (result.Items || []).map(i => {
    const u = {};
    for (const [k, v] of Object.entries(i)) {
      u[k] = Object.values(v)[0];
    }
    return u;
  });
  return resp(200, items);
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return resp(200, {});

  const path   = event.path || "";
  const method = event.httpMethod;
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  // Extract user email from Cognito authorizer context
  const userEmail = event.requestContext?.authorizer?.claims?.email || null;

  if (path.endsWith("/feedback/upload-url") && method === "POST") {
    return handleUploadUrl(event);
  }
  if (path.endsWith("/feedback") && method === "POST") {
    return handleSubmit({ ...body, userEmail }, userEmail);
  }
  if (path.endsWith("/feedback") && method === "GET") {
    return handleList();
  }

  return resp(404, { error: "Not found" });
};
