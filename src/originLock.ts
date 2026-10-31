const heldHere = new Set<string>();

/**
 * Runs `run` when nobody else in this origin holds `name`, and returns "busy" otherwise:
 * `navigator.locks` across tabs, the set within this tab when it is missing.
 */
export async function withOriginLock<T>(name: string, run: () => Promise<T>): Promise<T | "busy"> {
  if (heldHere.has(name)) return "busy";
  heldHere.add(name);
  try {
    const locks = globalThis.navigator?.locks;
    if (!locks) return await run();
    return await locks.request(name, { ifAvailable: true }, (lock) => (lock ? run() : "busy" as const));
  } finally {
    heldHere.delete(name);
  }
}
