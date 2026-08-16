import type { ReaderWarning } from "../contracts";

export const MAX_WARNING_EXCERPT_CODE_POINTS = 200;

export function warningExcerpt(sourceLine: string): string {
  const codePoints = [...sourceLine];
  if (codePoints.length <= MAX_WARNING_EXCERPT_CODE_POINTS) return sourceLine;
  return `${codePoints.slice(0, MAX_WARNING_EXCERPT_CODE_POINTS - 1).join("")}…`;
}

export function readerWarning(
  code: string,
  message: string,
  line?: number,
  sourceLine?: string,
): ReaderWarning {
  if (line === undefined) return { code, message };
  return {
    code,
    message,
    line,
    ...(sourceLine === undefined
      ? {}
      : { excerpt: warningExcerpt(sourceLine) }),
  };
}
