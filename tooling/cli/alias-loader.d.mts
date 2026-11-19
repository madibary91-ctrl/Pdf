export function candidateFor(base: string): string | null;
export function resolve(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (specifier: string, context: { parentURL?: string }) => unknown,
): Promise<unknown>;
