'use strict';

const {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  QueryCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const TABLE  = process.env.TABLE_NAME;

const ok  = (body = {}) => ({ statusCode: 200, body: JSON.stringify(body) });
const err = (msg, status = 400) => ({ statusCode: status, body: JSON.stringify({ error: msg }) });

// TTL: 12 hours — cleans up stale connections automatically
const ttl = () => Math.floor(Date.now() / 1000) + 43200;

exports.handler = async (event) => {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  try {
    // ── $connect ──────────────────────────────────────────────────
    if (routeKey === '$connect') {
      await dynamo.send(new PutItemCommand({
        TableName: TABLE,
        Item: marshall({
          PK: 'WS_CONN',
          SK: `CONN#${connectionId}`,
          connectionId,
          matchId: null,
          endpoint,
          ttl: ttl(),
          connectedAt: Date.now(),
        }, { removeUndefinedValues: true }),
      }));
      return ok();
    }

    // ── $disconnect ───────────────────────────────────────────────
    if (routeKey === '$disconnect') {
      await dynamo.send(new DeleteItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: 'WS_CONN', SK: `CONN#${connectionId}` }),
      }));
      return ok();
    }

    // ── Custom routes ─────────────────────────────────────────────
    const body   = event.body ? JSON.parse(event.body) : {};
    const action = body.action;

    // joinMatch — client tells us which match it's watching
    if (action === 'joinMatch') {
      const { matchId } = body;
      if (!matchId) return err('matchId required');

      await dynamo.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: 'WS_CONN', SK: `CONN#${connectionId}` }),
        UpdateExpression: 'SET matchId = :m, #t = :t',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ExpressionAttributeValues: marshall({ ':m': matchId, ':t': ttl() }),
      }));
      return ok({ joined: matchId });
    }

    // clipTrigger — scorer fires this on wicket / boundary
    // We broadcast to every other connection in the same match
    if (action === 'clipTrigger') {
      const { matchId, inningsNumber, over, ball, event: clipEvent } = body;
      if (!matchId) return err('matchId required');

      const res = await dynamo.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        FilterExpression: 'matchId = :m',
        ExpressionAttributeValues: marshall({
          ':pk': 'WS_CONN',
          ':sk': 'CONN#',
          ':m': matchId,
        }),
      }));

      const connections = (res.Items ?? []).map(i => unmarshall(i));
      const payload = JSON.stringify({
        type:          'clipTrigger',
        matchId,
        inningsNumber: inningsNumber ?? 1,
        over:          over    ?? 0,
        ball:          ball    ?? 0,
        event:         clipEvent ?? 'manual',
        ts:            Date.now(),
      });

      // Broadcast to all connections except the sender; prune stale ones.
      const apigw = new ApiGatewayManagementApiClient({ endpoint });
      await Promise.all(
        connections
          .filter(c => c.connectionId !== connectionId)
          .map(c =>
            apigw.send(new PostToConnectionCommand({
              ConnectionId: c.connectionId,
              Data: Buffer.from(payload),
            })).catch(() =>
              dynamo.send(new DeleteItemCommand({
                TableName: TABLE,
                Key: marshall({ PK: 'WS_CONN', SK: `CONN#${c.connectionId}` }),
              })).catch(() => {})
            )
          )
      );

      return ok({ broadcast: connections.length - 1 });
    }

    return ok();

  } catch (e) {
    console.error('WS Lambda error:', e);
    return err(e.message ?? 'Internal error', 500);
  }
};
