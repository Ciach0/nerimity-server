import { Request, Response, Router } from 'express';
import { prisma } from '../../common/database';
import { authenticate } from '../../middleware/authenticate';
import { isModMiddleware } from './isModMiddleware';
import {
  customExpressValidatorResult,
  generateError,
} from '../../common/errorHandler';
import { addToObjectIfExists } from '../../common/addToObjectIfExists';
import { USER_BADGES, hasBit } from '../../common/Bitwise';
import bcrypt from 'bcrypt';
import { removeAccountCacheByUserIds } from '../../cache/UserCache';
import { getIO } from '../../socket/socket';
import { AUTHENTICATE_ERROR } from '../../common/ClientEventNames';
import { AuditLogType } from '../../common/AuditLog';
import { generateId } from '../../common/flakeId';
import { checkUserPassword } from '../../services/UserAuthentication';

export function updateUser(Router: Router) {
  Router.post(
    '/moderation/users/:userId',
    authenticate(),
    isModMiddleware,
    route
  );
}

interface Body {
  email?: string;
  username?: string;
  tag?: string;
  badges?: number;
  newPassword?: string;
  password?: string;

  emailConfirmed?: boolean;
}

async function route(req: Request, res: Response) {
  const body: Body = req.body;
  const userId = req.params.userId;

  const validateError = customExpressValidatorResult(req);
  if (validateError) {
    return res.status(400).json(validateError);
  }

  const moderatorAccount = await prisma.account.findFirst({
    where: { id: req.accountCache.id },
    select: { password: true },
  });
  if (!moderatorAccount)
    return res
      .status(404)
      .json(generateError('Something went wrong. Try again later.'));

  const isPasswordValid = await checkUserPassword(
    moderatorAccount.password,
    body.password,
  );
  if (!isPasswordValid)
    return res.status(403).json(generateError('Invalid password.', 'password'));

  const account = await prisma.account.findFirst({
    where: { userId },
    select: { user: { select: { username: true, tag: true, badges: true } } },
  });

  if (!account)
    return res.status(404).json(generateError('User does not exist.'));

  if (body.badges !== undefined) {
    const alreadyIsFounder = hasBit(
      account.user.badges,
      USER_BADGES.FOUNDER.bit
    );
    const updatedIsFounder = hasBit(body.badges, USER_BADGES.FOUNDER.bit);

    if (alreadyIsFounder !== updatedIsFounder) {
      return res
        .status(403)
        .json(
          generateError(`Cannot modify the ${USER_BADGES.FOUNDER.name} badge`)
        );
    }
  }
  if (body.tag || body.username) {
    const exists = await prisma.user.findFirst({
      where: {
        tag: body.tag?.trim() || account.user.tag,
        username: body.username?.trim() || account.user.username,
        NOT: { id: userId },
      },
    });
    if (exists)
      return res
        .status(403)
        .json(
          generateError(
            'Someone already has this combination of tag and username.'
          )
        );
  }

  const update = {
    ...addToObjectIfExists('email', body.email),
    ...(body.emailConfirmed !== undefined
      ? {
        emailConfirmed: true,
        emailConfirmCode: null,
      }
      : undefined),
    ...(body.newPassword?.trim?.()
      ? {
        password: await bcrypt.hash(body.newPassword.trim(), 10),
        passwordVersion: { increment: 1 },
      }
      : undefined),
    user: {
      update: {
        ...addToObjectIfExists('username', body.username),
        ...addToObjectIfExists('tag', body.tag),
        ...addToObjectIfExists('badges', body.badges),
      },
    },
  };

  const user = await prisma.account.update({
    where: { userId },
    data: update,
    select: {
      email: true,
      user: {
        include: {
          profile: true,
        },
      },
    },
  });
  await removeAccountCacheByUserIds([userId]);

  if (body.newPassword?.trim()) {
    const broadcaster = getIO().in(userId);
    broadcaster.emit(AUTHENTICATE_ERROR, { message: 'Invalid Token' });
    broadcaster.disconnectSockets(true);
  }

  await prisma.auditLog.create({
    data: {
      id: generateId(),
      actionType: AuditLogType.userUpdate,
      actionById: req.accountCache.user.id,
      username: user.user.username,
      userId: user.user.id,
    }
  })

  res.json(user);
}
