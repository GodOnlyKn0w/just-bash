/**
 * An Error carrying the errno name as `code`, the way Node's fs reports
 * failures. The message keeps the `ECODE: ...` prefix, so callers that match
 * on the message and callers that read `code` see the same failure.
 */
export function fsError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
