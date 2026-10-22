/** Removes `user:password@` from every URL in a text, e.g. proxy URLs quoted in SDK or undici error messages. */
export const redactUrlCredentials = (text: string): string => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1<credentials>@');

export const errorMessage = (err: unknown): string => redactUrlCredentials(err instanceof Error ? err.message : String(err));
