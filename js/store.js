/**
 * store.js - everything lives on this device.
 *
 * localStorage, wrapped so that a private window, cleared site data or a
 * quota error degrades to an in-memory session instead of a white screen.
 * No account, no server, no sync - which is a real trade-off, so the You
 * screen offers an export and says plainly that a lost phone is a lost log.
 */

const KEY = 'victu.v1';

const BLANK = {
  profile: null,
  katoriMl: 150,
  log: {},            // 'YYYY-MM-DD' -> [entry]
  weights: [],        // [{ date, kg }]
  priceOverrides: {}, // foodId -> INR/kg
  dislikes: [],
  pantry: {},         // foodId -> { haveG: number|null, updatedAt }  (null = "always have")
  scanned: [],        // foods pulled from Open Food Facts, cached forever
  plan: null,         // last generated week
  targetNudge: 0,     // kcal, from weekly reviews
};

let memory = structuredClone(BLANK);
let persistent = true;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(BLANK);
    return { ...structuredClone(BLANK), ...JSON.parse(raw) };
  } catch {
    persistent = false;
    return structuredClone(BLANK);
  }
}

function write(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    persistent = true;
  } catch {
    persistent = false; // private window, or quota. Session still works.
  }
}

memory = read();

export const store = {
  get state() { return memory; },
  get isPersistent() { return persistent; },

  update(patch) {
    memory = typeof patch === 'function' ? patch(memory) : { ...memory, ...patch };
    write(memory);
    return memory;
  },

  // --- log -----------------------------------------------------------------

  entriesFor(date) {
    return memory.log[date] ?? [];
  },

  addEntry(date, entry) {
    const list = [...(memory.log[date] ?? []), { ...entry, id: crypto.randomUUID() }];
    return this.update({ log: { ...memory.log, [date]: list } });
  },

  addEntries(date, entries) {
    const list = [...(memory.log[date] ?? []), ...entries.map((e) => ({ ...e, id: crypto.randomUUID() }))];
    return this.update({ log: { ...memory.log, [date]: list } });
  },

  removeEntry(date, id) {
    const list = (memory.log[date] ?? []).filter((e) => e.id !== id);
    return this.update({ log: { ...memory.log, [date]: list } });
  },

  // --- weight --------------------------------------------------------------

  addWeight(date, kg) {
    const others = memory.weights.filter((w) => w.date !== date);
    return this.update({ weights: [...others, { date, kg }].sort((a, b) => a.date.localeCompare(b.date)) });
  },

  // --- prices --------------------------------------------------------------

  setPrice(foodId, perKg) {
    return this.update({ priceOverrides: { ...memory.priceOverrides, [foodId]: perKg } });
  },

  clearPrice(foodId) {
    const next = { ...memory.priceOverrides };
    delete next[foodId];
    return this.update({ priceOverrides: next });
  },

  // --- pantry --------------------------------------------------------------

  /** haveG null means "I always have this" and is never decremented. */
  setPantry(foodId, haveG) {
    return this.update({
      pantry: { ...memory.pantry, [foodId]: { haveG, updatedAt: new Date().toISOString() } },
    });
  },

  removePantry(foodId) {
    const next = { ...memory.pantry };
    delete next[foodId];
    return this.update({ pantry: next });
  },

  /**
   * Cooking something uses up what it used. Only entries with a quantity are
   * touched - a staple you marked "always have" stays put, because pretending
   * to know how much atta is in the dabba is how pantry trackers start lying.
   */
  consumeFromPantry(ingredients) {
    const next = { ...memory.pantry };
    let changed = false;
    for (const { food, g } of ingredients) {
      const held = next[food];
      if (!held || held.haveG == null) continue;
      const left = Math.max(0, held.haveG - g);
      next[food] = { haveG: left, updatedAt: new Date().toISOString() };
      changed = true;
    }
    return changed ? this.update({ pantry: next }) : memory;
  },

  /** Marking the shopping list bought puts it all in the pantry. */
  stockFromShopping(items) {
    const next = { ...memory.pantry };
    for (const i of items) {
      if (!i.buyG) continue;
      const held = next[i.foodId];
      if (held?.haveG == null && held) continue; // "always have" - leave alone
      next[i.foodId] = { haveG: (held?.haveG ?? 0) + i.buyG, updatedAt: new Date().toISOString() };
    }
    return this.update({ pantry: next });
  },

  // --- scanned products ----------------------------------------------------

  addScanned(food) {
    const others = memory.scanned.filter((f) => f.id !== food.id);
    return this.update({ scanned: [...others, food] });
  },

  toggleDislike(recipeId) {
    const has = memory.dislikes.includes(recipeId);
    return this.update({
      dislikes: has ? memory.dislikes.filter((d) => d !== recipeId) : [...memory.dislikes, recipeId],
    });
  },

  // --- portability ---------------------------------------------------------

  export() {
    return JSON.stringify({ app: 'victu', version: 1, exportedAt: new Date().toISOString(), data: memory }, null, 2);
  },

  import(json) {
    const parsed = JSON.parse(json);
    const data = parsed?.data ?? parsed;
    if (!data || typeof data !== 'object') throw new Error('That file is not a Victu backup.');
    memory = { ...structuredClone(BLANK), ...data };
    write(memory);
    return memory;
  },

  reset() {
    memory = structuredClone(BLANK);
    try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
    return memory;
  },
};

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftDate(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
