'use strict';

const {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl }  = require('@aws-sdk/s3-request-presigner');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const s3     = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const TABLE  = process.env.TABLE_NAME;
const BUCKET = process.env.CLIP_BUCKET;
const CF_URL = process.env.CLOUDFRONT_URL; // set after CloudFront is created

const ok  = (body, status = 200) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});
const err = (msg, status = 400) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify({ error: msg }),
});

const newId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const now   = () => Date.now();

// Return a playback URL — CloudFront if configured, else a 1-hour signed S3 URL.
async function playUrl(s3Key) {
  if (CF_URL) return `${CF_URL}/${s3Key}`;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }), { expiresIn: 3600 });
}

// Pad numbers for lexicographic DynamoDB sort ordering.
const pad = (n, w) => String(n ?? 0).padStart(w, '0');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const path   = event.resource;
  const query  = event.queryStringParameters ?? {};
  const body   = event.body ? JSON.parse(event.body) : {};

  try {
    // ── POST /clips/presign ───────────────────────────────────────
    // Step 1: get a presigned PUT URL; device uploads the MP4 directly to S3.
    if (method === 'POST' && path === '/clips/presign') {
      const {
        matchId, inningsNumber = 1, over = 0, ball = 0,
        event: clipEvent = 'manual',
        contentType = 'video/mp4',
      } = body;
      if (!matchId) return err('matchId required');

      const clipId  = newId();
      const s3Key   = `clips/${matchId}/${pad(inningsNumber,2)}_${pad(over,3)}_${pad(ball,2)}_${clipId}.mp4`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: contentType }),
        { expiresIn: 300 }, // 5-min window to complete upload
      );

      return ok({ clipId, s3Key, uploadUrl });
    }

    // ── POST /clips ───────────────────────────────────────────────
    // Step 2: after upload succeeds, save the clip record in DynamoDB.
    if (method === 'POST' && path === '/clips') {
      const {
        matchId, inningsNumber = 1, over = 0, ball = 0,
        event: clipEvent = 'manual',
        s3Key, durationMs = 0,
      } = body;
      if (!matchId || !s3Key) return err('matchId and s3Key required');

      const clipId = s3Key.split('/').pop().replace('.mp4', '');
      const clip = {
        PK: `MATCH#${matchId}`,
        SK: `CLIP#${pad(inningsNumber,2)}#${pad(over,3)}#${pad(ball,2)}#${clipId}`,
        clipId, matchId,
        inningsNumber: Number(inningsNumber),
        over:          Number(over),
        ball:          Number(ball),
        event:         clipEvent,
        s3Key, durationMs: Number(durationMs),
        createdAt: now(),
      };

      await dynamo.send(new PutItemCommand({
        TableName: TABLE,
        Item: marshall(clip, { removeUndefinedValues: true }),
      }));

      return ok({ ...clip, playUrl: await playUrl(s3Key) }, 201);
    }

    // ── GET /clips ────────────────────────────────────────────────
    // List all clips for a match, optionally filtered to one innings.
    if (method === 'GET' && path === '/clips') {
      const { matchId, inningsNumber } = query;
      if (!matchId) return err('matchId required');

      const skPrefix = inningsNumber
        ? `CLIP#${pad(inningsNumber, 2)}`
        : 'CLIP#';

      const res = await dynamo.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: marshall({ ':pk': `MATCH#${matchId}`, ':sk': skPrefix }),
      }));

      const clips = await Promise.all(
        (res.Items ?? []).map(async i => {
          const c = unmarshall(i);
          return { ...c, playUrl: await playUrl(c.s3Key) };
        })
      );

      return ok(clips);
    }

    return err('Not found', 404);

  } catch (e) {
    console.error('Clip Lambda error:', e);
    return err(e.message ?? 'Internal server error', 500);
  }
};
