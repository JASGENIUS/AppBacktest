/**
 * Minimal dot-path lookup: "loads.0.pods" walks objects by key and arrays by
 * numeric index. Returns undefined on any miss (JSON has no undefined, so
 * undefined always means "not found"). An empty path returns obj itself.
 */
export function getPath(obj: unknown, dotPath: string): unknown {
  if (dotPath === "") return obj;
  let current: unknown = obj;
  for (const segment of dotPath.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined; // primitive mid-path
    }
  }
  return current;
}
