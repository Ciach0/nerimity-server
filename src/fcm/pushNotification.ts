import admin from 'firebase-admin';
import { cert } from 'firebase-admin/app';
import { prisma } from '../common/database';
import { ServerNotificationPingMode, removeFCMTokens } from '../services/User/User';
import { Message, User } from '@prisma/client';
import { addToObjectIfExists } from '../common/addToObjectIfExists';
import { ChannelCache } from '../cache/ChannelCache';
import { ServerCache } from '../cache/ServerCache';
import { Log } from '../common/Log';

let credentials: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  credentials = require('../fcm-credentials.json');
} catch {
  Log.warn("fcm-credentials.json was not provided. Mobile push notifications will not work.")
}

if (credentials) {
  admin.initializeApp({
    credential: cert(credentials),
  });
}

export async function sendServerPushMessageNotification(
  serverId: string,
  message: Message & {
    createdBy: {
      id: string;
      username: string;
      avatar?: string | null;
      hexColor: string | null;
    };
    mentions: {
      id: string;
      username: string;
      tag: string;
      hexColor: string | null;
      avatar: string | null;
    }[];
  },
  channel: ChannelCache,
  server: ServerCache
) {
  if (!credentials) return;
  const mentionedUserIds = message.mentions.map((user) => user.id);
  const tokens = (
    await prisma.firebaseMessagingToken.findMany({
      where: {
        account: {
          user: {
            servers: {
              some: {
                id: serverId,
              },
            },
            OR: [
              {
                joinedServerSettings: {
                  none: { serverId: serverId },
                },
              },
              {
                joinedServerSettings: {
                  some: {
                    serverId: serverId,
                    userId: { in: mentionedUserIds },
                    notificationPingMode:
                      ServerNotificationPingMode.MENTIONS_ONLY,
                  },
                },
              },
              {
                joinedServerSettings: {
                  some: {
                    serverId: serverId,
                    notificationPingMode: ServerNotificationPingMode.ALL,
                  },
                },
              },
            ],
          },
        },
      },
      select: { token: true },
    })
  ).map((fcm) => fcm.token);
  if (!tokens.length) return;

  const content = message?.content?.substring(0, 100);

  const batchResponse = await admin.messaging().sendEachForMulticast({
    tokens,
    android: { priority: 'high' },
    data: {
      ...(content ? { content } : undefined),
      type: message.type.toString(),
      channelName: channel.name!,
      serverName: server.name,
      channelId: message.channelId,
      serverId,
      cUserId: message.createdBy.id,
      cName: message.createdBy.username,
      ...(server.avatar ? { sAvatar: server.avatar } : undefined),
      ...(server.hexColor ? { sHexColor: server.hexColor } : undefined),
    },
  });

  const failedTokens = batchResponse.responses
    .map((sendResponse, index) => sendResponse.error && tokens[index])
    .filter((token) => token) as string[];

  if (!failedTokens.length) return;
  removeFCMTokens(failedTokens);
}

export async function sendDmPushNotification(
  message: Message & {
    createdBy: {
      id: string;
      username: string;
      avatar?: string | null;
      hexColor: string | null;
    };
  },
  channel: ChannelCache
) {
  if (!credentials) return;
  const recipientId = channel.inbox?.recipientId;
  const tokens = (
    await prisma.firebaseMessagingToken.findMany({
      where: { account: { user: { id: recipientId } } },
      select: { token: true },
    })
  ).map((fcm) => fcm.token);
  if (!tokens.length) return;

  const content = message?.content?.substring(0, 100);

  const batchResponse = await admin.messaging().sendEachForMulticast({
    tokens,
    android: { priority: 'high' },
    data: {
      ...(content ? { content } : undefined),
      type: message.type.toString(),
      channelId: message.channelId,
      cUserId: message.createdBy.id,
      cName: message.createdBy.username,
      ...(message.createdBy.avatar
        ? { uAvatar: message.createdBy.avatar }
        : undefined),
      ...(message.createdBy.hexColor
        ? { uHexColor: message.createdBy.hexColor }
        : undefined),
    },
  });

  const failedTokens = batchResponse.responses
    .map((sendResponse, index) => sendResponse.error && tokens[index])
    .filter((token) => token) as string[];

  if (!failedTokens.length) return;
  removeFCMTokens(failedTokens);
}
