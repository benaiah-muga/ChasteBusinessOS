export function workmateLoginReturnHref(search: string): string {
  const prompt = new URLSearchParams(search).get("workmatePrompt");
  return prompt === null ? "/" : `/?workmatePrompt=${encodeURIComponent(prompt)}`;
}
