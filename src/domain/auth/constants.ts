/**
 * Session cookie name — shared between the auth domain module and the
 * Edge middleware so the middleware does not need to import the auth
 * module (which uses node:crypto, unavailable in the Edge runtime).
 */
export const sessionCookieName = 'leabhar-session';
