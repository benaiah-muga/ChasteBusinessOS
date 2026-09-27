export function consumeWorkmatePrompt(
  url: URL,
  allowedPrompts: readonly string[],
): { prompt: string; href: string } | null {
  const prompt = url.searchParams.get("workmatePrompt");
  if (!prompt || !allowedPrompts.includes(prompt)) return null;

  url.searchParams.delete("workmatePrompt");
  return {
    prompt,
    href: `${url.pathname}${url.search}${url.hash}`,
  };
}
