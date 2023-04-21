import { Request, Response, Router } from 'express';
import { body } from 'express-validator';
import { customExpressValidatorResult, generateError } from '../../common/errorHandler';
import { authenticate } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import { createPost } from '../../services/Post';
import { connectBusboyWrapper } from '../../middleware/connectBusboyWrapper';
import { uploadImage } from '../../common/nerimityCDN';


export function postCreate(Router: Router) {
  Router.post('/posts', 
    authenticate(),
    rateLimit({
      name: 'create_post',
      expireMS: 20000,
      requestCount: 5,
    }),
    connectBusboyWrapper,
    body('content')
      .isString().withMessage('Content must be a string!')
      .isLength({ min: 1, max: 500 }).withMessage('Content length must be between 1 and 500 characters.')
      .optional(true),
    body('postId')
      .isString().withMessage('postId must be a string!')
      .isLength({ min: 1, max: 500 }).withMessage('Content length must be between 1 and 500 characters.')
      .optional(true),
    route
  );
}


interface Body {
  content: string;
  postId?: string; // Used if you want to reply to a post
}

async function route (req: Request, res: Response) {
  const body = req.body as Body;

  const validateError = customExpressValidatorResult(req);

  if (validateError) {
    return res.status(400).json(validateError);
  }
  if (!body.content?.trim() && !req.fileInfo?.file) {
    return res.status(400).json(generateError('content or attachment is required.'));
  }


  let attachment: { width?: number; height?: number; path: string} | undefined = undefined;

  if (req.fileInfo?.file) {
    const [uploadedImage, err] = await uploadImage(req.fileInfo?.file, req.fileInfo.info.filename, req.accountCache.user.id);
    if (uploadedImage) {
      attachment = {
        width: uploadedImage.dimensions.width,
        height: uploadedImage.dimensions.height,
        path: uploadedImage.path
      };
    }
  }


  const post = await createPost({
    content: body.content,
    userId: req.accountCache.user.id,
    commentToId: body.postId,
    attachment
  });


  res.json(post);
}