import { NextFunction, Request, Response, Router } from 'express';
import { body } from 'express-validator';
import {
  customExpressValidatorResult,
  generateError,
} from '../../common/errorHandler';
import {
  CHANNEL_PERMISSIONS,
  ROLE_PERMISSIONS,
  USER_BADGES,
  hasBit,
} from '../../common/Bitwise';
import { authenticate } from '../../middleware/authenticate';
import { channelPermissions } from '../../middleware/channelPermissions';
import { channelVerification } from '../../middleware/channelVerification';
import { MessageType } from '../../types/Message';
import { AttachmentProviders, createMessage } from '../../services/Message';
import {
  memberHasRolePermission,
  memberHasRolePermissionMiddleware,
} from '../../middleware/memberHasRolePermission';
import { rateLimit } from '../../middleware/rateLimit';
import { deleteImage, uploadImage } from '../../common/nerimityCDN';
import { connectBusboyWrapper } from '../../middleware/connectBusboyWrapper';
import { TextChannelTypes } from '../../types/Channel';
import { Attachment } from '@prisma/client';
import { dateToDateTime } from '../../common/database';
import { ChannelCache } from '../../cache/ChannelCache';
import { AccountCache, UserCache } from '../../cache/UserCache';
import { ServerCache } from '../../cache/ServerCache';

export function channelMessageCreate(Router: Router) {
  Router.post(
    '/channels/:channelId/messages',
    authenticate(),
    channelVerification(),
    channelPermissions({
      bit: CHANNEL_PERMISSIONS.SEND_MESSAGE.bit,
      message: 'You are not allowed to send messages in this channel.',
    }),
    memberHasRolePermissionMiddleware(ROLE_PERMISSIONS.SEND_MESSAGE),
    connectBusboyWrapper,
    body('content')
      .optional(true)
      .isString()
      .withMessage('Content must be a string!')
      .isLength({ min: 1, max: 2000 })
      .withMessage('Content length must be between 1 and 2000 characters.'),
    body('socketId')
      .optional(true)
      .isString()
      .withMessage('SocketId must be a string!')
      .isLength({ min: 1, max: 255 })
      .withMessage('SocketId length must be between 1 and 255 characters.'),

    body('googleDriveAttachment')
      .optional(true)
      .isObject()
      .withMessage('googleDriveFile must be an object!'),

    body('googleDriveAttachment.id')
      .optional(true)
      .isString()
      .withMessage('googleDriveAttachment id must be a string!')
      .isLength({ min: 1, max: 255 })
      .withMessage(
        'googleDriveAttachment id length must be between 1 and 255 characters.'
      ),

    body('googleDriveAttachment.mime')
      .optional(true)
      .isString()
      .withMessage('googleDriveAttachment mime must be a string!')
      .isLength({ min: 1, max: 255 })
      .withMessage(
        'googleDriveAttachment mime length must be between 1 and 255 characters.'
      ),

    rateLimit({
      name: 'create_message',
      expireMS: 20000,
      requestCount: 20,
    }),
    route
  );
}

interface Body {
  content?: string;
  socketId?: string;
  googleDriveAttachment?: {
    id: string;
    mime: string;
  };
}

async function route(req: Request, res: Response) {
  const body = req.body as Body;

  const validateError = customExpressValidatorResult(req);

  if (validateError) {
    return res.status(400).json(validateError);
  }

  const hasAttachment = body.googleDriveAttachment || req.fileInfo?.file;

  if (hasAttachment) {
    if (!isEmailConfirmed(req.accountCache)) {
      return res
        .status(400)
        .json(
          generateError(
            'You must confirm your email to send attachment messages.'
          )
        );
    }

    const isServerNotPublicAndNotSupporter =
      req.serverCache &&
      !isServerPublic(req.serverCache) &&
      !isSupporterOrModerator(req.accountCache.user);

    if (isServerNotPublicAndNotSupporter) {
      return res
        .status(400)
        .json(
          generateError(
            'You must be a Nerimity supporter to send attachment messages to a private server.'
          )
        );
    }
    const isPrivateChannelAndNotSupporter =
      isPrivateChannel(req.channelCache) &&
      !isSupporterOrModerator(req.accountCache.user);

    if (isPrivateChannelAndNotSupporter) {
      return res
        .status(400)
        .json(
          generateError(
            'You must be a Nerimity supporter to send attachment messages to a private channel.'
          )
        );
    }
  }

  if (body.googleDriveAttachment) {
    if (!body.googleDriveAttachment.id)
      return res
        .status(400)
        .json(generateError('googleDriveAttachment id is required'));
    if (!body.googleDriveAttachment.mime)
      return res
        .status(400)
        .json(generateError('googleDriveAttachment mime is required'));
  }

  if (req.channelCache.serverId && !req.accountCache.emailConfirmed) {
    return res
      .status(400)
      .json(generateError('You must confirm your email to send messages.'));
  }

  if (req.channelCache.inbox && !req.channelCache.inbox.canMessage) {
    return res.status(400).json(generateError('You cannot message this user.'));
  }

  if (!TextChannelTypes.includes(req.channelCache.type)) {
    return res
      .status(400)
      .json(generateError('You cannot send messages in this channel.'));
  }

  if (
    !body.content?.trim() &&
    !req.fileInfo?.file &&
    !body.googleDriveAttachment
  ) {
    return res
      .status(400)
      .json(generateError('content or attachment is required.'));
  }

  let canMentionEveryone = body.content?.includes('[@:e]');
  if (canMentionEveryone) {
    const [hasMentionEveryonePerm] = memberHasRolePermission(
      req,
      ROLE_PERMISSIONS.MENTION_EVERYONE
    );
    canMentionEveryone = !!hasMentionEveryonePerm;
  }

  let attachment: Partial<Attachment> | undefined = undefined;

  if (req.fileInfo?.file) {
    const [uploadedImage, err] = await uploadImage(
      req.fileInfo?.file,
      req.fileInfo.info.filename,
      req.channelCache.id
    );

    if (err) {
      if (typeof err === 'string') {
        return res.status(403).json(generateError(err));
      }
      if (err.type === 'INVALID_IMAGE') {
        return res
          .status(403)
          .json(generateError('You can only upload images for now.'));
      }
      return res
        .status(403)
        .json(generateError(`An unknown error has occurred (${err.type})`));
    }

    attachment = {
      width: uploadedImage!.dimensions.width,
      height: uploadedImage!.dimensions.height,
      path: uploadedImage!.path,
    };
  }

  if (body.googleDriveAttachment) {
    attachment = {
      fileId: body.googleDriveAttachment.id,
      mime: body.googleDriveAttachment.mime,
      provider: AttachmentProviders.GoogleDrive,
      createdAt: dateToDateTime() as unknown as Date,
    };
  }

  const [message, error] = await createMessage({
    channelId: req.channelCache.id,
    content: body.content,
    userId: req.accountCache.user.id,
    channel: req.channelCache,
    serverId: req.channelCache?.server?.id,
    server: req.serverCache,
    socketId: body.socketId,
    type: MessageType.CONTENT,
    attachment,
    everyoneMentioned: canMentionEveryone,
  });

  if (error) {
    if (req.fileInfo?.file && attachment?.path) {
      deleteImage(attachment.path);
    }
    return res.status(400).json(generateError(error));
  }

  res.json(message);
}

const isEmailConfirmed = (user: AccountCache) => {
  return user.emailConfirmed;
};

const isSupporterOrModerator = (user: UserCache) => {
  return (
    hasBit(user.badges, USER_BADGES.SUPPORTER.bit) ||
    hasBit(user.badges, USER_BADGES.FOUNDER.bit) ||
    hasBit(user.badges, USER_BADGES.ADMIN.bit)
  );
};

const isPrivateChannel = (channel: ChannelCache) => {
  if (!channel.serverId) return false;
  return hasBit(channel.permissions, CHANNEL_PERMISSIONS.PRIVATE_CHANNEL.bit);
};

const isServerPublic = (server: ServerCache) => {
  return server.public;
};
