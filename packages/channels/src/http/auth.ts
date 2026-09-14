/**
 * Resolves the principal a request acts as, or `undefined` when it is unauthenticated. `http()`
 * runs it before anything else: an unauthenticated request is answered `401` before the Route
 * store or a Provider is touched. It receives a clone of the request, so reading the body to
 * verify a signature does not consume the endpoint's body.
 */
export type Authenticator = (request: Request) => Promise<string | undefined>;

const bearerHeader = /^Bearer +(\S+)$/i;

/**
 * Bearer-token authenticator. `tokens` maps each accepted token to the principal it acts as, so
 * `Authorization: Bearer <token>` resolves to that principal; a missing header, another scheme, or
 * an unknown token is unauthenticated.
 */
export const bearer = (tokens: Readonly<Record<string, string>>): Authenticator => {
  const principals = new Map(Object.entries(tokens));
  return async (request) => {
    const token = bearerHeader.exec(request.headers.get("authorization") ?? "")?.[1];
    return token === undefined ? undefined : principals.get(token);
  };
};
