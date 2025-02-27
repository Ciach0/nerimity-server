import { NextFunction, Request, Response } from 'express';
import { checkRateLimited } from '../cache/RateLimitCache';
import { generateError } from '../common/errorHandler';


interface Options {
  name: string
  expireMS: number
  requestCount: number,
  useIP?: boolean // By default, it uses user id.
  globalLimit?: boolean // Rate limit globally
  nextIfRatedLimited?: boolean // false by default
  message?: string;
}

export function rateLimit (opts: Options) {
  return async (req: Request, res: Response, next: NextFunction) => {



    const ip = req.userIP.replace(/:/g, '=');

    let id = '';
    
    if (!opts.globalLimit) {
      id = opts.useIP ? ip : req.accountCache?.user.id;
      if (opts.name) {
        id = `${id}-${opts.name}`;
      }
    }

    if (opts.globalLimit) {
      id = opts.name;
    }

    const ttl = await checkRateLimited({
      id,
      expireMS: opts.expireMS,
      requestCount: opts.requestCount
    });

    if (ttl && opts.nextIfRatedLimited) {
      req.rateLimited = ttl as number;
      return next();
    }

    if (ttl) {
      return res.status(429).json({...generateError(opts.message || 'Slow down!'), ttl});
    }


    next();
  };
}