/**
 * Run with: node --test tests/
 *
 * These are not decorative. Every assertion here is a number the app shows the
 * user, and the budget and safety-floor cases are the ones most likely to
 * break quietly during a refactor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  bmr, tdee, dailyTarget, referenceWeight, bmi,
  portionToStoredGrams, nutritionFor, roundNutrition, addNutrition,
  pricePerKg, costOfStoredGrams, recipeNutrition, recipeCost, proteinValue,
  generateWeekPlan, shoppingList, buildDb, measuresFor,
  weightTrend, suggestAdjustment, formatQty,
  repairDay, spreadSurplus, pantryMatch, shoppingListMinusPantry,
  packPlan, tillCost, recipeCostBreakdown, fitCheck,
  packMeasures, ASSUMED_STAPLES,
} from '../js/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(here, '..', 'data', f), 'utf8'));

const db = buildDb({
  foods: read('foods.json'),
  portions: read('portions.json'),
  seasonality: read('seasonality.json'),
  recipes: read('recipes.json'),
  packaged: read('packaged.json'),
});

// --- data integrity ---------------------------------------------------------

test('every recipe ingredient resolves to a known food', () => {
  for (const r of db.recipes) {
    for (const item of r.ing) {
      assert.ok(db.foodsById[item.food], `${r.id} references unknown food "${item.food}"`);
    }
  }
});

test('every serveWith resolves to a known measure', () => {
  for (const r of db.recipes) {
    for (const spec of r.serveWith ?? []) {
      const id = spec.split(':')[0];
      assert.ok(db.measuresById[id], `${r.id} references unknown measure "${id}"`);
    }
  }
});

test('macros are physically consistent with stated calories', () => {
  // Food tables disagree on whether fibre counts toward carbohydrate energy -
  // USDA excludes it for vegetables, IFCT often reports total carbohydrate.
  // So the honest check is a band: stated kcal must sit between the
  // fibre-excluded and fibre-included Atwater sums, with slack for rounding.
  // Narrow enough to catch a typo, wide enough not to fight the source data.
  for (const f of db.foods) {
    const n = f.per100g;
    if (n.kcal === 0) continue;
    const fibre = n.fiber ?? 0;
    const lo = (n.p * 4 + Math.max(0, n.c - fibre) * 4 + n.f * 9) * 0.88;
    const hi = (n.p * 4 + n.c * 4 + n.f * 9) * 1.12;
    assert.ok(
      n.kcal >= lo && n.kcal <= hi,
      `${f.id}: stated ${n.kcal} kcal is outside the plausible band ${Math.round(lo)}-${Math.round(hi)} implied by its macros`
    );
  }
});

test('seasonality keys are valid food ids', () => {
  for (const id of Object.keys(db.seasonality.produce)) {
    assert.ok(db.foodsById[id], `seasonality references unknown food "${id}"`);
  }
});

// --- energy -----------------------------------------------------------------

test('BMR matches Mifflin-St Jeor worked by hand', () => {
  // male, 80 kg, 175 cm, 30 y: 10*80 + 6.25*175 - 5*30 + 5 = 1748.75
  assert.equal(
    Math.round(bmr({ sex: 'male', weightKg: 80, heightCm: 175, ageYears: 30 })),
    1749
  );
  // female, 60 kg, 160 cm, 30 y: 600 + 1000 - 150 - 161 = 1289
  assert.equal(
    Math.round(bmr({ sex: 'female', weightKg: 60, heightCm: 160, ageYears: 30 })),
    1289
  );
});

test('TDEE applies the activity factor', () => {
  const p = { sex: 'male', weightKg: 80, heightCm: 175, ageYears: 30, activity: 'light' };
  assert.equal(Math.round(tdee(p)), Math.round(1748.75 * 1.375));
});

test('a 0.5 kg/week goal produces the textbook ~550 kcal deficit', () => {
  const p = { sex: 'male', weightKg: 80, heightCm: 175, ageYears: 30, activity: 'light', goalKgPerWeek: 0.5 };
  const t = dailyTarget(p);
  assert.equal(t.maintenanceKcal - t.kcal, Math.round((0.5 * 7700) / 7));
  assert.equal(t.notes.length, 0, 'nothing should be clamped for a sane goal');
  assert.equal(t.projectedKgPerWeek, 0.5);
});

test('an aggressive goal is clamped, and says so', () => {
  const p = { sex: 'male', weightKg: 80, heightCm: 175, ageYears: 30, activity: 'sedentary', goalKgPerWeek: 2 };
  const t = dailyTarget(p);
  assert.ok(t.projectedKgPerWeek <= 0.76, `projected ${t.projectedKgPerWeek} should be capped`);
  assert.ok(t.notes.length > 0, 'must explain the clamp');
  assert.ok(t.kcal >= t.maintenanceKcal * 0.75 - 1, 'deficit must not exceed 25% of maintenance');
});

test('the absolute calorie floor holds for a small sedentary user', () => {
  const p = { sex: 'female', weightKg: 45, heightCm: 150, ageYears: 55, activity: 'sedentary', goalKgPerWeek: 0.75 };
  const t = dailyTarget(p);
  assert.ok(t.kcal >= 1200, `${t.kcal} must not fall below the 1200 floor`);
});

test('protein target uses BMI-25 reference weight for a heavy user', () => {
  const heavy = { weightKg: 120, heightCm: 170 };
  const ref = referenceWeight(heavy);
  assert.ok(ref < 120 && ref > 70, `reference ${ref} should sit near BMI 25`);
  assert.equal(Math.round(ref), Math.round(25 * 1.7 * 1.7));
  // In-range user keeps their own weight.
  assert.equal(referenceWeight({ weightKg: 70, heightCm: 175 }), 70);
});

test('bmi is computed correctly', () => {
  assert.equal(bmi({ weightKg: 80, heightCm: 175 }), 26.1);
});

// --- portions ---------------------------------------------------------------

test('a katori of dal resolves to roughly 50 g of dry dal', () => {
  const { storedG } = portionToStoredGrams({
    food: db.foodsById.toor_dal,
    measure: db.measuresById.katori_dal,
    qty: 1,
  });
  assert.equal(Math.round(storedG), 50);
  const n = roundNutrition(nutritionFor(db.foodsById.toor_dal, storedG));
  assert.ok(n.p > 10 && n.p < 12, `a katori of dal should carry ~11 g protein, got ${n.p}`);
});

test('katori calibration scales every katori measure', () => {
  const big = portionToStoredGrams({
    food: db.foodsById.toor_dal,
    measure: db.measuresById.katori_dal,
    qty: 1,
    katoriScale: 1.33,
  });
  assert.equal(Math.round(big.storedG), 67);
});

test('a roti resolves to its raw atta weight, not its cooked weight', () => {
  const { storedG } = portionToStoredGrams({
    food: db.foodsById.atta,
    measure: db.measuresById.roti_medium,
    qty: 2,
  });
  assert.equal(storedG, 64);
});

test('paratha fat is surfaced separately rather than hidden in the flour', () => {
  const { storedG, addFatG } = portionToStoredGrams({
    food: db.foodsById.atta,
    measure: db.measuresById.paratha_plain,
    qty: 1,
  });
  assert.equal(storedG, 45);
  assert.equal(addFatG, 5);
});

test('grams passes straight through', () => {
  const { storedG } = portionToStoredGrams({
    food: db.foodsById.paneer,
    measure: db.measuresById.g,
    qty: 100,
  });
  assert.equal(storedG, 100);
});

test('measuresFor puts the sensible default first', () => {
  const list = measuresFor(db, db.foodsById.toor_dal);
  assert.equal(list[0].id, 'katori_dal');
});

// --- price and seasonality --------------------------------------------------

test('in-season produce is cheaper than out-of-season', () => {
  const janPalak = pricePerKg(db, 'spinach', 'jan');
  const junPalak = pricePerKg(db, 'spinach', 'jun');
  assert.ok(junPalak > janPalak, 'June palak must not be priced like January palak');
  assert.equal(janPalak, 22 * 0.8);
  assert.equal(junPalak, 22 * 2.2);
});

test('a user price correction overrides both base and season', () => {
  assert.equal(pricePerKg(db, 'spinach', 'jun', { spinach: 30 }), 30);
});

test('staples with no seasonality entry keep their base price', () => {
  assert.equal(pricePerKg(db, 'toor_dal', 'jun'), 126);
});

// --- recipes ----------------------------------------------------------------

test('dal tadka nutrition and cost land in a believable range', () => {
  const r = db.recipesById.dal_tadka;
  const n = roundNutrition(recipeNutrition(db, r, 1));
  assert.ok(n.kcal > 230 && n.kcal < 330, `kcal ${n.kcal} out of range`);
  assert.ok(n.p > 11 && n.p < 16, `protein ${n.p} out of range`);
  const c = recipeCost(db, r, 1, 'oct');
  assert.ok(c > 8 && c < 25, `cost Rs ${c.toFixed(1)} out of range`);
});

test('scaling a recipe scales nutrition and cost linearly', () => {
  const r = db.recipesById.khichdi;
  const one = recipeNutrition(db, r, 1);
  const four = recipeNutrition(db, r, 4);
  assert.ok(Math.abs(four.kcal - one.kcal * 4) < 0.001);
  // Cost has a flat per-serving spice allowance, so it scales linearly too.
  const c1 = recipeCost(db, r, 1, 'oct');
  const c4 = recipeCost(db, r, 4, 'oct');
  assert.ok(Math.abs(c4 - c1 * 4) < 0.001);
});

test('soya is the best protein value and paneer among the worst', () => {
  const soya = proteinValue(db, db.recipesById.soya_keema, 'oct');
  const paneer = proteinValue(db, db.recipesById.paneer_bhurji, 'oct');
  assert.ok(soya < paneer, `soya Rs${soya.toFixed(2)}/g should beat paneer Rs${paneer.toFixed(2)}/g protein`);
  assert.ok(soya < 2.0, `soya protein should cost under Rs 2/g, got ${soya.toFixed(2)}`);
});

// --- planner ----------------------------------------------------------------

const profile = {
  sex: 'male', weightKg: 80, heightCm: 175, ageYears: 28,
  activity: 'light', goalKgPerWeek: 0.5, diet: 'veg', region: 'north_india_plains',
};
const target = dailyTarget(profile);

test('a generated week has seven days with meals in every slot', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400, household: 1 });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.days.length, 7);
  for (const d of plan.days) {
    assert.ok(d.meals.length >= 3, `${d.date} has only ${d.meals.length} meals`);
  }
});

test('a vegetarian plan never suggests meat, fish or egg', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400 });
  const nonVeg = new Set(db.recipes.filter((r) => !r.veg).map((r) => r.id));
  for (const d of plan.days) {
    for (const m of d.meals) {
      assert.ok(!nonVeg.has(m.recipeId), `veg plan surfaced ${m.recipeId}`);
    }
  }
});

test('an eggetarian plan allows egg but not meat or fish', () => {
  const eggProfile = { ...profile, diet: 'egg' };
  const plan = generateWeekPlan(db, { profile: eggProfile, target, month: 'nov', weeklyBudget: 1600 });
  const banned = new Set(['chicken_curry', 'fish_curry']);
  for (const d of plan.days) {
    for (const m of d.meals) assert.ok(!banned.has(m.recipeId), `egg plan surfaced ${m.recipeId}`);
  }
});

test('daily calories land near the target rather than wandering', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400 });
  for (const d of plan.days) {
    const drift = Math.abs(d.nutrition.kcal - target.kcal) / target.kcal;
    assert.ok(drift < 0.2, `${d.date}: ${d.nutrition.kcal} kcal vs target ${target.kcal} (${Math.round(drift * 100)}% off)`);
  }
});

test('summer plans avoid winter-only dishes', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'may', weeklyBudget: 1400 });
  const winterOnly = new Set(['sarson_ka_saag', 'palak_paneer', 'moong_dal_palak', 'aloo_gobhi']);
  const hits = plan.days.flatMap((d) => d.meals).filter((m) => winterOnly.has(m.recipeId));
  assert.equal(hits.length, 0, `May plan surfaced winter dishes: ${hits.map((h) => h.recipeId).join(', ')}`);
});

test('the same dish does not appear on consecutive days', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400 });
  for (let i = 1; i < plan.days.length; i++) {
    const prev = new Set(plan.days[i - 1].meals.map((m) => m.recipeId));
    for (const m of plan.days[i].meals) {
      assert.ok(!prev.has(m.recipeId), `${m.recipeId} repeats on consecutive days`);
    }
  }
});

test('a generous budget is respected and a cramped one is reported, not faked', () => {
  const roomy = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 2000 });
  assert.ok(roomy.withinBudget, `Rs 2000/week should be achievable, cost was ${roomy.totalCostRounded}`);

  const cramped = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 200 });
  assert.equal(cramped.withinBudget, false);
  // Two honest branches: either it is a stock-up shop, or the budget genuinely
  // does not reach. Both must say so plainly rather than shrinking portions.
  const note = cramped.budgetNote ?? '';
  assert.ok(
    note.includes('not quietly cut') || note.includes('cupboard'),
    `budget note must explain itself, got: ${note}`
  );
});

test('tightening the budget makes the planner choose cheaper weeks', () => {
  const roomy = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 5000 });
  const tight = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 700 });
  assert.ok(tight.totalCost < roomy.totalCost, `tight week (${tight.totalCostRounded}) should undercut roomy week (${roomy.totalCostRounded})`);
});

test('household size scales cost but not per-person calories', () => {
  // Budget deliberately far above any plan, so the cost-repair loop never fires
  // and the scaling is pure. At a tight budget the planner is SUPPOSED to switch
  // to cheaper recipes for a bigger household, which breaks exact 4x scaling -
  // that is correct behaviour, tested separately below.
  const one = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 999999, household: 1 });
  const four = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 999999, household: 4 });
  const ratio = four.totalCost / one.totalCost;
  assert.ok(ratio > 3.8 && ratio < 4.2, `four people should cost about 4x one person, got ${ratio.toFixed(2)}x`);
  const oneKcal = one.days[0].nutrition.kcal;
  const fourKcal = four.days[0].nutrition.kcal;
  assert.ok(Math.abs(oneKcal - fourKcal) / oneKcal < 0.2, 'per-person calories must not change with household size');
});

test('dislikes are excluded', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400, dislikes: ['khichdi', 'poha'] });
  const ids = plan.days.flatMap((d) => d.meals.map((m) => m.recipeId));
  assert.ok(!ids.includes('khichdi') && !ids.includes('poha'));
});

test('feeding four costs less than four times one, because packs are shared', () => {
  const one = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400, household: 1 });
  const four = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400, household: 4 });
  // The real shop scales sub-linearly: one person still has to buy a whole
  // 500 g pack of dal, and four people share the same pack of oil.
  const tillRatio = four.tillCost / one.tillCost;
  assert.ok(tillRatio < 4, `till cost should undercut linear scaling, got ${tillRatio.toFixed(2)}x`);
  assert.ok(tillRatio > 1.2, `but it should still cost meaningfully more, got ${tillRatio.toFixed(2)}x`);
  // Per-person calories must not be the thing that gives.
  assert.ok(Math.abs(four.days[0].nutrition.kcal - one.days[0].nutrition.kcal) / one.days[0].nutrition.kcal < 0.2);
});

// --- shopping list ----------------------------------------------------------

test('the shopping list consolidates, rounds to purchasable amounts and prices up', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400 });
  const list = shoppingList(db, plan, { month: 'nov' });

  assert.ok(list.items.length > 5, 'a week should need more than five things');
  const ids = list.items.map((i) => i.foodId);
  assert.equal(new Set(ids).size, ids.length, 'each food must appear exactly once');

  for (const item of list.items) {
    assert.ok(item.buyG >= item.neededG, `${item.foodId}: buying ${item.buyG} g for ${item.neededG} g needed`);
    const food = db.foodsById[item.foodId];
    if (item.loose) {
      assert.equal(item.buyG % 50, 0, `${item.foodId}: loose goods round to 50 g, got ${item.buyG}`);
      assert.ok(item.buyG - item.neededG < 50, `${item.foodId}: over-buying loose goods`);
    } else {
      // Packs: you cannot buy 55 g of dal, so overshoot is expected. What must
      // hold is that the surplus is never more than one whole extra pack.
      const smallest = Math.min(...food.packs);
      assert.ok(
        item.buyG - item.neededG < Math.max(...food.packs),
        `${item.foodId}: bought ${item.buyG} g for ${item.neededG} g - more than a full extra pack`
      );
      assert.ok(item.packs.every((p) => food.packs.includes(p.g)), `${item.foodId}: invented a pack size`);
      assert.ok(smallest > 0);
    }
    assert.ok(item.cost > 0);
  }
  assert.ok(list.total > 0);
});

test('formatQty reads the way a shopping list should', () => {
  assert.equal(formatQty(500), '500 g');
  assert.equal(formatQty(1000), '1 kg');
  assert.equal(formatQty(1250), '1.25 kg');
});

// --- weight trend -----------------------------------------------------------

test('a short log refuses to claim a trend', () => {
  const entries = [
    { date: '2026-10-01', kg: 80 },
    { date: '2026-10-02', kg: 79.8 },
    { date: '2026-10-03', kg: 80.2 },
  ];
  const t = weightTrend(entries);
  assert.equal(t.confident, false);
  assert.equal(t.ratePerWeek, null);
  assert.match(t.note, /two weeks/);
});

test('a steady decline is detected at roughly the right rate', () => {
  const entries = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date('2026-09-01T00:00:00Z');
    d.setDate(d.getDate() + i);
    // 0.5 kg/week with daily water noise on top.
    entries.push({ date: d.toISOString().slice(0, 10), kg: 80 - i * (0.5 / 7) + (i % 3 - 1) * 0.3 });
  }
  const t = weightTrend(entries);
  assert.ok(t.confident);
  assert.ok(Math.abs(t.ratePerWeek + 0.5) < 0.15, `detected ${t.ratePerWeek}, expected about -0.5`);
});

test('adjustment advice blames adherence before it blames the target', () => {
  const trend = { confident: true, ratePerWeek: -0.05 };
  const s = suggestAdjustment({ target, trend, adherence: 0.4 });
  assert.equal(s.action, 'hold');
  assert.match(s.message, /40%/);
});

test('a stalled plan with good adherence gets a cut, a fast one gets a raise', () => {
  const stalled = suggestAdjustment({ target, trend: { confident: true, ratePerWeek: -0.05 }, adherence: 0.95 });
  assert.equal(stalled.action, 'reduce');

  const fast = suggestAdjustment({ target, trend: { confident: true, ratePerWeek: -1.1 }, adherence: 0.95 });
  assert.equal(fast.action, 'increase');

  const onTrack = suggestAdjustment({ target, trend: { confident: true, ratePerWeek: -0.5 }, adherence: 0.95 });
  assert.equal(onTrack.action, 'hold');
});

// --- packaged food ----------------------------------------------------------

test('packaged items join the food list and keep their pack sizes', () => {
  const lays = db.foodsById.pkg_lays_salted;
  assert.ok(lays, 'Lays should be a food like any other');
  assert.equal(lays.yieldFactor, 1, 'a packet is already in the state you eat it');
  const packs = packMeasures(lays);
  assert.ok(packs.length >= 2);
  assert.ok(packs.some((p) => p.label.includes('50 g')));
});

test('a pack measure resolves to its own grams, not a katori guess', () => {
  const lays = db.foodsById.pkg_lays_salted;
  const pack = packMeasures(lays).find((p) => p.cookedG === 50);
  const { storedG } = portionToStoredGrams({ food: lays, measure: pack, qty: 1 });
  assert.equal(storedG, 50);
  const n = roundNutrition(nutritionFor(lays, storedG));
  assert.equal(n.kcal, 277, 'a 50 g Lays packet is 277 kcal');
});

test('pack sizes are offered before generic measures', () => {
  const list = measuresFor(db, db.foodsById.pkg_monster);
  assert.ok(list[0].isPack, 'the first option for a can should be the can');
});

test("the real lunch: Monster, Kurkure and Lays", () => {
  // The case this whole feature exists for.
  const monster = db.foodsById.pkg_monster;
  const kurkure = db.foodsById.pkg_kurkure;
  const lays = db.foodsById.pkg_lays_salted;

  const can = packMeasures(monster).find((p) => p.cookedG === 350);
  const kPack = packMeasures(kurkure).find((p) => p.cookedG === 75);
  const lPack = packMeasures(lays).find((p) => p.cookedG === 50);

  let total = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 };
  for (const [food, m] of [[monster, can], [kurkure, kPack], [lays, lPack]]) {
    const { storedG } = portionToStoredGrams({ food, measure: m, qty: 1 });
    total = addNutrition(total, nutritionFor(food, storedG));
  }
  const n = roundNutrition(total);
  assert.ok(n.kcal > 750 && n.kcal < 950, `that lunch should be 750-950 kcal, got ${n.kcal}`);
  assert.ok(n.p < 10, `and almost no protein, got ${n.p} g`);
});

// --- day repair -------------------------------------------------------------

test('day repair suggests meals for the slots still left', () => {
  const consumed = { kcal: 850, p: 5, c: 95, f: 45, fiber: 3 };
  const r = repairDay(db, {
    profile, target, consumed,
    slotsLeft: ['dinner'], month: 'nov', dailyBudget: 140, spentToday: 70,
  });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].slot, 'dinner');
  assert.ok(r.suggestions[0].options.length >= 2, 'a choice, not a verdict');
  assert.ok(r.kcalLeft > 0);
  assert.ok(r.projectedKcal <= target.kcal * 1.12, `projected ${r.projectedKcal} should land near ${target.kcal}`);
});

test('day repair favours protein after a protein-free lunch', () => {
  const consumed = { kcal: 850, p: 5, c: 95, f: 45, fiber: 3 };
  const r = repairDay(db, { profile, target, consumed, slotsLeft: ['dinner'], month: 'nov' });
  const picked = r.suggestions[0];
  assert.ok(picked.nutrition.p >= 18, `after a junk lunch it should push protein, got ${picked.nutrition.p} g`);
});

test('day repair refuses to starve you to pay for a bad lunch', () => {
  // Blown the whole day already.
  const consumed = { kcal: target.kcal + 500, p: 20, c: 200, f: 70, fiber: 5 };
  const r = repairDay(db, { profile, target, consumed, slotsLeft: ['dinner'], month: 'nov' });
  assert.equal(r.verdict, 'over');
  assert.equal(r.suggestions.length, 0);
  assert.ok(r.offerWeekSpread, 'it should offer to spread the surplus instead');
  assert.match(r.message, /make tomorrow worse/);
});

test('a tight day is flagged as tight rather than quietly serving crumbs', () => {
  const consumed = { kcal: target.kcal - 200, p: 40, c: 150, f: 50, fiber: 10 };
  const r = repairDay(db, { profile, target, consumed, slotsLeft: ['dinner'], month: 'nov' });
  assert.equal(r.verdict, 'tight');
  assert.match(r.message, /tight/);
});

test('surplus is spread across the week, capped, and never below the floor', () => {
  const s = spreadSurplus({ surplusKcal: 700, daysLeft: 4, target, profile });
  assert.ok(s.perDay <= 200, 'never more than 200 kcal a day');
  assert.ok(s.perDay > 0);
  assert.ok(target.kcal - s.perDay >= 1500, 'must stay above the male floor');

  const huge = spreadSurplus({ surplusKcal: 5000, daysLeft: 2, target, profile });
  assert.ok(huge.unabsorbed > 0, 'an unrepayable surplus should be reported, not hidden');
  assert.match(huge.message, /not worth chasing/);

  const done = spreadSurplus({ surplusKcal: 400, daysLeft: 0, target, profile });
  assert.equal(done.perDay, 0);
});

// --- pantry -----------------------------------------------------------------

test('pantry matching ranks what you can actually cook first', () => {
  const pantry = ['mushroom', 'onion', 'tomato', 'capsicum'];
  const matches = pantryMatch(db, pantry, { profile });
  const mm = matches.find((m) => m.recipeId === 'masala_mushroom');
  assert.ok(mm, 'masala mushroom should be matchable');
  assert.ok(mm.canCookNow, `should be cookable, missing: ${mm.missingNames.join(', ')}`);
  assert.equal(matches[0].coverage, 1, 'a fully-covered recipe should rank first');
});

test('staples are assumed present so the matcher is not useless', () => {
  assert.ok(ASSUMED_STAPLES.has('mustard_oil'));
  const matches = pantryMatch(db, ['mushroom', 'onion', 'tomato', 'capsicum'], { profile });
  const mm = matches.find((m) => m.recipeId === 'masala_mushroom');
  assert.ok(!mm.missing.includes('mustard_oil'), 'nobody lists oil as missing');
  assert.ok(!mm.missing.includes('ginger'));
});

test('turning staples off makes them count as missing', () => {
  const matches = pantryMatch(db, ['mushroom', 'onion', 'tomato', 'capsicum'], { profile, includeStaples: false });
  const mm = matches.find((m) => m.recipeId === 'masala_mushroom');
  assert.ok(mm.missing.includes('mustard_oil'));
});

test('one-ingredient-short recipes are identified and costed', () => {
  const matches = pantryMatch(db, ['toor_dal', 'tomato'], { profile, month: 'nov' });
  const dal = matches.find((m) => m.recipeId === 'dal_tadka');
  assert.ok(dal.canCookNow || dal.oneShort, 'dal tadka needs almost nothing beyond dal and tomato');
  for (const m of matches) {
    if (m.missing.length) assert.ok(m.missingCost >= 0);
  }
});

test('a vegetarian pantry never surfaces meat', () => {
  const matches = pantryMatch(db, ['chicken', 'onion', 'tomato', 'curd'], { profile });
  assert.ok(!matches.some((m) => m.recipeId === 'chicken_curry'), 'veg profile must not suggest chicken');
});

test('the shopping list subtracts what the pantry already holds', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400 });
  const list = shoppingList(db, plan, { month: 'nov' });
  const first = list.items[0];

  // "I always have this" - no quantity.
  const always = shoppingListMinusPantry(db, list, { [first.foodId]: { haveG: null } });
  const alwaysItem = always.items.find((i) => i.foodId === first.foodId);
  assert.equal(alwaysItem.buyG, 0);
  assert.equal(alwaysItem.cost, 0);
  assert.ok(always.total < list.total, 'the total should drop');

  // Partial stock.
  const partial = shoppingListMinusPantry(db, list, { [first.foodId]: { haveG: Math.floor(first.neededG / 2) } });
  const partialItem = partial.items.find((i) => i.foodId === first.foodId);
  assert.ok(partialItem.buyG > 0 && partialItem.buyG < first.buyG, 'buy less, not nothing');

  // Empty pantry changes nothing.
  const none = shoppingListMinusPantry(db, list, {});
  assert.equal(none.total, list.total);
});

test('pack measures are resolvable by id, not just generated', () => {
  // Regression: packMeasures() built measures on the fly but never registered
  // them, so the logger looked up "can (350 ml)" by id, found nothing, and
  // silently logged ONE GRAM. A Monster became 0.5 kcal.
  const monster = db.foodsById.pkg_monster;
  const can = packMeasures(monster).find((p) => p.cookedG === 350);
  assert.ok(db.measuresById[can.id], 'pack measures must be in measuresById');

  const resolved = db.measuresById[can.id];
  const { storedG } = portionToStoredGrams({ food: monster, measure: resolved, qty: 1 });
  assert.equal(storedG, 350);
  const n = roundNutrition(nutritionFor(monster, storedG));
  assert.ok(n.kcal > 150 && n.kcal < 185, `a 350 ml can should be ~170 kcal, got ${n.kcal}`);
});

test('every food with packs has them all resolvable', () => {
  for (const f of db.foods) {
    for (const m of packMeasures(f)) {
      assert.ok(db.measuresById[m.id], `${f.id}: pack "${m.label}" is not resolvable`);
    }
  }
});

test('aliases make English and regional names findable', () => {
  const find = (term) => db.foods.filter((f) =>
    f.name.toLowerCase().includes(term) ||
    (f.alias ?? '').toLowerCase().includes(term));
  assert.ok(find('capsicum').some((f) => f.id === 'capsicum'), 'capsicum should find Shimla mirch');
  assert.ok(find('okra').some((f) => f.id === 'bhindi'), 'okra should find bhindi');
  assert.ok(find('bottle gourd').some((f) => f.id === 'lauki'));
  assert.ok(find('yogurt').some((f) => f.id === 'curd'));
  assert.ok(find('chickpeas').some((f) => f.id === 'kabuli_chana'));
});

// --- pack economics ---------------------------------------------------------

test('twenty grams of milk costs a whole packet, not twenty grams of value', () => {
  // The bug this whole model exists to fix.
  const proRata = costOfStoredGrams(db, 'milk_toned', 20, 'oct', {});
  const plan = packPlan(db, 'milk_toned', 20, 'oct', {});
  assert.ok(proRata < 2, `pro-rata should be about a rupee, got ${proRata.toFixed(2)}`);
  assert.equal(plan.buyG, 500, 'you buy a 500 ml packet');
  assert.ok(plan.cost > 25, `the real cost is a packet, got ${plan.cost.toFixed(2)}`);
  assert.equal(plan.leftoverG, 480, 'and 480 ml is left for later');
});

test('loose goods are still priced pro-rata, because they genuinely are', () => {
  const plan = packPlan(db, 'bhindi', 180, 'oct', {});
  assert.equal(plan.loose, true, 'bhindi is sold by weight');
  assert.equal(plan.buyG, 200, 'rounded only to what a shopkeeper will weigh');
  assert.ok(plan.leftoverG <= 50);
});

test('packs are chosen to cover the need with the least excess', () => {
  // 1.2 kg of atta from [1000, 5000, 10000] should be 2 x 1 kg, not a 5 kg bag.
  const plan = packPlan(db, 'atta', 1200, 'oct', {});
  assert.equal(plan.buyG, 2000);
  assert.deepEqual(plan.packs.map((p) => p.g), [1000, 1000]);

  // And a need below the smallest pack still buys exactly one.
  const tiny = packPlan(db, 'paneer', 30, 'oct', {});
  assert.equal(tiny.buyG, 200);
  assert.equal(tiny.packs.length, 1);
});

test('a pack plan never buys less than needed', () => {
  for (const food of db.foods) {
    if (food.cat === 'packaged' || food.cat === 'eatingout') continue;
    for (const need of [1, 55, 180, 640, 1300]) {
      const plan = packPlan(db, food.id, need, 'oct', {});
      assert.ok(plan.buyG >= need, `${food.id}: bought ${plan.buyG} for ${need}`);
      assert.ok(plan.leftoverG >= 0);
    }
  }
});

test('a recipe reports ingredient value and till cost separately', () => {
  const r = db.recipesById.dal_tadka;
  const b = recipeCostBreakdown(db, r, 1, 'oct', {}, {});
  assert.ok(b.till > b.ingredients * 2, `till (${b.till}) should far exceed ingredient value (${b.ingredients}) on an empty pantry`);
  assert.equal(b.lines.length, r.ing.length);
  for (const line of b.lines) assert.ok(line.tillCost >= 0 && line.buyG >= 0);
});

test('a stocked pantry collapses till cost toward ingredient value', () => {
  const r = db.recipesById.dal_tadka;
  const empty = recipeCostBreakdown(db, r, 1, 'oct', {}, {});
  const stocked = recipeCostBreakdown(db, r, 1, 'oct', {}, Object.fromEntries(
    r.ing.map((i) => [i.food, { haveG: null }])
  ));
  assert.ok(stocked.till < empty.till, 'owning the ingredients must cost less');
  // Nothing left to buy, so the only cost is the flat spice-and-fuel allowance.
  assert.equal(stocked.till, 3, 'with everything in hand, only the spice allowance remains');
  assert.ok(stocked.lines.every((l) => l.alreadyHave && l.tillCost === 0));
});

test('a week separates what you pay from what you eat', () => {
  const plan = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400 });
  assert.ok(plan.tillCost > 0);
  assert.equal(plan.eatenValue + plan.leftoverValue, plan.tillCost, 'the two parts must sum to the bill');
  assert.ok(plan.leftoverValue > 0, 'a first shop always leaves something in the cupboard');
});

test('a stocked pantry makes the next shop much cheaper', () => {
  const first = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400 });
  // Pretend everything bought last week is still in the cupboard.
  const pantry = Object.fromEntries(first.shopping.items.map((i) => [i.foodId, { haveG: i.buyG }]));
  const second = generateWeekPlan(db, { profile, target, month: 'nov', weeklyBudget: 1400, pantry });
  assert.ok(second.tillCost < first.tillCost, `second shop (${second.tillCost}) should undercut the first (${first.tillCost})`);
});

// --- choices, not verdicts --------------------------------------------------

test('day repair offers several options per remaining meal', () => {
  const consumed = { kcal: 850, p: 5, c: 95, f: 45, fiber: 3 };
  const r = repairDay(db, { profile, target, consumed, slotsLeft: ['dinner'], month: 'nov' });
  const opts = r.suggestions[0].options;
  assert.ok(opts.length >= 2 && opts.length <= 3, `expected 2-3 options, got ${opts.length}`);
  const ids = opts.map((o) => o.recipeId);
  assert.equal(new Set(ids).size, ids.length, 'options must be different dishes');
  for (const o of opts) {
    assert.ok(o.nutrition.kcal > 0 && o.cost >= 0 && o.name);
    assert.ok(o.why, 'each option should say why it is there');
  }
});

test('the options are meaningfully different, not three variations on one dish', () => {
  const consumed = { kcal: 700, p: 10, c: 80, f: 35, fiber: 4 };
  const r = repairDay(db, { profile, target, consumed, slotsLeft: ['dinner'], month: 'nov' });
  const opts = r.suggestions[0].options;
  if (opts.length >= 3) {
    const costs = opts.map((o) => o.cost);
    const times = opts.map((o) => o.timeMin);
    assert.ok(new Set(costs).size > 1 || new Set(times).size > 1,
      'options should differ on cost or time, not just name');
  }
});

test('the headline figures follow the first option', () => {
  const consumed = { kcal: 850, p: 5, c: 95, f: 45, fiber: 3 };
  const r = repairDay(db, { profile, target, consumed, slotsLeft: ['dinner'], month: 'nov' });
  const s = r.suggestions[0];
  assert.equal(s.recipeId, s.options[0].recipeId);
  assert.equal(s.chosen, 0);
});

// --- "I want this tonight" --------------------------------------------------

test('something that fits is confirmed with the numbers', () => {
  const consumed = { kcal: 600, p: 20, c: 70, f: 25, fiber: 6 };
  const f = fitCheck(db, { target, consumed, item: { kind: 'recipe', id: 'dal_tadka' }, servings: 1 });
  assert.equal(f.fits, true);
  assert.ok(f.projected > consumed.kcal);
  assert.match(f.message, /fits/);
  assert.ok(f.cost >= 0);
});

test('something that does not fit says how much would', () => {
  const consumed = { kcal: target.kcal - 300, p: 60, c: 180, f: 50, fiber: 15 };
  const f = fitCheck(db, {
    target, consumed,
    item: { kind: 'food', id: 'pkg_cholebhature', measureId: db.foods.find((x) => x.id === 'pkg_cholebhature').packs ? 'pkg_cholebhature__pack0' : 'g' },
    servings: 1,
  });
  assert.equal(f.fits, false);
  assert.ok(f.overBy > 0);
  assert.ok(f.fitFraction > 0 && f.fitFraction < 1, `a partial portion should fit, got ${f.fitFraction}`);
  assert.match(f.message, /past the target|past today/);
  assert.ok(/portion|tomorrow|%/.test(f.message), 'it must offer a way forward, not just a verdict');
});

test('a near miss is answered with the portion that would fit', () => {
  // Only slightly over, so the "about N% of it would fit" branch applies.
  const consumed = { kcal: target.kcal - 400, p: 60, c: 180, f: 50, fiber: 15 };
  const f = fitCheck(db, { target, consumed, item: { kind: 'recipe', id: 'paneer_bhurji' }, servings: 1 });
  if (!f.fits) {
    assert.ok(f.fitFraction >= 0.5, `expected a near miss, got ${f.fitFraction}`);
    assert.match(f.message, /would fit/);
  } else {
    assert.match(f.message, /fits/);
  }
});

test('fit check never moralises, it reports', () => {
  const consumed = { kcal: target.kcal, p: 40, c: 200, f: 60, fiber: 10 };
  const f = fitCheck(db, { target, consumed, item: { kind: 'recipe', id: 'paneer_bhurji' }, servings: 1 });
  assert.ok(!/should not|bad|unhealthy|avoid|guilt/i.test(f.message), `moralising: ${f.message}`);
  assert.match(f.message, /kcal/);
});

// --- units ------------------------------------------------------------------

test('grams mode puts the scale first, katori mode puts the bowl first', () => {
  const dal = db.foodsById.toor_dal;
  assert.equal(measuresFor(db, dal, 'katori')[0].id, 'katori_dal');
  assert.equal(measuresFor(db, dal, 'grams')[0].id, 'g');
});

test('switching units never removes a measure, it only reorders', () => {
  const dal = db.foodsById.toor_dal;
  const a = measuresFor(db, dal, 'katori').map((m) => m.id).sort();
  const b = measuresFor(db, dal, 'grams').map((m) => m.id).sort();
  assert.deepEqual(a, b, 'a scale owner can still log a katori when eating out');
});

test('liquids offer millilitres first on a scale', () => {
  const milk = db.foodsById.milk_toned;
  const first = measuresFor(db, milk, 'grams')[0].id;
  assert.ok(first === 'g' || first === 'ml', `got ${first}`);
});

test('purchase packs are never offered as a portion to eat', () => {
  // toor dal has packs [500, 1000] for shopping; nobody eats 500 g of dry dal.
  const dal = db.foodsById.toor_dal;
  assert.ok(dal.packs?.length, 'dal should have purchase packs');
  assert.equal(packMeasures(dal).length, 0, 'but none of them are servings');
  // A packet of crisps genuinely is eaten by the packet.
  assert.ok(packMeasures(db.foodsById.pkg_lays_salted).length > 0);
});
