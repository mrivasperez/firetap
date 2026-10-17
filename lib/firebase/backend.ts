// The database operations DocumentStore needs, so it can run on the web SDK
// in browsers and on the Admin SDK on servers.
export type DatabaseBackend = {
  /** The value at path, or null when nothing is stored there. */
  get(path: string): Promise<unknown>;
  set(path: string, value: unknown): Promise<void>;
  update(path: string, values: Record<string, unknown>): Promise<void>;
  remove(path: string): Promise<void>;
  /** A new push key under path, generated locally. */
  newKey(path: string): string;
  /** Return undefined from apply to abort. */
  transaction(
    path: string,
    apply: (current: unknown) => unknown
  ): Promise<{ committed: boolean; value: unknown }>;
  /** Milliseconds to add to the local clock to get the server's, or null if unknown. */
  serverTimeOffset(): Promise<number | null>;
  /** Calls onChild for every child of path with a key after afterKey, now and as children are added or changed. */
  watchChildren?(
    path: string,
    afterKey: string | null,
    onChild: (key: string, value: unknown) => void
  ): () => void;
};
