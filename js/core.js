/**
 * core.js - all the maths, no DOM.
 *
 * Kept free of UI on purpose: every number the app shows comes from a function
 * in here, and every function in here is runnable under `node --test`. A diet
 * tracker that cannot be tested is a diet tracker that quietly lies to you.
 */

// ---------------------------------------------------------------------------
// Energy and targets
// ---------------------------------------------------------------------------

/** Mifflin-St Jeor. Still the best-validated predictive equation for adults. */
export function bmr({ sex, weightKg, heightCm, ageYears }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === 'male' ? base + 5 : base - 161;
}

export const ACTIVITY = {
  sedentary:   { factor: 1.2,   label: 'Desk job, little walking' },
  light:       { factor: 1.375, label: 'Light activity or 1-3 workouts/week' },
  moderate:    { factor: 1.55,  label: 'Moderate, 3-5 workouts/week' },
  active:      { factor: 1.725, label: 'Active, 6-7 workouts/week' },
  very_active: { factor: 1.9,   label: 'Physical job or two-a-days' },
};

export function tdee(profile) {
  const f = (ACTIVITY[profile.activity] ?? ACTIVITY.sedentary).factor;
  return bmr(profile) * f;
}

/** 1 kg of body fat ~ 7700 kcal. Standard planning figure. */
export const KCAL_PER_KG_FAT = 7700;

export const SAFETY = {
  /** Absolute intake floors. Below these, adherence and micronutrients both fall apart. */
  minKcalMale: 1500,
  minKcalFemale: 1200,
  /** Never cut more than this share of maintenance, however aggressive the goal. */
  maxDeficitFraction: 0.25,
  /** Faster than this and you are mostly losing muscle and water. */
  maxLossKgPerWeek: 0.75,
  proteinGPerKg: 1.6,
  minFatFraction: 0.20,
  fiberG: 30,
};

/**
 * Turns a profile and a goal into a daily target, refusing to return an
 * unsafe number. Always reports what it clamped and why, so the UI can be
 * honest instead of silently overriding the user.
 */
export function dailyTarget(profile) {
  const maintenance = tdee(profile);
  const requestedRate = profile.goalKgPerWeek ?? 0.5;
  const notes = [];

  let rate = requestedRate;
  if (rate > SAFETY.maxLossKgPerWeek) {
    rate = SAFETY.maxLossKgPerWeek;
    notes.push(
      `Capped loss at ${SAFETY.maxLossKgPerWeek} kg/week - faster than this costs muscle, not just fat.`
    );
  }

  let target = maintenance - (rate * KCAL_PER_KG_FAT) / 7;

  const maxCut = maintenance * (1 - SAFETY.maxDeficitFraction);
  if (target < maxCut) {
    target = maxCut;
    notes.push(
      `Deficit held at ${Math.round(SAFETY.maxDeficitFraction * 100)}% of maintenance; your goal rate would need a deeper cut than is sensible at your size.`
    );
  }

  const floor = profile.sex === 'male' ? SAFETY.minKcalMale : SAFETY.minKcalFemale;
  if (target < floor) {
    target = floor;
    notes.push(`Raised to the ${floor} kcal floor. Eating below this is not something this app will plan for.`);
  }

  // What that target actually delivers, after clamping.
  const actualRate = ((maintenance - target) * 7) / KCAL_PER_KG_FAT;

  // Protein is anchored to a reference weight, so a heavier user is not handed
  // an absurd 200 g/day target that no home kitchen can hit on a budget.
  const refWeight = referenceWeight(profile);
  const proteinG = Math.round(refWeight * SAFETY.proteinGPerKg);
  const fatG = Math.round((target * SAFETY.minFatFraction) / 9);
  const carbG = Math.max(0, Math.round((target - proteinG * 4 - fatG * 9) / 4));

  return {
    maintenanceKcal: Math.round(maintenance),
    kcal: Math.round(target),
    proteinG,
    fatG,
    carbG,
    fiberG: SAFETY.fiberG,
    requestedKgPerWeek: requestedRate,
    projectedKgPerWeek: Number(actualRate.toFixed(2)),
    notes,
  };
}

/**
 * Protein reference weight: current weight if BMI is in range, otherwise the
 * weight at BMI 25. Keeps targets achievable without under-feeding protein.
 */
export function referenceWeight({ weightKg, heightCm }) {
  const m = heightCm / 100;
  const bmi = weightKg / (m * m);
  if (bmi <= 25) return weightKg;
  return 25 * m * m;
}

export function bmi({ weightKg, heightCm }) {
  const m = heightCm / 100;
  return Number((weightKg / (m * m)).toFixed(1));
}

// ---------------------------------------------------------------------------
// Portions: household measures to grams as-stored
// ---------------------------------------------------------------------------

/**
 * Resolve a logged portion to grams of the food AS STORED, which is the basis
 * foods.json uses for both nutrition and price.
 *
 * A katori of cooked dal is ~150 g cooked; dividing by yieldFactor gives the
 * ~50 g of dry dal that actually went in, which is what you paid for and what
 * carries the protein.
 */
export function portionToStoredGrams({ food, measure, qty = 1, katoriScale = 1 }) {
  if (!measure || measure.isBase) {
    return { storedG: qty, addFatG: 0 };
  }

  const isKatori = measure.id.startsWith('katori_') || measure.id.startsWith('glass_') ||
                   measure.id.startsWith('cup_') || measure.id.startsWith('ladle_') ||
                   measure.id.startsWith('bowl_');
  const scale = isKatori ? katoriScale : 1;

  // Measures given as raw weight (rotis, dosa) already describe the stored food.
  if (measure.rawG != null) {
    return { storedG: measure.rawG * qty * scale, addFatG: (measure.addFatG ?? 0) * qty };
  }

  const cookedG = (measure.cookedG ?? measure.cookedMl ?? 0) * qty * scale;
  const yf = food?.yieldFactor ?? 1;
  return { storedG: cookedG / yf, addFatG: (measure.addFatG ?? 0) * qty };
}

const EMPTY = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 };

export function nutritionFor(food, storedG) {
  if (!food) return { ...EMPTY };
  const k = storedG / 100;
  const n = food.per100g;
  return {
    kcal: n.kcal * k,
    p: n.p * k,
    c: n.c * k,
    f: n.f * k,
    fiber: (n.fiber ?? 0) * k,
  };
}

export function addNutrition(a, b) {
  return {
    kcal: a.kcal + b.kcal,
    p: a.p + b.p,
    c: a.c + b.c,
    f: a.f + b.f,
    fiber: a.fiber + b.fiber,
  };
}

export function roundNutrition(n) {
  return {
    kcal: Math.round(n.kcal),
    p: Math.round(n.p * 10) / 10,
    c: Math.round(n.c * 10) / 10,
    f: Math.round(n.f * 10) / 10,
    fiber: Math.round(n.fiber * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Price, with seasonality
// ---------------------------------------------------------------------------

export const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

export function monthKey(date = new Date()) {
  return MONTHS[date.getMonth()];
}

export function availability(db, foodId, month) {
  return db.seasonality?.produce?.[foodId]?.[month] ?? null;
}

/**
 * Effective price per kg. A user correction always wins; otherwise the seeded
 * base price is nudged by how available the thing is this month.
 */
export function pricePerKg(db, foodId, month, overrides = {}) {
  const food = db.foodsById[foodId];
  if (!food) return 0;
  if (overrides[foodId] != null) return overrides[foodId];

  const avail = availability(db, foodId, month);
  const mult = avail ? (db.seasonality.priceMultiplier[avail] ?? 1) : 1;
  return food.price * mult;
}

export function costOfStoredGrams(db, foodId, storedG, month, overrides) {
  return (pricePerKg(db, foodId, month, overrides) * storedG) / 1000;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export function recipeNutrition(db, recipe, servings = 1) {
  let total = { ...EMPTY };
  for (const item of recipe.ing) {
    const food = db.foodsById[item.food];
    total = addNutrition(total, nutritionFor(food, item.g * servings));
  }
  return total;
}

export function recipeCost(db, recipe, servings = 1, month = monthKey(), overrides = {}) {
  let cost = 0;
  for (const item of recipe.ing) {
    cost += costOfStoredGrams(db, item.food, item.g * servings, month, overrides);
  }
  // Spices, salt, fuel. Not free, not worth modelling per-gram.
  cost += 3 * servings;
  return cost;
}

/** Nutrition of the accompaniments a recipe suggests ("roti_medium:2"). */
export function serveWithNutrition(db, recipe, servings = 1, katoriScale = 1) {
  let total = { ...EMPTY };
  let cost = 0;
  for (const spec of recipe.serveWith ?? []) {
    const [measureId, qtyStr] = spec.split(':');
    const measure = db.measuresById[measureId];
    if (!measure) continue;
    const qty = Number(qtyStr ?? 1) * servings;
    const foodId = measureId.startsWith('katori_rice') ? 'rice'
                 : measureId.startsWith('katori_curd') ? 'curd'
                 : measureId.startsWith('katori_dal') ? 'toor_dal'
                 : 'atta';
    const food = db.foodsById[foodId];
    const { storedG, addFatG } = portionToStoredGrams({ food, measure, qty, katoriScale });
    total = addNutrition(total, nutritionFor(food, storedG));
    cost += costOfStoredGrams(db, foodId, storedG, monthKey(), {});
    if (addFatG) {
      total = addNutrition(total, nutritionFor(db.foodsById.mustard_oil, addFatG));
      cost += costOfStoredGrams(db, 'mustard_oil', addFatG, monthKey(), {});
    }
  }
  return { nutrition: total, cost };
}

/** Protein rupees-per-gram - the metric that matters most on a tight budget. */
export function proteinValue(db, recipe, month = monthKey(), overrides = {}) {
  const n = recipeNutrition(db, recipe, 1);
  const c = recipeCost(db, recipe, 1, month, overrides);
  return n.p > 0 ? c / n.p : Infinity;
}

// ---------------------------------------------------------------------------
// Weekly planner
// ---------------------------------------------------------------------------

const SLOTS = [
  { meal: 'breakfast', share: 0.23 },
  { meal: 'lunch',     share: 0.33 },
  { meal: 'dinner',    share: 0.28 },
  { meal: 'snack',     share: 0.09 },
];

/** Room held back for a daily salad, taken off the three main meals. */
const SALAD_SHARE = 0.07;

export function isSalad(recipe) {
  return (recipe.tags ?? []).includes('salad');
}

function seasonOf(month) {
  if (['nov','dec','jan','feb'].includes(month)) return 'winter';
  if (['mar','apr','may','jun'].includes(month)) return 'summer';
  return 'monsoon';
}

function recipeSeasonFit(db, recipe, month) {
  if (recipe.seasons?.includes('all')) return 1;
  const season = seasonOf(month);
  if (recipe.seasons?.includes(season)) return 1;

  // Out of its stated season: how bad depends on whether its produce is around.
  let worst = 1;
  for (const item of recipe.ing) {
    const a = availability(db, item.food, month);
    if (a === 'off') worst = Math.min(worst, 0);
    else if (a === 'scarce') worst = Math.min(worst, 0.35);
  }
  return worst * 0.6;
}

/**
 * Greedy scorer with a budget repair loop.
 *
 * Deliberately not a true optimiser: a solver would hand you a mathematically
 * perfect week of boiled soya you would abandon by Wednesday. This scores
 * protein, cost, season and variety together, then tightens the cost weight
 * and re-runs until the week fits the budget.
 */
export function generateWeekPlan(db, opts) {
  const {
    profile,
    target,
    month = monthKey(),
    weeklyBudget,
    household = 1,
    dislikes = [],
    priceOverrides = {},
    katoriScale = 1,
    pantry = {},
    startDate = new Date(),
  } = opts;

  const vegOnly = profile.diet === 'veg';
  const allowEgg = profile.diet === 'egg' || profile.diet === 'nonveg';

  const pool = db.recipes.filter((r) => {
    if (dislikes.includes(r.id)) return false;
    if (vegOnly && !r.veg) return false;
    if (!vegOnly && !allowEgg && !r.veg) return false;
    if (profile.diet === 'egg' && !r.veg && r.id !== 'egg_bhurji') return false;
    return recipeSeasonFit(db, r, month) > 0;
  });

  if (!pool.length) {
    return { error: 'No recipes fit those constraints. Widen the diet setting or clear some dislikes.' };
  }

  let costWeight = 1;
  let attempt;

  // The budget is checked against what the shop ACTUALLY costs - whole packs,
  // minus what the pantry already holds - not against pro-rata ingredient
  // value. Those two numbers are far apart on a first shop and converge once
  // the cupboard is stocked, and the first one is the one you pay.
  for (let i = 0; i < 6; i++) {
    attempt = buildWeek({ db, pool, target, month, household, priceOverrides, katoriScale, costWeight, startDate });
    attempt.month = month;
    const list = shoppingList(db, attempt, { household, month, priceOverrides, pantry });
    attempt.shopping = list;
    attempt.tillCost = list.total;
    attempt.eatenValue = list.eatenValue;
    attempt.leftoverValue = list.leftoverValue;
    if (list.total <= weeklyBudget) break;
    costWeight *= 1.8;
  }

  attempt.withinBudget = attempt.tillCost <= weeklyBudget;
  attempt.weeklyBudget = weeklyBudget;

  if (!attempt.withinBudget) {
    const stockUp = attempt.leftoverValue;
    attempt.budgetNote = stockUp > attempt.tillCost * 0.35
      ? `This shop comes to Rs ${attempt.tillCost} against a weekly budget of Rs ${Math.round(weeklyBudget)}, but Rs ${stockUp} of that stays in your cupboard rather than being eaten this week. ` +
        `Stocking a kitchen from empty always costs more than running one. Next week's list should be far smaller, and the week after that smaller still.`
      : `The cheapest sensible week at your calorie and protein targets costs about Rs ${attempt.tillCost} at the till, against a budget of Rs ${Math.round(weeklyBudget)}. ` +
        `Either the budget needs about Rs ${attempt.tillCost - Math.round(weeklyBudget)} more, or the protein target has to come down. I have not quietly cut your food to make the number fit.`;
  }
  return attempt;
}

function buildWeek({ db, pool, target, month, household, priceOverrides, katoriScale, costWeight, startDate }) {
  const used = new Map(); // recipeId -> last day index used
  const days = [];
  let totalCost = 0;

  for (let d = 0; d < 7; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);

    const meals = [];
    let dayNutrition = { ...EMPTY };
    let dayCost = 0;

    for (const slot of SLOTS) {
      const slotKcal = target.kcal * slot.share;
      const all = pool.filter((r) => r.meals.includes(slot.meal) && !isSalad(r));
      if (!all.length) continue;

      // Hard block on anything eaten today or yesterday. A soft penalty is not
      // enough: a high-protein cheap dish like soya keema out-scores the
      // penalty every time and you end up eating it twice a day all week.
      const fresh = all.filter((r) => {
        const last = used.get(r.id);
        return last == null || d - last >= 2;
      });
      const candidates = fresh.length ? fresh : all;

      let best = null;
      for (const r of candidates) {
        const per1 = recipeNutrition(db, r, 1);
        const extras = serveWithNutrition(db, r, 1, katoriScale);
        const kcal1 = per1.kcal + extras.nutrition.kcal;
        if (kcal1 <= 0) continue;

        // Servings needed to land on this slot's calories, kept to sane bounds.
        const servings = clamp(slotKcal / kcal1, 0.5, 2.5);
        const n = scaleNutrition(per1, servings);
        const ex = scaleNutrition(extras.nutrition, servings);
        const totalN = addNutrition(n, ex);
        const cost = (recipeCost(db, r, servings, month, priceOverrides) + extras.cost * servings) * household;

        const proteinPerKcal = totalN.p / Math.max(1, totalN.kcal);
        const seasonFit = recipeSeasonFit(db, r, month);
        const lastUsed = used.get(r.id);
        const repeatPenalty = lastUsed == null ? 0 : Math.max(0, 6 - (d - lastUsed)) * 1.4;

        // Cost is scored PER PERSON. Scoring the household total would make a
        // family of four get cheaper food than one person on the same budget
        // per head, which is backwards.
        const costPerPerson = cost / household;

        const score =
          proteinPerKcal * 160 +
          seasonFit * 2.2 -
          (costPerPerson / 40) * costWeight -
          repeatPenalty -
          (r.effort === 'high' ? 1.2 : r.effort === 'medium' ? 0.3 : 0);

        if (!best || score > best.score) {
          best = { recipe: r, servings, nutrition: totalN, cost, score };
        }
      }

      if (!best) continue;
      used.set(best.recipe.id, d);
      dayNutrition = addNutrition(dayNutrition, best.nutrition);
      dayCost += best.cost;
      meals.push({
        meal: slot.meal,
        recipeId: best.recipe.id,
        name: best.recipe.name,
        servings: Number(best.servings.toFixed(2)),
        nutrition: roundNutrition(best.nutrition),
        cost: Math.round(best.cost),
        serveWith: best.recipe.serveWith ?? [],
      });
    }

    // A salad every day, attached to whichever main meal is larger. Raw veg is
    // the cheapest way to add volume and fibre to a deficit, and a plan that
    // never suggests one is a plan nobody's mother would recognise.
    const saladPool = pool.filter(isSalad);
    if (saladPool.length) {
      const saladKcal = target.kcal * SALAD_SHARE;
      let bestSalad = null;
      for (const r of saladPool) {
        const lastUsed = used.get(r.id);
        if (lastUsed != null && d - lastUsed < 3) continue;
        const per1 = recipeNutrition(db, r, 1);
        if (per1.kcal <= 0) continue;
        const servings = clamp(saladKcal / per1.kcal, 0.5, 1.5);
        const n = scaleNutrition(per1, servings);
        const cost = recipeCost(db, r, servings, month, priceOverrides) * household;
        const seasonFit = recipeSeasonFit(db, r, month);
        const score = (n.fiber / Math.max(1, n.kcal)) * 900 +
                      (n.p / Math.max(1, n.kcal)) * 120 +
                      seasonFit * 2 -
                      (cost / household / 40) * costWeight;
        if (!bestSalad || score > bestSalad.score) {
          bestSalad = { recipe: r, servings, nutrition: n, cost, score };
        }
      }
      if (bestSalad) {
        used.set(bestSalad.recipe.id, d);
        const withMeal = meals.find((m) => m.meal === 'dinner') ? 'dinner' : 'lunch';
        dayNutrition = addNutrition(dayNutrition, bestSalad.nutrition);
        dayCost += bestSalad.cost;
        meals.push({
          meal: withMeal,
          isSalad: true,
          recipeId: bestSalad.recipe.id,
          name: bestSalad.recipe.name,
          servings: Number(bestSalad.servings.toFixed(2)),
          nutrition: roundNutrition(bestSalad.nutrition),
          cost: Math.round(bestSalad.cost),
          serveWith: [],
        });
      }
    }

    totalCost += dayCost;
    days.push({
      date: date.toISOString().slice(0, 10),
      meals,
      nutrition: roundNutrition(dayNutrition),
      cost: Math.round(dayCost),
      kcalGap: Math.round(dayNutrition.kcal - target.kcal),
      proteinGap: Math.round(dayNutrition.p - target.proteinG),
    });
  }

  return { days, totalCost, totalCostRounded: Math.round(totalCost) };
}

function scaleNutrition(n, k) {
  return { kcal: n.kcal * k, p: n.p * k, c: n.c * k, f: n.f * k, fiber: n.fiber * k };
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Shopping list
// ---------------------------------------------------------------------------

/**
 * What you actually hand over at the till.
 *
 * A recipe using 20 g of milk does not cost 20 g worth of milk. You buy a
 * 500 ml packet. Pro-rata costing quietly understates every small quantity,
 * and for a budget that is the difference between a plan that works and one
 * that doesn't.
 *
 * But this is only true for things sold in packs. Bhindi, palak and tomatoes
 * are sold loose by weight, so for those pro-rata IS the honest number. The
 * food data marks which is which.
 *
 * Returns the packs you'd buy, what they cost, and what is left over - the
 * leftover is not waste, it goes into the pantry and the next recipe uses it.
 */
export function packPlan(db, foodId, gramsNeeded, month = monthKey(), overrides = {}) {
  const food = db.foodsById[foodId];
  const perKg = pricePerKg(db, foodId, month, overrides);

  if (!food || gramsNeeded <= 0) {
    return { packs: [], buyG: 0, cost: 0, leftoverG: 0, loose: true };
  }

  // Sold loose: buy what you need, rounded to something a shopkeeper will weigh.
  if (food.loose || !food.packs?.length) {
    const step = 50;
    const buyG = Math.ceil(gramsNeeded / step) * step;
    return {
      packs: [{ g: buyG, cost: (perKg * buyG) / 1000, loose: true }],
      buyG,
      cost: (perKg * buyG) / 1000,
      leftoverG: buyG - gramsNeeded,
      loose: true,
    };
  }

  // Sold in packs: cover the need with as little excess as possible, preferring
  // fewer, larger packs when the excess is the same.
  const sizes = [...food.packs].sort((a, b) => b - a);
  const chosen = [];
  let remaining = gramsNeeded;

  for (const size of sizes) {
    while (remaining >= size) { chosen.push(size); remaining -= size; }
  }
  if (remaining > 0) {
    // One more pack: the smallest that covers what is left.
    const smallestCovering = [...sizes].reverse().find((sz) => sz >= remaining);
    chosen.push(smallestCovering ?? sizes[sizes.length - 1]);
  }

  const buyG = chosen.reduce((a, b) => a + b, 0);
  const cost = (perKg * buyG) / 1000;
  return {
    packs: chosen.map((g) => ({ g, cost: (perKg * g) / 1000, loose: false })),
    buyG,
    cost,
    leftoverG: buyG - gramsNeeded,
    loose: false,
  };
}

/** What this quantity costs at the till, buying fresh with an empty pantry. */
export function tillCost(db, foodId, grams, month = monthKey(), overrides = {}) {
  return packPlan(db, foodId, grams, month, overrides).cost;
}

/**
 * A recipe has two honest costs and they answer different questions.
 *
 *   ingredients — what this serving consumed in value. Use it to compare
 *                 recipes against each other.
 *   till        — what you'd pay buying every ingredient fresh today. Much
 *                 higher for anything using a little of a lot of packets.
 *
 * Over a week the two converge, because pack leftovers get eaten. The gap is
 * really the cost of the first shop, so the weekly plan is where it resolves.
 */
export function recipeCostBreakdown(db, recipe, servings = 1, month = monthKey(), overrides = {}, pantry = {}) {
  let ingredients = 0;
  let till = 0;
  const lines = [];

  for (const item of recipe.ing) {
    const g = item.g * servings;
    const used = costOfStoredGrams(db, item.food, g, month, overrides);

    const held = pantry[item.food];
    const covered = held ? (held.haveG == null ? Infinity : held.haveG) : 0;
    const shortfall = Math.max(0, g - covered);
    const plan = packPlan(db, item.food, shortfall, month, overrides);

    ingredients += used;
    till += plan.cost;
    lines.push({
      foodId: item.food,
      name: db.foodsById[item.food]?.name ?? item.food,
      g: Math.round(g),
      usedCost: Math.round(used),
      buyG: plan.buyG,
      tillCost: Math.round(plan.cost),
      leftoverG: Math.round(plan.leftoverG),
      loose: plan.loose,
      alreadyHave: shortfall <= 0,
    });
  }

  const spices = 3 * servings;
  return {
    ingredients: Math.round(ingredients + spices),
    till: Math.round(till + spices),
    lines,
  };
}

/**
 * Consolidates a week of meals into one list and buys real packs.
 *
 * Quantities are summed across the whole week BEFORE any rounding, which is
 * what makes pack sizes work out: seven recipes each wanting 20 g of milk
 * need one packet between them, not seven.
 */
export function shoppingList(db, plan, { household = 1, month = monthKey(), priceOverrides = {}, pantry = {} } = {}) {
  const totals = new Map();

  for (const day of plan.days) {
    for (const meal of day.meals) {
      const recipe = db.recipesById[meal.recipeId];
      if (!recipe) continue;
      for (const item of recipe.ing) {
        const g = item.g * meal.servings * household;
        totals.set(item.food, (totals.get(item.food) ?? 0) + g);
      }
      for (const spec of recipe.serveWith ?? []) {
        const [measureId, qtyStr] = spec.split(':');
        const measure = db.measuresById[measureId];
        if (!measure) continue;
        const foodId = measureId.startsWith('katori_rice') ? 'rice'
                     : measureId.startsWith('katori_curd') ? 'curd'
                     : measureId.startsWith('katori_dal') ? 'toor_dal'
                     : 'atta';
        const { storedG } = portionToStoredGrams({
          food: db.foodsById[foodId],
          measure,
          qty: Number(qtyStr ?? 1) * meal.servings * household,
        });
        totals.set(foodId, (totals.get(foodId) ?? 0) + storedG);
      }
    }
  }

  const items = [...totals.entries()]
    .map(([foodId, grams]) => {
      const food = db.foodsById[foodId];
      const held = pantry[foodId];
      const covered = held ? (held.haveG == null ? Infinity : held.haveG) : 0;
      const shortfall = Math.max(0, grams - covered);

      if (shortfall <= 0) {
        return {
          foodId, name: food?.name ?? foodId, category: food?.cat ?? 'other',
          neededG: Math.round(grams), buyG: 0, buyLabel: '—', cost: 0,
          pricePerKg: Math.round(pricePerKg(db, foodId, month, priceOverrides)),
          availability: availability(db, foodId, month),
          alreadyHave: true, leftoverG: 0, loose: !!food?.loose, packs: [],
        };
      }

      const plan = packPlan(db, foodId, shortfall, month, priceOverrides);
      return {
        foodId,
        name: food?.name ?? foodId,
        category: food?.cat ?? 'other',
        neededG: Math.round(shortfall),
        buyG: plan.buyG,
        buyLabel: describePacks(plan, food),
        cost: Math.round(plan.cost),
        pricePerKg: Math.round(pricePerKg(db, foodId, month, priceOverrides)),
        availability: availability(db, foodId, month),
        alreadyHave: false,
        partiallyHave: covered > 0,
        leftoverG: Math.round(plan.leftoverG),
        loose: plan.loose,
        packs: plan.packs,
      };
    })
    .sort((a, b) => b.cost - a.cost);

  const total = items.reduce((s, i) => s + i.cost, 0);
  const leftoverValue = items.reduce(
    (s, i) => s + (i.leftoverG > 0 ? (i.pricePerKg * i.leftoverG) / 1000 : 0), 0
  );

  return {
    items,
    total,
    leftoverValue: Math.round(leftoverValue),
    eatenValue: Math.round(total - leftoverValue),
  };
}

/** "2 × 500 g" reads better on a shopping list than "1 kg". */
function describePacks(plan, food) {
  if (plan.loose) return formatQty(plan.buyG);
  const counts = new Map();
  for (const p of plan.packs) counts.set(p.g, (counts.get(p.g) ?? 0) + 1);
  const unit = food?.liquid ? 'ml' : 'g';
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([g, n]) => {
      const label = g >= 1000 ? `${g / 1000} ${unit === 'ml' ? 'l' : 'kg'}` : `${g} ${unit}`;
      return n > 1 ? `${n} × ${label}` : label;
    })
    .join(' + ');
}

export function formatQty(g) {
  return g >= 1000 ? `${(g / 1000).toFixed(g % 1000 === 0 ? 0 : 2)} kg` : `${g} g`;
}

// ---------------------------------------------------------------------------
// Weight trend
// ---------------------------------------------------------------------------

/**
 * Daily weight is mostly water. A 7-day moving average over at least two
 * weeks is the only honest read on whether the plan is working - which is why
 * the app nudges targets weekly, not daily.
 */
export function weightTrend(entries) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const smoothed = sorted.map((e, i) => {
    const window = sorted.slice(Math.max(0, i - 6), i + 1);
    return { date: e.date, kg: window.reduce((s, x) => s + x.kg, 0) / window.length };
  });

  if (smoothed.length < 10) {
    return { smoothed, ratePerWeek: null, confident: false, note: 'Needs about two weeks of weigh-ins before the trend means anything.' };
  }

  const recent = smoothed.slice(-14);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  const ratePerWeek = days > 0 ? ((last.kg - first.kg) / days) * 7 : 0;

  return { smoothed, ratePerWeek: Number(ratePerWeek.toFixed(2)), confident: true, note: null };
}

/** Weekly check-in: compare measured loss to intent and suggest one adjustment. */
export function suggestAdjustment({ target, trend, adherence }) {
  if (!trend?.confident) {
    return { action: 'hold', message: trend?.note ?? 'Keep logging - not enough data yet.' };
  }
  if (adherence != null && adherence < 0.7) {
    return {
      action: 'hold',
      message: `You hit the calorie target on ${Math.round(adherence * 100)}% of days. The target is not the problem yet - another week of logging will tell us more than a change would.`,
    };
  }

  const measured = -trend.ratePerWeek;
  const intended = target.projectedKgPerWeek;
  const diff = measured - intended;

  if (Math.abs(diff) < 0.15) {
    return { action: 'hold', message: `Losing ${measured.toFixed(2)} kg/week against a plan of ${intended} - that is on track. Change nothing.` };
  }
  if (diff < 0) {
    return {
      action: 'reduce',
      deltaKcal: -150,
      message: `Losing ${measured.toFixed(2)} kg/week against a plan of ${intended}. Trim about 150 kcal/day, or add a daily walk - whichever you will actually keep doing.`,
    };
  }
  return {
    action: 'increase',
    deltaKcal: 120,
    message: `Losing ${measured.toFixed(2)} kg/week, faster than the ${intended} planned. Add about 120 kcal/day - faster is not better here, and this is how you keep the muscle.`,
  };
}

// ---------------------------------------------------------------------------
// DB assembly
// ---------------------------------------------------------------------------

export function buildDb({ foods, portions, seasonality, recipes, packaged, scanned }) {
  // Packaged items and scanned barcodes are foods like any other: same schema,
  // same costing, same logging. The only extra is `packs`, which lets the UI
  // offer "one ₹20 packet" instead of asking anyone to estimate grams.
  const packagedFoods = (packaged?.items ?? []).map((i) => ({
    ...i,
    state: 'ready',
    yieldFactor: 1,
    isPackaged: true,
  }));
  const scannedFoods = (scanned ?? []).map((i) => ({
    ...i,
    state: 'ready',
    yieldFactor: 1,
    isPackaged: true,
    isScanned: true,
  }));

  const db = {
    foods: [...foods.foods, ...packagedFoods, ...scannedFoods],
    measures: portions.measures,
    seasonality,
    recipes: recipes.recipes,
    plateHeuristics: portions.plateHeuristics,
    defaultMeasureByCategory: portions.defaultMeasureByCategory,
    foodsById: {},
    measuresById: {},
    recipesById: {},
  };
  for (const f of db.foods) db.foodsById[f.id] = f;
  for (const m of db.measures) db.measuresById[m.id] = m;
  for (const r of db.recipes) db.recipesById[r.id] = r;

  // Pack sizes are per-food, but the logger looks every measure up by id in
  // measuresById. Without this, picking "can (350 ml)" resolves to nothing and
  // silently logs one gram.
  for (const f of db.foods) {
    for (const m of packMeasures(f)) {
      db.measures.push(m);
      db.measuresById[m.id] = m;
    }
  }
  return db;
}

/**
 * A packaged item's own pack sizes, as measures the portion pad can use.
 *
 * Only for things you eat by the packet. Staples also carry `packs`, but
 * those are PURCHASE sizes for the shopping list - nobody sits down to a
 * 500 g serving of toor dal, and offering it as a portion is nonsense.
 */
export function packMeasures(food) {
  if (!food?.isPackaged) return [];
  return (food.packs ?? []).map((p, i) => ({
    id: `${food.id}__pack${i}`,
    label: p.label,
    appliesTo: [food.cat],
    cookedG: p.g,
    isPack: true,
  }));
}

/**
 * Measures that make sense for a given food, best default first.
 *
 * `units` follows the profile. Someone with a kitchen scale wants grams at
 * the top and finds katori guesses actively annoying; someone without one
 * needs the household measures, because "about 60 g of dry dal" is not a
 * thing anyone can judge by eye. Both lists stay complete - only the order
 * changes - so a scale owner can still log a katori when eating out.
 */
export function measuresFor(db, food, units = 'katori') {
  const generic = db.measures.filter(
    (m) => m.appliesTo.includes('*') || m.appliesTo.includes(food.cat)
  );

  if (units === 'grams') {
    const base = food.liquid ? 'ml' : 'g';
    const other = food.liquid ? 'g' : 'ml';
    generic.sort((a, b) => rank(a) - rank(b));
    function rank(m) {
      if (m.id === base) return 0;
      if (m.id === other) return 1;
      // Countable things stay near the top: nobody weighs an egg or a roti.
      if (m.id.startsWith('piece_') || m.id.startsWith('roti') || m.id.startsWith('paratha')) return 2;
      return 3;
    }
  } else {
    const preferred = db.defaultMeasureByCategory[food.cat];
    generic.sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));
  }

  // Pack sizes come first for anything eaten straight from a packet.
  return [...packMeasures(food), ...generic];
}

// ---------------------------------------------------------------------------
// Day repair - the junk-food adjustment
// ---------------------------------------------------------------------------

/**
 * You had a Monster, a Kurkure and a Lays for lunch. Now what?
 *
 * This is arithmetic, not AI. Given what has already gone in today, it works
 * out what is left and suggests meals for the slots still to come. Three
 * things it deliberately does NOT do:
 *
 *  - It will not drop you below the safety floor to "make up" for a bad lunch.
 *    Starving at dinner to pay for chips is how people end up bingeing.
 *  - It will not pretend a blown day can be fixed inside that day. Past a
 *    point it says so and offers to spread the surplus across the week.
 *  - It does not moralise. It reports the gap and offers the next move.
 */
export function repairDay(db, opts) {
  const {
    profile, target, consumed,
    slotsLeft = [], month = monthKey(),
    dailyBudget = Infinity, spentToday = 0,
    dislikes = [], priceOverrides = {}, katoriScale = 1,
  } = opts;

  const kcalLeft = target.kcal - consumed.kcal;
  const proteinLeft = Math.max(0, target.proteinG - consumed.p);
  const budgetLeft = dailyBudget - spentToday;

  const base = {
    kcalLeft: Math.round(kcalLeft),
    proteinLeft: Math.round(proteinLeft),
    budgetLeft: Math.round(budgetLeft),
    slotsLeft,
  };

  // Already over for the day.
  if (kcalLeft <= 0) {
    return {
      ...base,
      verdict: 'over',
      suggestions: [],
      message:
        `You're ${Math.abs(Math.round(kcalLeft))} kcal past today's target with ${proteinLeft > 0 ? `${Math.round(proteinLeft)} g of protein still short` : 'protein already met'}. ` +
        `Eating nothing else tonight would make tomorrow worse, not better. Have something with protein and little else — curd, sprouts, eggs — and let the week absorb it.`,
      offerWeekSpread: true,
    };
  }

  // Enough left for a real meal?
  const perSlot = slotsLeft.length ? kcalLeft / slotsLeft.length : kcalLeft;
  const tight = perSlot < 250;

  const pool = db.recipes.filter((r) => {
    if (dislikes.includes(r.id)) return false;
    if (profile.diet === 'veg' && !r.veg) return false;
    if (profile.diet === 'egg' && !r.veg && r.id !== 'egg_bhurji') return false;
    return true;
  });

  const suggestions = [];
  const used = new Set();

  for (const slot of slotsLeft) {
    const slotKcal = kcalLeft / slotsLeft.length;
    // When there is barely any room left, salads are exactly the right answer,
    // so they stay in the running rather than being filtered out as sides.
    const candidates = pool.filter((r) => r.meals.includes(slot) && !used.has(r.id));
    if (!candidates.length) continue;

    const scored = [];
    for (const r of candidates) {
      const per1 = recipeNutrition(db, r, 1);
      const extras = serveWithNutrition(db, r, 1, katoriScale);
      const kcal1 = per1.kcal + extras.nutrition.kcal;
      if (kcal1 <= 0) continue;

      // When room is tight, allow smaller servings than the weekly planner would.
      const servings = clamp(slotKcal / kcal1, tight ? 0.4 : 0.5, 2.0);
      const n = addNutrition(scaleNutrition(per1, servings), scaleNutrition(extras.nutrition, servings));
      const cost = recipeCost(db, r, servings, month, priceOverrides) + extras.cost * servings;

      // Overshooting what is left is the thing to avoid most.
      const overshoot = Math.max(0, n.kcal - slotKcal * 1.15);
      // Junk is protein-poor, so protein is weighted harder here than in the
      // weekly planner.
      // Two protein terms, deliberately. Density alone lets a salad win dinner
      // after a protein-free lunch - it is protein-dense per calorie but
      // delivers 15 g where soya keema delivers 35, and the gap to close is
      // absolute, not proportional.
      const closesGap = Math.min(n.p, proteinLeft);
      const score =
        (n.p / Math.max(1, n.kcal)) * 160 +
        closesGap * 0.5 -
        (overshoot / 100) * 3 -
        (cost / Math.max(40, budgetLeft)) * 2 -
        (r.effort === 'high' ? 1.5 : r.effort === 'medium' ? 0.4 : 0);

      scored.push({ recipe: r, servings, nutrition: n, cost, score });
    }

    scored.sort((a, b) => b.score - a.score);

    // Three genuinely different answers beat one verdict. Picking strictly by
    // score returns three variations on the same dal, so the runners-up are
    // chosen to differ: the best overall, then the best cheap one, then the
    // best quick one, filling from the ranking if those collide.
    const options = [];
    const take = (cand) => {
      if (!cand || options.some((o) => o.recipe.id === cand.recipe.id)) return;
      options.push(cand);
    };
    take(scored[0]);
    take([...scored].sort((a, b) => a.cost - b.cost)[0]);
    take([...scored].sort((a, b) => a.recipe.timeMin - b.recipe.timeMin)[0]);
    for (const c of scored) { if (options.length >= 3) break; take(c); }

    if (options.length) {
      for (const o of options) used.add(o.recipe.id);
      suggestions.push({
        slot,
        options: options.map((o, i) => ({
          recipeId: o.recipe.id,
          name: o.recipe.name,
          servings: Number(o.servings.toFixed(2)),
          nutrition: roundNutrition(o.nutrition),
          cost: Math.round(o.cost),
          timeMin: o.recipe.timeMin,
          why: i === 0 ? 'best fit' : o.cost === Math.min(...options.map((x) => x.cost)) ? 'cheapest'
             : o.recipe.timeMin === Math.min(...options.map((x) => x.recipe.timeMin)) ? 'quickest' : 'another option',
        })),
        // The first option is what the day projects to until the user switches.
        chosen: 0,
        recipeId: options[0].recipe.id,
        name: options[0].recipe.name,
        servings: Number(options[0].servings.toFixed(2)),
        nutrition: roundNutrition(options[0].nutrition),
        cost: Math.round(options[0].cost),
      });
    }
  }

  const planned = suggestions.reduce(
    (s, x) => ({ kcal: s.kcal + x.nutrition.kcal, p: s.p + x.nutrition.p }),
    { kcal: 0, p: 0 }
  );

  let message;
  if (tight) {
    message =
      `${Math.round(kcalLeft)} kcal left across ${slotsLeft.length} ${slotsLeft.length === 1 ? 'meal' : 'meals'}, which is tight. ` +
      `These are picked for protein and volume rather than comfort — you'll finish the day fed, not full.`;
  } else {
    message =
      `${Math.round(kcalLeft)} kcal and ${Math.round(proteinLeft)} g of protein left. ` +
      `This lands you at about ${Math.round(consumed.kcal + planned.kcal)} kcal for the day.`;
  }

  return {
    ...base,
    verdict: tight ? 'tight' : 'ok',
    suggestions,
    projectedKcal: Math.round(consumed.kcal + planned.kcal),
    projectedProtein: Math.round(consumed.p + planned.p),
    message,
    offerWeekSpread: false,
  };
}

/**
 * Spread one day's surplus across the days left in the week, instead of
 * punishing tomorrow. Capped at 200 kcal a day and never below the floor,
 * because a surplus you cannot repay gently is one you should simply accept.
 */
export function spreadSurplus({ surplusKcal, daysLeft, target, profile }) {
  const floor = profile.sex === 'male' ? SAFETY.minKcalMale : SAFETY.minKcalFemale;
  const maxPerDay = Math.min(200, Math.max(0, target.kcal - floor));

  if (daysLeft <= 0) {
    return { perDay: 0, absorbed: 0, unabsorbed: surplusKcal, message: 'The week is done. Let this one go and start the next one clean.' };
  }

  const wanted = surplusKcal / daysLeft;
  const perDay = Math.min(wanted, maxPerDay);
  const absorbed = perDay * daysLeft;
  const unabsorbed = Math.max(0, surplusKcal - absorbed);

  return {
    perDay: Math.round(perDay),
    absorbed: Math.round(absorbed),
    unabsorbed: Math.round(unabsorbed),
    message: unabsorbed > 100
      ? `Trimming ${Math.round(perDay)} kcal a day for the ${daysLeft} days left absorbs most of it. The last ${Math.round(unabsorbed)} kcal is not worth chasing — it is about ${(unabsorbed / KCAL_PER_KG_FAT * 1000).toFixed(0)} g of body weight.`
      : `Trimming ${Math.round(perDay)} kcal a day for the ${daysLeft} days left clears it completely. No single day has to hurt.`,
  };
}

// ---------------------------------------------------------------------------
// Pantry and fridge matching
// ---------------------------------------------------------------------------

/**
 * Foods assumed present in any Indian kitchen unless told otherwise. Without
 * this, every recipe shows "missing: mustard oil" and the matcher is useless.
 */
export const ASSUMED_STAPLES = new Set([
  'mustard_oil', 'ghee', 'sugar', 'tea_leaves', 'green_chilli', 'ginger', 'garlic', 'coriander',
]);

/**
 * What can I cook right now?
 *
 * Ranks recipes by how much of each is already in the kitchen. Deliberately
 * ranks by *ingredient coverage* first and nutrition second: at 8pm the
 * question is "what can I actually make", not "what is optimal".
 */
export function pantryMatch(db, pantryIds, opts = {}) {
  const {
    profile = { diet: 'veg' }, month = monthKey(),
    priceOverrides = {}, dislikes = [], includeStaples = true,
  } = opts;

  const have = new Set(pantryIds);
  if (includeStaples) for (const s of ASSUMED_STAPLES) have.add(s);

  const out = [];
  for (const r of db.recipes) {
    if (dislikes.includes(r.id)) continue;
    if (profile.diet === 'veg' && !r.veg) continue;
    if (profile.diet === 'egg' && !r.veg && r.id !== 'egg_bhurji') continue;

    const missing = [];
    const using = [];
    for (const item of r.ing) {
      if (have.has(item.food)) using.push(item.food);
      else missing.push(item.food);
    }

    const coverage = r.ing.length ? using.length / r.ing.length : 0;
    const n = roundNutrition(recipeNutrition(db, r, 1));
    const missingCost = missing.reduce(
      (s, id) => s + costOfStoredGrams(db, id, (r.ing.find((i) => i.food === id)?.g ?? 0), month, priceOverrides),
      0
    );

    out.push({
      recipeId: r.id,
      name: r.name,
      coverage,
      canCookNow: missing.length === 0,
      oneShort: missing.length === 1,
      using,
      missing,
      missingNames: missing.map((id) => db.foodsById[id]?.name ?? id),
      missingCost: Math.round(missingCost),
      nutrition: n,
      timeMin: r.timeMin,
      effort: r.effort,
    });
  }

  return out.sort((a, b) =>
    b.coverage - a.coverage ||
    a.missing.length - b.missing.length ||
    b.nutrition.p - a.nutrition.p
  );
}

/** The shopping list, minus what the pantry already holds. */
export function shoppingListMinusPantry(db, list, pantry) {
  const items = list.items.map((i) => {
    const held = pantry?.[i.foodId];
    if (!held) return { ...i, alreadyHave: false };
    // A pantry entry with no quantity means "I always have this".
    if (held.haveG == null) return { ...i, alreadyHave: true, buyG: 0, cost: 0 };
    const stillNeed = Math.max(0, i.neededG - held.haveG);
    if (stillNeed <= 0) return { ...i, alreadyHave: true, buyG: 0, cost: 0 };
    const step = ['pulse', 'grain', 'protein'].includes(i.category) ? 250 : 100;
    const buyG = Math.ceil(stillNeed / step) * step;
    return {
      ...i,
      alreadyHave: false,
      partiallyHave: true,
      neededG: Math.round(stillNeed),
      buyG,
      buyLabel: formatQty(buyG),
      cost: Math.round((i.pricePerKg * buyG) / 1000),
    };
  });
  return { items, total: items.reduce((s, i) => s + i.cost, 0) };
}


/**
 * "I want chole bhature tonight — does that work?"
 *
 * Answers with arithmetic rather than permission. Reports what it does to the
 * day, and if it does not fit, what portion would, because "no" is useless
 * and "two-thirds of a plate" is actionable.
 */
export function fitCheck(db, opts) {
  const {
    target, consumed, item, servings = 1,
    katoriScale = 1, month = monthKey(), priceOverrides = {},
  } = opts;

  let n, cost, label;
  if (item.kind === 'recipe') {
    const r = db.recipesById[item.id];
    if (!r) return null;
    const extras = serveWithNutrition(db, r, servings, katoriScale);
    n = addNutrition(recipeNutrition(db, r, servings), extras.nutrition);
    cost = recipeCost(db, r, servings, month, priceOverrides) + extras.cost;
    label = r.name;
  } else {
    const food = db.foodsById[item.id];
    if (!food) return null;
    const measure = db.measuresById[item.measureId] ?? db.measuresById.g;
    const { storedG, addFatG } = portionToStoredGrams({ food, measure, qty: servings, katoriScale });
    n = nutritionFor(food, storedG);
    if (addFatG) n = addNutrition(n, nutritionFor(db.foodsById.mustard_oil, addFatG));
    cost = costOfStoredGrams(db, food.id, storedG, month, priceOverrides);
    label = food.name;
  }

  const kcalLeft = target.kcal - consumed.kcal;
  const after = consumed.kcal + n.kcal;
  const over = after - target.kcal;
  const fits = over <= 0;

  // What fraction would fit, if it does not?
  const fitFraction = n.kcal > 0 ? Math.max(0, kcalLeft / n.kcal) : 0;

  return {
    label,
    servings,
    nutrition: roundNutrition(n),
    cost: Math.round(cost),
    kcalLeft: Math.round(kcalLeft),
    projected: Math.round(after),
    overBy: Math.round(Math.max(0, over)),
    fits,
    fitFraction: Number(fitFraction.toFixed(2)),
    message: fits
      ? `That fits. It puts you at ${Math.round(after)} of ${target.kcal} kcal, with ${Math.round(target.kcal - after)} still spare.`
      : fitFraction >= 0.5
        ? `That takes you ${Math.round(over)} kcal past today's target. About ${Math.round(fitFraction * 100)}% of it would fit — roughly ${(servings * fitFraction).toFixed(1)} servings instead of ${servings}.`
        : `That is ${Math.round(over)} kcal past the target, which is more than today has room for. Have it tomorrow and plan the day around it, or have a small portion now and accept the overshoot.`,
  };
}
