'use strict';

const {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const TABLE  = process.env.TABLE_NAME;

// ── Helpers ───────────────────────────────────────────────────
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

async function putItem(item) {
  await client.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall(item, { removeUndefinedValues: true }),
  }));
}

async function getItem(pk, sk) {
  const res = await client.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ PK: pk, SK: sk }),
  }));
  return res.Item ? unmarshall(res.Item) : null;
}

async function queryItems(pk, skPrefix, options = {}) {
  const params = {
    TableName: TABLE,
    KeyConditionExpression: skPrefix
      ? 'PK = :pk AND begins_with(SK, :sk)'
      : 'PK = :pk',
    ExpressionAttributeValues: marshall(
      skPrefix ? { ':pk': pk, ':sk': skPrefix } : { ':pk': pk }
    ),
    ...options,
  };
  const res = await client.send(new QueryCommand(params));
  return (res.Items ?? []).map(i => unmarshall(i));
}

async function updateItem(pk, sk, updates) {
  const ks = Object.keys(updates);
  if (!ks.length) return;
  await client.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ PK: pk, SK: sk }),
    UpdateExpression: `SET ${ks.map(k => `#${k} = :${k}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(ks.map(k => [`#${k}`, k])),
    ExpressionAttributeValues: marshall(
      Object.fromEntries(ks.map(k => [`:${k}`, updates[k]])),
      { removeUndefinedValues: true }
    ),
  }));
}

// Atomically increment the country counter and return the new playerCode.
async function nextPlayerCode(country) {
  const res = await client.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { PK: { S: 'COUNTER#PLAYER' }, SK: { S: `COUNTRY#${country}` } },
    UpdateExpression: 'ADD #n :inc',
    ExpressionAttributeNames: { '#n': 'count' },
    ExpressionAttributeValues: { ':inc': { N: '1' } },
    ReturnValues: 'UPDATED_NEW',
  }));
  const n = parseInt(res.Attributes.count.N, 10);
  return `${country}-${String(n).padStart(6, '0')}`;
}

// ADD numeric values to career stats (never overwrites, always accumulates).
async function addCareerStats(playerId, batting, bowling) {
  const adds = [];
  const vals = {};

  if (batting) {
    const b = batting;
    adds.push('innings :bi', 'runsScored :runs', 'ballsFaced :balls',
              'fours :fours', 'sixes :sixes');
    Object.assign(vals, {
      ':bi':    1,
      ':runs':  b.runsScored   || 0,
      ':balls': b.ballsFaced   || 0,
      ':fours': b.fours        || 0,
      ':sixes': b.sixes        || 0,
    });
    if ((b.runsScored || 0) >= 50 && (b.runsScored || 0) < 100) {
      adds.push('fifties :fif'); vals[':fif'] = 1;
    }
    if ((b.runsScored || 0) >= 100) {
      adds.push('hundreds :hun'); vals[':hun'] = 1;
    }
  }

  if (bowling && (bowling.legalDeliveries || 0) > 0) {
    adds.push('wicketsTaken :wkts', 'ballsBowled :bb', 'runsConceded :rc');
    Object.assign(vals, {
      ':wkts': bowling.wicketsTaken    || 0,
      ':bb':   bowling.legalDeliveries || 0,
      ':rc':   bowling.runsConceded    || 0,
    });
  }

  if (!adds.length) return;

  // Always bump match count once per call.
  adds.push('matches :m');
  vals[':m'] = 1;

  await client.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { PK: { S: `PLAYER_STATS#${playerId}` }, SK: { S: 'CAREER' } },
    UpdateExpression: `ADD ${adds.join(', ')}`,
    ExpressionAttributeValues: Object.fromEntries(
      Object.entries(vals).map(([k, v]) => [k, { N: String(v) }])
    ),
  }));
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  const method = event.httpMethod;
  const path   = event.resource;
  const params = event.pathParameters ?? {};
  const query  = event.queryStringParameters ?? {};
  const body   = event.body ? JSON.parse(event.body) : {};

  try {
    // ── POST /players ─────────────────────────────────────────
    if (method === 'POST' && path === '/players') {
      const { teamId, name, battingStyle, bowlingStyle, role, jerseyNumber, country } = body;
      if (!teamId || !name) return err('teamId and name are required');

      const playerId   = newId();
      const cc         = country?.toUpperCase() ?? null;
      const playerCode = cc ? await nextPlayerCode(cc) : null;

      const player = {
        PK: `TEAM#${teamId}`, SK: `PLAYER#${playerId}`,
        id: playerId, teamId, name,
        shortName:    name.split(' ').map(w => w[0]).join('').toUpperCase(),
        role:         role         ?? 'all_rounder',
        battingStyle: battingStyle ?? 'right_hand',
        bowlingStyle: bowlingStyle ?? null,
        jerseyNumber: jerseyNumber ?? null,
        country:      cc,
        playerCode,
        photoUrl:  null,
        bio:       null,
        claimedBy: null,
        createdAt: now(), updatedAt: now(),
      };

      if (playerCode && cc) {
        // Write both: team roster record + country registry record.
        const registryItem = {
          ...player,
          PK: `COUNTRY#${cc}`, SK: `PLAYER#${playerCode}`,
        };
        await client.send(new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: TABLE, Item: marshall(player,       { removeUndefinedValues: true }) } },
            { Put: { TableName: TABLE, Item: marshall(registryItem, { removeUndefinedValues: true }) } },
          ],
        }));
      } else {
        await putItem(player);
      }

      return ok(player, 201);
    }

    // ── POST /players/stats/batch ─────────────────────────────
    if (method === 'POST' && path === '/players/stats/batch') {
      const { players: list = [] } = body;
      await Promise.all(
        list.map(({ playerId, batting, bowling }) =>
          addCareerStats(playerId, batting, bowling).catch(() => {})
        )
      );
      return ok({ updated: list.length });
    }

    // ── GET /players ──────────────────────────────────────────
    if (method === 'GET' && path === '/players') {
      const { teamId } = query;
      if (!teamId) return err('teamId query param required');
      const players = await queryItems(`TEAM#${teamId}`, 'PLAYER#');
      return ok(players);
    }

    // ── GET /players/search ───────────────────────────────────
    if (method === 'GET' && path === '/players/search') {
      const { country, q = '' } = query;
      if (!country) return err('country query param required');
      const all = await queryItems(`COUNTRY#${country.toUpperCase()}`, 'PLAYER#');
      const filtered = q.length >= 2
        ? all.filter(p => p.name.toLowerCase().includes(q.toLowerCase()))
        : all;
      return ok(filtered.slice(0, 30));
    }

    // ── GET /players/{playerId} ───────────────────────────────
    if (method === 'GET' && path === '/players/{playerId}') {
      const { playerId } = params;
      const { teamId } = query;
      if (!teamId) return err('teamId query param required');
      const player = await getItem(`TEAM#${teamId}`, `PLAYER#${playerId}`);
      if (!player) return err('Player not found', 404);
      return ok(player);
    }

    // ── PUT /players/{playerId} ───────────────────────────────
    if (method === 'PUT' && path === '/players/{playerId}') {
      const { playerId } = params;
      const { teamId } = query;
      if (!teamId) return err('teamId query param required');

      const allowed = ['name', 'role', 'battingStyle', 'bowlingStyle',
                       'jerseyNumber', 'isCaptain', 'isWicketKeeper', 'photoUrl', 'bio'];
      const updates = Object.fromEntries(
        Object.entries(body).filter(([k]) => allowed.includes(k))
      );
      updates.updatedAt = now();
      await updateItem(`TEAM#${teamId}`, `PLAYER#${playerId}`, updates);

      // Mirror to registry if player has a code.
      const player = await getItem(`TEAM#${teamId}`, `PLAYER#${playerId}`);
      if (player?.playerCode && player?.country) {
        await updateItem(`COUNTRY#${player.country}`, `PLAYER#${player.playerCode}`, updates)
          .catch(() => {});
      }

      return ok({ updated: true });
    }

    // ── POST /players/{playerId}/claim ────────────────────────
    if (method === 'POST' && path === '/players/{playerId}/claim') {
      const { playerId } = params;
      const { teamId, userId } = body;
      if (!teamId || !userId) return err('teamId and userId are required');

      const player = await getItem(`TEAM#${teamId}`, `PLAYER#${playerId}`);
      if (!player) return err('Player not found', 404);
      if (player.claimedBy && player.claimedBy !== userId) {
        return err('This player profile is already claimed by another account', 409);
      }

      const updates = { claimedBy: userId, updatedAt: now() };
      await updateItem(`TEAM#${teamId}`, `PLAYER#${playerId}`, updates);
      if (player.playerCode && player.country) {
        await updateItem(
          `COUNTRY#${player.country}`, `PLAYER#${player.playerCode}`, updates
        ).catch(() => {});
      }

      return ok({ claimed: true, playerCode: player.playerCode });
    }

    // ── GET /players/{playerId}/stats ─────────────────────────
    if (method === 'GET' && path === '/players/{playerId}/stats') {
      const { playerId } = params;
      const stats = await getItem(`PLAYER_STATS#${playerId}`, 'CAREER');
      return ok(stats ?? {
        playerId, matches: 0, innings: 0,
        runsScored: 0, ballsFaced: 0, fours: 0, sixes: 0, fifties: 0, hundreds: 0,
        wicketsTaken: 0, ballsBowled: 0, runsConceded: 0,
      });
    }

    return err('Not found', 404);

  } catch (e) {
    console.error('Player Lambda error:', e);
    return err(e.message ?? 'Internal server error', 500);
  }
};
