import { describe, it, expect } from "vitest";
import { generateUserId } from "../src/config";

describe("Utility Functions", () => {
  describe("generateUserId", () => {
    it("should generate a valid user ID with correct format", () => {
      const userId = generateUserId();

      expect(userId).toBeDefined();
      expect(typeof userId).toBe("string");
      expect(userId).toMatch(/^user-\d+-[a-z0-9]+$/);
    });

    it("should generate unique IDs on subsequent calls", () => {
      const id1 = generateUserId();
      const id2 = generateUserId();
      const id3 = generateUserId();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('should start with "user-" prefix', () => {
      const userId = generateUserId();
      
      expect(userId.startsWith("user-")).toBe(true);
    });

    it("should contain timestamp component", () => {
      const beforeTime = Date.now();
      const userId = generateUserId();
      const afterTime = Date.now();

      const parts = userId.split("-");
      const timestamp = parseInt(parts[1]);

      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });

    it("should handle rapid consecutive calls", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateUserId());
      }

      expect(ids.size).toBe(100);
    });

    it("should generate IDs with different random suffixes", () => {
      const id1 = generateUserId();
      const id2 = generateUserId();

      const suffix1 = id1.split("-")[2];
      const suffix2 = id2.split("-")[2];

      expect(suffix1).toBeDefined();
      expect(suffix2).toBeDefined();
    });
  });
});
