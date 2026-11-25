import { HttpError } from './errors.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Express middleware that verifies a Firebase ID token and puts the decoded claims on req.user.
 * Revocation is not checked: that costs an Auth API call per request, which becomes its own
 * bottleneck at entry-opening traffic. Tokens expire after an hour regardless.
 * @param {{verifyIdToken: (token: string) => Promise<import('firebase-admin/auth').DecodedIdToken>}} auth
 */
export function requireUser(auth) {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.get('authorization') ?? '');
    if (!match) {
      throw new HttpError(401, 'missing_token');
    }
    try {
      req.user = await auth.verifyIdToken(match[1]);
    } catch {
      throw new HttpError(401, 'invalid_token');
    }
    next();
  };
}
