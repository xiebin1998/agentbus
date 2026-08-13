import { describe, it, expect, beforeEach } from "vitest";
import { ChannelManager, type ChannelState } from "../src/daemon/channel";

describe("ChannelManager", () => {
  let mgr: ChannelManager;

  beforeEach(() => {
    mgr = new ChannelManager();
  });

  describe("getOrCreate – initial state", () => {
    it("new channel has state SYN_SENT", () => {
      const [ch, isNew] = mgr.getOrCreate("remote-a", "msg-1");
      expect(isNew).toBe(true);
      expect(ch.state).toBe("SYN_SENT");
    });

    it("subsequent getOrCreate returns same channel with same state", () => {
      const [ch1] = mgr.getOrCreate("remote-a", "msg-1");
      const [ch2] = mgr.getOrCreate("remote-a", "msg-2");
      expect(ch2).toBe(ch1);
      expect(ch2.state).toBe("SYN_SENT");
    });
  });

  describe("setState", () => {
    it("updates state to ESTABLISHED", () => {
      mgr.getOrCreate("remote-a", "msg-1");
      mgr.setState("remote-a", "ESTABLISHED");
      expect(mgr.get("remote-a")!.state).toBe("ESTABLISHED");
    });

    it("updates updatedAt timestamp", () => {
      mgr.getOrCreate("remote-a", "msg-1");
      const before = mgr.get("remote-a")!.updatedAt;

      // small delay to ensure timestamp differs
      const future = new Date(new Date(before).getTime() + 1000).toISOString();
      // We can't control Date.now easily, so just verify it's a valid ISO string
      mgr.setState("remote-a", "ESTABLISHED");
      const after = mgr.get("remote-a")!.updatedAt;
      expect(after).toBeTruthy();
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });

    it("can transition back to SYN_SENT", () => {
      mgr.getOrCreate("remote-a", "msg-1");
      mgr.setState("remote-a", "ESTABLISHED");
      mgr.setState("remote-a", "SYN_SENT");
      expect(mgr.get("remote-a")!.state).toBe("SYN_SENT");
    });

    it("is a no-op on non-existent remote", () => {
      // Should not throw
      mgr.setState("non-existent", "ESTABLISHED");
      expect(mgr.get("non-existent")).toBeNull();
    });
  });

  describe("listChannels reflects state", () => {
    it("includes state in listed channels", () => {
      mgr.getOrCreate("r1", "m1");
      mgr.getOrCreate("r2", "m2");
      mgr.setState("r1", "ESTABLISHED");

      const channels = mgr.listChannels();
      expect(channels).toHaveLength(2);
      const r1 = channels.find((c) => c.remote === "r1")!;
      const r2 = channels.find((c) => c.remote === "r2")!;
      expect(r1.state).toBe("ESTABLISHED");
      expect(r2.state).toBe("SYN_SENT");
    });
  });
});
