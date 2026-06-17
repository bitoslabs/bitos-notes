/**
 * core/eventbus.js
 * Tiny pub/sub — lets features communicate without direct coupling (SRP).
 * Any module can publish a topic; any module can subscribe. No imports between
 * feature modules needed.
 */

export const bus = (() => {
  const subs = new Map();

  return {
    /** Subscribe to a topic. Returns an unsubscribe function. */
    on(topic, handler) {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(handler);
      return () => subs.get(topic)?.delete(handler);
    },

    /** Publish an event. Handlers run synchronously; errors are isolated. */
    emit(topic, payload) {
      const set = subs.get(topic);
      if (!set) return;
      for (const h of set) {
        try { h(payload); }
        catch (err) { console.error(`[bus] handler error for "${topic}"`, err); }
      }
    },

    /** One-shot subscription: auto-unsubscribes after first event. */
    once(topic, handler) {
      const off = this.on(topic, (p) => { off(); handler(p); });
      return off;
    },
  };
})();
