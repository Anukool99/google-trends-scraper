/** Longer error text is cut before redacting; the regex below is quadratic on long scheme-like runs. */
const MAX_MESSAGE_LENGTH = 4000;

/** Removes `user:password@` from every URL in a text, e.g. proxy URLs quoted in SDK or undici error messages. */
export const redactUrlCredentials = (text: string): string => {
    // Cutting can split a URL; dropping the last partial word keeps a cut-off password out of the result.
    const capped = text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH).replace(/\S*$/, '')}…` : text;
    return capped.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1<credentials>@');
};

/**
 * The credentials part of a proxy URL, taken without URL parsing so that malformed URLs
 * (e.g. a password with an unencoded `/`) are covered too.
 */
const credentialsOf = (url: string): string[] => {
    const start = url.indexOf('://');
    const at = url.lastIndexOf('@');
    if (start < 0 || at <= start + 3) return [];
    const userinfo = url.slice(start + 3, at);
    const colon = userinfo.indexOf(':');
    return colon < 0 ? [userinfo] : [userinfo, userinfo.slice(colon + 1)];
};

/** Like `redactUrlCredentials`, and also removes the given proxy URLs and their credentials wherever they appear verbatim. */
export const errorMessage = (err: unknown, proxyUrls: readonly string[] = []): string => {
    let message = err instanceof Error ? err.message : String(err);
    for (const url of proxyUrls) {
        message = message.split(url).join('<proxy>');
        for (const secret of credentialsOf(url)) {
            if (secret) message = message.split(secret).join('<redacted>');
        }
    }
    return redactUrlCredentials(message);
};
