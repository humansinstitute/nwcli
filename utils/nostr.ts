import { RelayPool } from "applesauce-relay";

let pool: RelayPool | null = null;

export function getRelayPool(): RelayPool {
  if (!pool) {
    pool = new RelayPool();
  }
  return pool;
}

export function closeRelayPool() {
  try {
    // RelayPool may expose a close/stop; call if present
    (pool as any)?.close?.();
    (pool as any)?.stop?.();
  } catch {}
  pool = null;
}

