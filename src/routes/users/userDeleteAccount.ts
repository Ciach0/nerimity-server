import { Request, Response, Router } from 'express';
import { body } from 'express-validator';
import {
  customExpressValidatorResult,
  generateError,
} from '../../common/errorHandler';
import { authenticate } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import { prisma } from '../../common/database';
import { checkUserPassword } from '../../services/UserAuthentication';
import { deleteAccount } from '../../services/User/UserManagement';

export function userDeleteAccount(Router: Router) {
  Router.delete(
    '/users/delete-account',
    authenticate(),
    rateLimit({
      name: 'delete_account',
      expireMS: 60000,
      requestCount: 20,
    }),
    body('password')
      .not()
      .isEmpty()
      .withMessage('Password required!')
      .isString()
      .withMessage('Password must be a string.'),
    route
  );
}

interface Body {
  password: string;
}

async function route(req: Request, res: Response) {
  const body: Body = req.body;

  const validateError = customExpressValidatorResult(req);
  if (validateError) {
    return res.status(400).json(validateError);
  }

  const account = await prisma.account
    .findUnique({
      where: { id: req.accountCache.id },
      select: { password: true },
    })
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    .catch(() => { });

  if (!account)
    return res
      .status(404)
      .json(generateError('Something went wrong. Try again later.'));

  const isPasswordValid = await checkUserPassword(
    account.password,
    body.password
  );

  if (!isPasswordValid)
    return res.status(403).json(generateError('Invalid password.', 'password'));

  const [, error] = await deleteAccount(req.accountCache.user.id);

  if (error) {
    return res.status(400).json(error);
  }

  res.json({ status: true });
}
