type PathNames = {
  rooms: string; // presence
  signaling: string; // WebRTC offers/answers
  updates: string; // the document's edit log
  snapshots: string; // compacted document state
  meta: string; // document metadata (snapshot generation, merge lease)
};

export type DatabasePathsConfig = {
  structure: "flat" | "nested";

  // Separate roots keyed by docId, e.g. rooms: '/rooms' -> '/rooms/{docId}'.
  flat?: Partial<PathNames>;

  // Everything under {basePath}/{docId}/; missing sub-paths default to their name.
  nested?: {
    basePath: string; // e.g., '/documents'
    subPaths?: Partial<PathNames>;
  };
};

export const DEFAULT_DATABASE_PATHS: DatabasePathsConfig = {
  structure: "nested",
  nested: { basePath: "/documents" },
};

const PATH_NAMES: (keyof PathNames)[] = ["rooms", "signaling", "updates", "snapshots", "meta"];

export type ConnectionState = "disconnected" | "connecting" | "connected";

// Characters Firebase rejects in keys, plus "/" which would escape the document.
const INVALID_DOC_ID = /[.#$\[\]/]/;

export function validateDocId(docId: string): void {
  if (typeof docId !== "string" || docId.trim().length === 0) {
    throw new Error("docId must be a non-empty string");
  }
  if (INVALID_DOC_ID.test(docId)) {
    throw new Error(
      `docId "${docId}" contains a character Firebase does not allow in keys (. # $ [ ] /)`
    );
  }
}

export function buildDatabasePaths(
  config: DatabasePathsConfig | undefined,
  docId: string
): PathNames {
  validateDocId(docId);
  const resolved = config ?? DEFAULT_DATABASE_PATHS;
  const paths = {} as PathNames;
  if (resolved.structure === "flat") {
    for (const name of PATH_NAMES) {
      paths[name] = `${resolved.flat?.[name] ?? `/${name}`}/${docId}`;
    }
  } else if (resolved.structure === "nested") {
    if (!resolved.nested)
      throw new Error("Nested structure requires nested config");
    const base = `${resolved.nested.basePath}/${docId}`;
    for (const name of PATH_NAMES) {
      paths[name] = `${base}/${resolved.nested.subPaths?.[name] ?? name}`;
    }
  } else {
    throw new Error(`Unknown database structure: ${resolved.structure}`);
  }
  return paths;
}
