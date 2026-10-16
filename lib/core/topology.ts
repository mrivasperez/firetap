// Peers sorted into a ring link at distances 1, 2, 4, ... up to maxDegree.
// The rule is symmetric, so both sides agree on every link, and the ring keeps
// the graph connected with about log2(n) hops.
export function desiredNeighbors(
  selfId: string,
  otherIds: Iterable<string>,
  maxDegree: number
): Set<string> {
  const others = Array.from(new Set(otherIds)).filter((id) => id !== selfId);
  if (others.length <= maxDegree) return new Set(others);

  const ring = [selfId, ...others].sort();
  const n = ring.length;
  const self = ring.indexOf(selfId);
  const desired = new Set<string>();

  for (let distance = 1; distance <= Math.floor(n / 2); distance *= 2) {
    const ahead = ring[(self + distance) % n];
    const behind = ring[(self - distance + n) % n];
    const added = new Set([ahead, behind]);
    if (desired.size + added.size > maxDegree) break;
    added.forEach((id) => desired.add(id));
  }
  return desired;
}
