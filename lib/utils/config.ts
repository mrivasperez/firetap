export type DatabasePathsConfig = {
  structure: "flat" | "nested";

  // Separate roots keyed by docId, e.g. rooms: '/rooms' -> '/rooms/{docId}'.
  flat?: {
    documents: string;
    rooms: string;
    snapshots: string;
    signaling: string;
  };

  // For 'nested' structure: all under documents/{{docId}}
  nested?: {
    basePath: string; // e.g., '/documents'
    subPaths: {
      documents: string; // e.g., 'documents'
      rooms: string; // e.g., 'rooms'
      snapshots: string; // e.g., 'snapshots'
      signaling: string; // e.g., 'signaling'
    };
  };
};

export const DEFAULT_DATABASE_PATHS: DatabasePathsConfig = {
  structure: "nested",
  nested: {
    basePath: "/documents",
    subPaths: {
      documents: "documents",
      rooms: "rooms",
      snapshots: "snapshots",
      signaling: "signaling",
    },
  },
};

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
) {
  validateDocId(docId);
  const resolved = config ?? DEFAULT_DATABASE_PATHS;
  if (resolved.structure === "flat") {
    if (!resolved.flat) throw new Error("Flat structure requires flat config");
    return {
      documents: `${resolved.flat.documents}/${docId}`,
      rooms: `${resolved.flat.rooms}/${docId}`,
      snapshots: `${resolved.flat.snapshots}/${docId}`,
      signaling: `${resolved.flat.signaling}/${docId}`,
    };
  } else if (resolved.structure === "nested") {
    if (!resolved.nested)
      throw new Error("Nested structure requires nested config");
    const base = `${resolved.nested.basePath}/${docId}`;
    return {
      documents: `${base}/${resolved.nested.subPaths.documents}`,
      rooms: `${base}/${resolved.nested.subPaths.rooms}`,
      snapshots: `${base}/${resolved.nested.subPaths.snapshots}`,
      signaling: `${base}/${resolved.nested.subPaths.signaling}`,
    };
  } else {
    throw new Error(`Unknown database structure: ${resolved.structure}`);
  }
}
