/**
 * app.js - screens and interaction. All arithmetic lives in core.js.
 */

import {
  buildDb, ACTIVITY, dailyTarget, bmi,
  portionToStoredGrams, nutritionFor, addNutrition, roundNutrition,
  pricePerKg, costOfStoredGrams, monthKey, availability,
  recipeNutrition, recipeCost, proteinValue, serveWithNutrition,
  generateWeekPlan, shoppingList, measuresFor,
  weightTrend, suggestAdjustment, formatQty,
  repairDay, spreadSurplus, pantryMatch, shoppingListMinusPantry, ASSUMED_STAPLES,
  packPlan, recipeCostBreakdown, fitCheck,
} from './core.js';
import { store, today, shiftDate } from './store.js';
import { lookupBarcode, canScan, scanFromCamera } from './lookup.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let db;
let viewDate = today();
let planTabDay = 0;

const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

/**
 * Which drawing stands for which food. Checked most-specific first, so
 * "paneer bhurji" gets paneer rather than the generic sabzi bowl.
 */
const ICON_RULES = [
  [/mushroom|khumb/i, 'i-mushroom'],
  [/paneer|tofu|cottage cheese/i, 'i-paneer'],
  [/\begg|anda|bhurji/i, 'i-egg'],
  // \b matters: without it "C-lassi-c Salted" matched the lassi rule and a
  // packet of crisps was drawn as a bowl of curd.
  [/\b(curd|dahi|milk|lassi|chaas|buttermilk|yoghurt|yogurt)\b/i, 'i-curd'],
  [/\b(chai|tea|coffee)\b/i, 'i-chai'],
  [/palak|methi|sarson|saag|spinach|greens|coriander|cabbage|lettuce/i, 'i-greens'],
  // Street and restaurant food before the grain rules, or "pani puri" becomes a roti.
  // "chaat" is a form, not a dish - it was hijacking corn chaat and rajma salad.
  [/samosa|pakora|bhajiya|vada pav|momo|pav bhaji|tikka|biryani|bhature|egg roll/i, 'i-packet'],
  [/corn|bhutta|makka/i, 'i-sabzi'],
  [/roti|paratha|naan|puri|chapati|thepla|bread|dosa|chilla|rusk|idli/i, 'i-roti'],
  [/rice|pulao|khichdi|poha|upma|oats|suji|rava|atta|flour|bajra/i, 'i-rice'],
  [/\bdal\b|sambar|kadhi|rajma|chole|chana|moong|masoor|urad|soya|sprout|lentil|bean/i, 'i-dal'],
  [/banana|apple|guava|papaya|orange|fruit|mango|kela/i, 'i-fruit'],
  [/chocolate|ice cream|mithai|sweet|biscuit|parle|marie|sugar|jaggery/i, 'i-sweet'],
  [/cola|monster|red bull|frooti|maaza|slice|juice|drink|energy|soda/i, 'i-can'],
  [/lay|kurkure|bingo|chips|bhujia|namkeen|packet|maggi|noodle|peanut butter|whey|mixture/i, 'i-packet'],
];

function iconFor(nameOrFood) {
  const food = typeof nameOrFood === 'string' ? null : nameOrFood;
  const name = typeof nameOrFood === 'string' ? nameOrFood : (nameOrFood?.name ?? '');
  for (const [re, id] of ICON_RULES) if (re.test(name)) return id;
  if (food?.cat === 'packaged' || food?.cat === 'eatingout') return 'i-packet';
  if (food?.cat === 'fruit') return 'i-fruit';
  if (food?.cat === 'veg') return 'i-sabzi';
  if (food?.cat === 'grain') return 'i-roti';
  if (food?.cat === 'pulse') return 'i-dal';
  if (food?.cat === 'dairy') return 'i-curd';
  if (food?.cat === 'protein') return 'i-paneer';
  if (food?.cat === 'nonveg') return 'i-egg';
  if (food?.cat === 'nut') return 'i-sweet';
  if (food?.cat === 'fat' || food?.cat === 'sugar') return 'i-sweet';
  return 'i-sabzi';
}

/** Inline so external <use> and CORS never come into it. */
function icon(id, cls = '') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

async function injectSprite() {
  try {
    const res = await fetch('assets/icons.svg');
    if (!res.ok) return;
    const markup = await res.text();
    const holder = document.createElement('div');
    holder.innerHTML = markup;
    const svg = holder.querySelector('svg');
    if (svg) document.body.insertBefore(svg, document.body.firstChild);
  } catch { /* the app works without drawings, just plainer */ }
}
const MEAL_COLOUR = {
  breakfast: 'var(--indigo)',
  lunch: 'var(--moss)',
  dinner: 'var(--amber)',
  snack: 'var(--steel-30)',
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const [foods, portions, seasonality, recipes, packaged] = await Promise.all(
      ['foods', 'portions', 'seasonality', 'recipes', 'packaged'].map((n) =>
        fetch(`data/${n}.json`).then((r) => {
          if (!r.ok) throw new Error(`data/${n}.json returned ${r.status}`);
          return r.json();
        })
      )
    );
    db = buildDb({ foods, portions, seasonality, recipes, packaged, scanned: store.state.scanned });
  } catch (err) {
    document.body.innerHTML =
      `<div class="screen"><h2 class="bar-title" style="padding-top:40px">Can't load the food data</h2>` +
      `<p class="note">${err.message}. Victu reads its data over HTTP, so it needs to be served rather than opened as a file. ` +
      `Run <code>npx serve</code> or <code>python3 -m http.server</code> in this folder and open the address it prints.</p></div>`;
    return;
  }

  await injectSprite();
  fillActivitySelect();
  wireEvents();

  if (!store.state.profile) {
    show('setup');
    updateSetupPreview();
  } else {
    $('#nav').hidden = false;
    show('today');
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* Offline support is a bonus, not a requirement. */
    });
  }

  if (!store.isPersistent) {
    toast("This browser isn't saving data - private window?");
  }
}

function fillActivitySelect() {
  $('#activity-select').innerHTML = Object.entries(ACTIVITY)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join('');
  $('#activity-select').value = 'light';
}

function show(id) {
  $$('.screen').forEach((s) => (s.hidden = s.id !== id));
  // "You" has no tab of its own, so leave Today lit while it is open.
  const lit = id === 'you' ? 'today' : id;
  $$('.nav-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.screen === lit));
  window.scrollTo({ top: 0 });
  if (id === 'today') renderToday();
  if (id === 'plan') renderPlan();
  if (id === 'kitchen') renderKitchen();
  if (id === 'you') renderYou();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** A newly scanned product has to join the food list before it can be logged. */
function rebuildDb() {
  db = buildDb({
    foods: { foods: db.foods.filter((f) => !f.isPackaged) },
    portions: { measures: db.measures, plateHeuristics: db.plateHeuristics, defaultMeasureByCategory: db.defaultMeasureByCategory },
    seasonality: db.seasonality,
    recipes: { recipes: db.recipes },
    packaged: { items: db.foods.filter((f) => f.isPackaged && !f.isScanned) },
    scanned: store.state.scanned,
  });
}

function units() {
  return store.state.profile?.units ?? 'katori';
}

function currentTarget() {
  const p = store.state.profile;
  const t = dailyTarget(p);
  const nudge = store.state.targetNudge ?? 0;
  if (nudge) {
    t.kcal = Math.max(p.sex === 'male' ? 1500 : 1200, t.kcal + nudge);
    t.nudged = nudge;
  }
  return t;
}

function weeklyBudget() {
  return ((store.state.profile.monthlyBudget ?? 4000) * 7) / 30.44;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function readSetupForm() {
  const f = $('#setup-form');
  const d = Object.fromEntries(new FormData(f));
  return {
    name: (d.name || '').trim(),
    sex: d.sex,
    ageYears: +d.ageYears,
    heightCm: +d.heightCm,
    weightKg: +d.weightKg,
    activity: d.activity,
    diet: d.diet,
    units: d.units || 'katori',
    goalKgPerWeek: +d.goalKgPerWeek,
    monthlyBudget: +d.monthlyBudget,
    household: Math.max(1, Math.min(6, +d.household || 1)),
    region: 'north_india_plains',
  };
}

function updateSetupPreview() {
  const p = readSetupForm();
  if (!p.weightKg || !p.heightCm || !p.ageYears) return;
  const t = dailyTarget(p);
  const weekly = Math.round((p.monthlyBudget * 7) / 30.44);

  $('#setup-preview').innerHTML = `
    You burn about <b>${t.maintenanceKcal}</b> kcal a day, so the plan targets
    <b>${t.kcal}</b> kcal with <b>${t.proteinG} g</b> protein — about
    <b>${t.projectedKgPerWeek} kg</b> a week. BMI <b>${bmi(p)}</b>.
    Budget works out to <b>₹${weekly}</b> a week for ${p.household === 1 ? 'one' : p.household} ${p.household === 1 ? 'person' : 'people'}.
    ${t.notes.length ? `<ul>${t.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
  `;
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function entryNutrition(entry) {
  if (entry.kind === 'food') {
    const food = db.foodsById[entry.foodId];
    return nutritionFor(food, entry.storedG);
  }
  const r = db.recipesById[entry.recipeId];
  if (!r) return { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 };
  const base = recipeNutrition(db, r, entry.servings);
  const extras = serveWithNutrition(db, r, entry.servings, store.state.katoriMl / 150);
  return addNutrition(base, extras.nutrition);
}

function entryCost(entry) {
  const month = monthKey(new Date(viewDate + 'T12:00:00'));
  const ov = store.state.priceOverrides;
  if (entry.kind === 'food') {
    return costOfStoredGrams(db, entry.foodId, entry.storedG, month, ov);
  }
  const r = db.recipesById[entry.recipeId];
  if (!r) return 0;
  const extras = serveWithNutrition(db, r, entry.servings, store.state.katoriMl / 150);
  return recipeCost(db, r, entry.servings, month, ov) + extras.cost;
}

/* Four katoris on a plate, arranged where they'd actually sit. Each fills
   from the bottom as that meal is logged - a plate filling up reads faster
   than a progress ring, and it is the thing this app is actually about. */
const SLOT_POS = (() => {
  // Katoris sit on a ring near the rim, the way they do on a real thali, so
  // the middle stays free for the number. The first version put them too far
  // in and the lunch bowl swallowed the figure.
  const cx = 100, cy = 100, ring = 63, r = 19;
  const at = (deg) => ({
    x: cx + ring * Math.cos((deg - 90) * Math.PI / 180),
    y: cy + ring * Math.sin((deg - 90) * Math.PI / 180),
    r,
  });
  return {
    breakfast: { ...at(0),   label: 'breakfast' },
    lunch:     { ...at(90),  label: 'lunch' },
    dinner:    { ...at(180), label: 'dinner' },
    snack:     { ...at(270), label: 'snack' },
  };
})();
const SLOT_PIGMENT = {
  breakfast: 'var(--ill-turmeric)',
  lunch:     'var(--ill-coriander)',
  dinner:    'var(--ill-cumin)',
  snack:     'var(--ill-chilli)',
};

function renderToday() {
  const t = currentTarget();
  const entries = store.entriesFor(viewDate);
  const d = new Date(viewDate + 'T12:00:00');
  const isToday = viewDate === today();

  $('#today-date').textContent = isToday
    ? 'Today'
    : d.toLocaleDateString(undefined, { weekday: 'long' });
  $('#today-sub').textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });

  // --- totals ---
  const byMeal = {};
  let total = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 };
  let spent = 0;
  for (const e of entries) {
    const n = entryNutrition(e);
    byMeal[e.meal] = (byMeal[e.meal] ?? 0) + n.kcal;
    total = addNutrition(total, n);
    spent += entryCost(e);
  }

  // --- the plate ---
  const slotShare = { breakfast: 0.25, lunch: 0.35, dinner: 0.30, snack: 0.10 };
  $('#thali-slots').innerHTML = Object.entries(SLOT_POS).map(([meal, pos]) => {
    const budget = t.kcal * slotShare[meal];
    const eaten = byMeal[meal] ?? 0;
    const frac = Math.max(0, Math.min(1, eaten / budget));
    const clipId = `clip-${meal}`;
    // Fill height measured from the bottom of the bowl.
    const fillTop = pos.y + pos.r - (2 * pos.r * frac);
    return `
      <clipPath id="${clipId}"><circle cx="${pos.x}" cy="${pos.y}" r="${pos.r - 2}"/></clipPath>
      <circle class="slot-ring" cx="${pos.x}" cy="${pos.y}" r="${pos.r}"/>
      <rect class="slot-fill" clip-path="url(#${clipId})"
        x="${pos.x - pos.r}" y="${fillTop}" width="${pos.r * 2}" height="${pos.r * 2}"
        fill="${SLOT_PIGMENT[meal]}" opacity="${frac > 0 ? 0.92 : 0}"/>
      <text class="slot-label" x="${pos.x}" y="${pos.y + pos.r + 10}">${pos.label}</text>`;
  }).join('');

  const left = Math.round(t.kcal - total.kcal);
  $('#thali-wrap').classList.toggle('is-over', left < 0);
  $('#thali-fig').textContent = Math.abs(left).toLocaleString('en-IN');
  $('#thali-cap').textContent = left < 0 ? 'over today' : 'left today';

  // --- the one status line ---
  $('#sp-val').textContent = Math.round(total.p);
  $('#sp-of').textContent = `of ${t.proteinG} g`;
  $('#sp-fill').style.width = `${Math.min(100, (total.p / t.proteinG) * 100)}%`;

  const dailyBudget = weeklyBudget() / 7;
  $('#sm-val').textContent = `₹${Math.round(spent)}`;
  $('#sm-of').textContent = `of ₹${Math.round(dailyBudget)}`;
  $('#sm-fill').style.width = `${Math.min(100, (spent / dailyBudget) * 100)}%`;
  $('#stat-money').classList.toggle('is-over', spent > dailyBudget);

  renderQuickLog();

  // --- what was eaten, grouped by meal ---
  const host = $('#log-list');
  if (!entries.length) {
    host.innerHTML = `<div class="empty-state">
      ${icon('i-empty-plate')}
      <p class="empty-title">Nothing logged yet</p>
      <p>Tap something above to log it again, or use Log food for anything new.</p>
    </div>`;
    renderRepair();
    return;
  }

  host.innerHTML = ['breakfast', 'lunch', 'dinner', 'snack']
    .filter((m) => entries.some((e) => e.meal === m))
    .map((m) => {
      const rows = entries.filter((e) => e.meal === m);
      const kcal = Math.round(rows.reduce((sum, e) => sum + entryNutrition(e).kcal, 0));
      return `<div class="meal-group">
        <div class="meal-group-head">
          <span>${MEAL_LABEL[m]}</span>
          <span class="mg-kcal">${kcal} kcal</span>
        </div>
        ${rows.map((e) => {
          const n = roundNutrition(entryNutrition(e));
          const art = e.kind === 'recipe' ? iconFor(e.label) : iconFor(db.foodsById[e.foodId] ?? e.label);
          return `<div class="meal-row">
            ${icon(art)}
            <span class="meal-main">
              <span class="meal-name">${escapeHtml(e.label)}</span>
              <span class="meal-portion">${escapeHtml(e.portionLabel)}</span>
            </span>
            <span class="meal-figs"><b>${n.kcal}</b>${n.p} g protein</span>
            <button class="meal-del" data-del="${e.id}" aria-label="Remove ${escapeHtml(e.label)}">✕</button>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');

  renderRepair();
}

/**
 * People eat the same twenty things. The fastest possible log is tapping
 * something you have eaten before, with the portion you used last time, into
 * the meal slot the clock implies. One tap, no sheet.
 */
function slotForNow() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

function frequentEntries(limit = 7) {
  const counts = new Map();
  const dates = Object.keys(store.state.log).sort().slice(-30);
  for (const date of dates) {
    for (const e of store.state.log[date]) {
      const key = e.kind === 'recipe' ? `r:${e.recipeId}` : `f:${e.foodId}:${e.portionLabel}`;
      const prev = counts.get(key);
      counts.set(key, { entry: e, n: (prev?.n ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, limit).map((x) => x.entry);
}

function renderQuickLog() {
  const favs = frequentEntries();
  const host = $('#quick');
  const box = $('#quick-log');

  if (!favs.length) {
    // Nothing logged ever: offer the plates instead, so the row is never empty.
    box.innerHTML = `
      <button class="qbtn" data-plate="thali_veg">${icon('i-roti')}<span class="qbtn-name">Roti thali</span></button>
      <button class="qbtn" data-plate="thali_rice">${icon('i-rice')}<span class="qbtn-name">Rice thali</span></button>
      <button class="qbtn qbtn-more" id="qbtn-browse">${icon('i-sabzi')}<span class="qbtn-name">Browse food</span></button>`;
    return;
  }

  box.innerHTML = favs.map((e, i) => {
    const n = roundNutrition(entryNutrition(e));
    const art = e.kind === 'recipe' ? iconFor(e.label) : iconFor(db.foodsById[e.foodId] ?? e.label);
    return `<button class="qbtn" data-quick="${i}">
      ${icon(art)}
      <span class="qbtn-name">${escapeHtml(e.label)}</span>
      <span class="qbtn-kcal">${n.kcal}</span>
    </button>`;
  }).join('') +
  `<button class="qbtn qbtn-more" id="qbtn-browse">${icon('i-sabzi')}<span class="qbtn-name">More</span></button>`;

  box._favs = favs;
}

// ---------------------------------------------------------------------------
// Log sheet
// ---------------------------------------------------------------------------

let pending = null; // { type:'food'|'recipe', id, measureId, qty, katoriSize }

function openSheet() {
  $('#sheet').hidden = false;
  $('#portion-pad').hidden = true;
  $('#search-results').hidden = false;
  $('#food-search').value = '';
  renderResults('');
  setTimeout(() => $('#food-search').focus(), 60);
}

function closeSheet() {
  $('#sheet').hidden = true;
  pending = null;
}

function currentFilter() {
  return $('#food-filter .tab[aria-selected="true"]')?.dataset.filter ?? 'all';
}

function renderResults(q) {
  const term = q.trim().toLowerCase();
  const month = monthKey();
  const filter = currentFilter();

  const wantRecipes = filter === 'all' || filter === 'recipe';
  const wantFoods = filter !== 'recipe';

  const recipes = !wantRecipes ? [] : db.recipes
    .filter((r) => !term || r.name.toLowerCase().includes(term))
    .slice(0, term ? 8 : 5)
    .map((r) => {
      const n = roundNutrition(recipeNutrition(db, r, 1));
      const c = Math.round(recipeCost(db, r, 1, month, store.state.priceOverrides));
      return `<li><button data-pick-recipe="${r.id}">
        ${icon(iconFor(r.name))}
        <span class="res-name">${escapeHtml(r.name)}<span class="res-sub">one serving, cooked — ₹${c}</span></span>
        <span class="res-fig">${n.kcal} kcal</span>
      </button></li>`;
    });

  const foods = !wantFoods ? [] : db.foods
    .filter((f) => {
      if (filter === 'packaged' && f.cat !== 'packaged') return false;
      if (filter === 'eatingout' && f.cat !== 'eatingout') return false;
      if (filter === 'raw' && (f.cat === 'packaged' || f.cat === 'eatingout')) return false;
      if (!term) return true;
      return matchesFood(f, term);
    })
    .slice(0, 16)
    .map((f) => {
      const measures = measuresFor(db, f, units());
      const m = measures[0];
      const { storedG } = portionToStoredGrams({ food: f, measure: m, qty: 1, katoriScale: store.state.katoriMl / 150 });
      const n = roundNutrition(nutritionFor(f, storedG));
      const badge = f.isScanned ? '<span class="badge-scan">scanned</span>'
                  : f.nova === 4 ? '<span class="badge-nova">ultra-processed</span>' : '';
      return `<li><button data-pick-food="${f.id}">
        ${icon(iconFor(f))}
        <span class="res-name">${escapeHtml(f.name)} ${badge}<span class="res-sub">${m ? escapeHtml(m.label) : 'per 100 g'}</span></span>
        <span class="res-fig">${n.kcal} kcal</span>
      </button></li>`;
    });

  $('#search-results').innerHTML = [...recipes, ...foods].join('') ||
    '<li class="empty">Nothing matches. Try a shorter word, or scan the barcode.</li>';
}

function openPortionPad(type, id) {
  if (type === 'food') {
    const food = db.foodsById[id];
    const measures = measuresFor(db, food, units());
    pending = { type, id, measureId: measures[0]?.id ?? 'g', qty: 1, katoriSize: 'standard' };
  } else {
    pending = { type, id, qty: 1 };
  }
  renderPortionPad();
  $('#portion-pad').hidden = false;
  // Put the pad where the results were, rather than below a list the user has
  // already finished with.
  $('#search-results').hidden = true;
  $('.sheet-panel').scrollTop = 0;
}

function renderPortionPad() {
  const pad = $('#portion-pad');
  if (!pending) return;

  if (pending.type === 'recipe') {
    const r = db.recipesById[pending.id];
    const n = roundNutrition(
      addNutrition(
        recipeNutrition(db, r, pending.qty),
        serveWithNutrition(db, r, pending.qty, store.state.katoriMl / 150).nutrition
      )
    );
    const cost = Math.round(
      recipeCost(db, r, pending.qty, monthKey(), store.state.priceOverrides) +
      serveWithNutrition(db, r, pending.qty, store.state.katoriMl / 150).cost
    );
    pad.innerHTML = `
      <div class="pp-head">${icon(iconFor(r.name))}<span class="pp-name">${escapeHtml(r.name)}</span></div>
      <div class="qty-row">
        <button class="btn qty-step" data-qty="-0.25" aria-label="Less">−</button>
        <input id="pp-qty" type="number" step="0.25" min="0.25" max="6" value="${pending.qty}" aria-label="Servings">
        <button class="btn qty-step" data-qty="0.25" aria-label="More">+</button>
        <span class="led-sub">servings${r.serveWith?.length ? ', with the usual roti or rice' : ''}</span>
      </div>
      <div class="pp-readout">
        <span><b>${n.kcal}</b> kcal</span><span><b>${n.p}</b> g protein</span>
        <span><b>${n.fiber}</b> g fibre</span><span><b>₹${cost}</b></span>
      </div>
      <button class="btn btn-primary btn-block" id="pp-save">Add to ${MEAL_LABEL[selectedMeal()].toLowerCase()}</button>
    `;
  } else {
    const food = db.foodsById[pending.id];
    const measures = measuresFor(db, food, units());
    const measure = db.measuresById[pending.measureId];
    const isKatori = /^(katori|glass|cup|ladle|bowl)_/.test(pending.measureId);
    const isBase = measure?.isBase === true;
    const sizeScale = { small: 100 / 150, standard: 1, large: 200 / 150 }[pending.katoriSize] ?? 1;
    const katoriScale = (store.state.katoriMl / 150) * sizeScale;

    const { storedG, addFatG } = portionToStoredGrams({ food, measure, qty: pending.qty, katoriScale });
    let n = nutritionFor(food, storedG);
    if (addFatG) n = addNutrition(n, nutritionFor(db.foodsById.mustard_oil, addFatG));
    const rn = roundNutrition(n);
    const cost = Math.round(
      costOfStoredGrams(db, food.id, storedG, monthKey(), store.state.priceOverrides) +
      (addFatG ? costOfStoredGrams(db, 'mustard_oil', addFatG, monthKey(), store.state.priceOverrides) : 0)
    );

    pad.innerHTML = `
      <div class="pp-head">
        ${icon(iconFor(food))}
        <span class="pp-name">${escapeHtml(food.name)}</span>
        <span class="pp-as">${formatQty(Math.round(storedG))} as bought</span>
      </div>
      ${isKatori && units() === 'katori' ? `
      <div class="katori-row" role="group" aria-label="Katori size">
        ${['small', 'standard', 'large'].map((s) => `
          <button class="katori" data-size="${s}" aria-pressed="${pending.katoriSize === s}">${s === 'standard' ? 'usual' : s}</button>
        `).join('')}
      </div>` : ''}
      <div class="measure-grid">
        ${measures.slice(0, 6).map((m) => `
          <button class="measure-btn" data-measure="${m.id}" aria-pressed="${m.id === pending.measureId}">${escapeHtml(m.label)}</button>
        `).join('')}
      </div>
      <div class="qty-row">
        <button class="btn qty-step" data-qty="${isBase ? -10 : -0.5}" aria-label="Less">−</button>
        <input id="pp-qty" type="number" step="${isBase ? 10 : 0.5}" min="${isBase ? 5 : 0.5}" value="${pending.qty}" aria-label="Quantity">
        <button class="btn qty-step" data-qty="${isBase ? 10 : 0.5}" aria-label="More">+</button>
        <span class="led-sub">${isBase ? escapeHtml(measure?.label ?? '') : `× ${escapeHtml(measure?.label ?? '')}`}</span>
      </div>
      ${addFatG ? `<p class="note">Plus about ${addFatG} g of oil or ghee from the tawa, counted in.</p>` : ''}
      <div class="pp-readout">
        <span><b>${rn.kcal}</b> kcal</span><span><b>${rn.p}</b> g protein</span>
        <span><b>${rn.fiber}</b> g fibre</span><span><b>₹${cost}</b></span>
      </div>
      <button class="btn btn-primary btn-block" id="pp-save">Add to ${MEAL_LABEL[selectedMeal()].toLowerCase()}</button>
    `;
  }
}

function selectedMeal() {
  return $('#meal-pick input:checked')?.value ?? 'lunch';
}

function savePending() {
  if (!pending) return;
  const meal = selectedMeal();

  if (pending.type === 'recipe') {
    const r = db.recipesById[pending.id];
    store.addEntry(viewDate, {
      kind: 'recipe', recipeId: r.id, servings: pending.qty, meal,
      label: r.name,
      portionLabel: `${pending.qty} serving${pending.qty === 1 ? '' : 's'}`,
    });
    // Cooking it uses it up.
    store.consumeFromPantry(r.ing.map((i) => ({ food: i.food, g: i.g * pending.qty })));
  } else {
    const food = db.foodsById[pending.id];
    const measure = db.measuresById[pending.measureId];
    const sizeScale = { small: 100 / 150, standard: 1, large: 200 / 150 }[pending.katoriSize] ?? 1;
    const katoriScale = (store.state.katoriMl / 150) * sizeScale;
    const { storedG, addFatG } = portionToStoredGrams({ food, measure, qty: pending.qty, katoriScale });

    store.addEntry(viewDate, {
      kind: 'food', foodId: food.id, storedG, meal,
      label: food.name,
      portionLabel: `${pending.qty} × ${measure?.label ?? 'g'}`,
    });
    if (addFatG) {
      store.addEntry(viewDate, {
        kind: 'food', foodId: 'mustard_oil', storedG: addFatG, meal,
        label: 'Oil on the tawa', portionLabel: `${addFatG} g`,
      });
    }
  }

  closeSheet();
  renderToday();
  toast('Logged');
}

function logPlate(plateId) {
  const plate = db.plateHeuristics[plateId];
  if (!plate) return;
  const meal = 'lunch';
  const katoriScale = store.state.katoriMl / 150;

  const entries = [];
  for (const part of plate) {
    const measure = db.measuresById[part.measure];
    if (!measure) continue;
    const foodId = part.measure.startsWith('katori_rice') ? 'rice'
                 : part.measure.startsWith('katori_curd') ? 'curd'
                 : part.measure.startsWith('katori_dal') ? 'toor_dal'
                 : part.measure.startsWith('katori_sabzi') ? 'potato'
                 : part.measure.startsWith('tsp_oil') ? 'mustard_oil'
                 : 'atta';
    const food = db.foodsById[foodId];
    const { storedG } = portionToStoredGrams({ food, measure, qty: part.qty, katoriScale });
    entries.push({
      kind: 'food', foodId, storedG, meal,
      label: food.name,
      portionLabel: `${part.qty} × ${measure.label}`,
    });
  }
  store.addEntries(viewDate, entries);
  renderToday();
  toast('Thali logged — adjust any line that was bigger or smaller');
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function buildPlan() {
  const p = store.state.profile;
  const plan = generateWeekPlan(db, {
    profile: p,
    target: currentTarget(),
    month: monthKey(),
    weeklyBudget: weeklyBudget(),
    household: p.household ?? 1,
    dislikes: store.state.dislikes,
    priceOverrides: store.state.priceOverrides,
    katoriScale: store.state.katoriMl / 150,
    pantry: store.state.pantry,
  });
  store.update({ plan });
  planTabDay = 0;
  return plan;
}

function renderPlan() {
  let plan = store.state.plan;
  if (!plan || plan.error || !plan.days) plan = buildPlan();

  if (plan.error) {
    $('#plan-sub').textContent = '';
    $('#budget-strip').innerHTML = `<span class="bs-lab">${escapeHtml(plan.error)}</span>`;
    $('#plan-day').innerHTML = '';
    $('#shopping').innerHTML = '';
    return;
  }

  const p = store.state.profile;
  // The list now buys whole packs and already subtracts the pantry itself.
  const list = plan.shopping ?? shoppingList(db, plan, {
    household: p.household ?? 1,
    month: plan.month,
    priceOverrides: store.state.priceOverrides,
    pantry: store.state.pantry,
  });

  $('#plan-sub').textContent =
    `${p.household > 1 ? `${p.household} people · ` : ''}${new Date().toLocaleDateString(undefined, { month: 'long' })} prices`;

  const budget = weeklyBudget();
  const strip = $('#budget-strip');
  strip.classList.toggle('is-over', !plan.withinBudget);
  strip.innerHTML = `
    <div><div class="bs-fig">₹${list.total}</div><div class="bs-lab">at the till</div></div>
    <div><div class="bs-fig">₹${list.eatenValue}</div><div class="bs-lab">eaten this week</div></div>
    <div><div class="bs-fig">₹${list.leftoverValue}</div><div class="bs-lab">stays in the kitchen</div></div>
  `;

  const note = $('#budget-note');
  note.hidden = !plan.budgetNote;
  if (plan.budgetNote) note.textContent = plan.budgetNote;

  $('#plan-tabs').innerHTML = plan.days
    .map((d, i) => {
      const dt = new Date(d.date + 'T12:00:00');
      return `<button class="tab" role="tab" aria-selected="${i === planTabDay}" data-day="${i}">${dt.toLocaleDateString(undefined, { weekday: 'short' })}</button>`;
    })
    .join('');

  renderPlanDay(plan, planTabDay);

  $('#shopping').innerHTML = list.items
    .map((i) => {
      const avail = i.availability;
      const tag = avail === 'peak' ? '<span class="r-tag is-peak">in season</span>'
                : avail === 'off' || avail === 'scarce' ? '<span class="r-tag is-off">out of season</span>'
                : '';
      const overridden = store.state.priceOverrides[i.foodId] != null;
      if (i.alreadyHave) {
        return `<li style="opacity:.55">
          <div class="led-main">
            <span class="led-name">${escapeHtml(i.name)}</span>
            <span class="led-sub">already in your kitchen</span>
          </div>
          <span class="led-fig">—</span>
        </li>`;
      }
      return `<li>
        <div class="led-main">
          <span class="led-name">${escapeHtml(i.name)}</span>
          <span class="led-sub">${i.buyLabel}${i.partiallyHave ? ' more needed' : ''}${
            i.leftoverG > 0 && !i.loose ? ` — ${formatQty(i.leftoverG)} spare` : ''} ${tag}</span>
        </div>
        <button class="link" data-price="${i.foodId}" title="Correct this price">₹${i.pricePerKg}/kg${overridden ? ' ✓' : ''}</button>
        <span class="led-fig led-fig-money">₹${i.cost}</span>
      </li>`;
    })
    .join('');
}

function renderPlanDay(plan, idx) {
  const day = plan.days[idx];
  if (!day) return;
  const t = currentTarget();

  $('#plan-day').innerHTML = `
    ${day.meals.map((m) => {
      const r = db.recipesById[m.recipeId];
      const withTxt = (m.serveWith ?? []).map((s) => {
        const [mid, q] = s.split(':');
        const measure = db.measuresById[mid];
        const qty = Number(q ?? 1) * m.servings;
        return `${qty % 1 === 0 ? qty : qty.toFixed(1)} × ${measure?.label ?? mid}`;
      }).join(', ');
      return `<div class="pd-meal">
        ${icon(iconFor(m.name))}
        <div class="pd-body">
          <span class="pd-slot">${MEAL_LABEL[m.meal]}</span>
          <span class="pd-name">${escapeHtml(m.name)}</span>
          <span class="pd-figs">${m.nutrition.kcal} kcal, ${m.nutrition.p} g protein, ₹${m.cost}</span>
        ${withTxt ? `<p class="pd-with">with ${escapeHtml(withTxt)}</p>` : ''}
        <p class="pd-with row-actions" style="margin-top:6px">
          <button class="link" data-cook="${m.recipeId}">Recipe</button>
          <button class="link" data-logplan="${idx}:${m.meal}">Log as eaten</button>
          ${r ? `<button class="link" data-dislike="${m.recipeId}">Not this</button>` : ''}
        </p>
        </div>
      </div>`;
    }).join('')}
    <div class="pd-totals">
      <span>${day.nutrition.kcal} kcal</span>
      <span>${day.nutrition.p} g protein</span>
      <span>₹${day.cost}</span>
      <span style="color:${day.proteinGap < -15 ? 'var(--madder)' : 'var(--ink-45)'}">
        ${day.proteinGap >= 0 ? `+${day.proteinGap}` : day.proteinGap} g vs ${t.proteinG} target
      </span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Cook
// ---------------------------------------------------------------------------

function renderCook() {
  const month = monthKey();
  const term = ($('#recipe-search').value || '').trim().toLowerCase();
  const sort = $('#recipe-sort input:checked')?.value ?? 'season';
  const p = store.state.profile;
  const ov = store.state.priceOverrides;

  let list = db.recipes.filter((r) => {
    if (term && !r.name.toLowerCase().includes(term)) return false;
    if (p.diet === 'veg' && !r.veg) return false;
    if (p.diet === 'egg' && !r.veg && r.id !== 'egg_bhurji') return false;
    return true;
  });

  const seasonScore = (r) => {
    const states = r.ing.map((i) => availability(db, i.food, month)).filter(Boolean);
    if (states.includes('off')) return 0;
    if (states.includes('scarce')) return 1;
    if (states.includes('peak')) return 3;
    return 2;
  };

  if (sort === 'protein') list.sort((a, b) => proteinValue(db, a, month, ov) - proteinValue(db, b, month, ov));
  else if (sort === 'cost') list.sort((a, b) => recipeCost(db, a, 1, month, ov) - recipeCost(db, b, 1, month, ov));
  else list.sort((a, b) => seasonScore(b) - seasonScore(a) || a.name.localeCompare(b.name));

  $('#recipe-list').innerHTML = list
    .map((r) => {
      const n = roundNutrition(recipeNutrition(db, r, 1));
      const cost = recipeCost(db, r, 1, month, ov);
      const pv = proteinValue(db, r, month, ov);
      const s = seasonScore(r);
      const tag = s === 3 ? '<span class="r-tag is-peak">in season now</span>'
                : s === 0 ? '<span class="r-tag is-off">not in season</span>' : '';
      const disliked = store.state.dislikes.includes(r.id);
      return `<li class="recipe"><details data-recipe="${r.id}">
        <summary class="recipe-sum">
          ${icon(iconFor(r.name))}
          <span class="r-name">${escapeHtml(r.name)}
            <span class="r-tags">
              ${tag}
              <span class="r-tag">${r.timeMin} min</span>
              <span class="r-tag">₹${pv.toFixed(2)}/g protein</span>
              ${disliked ? '<span class="r-tag is-off">hidden from plans</span>' : ''}
            </span>
          </span>
          <span class="r-figs">${n.kcal} kcal · ${n.p} p · ₹${Math.round(cost)}</span>
        </summary>
        <div class="recipe-body" data-body="${r.id}"></div>
      </details></li>`;
    })
    .join('') || '<li class="empty">No recipes match that.</li>';
}

function renderRecipeBody(recipeId, servings) {
  const r = db.recipesById[recipeId];
  const host = $(`[data-body="${recipeId}"]`);
  if (!r || !host) return;
  const month = monthKey();
  const ov = store.state.priceOverrides;

  const n = roundNutrition(recipeNutrition(db, r, servings));
  const b = recipeCostBreakdown(db, r, servings, month, ov, store.state.pantry);
  const gap = b.till - b.ingredients;

  host.innerHTML = `
    <div class="scale-row">
      <label>Cooking for <input type="number" min="1" max="6" step="1" value="${servings}" data-scale="${r.id}" aria-label="Servings"></label>
      <span class="led-sub">${n.kcal} kcal, ${n.p} g protein per serving</span>
    </div>
    <div class="cost-two">
      <div><span class="c2-fig">₹${b.ingredients}</span><span class="c2-lab">of ingredients used</span></div>
      <div><span class="c2-fig">₹${b.till}</span><span class="c2-lab">at the till today</span></div>
    </div>
    ${gap > b.ingredients ? `<p class="note">You cannot buy 20 g of milk — you buy the packet. The gap is what stays in your kitchen afterwards, and the next recipe draws on it.</p>` : ''}
    <ul class="ing-list">
      ${b.lines.map((l) => `<li><span>${escapeHtml(l.name)}</span>
        <span class="ing-q">${formatQty(l.g)}${l.alreadyHave
          ? ' — have it'
          : l.buyG > l.g ? ` — buy ${formatQty(l.buyG)}, ₹${l.tillCost}` : ` — ₹${l.tillCost}`}</span></li>`).join('')}
    </ul>
    <ol class="steps">${r.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    ${r.notes ? `<p class="r-note">${escapeHtml(r.notes)}</p>` : ''}
    <div class="row-actions" style="margin-top:14px">
      <button class="btn" data-logrecipe="${r.id}">Log one serving</button>
      <button class="btn btn-quiet" data-dislike="${r.id}">${store.state.dislikes.includes(r.id) ? 'Allow in plans' : 'Never plan this'}</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// You
// ---------------------------------------------------------------------------

function renderYou() {
  const p = store.state.profile;
  const t = currentTarget();
  $('#you-sub').textContent = `${p.name || 'You'} · ${p.weightKg} kg · BMI ${bmi(p)}`;

  // --- weight trend ---
  const trend = weightTrend(store.state.weights);
  drawTrend(trend);
  $('#trend-note').textContent = trend.confident
    ? `Seven-day average is moving ${trend.ratePerWeek > 0 ? 'up' : 'down'} ${Math.abs(trend.ratePerWeek)} kg a week.`
    : (trend.note ?? 'Add a weigh-in to start the trend.');

  // --- weekly review ---
  const adherence = computeAdherence(t);
  const s = suggestAdjustment({ target: t, trend, adherence });
  const box = $('#review');
  box.classList.toggle('is-warn', s.action !== 'hold');
  box.innerHTML = `<p style="margin:0">${escapeHtml(s.message)}</p>` +
    (s.deltaKcal ? `<button class="btn btn-quiet" style="margin-top:10px" id="btn-apply-nudge">Apply ${s.deltaKcal > 0 ? '+' : ''}${s.deltaKcal} kcal to my target</button>` : '');
  if (s.deltaKcal) {
    $('#btn-apply-nudge').onclick = () => {
      store.update({ targetNudge: (store.state.targetNudge ?? 0) + s.deltaKcal });
      renderYou();
      toast('Target adjusted');
    };
  }

  const u = units();
  $$('#units-toggle input').forEach((r) => (r.checked = r.value === u));
  $('#katori-block').hidden = u !== 'katori';
  $('#units-note').textContent = u === 'grams'
    ? 'Grams first everywhere. Katori measures are still there when you are eating out and cannot weigh anything.'
    : 'Household measures first. Switch to the scale any time — nothing you have already logged changes.';

  $('#katori-note').textContent = `Currently ${store.state.katoriMl} ml. ` +
    (store.state.katoriMl === 150 ? 'That is the standard assumption.' : 'Every katori you log scales to this.');
  $('#katori-form input').value = store.state.katoriMl;

  const ov = Object.keys(store.state.priceOverrides).length;
  $('#target-detail').innerHTML = `
    <div><div class="led-main"><span class="led-name">Maintenance</span><span class="led-sub">what you burn</span></div><span class="led-fig">${t.maintenanceKcal} kcal</span></div>
    <div><div class="led-main"><span class="led-name">Daily target</span><span class="led-sub">${t.nudged ? `includes a ${t.nudged > 0 ? '+' : ''}${t.nudged} kcal review adjustment` : 'from your goal rate'}</span></div><span class="led-fig">${t.kcal} kcal</span></div>
    <div><div class="led-main"><span class="led-name">Protein</span><span class="led-sub">1.6 g per kg reference weight</span></div><span class="led-fig">${t.proteinG} g</span></div>
    <div><div class="led-main"><span class="led-name">Projected loss</span><span class="led-sub">asked for ${t.requestedKgPerWeek} kg/week</span></div><span class="led-fig">${t.projectedKgPerWeek} kg/wk</span></div>
    <div><div class="led-main"><span class="led-name">Prices you've corrected</span><span class="led-sub">used in every plan</span></div><span class="led-fig">${ov}</span></div>
  `;
  if (t.notes.length) {
    $('#target-detail').innerHTML += `<div style="border:0"><p class="note">${t.notes.map(escapeHtml).join(' ')}</p></div>`;
  }
}

function computeAdherence(t) {
  const dates = Object.keys(store.state.log).sort().slice(-14);
  if (dates.length < 4) return null;
  let hit = 0;
  for (const d of dates) {
    const kcal = store.entriesFor(d).reduce((s, e) => s + entryNutrition(e).kcal, 0);
    if (kcal > 0 && kcal <= t.kcal * 1.08) hit++;
  }
  return hit / dates.length;
}

function drawTrend(trend) {
  const svg = $('#trend');
  const pts = trend.smoothed;
  const raw = store.state.weights;
  if (!raw.length) {
    svg.innerHTML = '<title>Weight</title><text x="160" y="58" text-anchor="middle" font-size="11" fill="#8291A0" font-family="Spline Sans, sans-serif">No weigh-ins yet</text>';
    return;
  }

  const W = 320, H = 110, pad = 12;
  const kgs = [...raw.map((r) => r.kg), ...pts.map((p) => p.kg)];
  const min = Math.min(...kgs) - 0.4, max = Math.max(...kgs) + 0.4;
  const span = Math.max(0.8, max - min);
  const x = (i, n) => pad + (i / Math.max(1, n - 1)) * (W - pad * 2);
  const y = (kg) => H - pad - ((kg - min) / span) * (H - pad * 2);

  const dots = raw.map((r, i) => `<circle class="trend-dot" cx="${x(i, raw.length).toFixed(1)}" cy="${y(r.kg).toFixed(1)}" r="2"></circle>`).join('');
  const line = pts.length > 1
    ? `<polyline class="trend-line" points="${pts.map((p, i) => `${x(i, pts.length).toFixed(1)},${y(p.kg).toFixed(1)}`).join(' ')}"></polyline>`
    : '';

  svg.innerHTML = `<title>Weight, with a seven-day average</title>${dots}${line}
    <text x="${W - pad}" y="${pad + 2}" text-anchor="end" font-size="9" fill="#8291A0" font-family="Spline Sans Mono, monospace">${max.toFixed(1)}</text>
    <text x="${W - pad}" y="${H - pad + 4}" text-anchor="end" font-size="9" fill="#8291A0" font-family="Spline Sans Mono, monospace">${min.toFixed(1)}</text>`;
}

// ---------------------------------------------------------------------------
// Day repair
// ---------------------------------------------------------------------------

function slotsStillToCome() {
  const logged = new Set(store.entriesFor(viewDate).map((e) => e.meal));
  const order = ['breakfast', 'lunch', 'dinner', 'snack'];
  const hour = viewDate === today() ? new Date().getHours() : 0;

  return order.filter((slot) => {
    if (logged.has(slot)) return false;
    if (viewDate !== today()) return true;
    if (slot === 'breakfast') return hour < 11;
    if (slot === 'lunch') return hour < 16;
    if (slot === 'dinner') return hour < 23;
    return hour < 20;
  });
}

let repairState = null;   // { result, picks: { slot: optionIndex } }

function renderRepair() {
  const box = $('#repair');
  const entries = store.entriesFor(viewDate);
  if (!entries.length) { box.hidden = true; return; }

  const t = currentTarget();
  let consumed = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 };
  let spent = 0;
  for (const e of entries) { consumed = addNutrition(consumed, entryNutrition(e)); spent += entryCost(e); }

  const r = repairDay(db, {
    profile: store.state.profile,
    target: t,
    consumed,
    slotsLeft: slotsStillToCome(),
    month: monthKey(new Date(viewDate + 'T12:00:00')),
    dailyBudget: weeklyBudget() / 7,
    spentToday: spent,
    dislikes: store.state.dislikes,
    priceOverrides: store.state.priceOverrides,
    katoriScale: store.state.katoriMl / 150,
  });

  // Keep whatever the user already switched to.
  const picks = {};
  for (const sg of r.suggestions) picks[sg.slot] = repairState?.picks?.[sg.slot] ?? 0;
  repairState = { result: r, picks, consumed, target: t };

  drawRepair();
}

function drawRepair() {
  const box = $('#repair');
  const { result: r, picks, consumed, target: t } = repairState;

  box.hidden = false;
  box.className = `repair ${r.verdict === 'over' ? 'is-over' : r.verdict === 'tight' ? 'is-tight' : ''}`;

  const daysLeft = 6 - new Date(viewDate + 'T12:00:00').getDay();
  const spread = r.offerWeekSpread
    ? spreadSurplus({ surplusKcal: consumed.kcal - t.kcal, daysLeft: Math.max(0, daysLeft), target: t, profile: store.state.profile })
    : null;

  // Projection follows whatever is currently selected.
  const chosenKcal = r.suggestions.reduce((sum, sg) => sum + (sg.options[picks[sg.slot]]?.nutrition.kcal ?? 0), 0);
  const chosenP = r.suggestions.reduce((sum, sg) => sum + (sg.options[picks[sg.slot]]?.nutrition.p ?? 0), 0);
  const chosenCost = r.suggestions.reduce((sum, sg) => sum + (sg.options[picks[sg.slot]]?.cost ?? 0), 0);

  box.innerHTML = `
    <p class="repair-msg">${escapeHtml(r.message)}</p>

    ${r.suggestions.map((sg) => `
      <div class="repair-slot">
        <div class="rs-head">${MEAL_LABEL[sg.slot]}</div>
        <div class="rs-options">
          ${sg.options.map((o, i) => `
            <button class="rs-opt" data-pick="${sg.slot}:${i}" aria-pressed="${picks[sg.slot] === i}">
              ${icon(iconFor(o.name))}
              <span class="rs-name">${escapeHtml(o.name)}${o.servings !== 1 ? ` ×${o.servings}` : ''}</span>
              <span class="rs-why">${escapeHtml(o.why)}</span>
              <span class="rs-figs">${o.nutrition.kcal} kcal · ${o.nutrition.p} g · ₹${o.cost}</span>
            </button>`).join('')}
        </div>
      </div>`).join('')}

    ${r.suggestions.length ? `
      <p class="repair-proj">Picking these puts you at <b>${Math.round(consumed.kcal + chosenKcal)}</b> of ${t.kcal} kcal,
        <b>${Math.round(consumed.p + chosenP)}</b> of ${t.proteinG} g protein, and costs <b>₹${chosenCost}</b> more today.</p>` : ''}

    ${spread ? `<p class="note">${escapeHtml(spread.message)}</p>` : ''}

    <div class="repair-want">
      <label class="field" style="flex:1">
        <span>Want something specific tonight?</span>
        <input type="search" id="want-search" placeholder="chole bhature, biryani, paneer…" autocomplete="off">
      </label>
      <ul id="want-results" class="results"></ul>
      <div id="want-verdict"></div>
    </div>

    <div class="row-actions">
      ${r.suggestions.length ? `<button class="btn btn-primary" id="btn-accept-repair">Log ${r.suggestions.length === 1 ? 'this' : 'these'}</button>` : ''}
      ${spread && spread.perDay > 0 ? `<button class="btn" id="btn-apply-spread">Trim ${spread.perDay} kcal/day this week</button>` : ''}
      <button class="btn btn-quiet" id="btn-hide-repair">Dismiss</button>
    </div>
  `;

  const accept = $('#btn-accept-repair');
  if (accept) accept.onclick = () => {
    for (const sg of r.suggestions) {
      const o = sg.options[picks[sg.slot]];
      if (!o) continue;
      store.addEntry(viewDate, {
        kind: 'recipe', recipeId: o.recipeId, servings: o.servings, meal: sg.slot,
        label: o.name, portionLabel: `${o.servings} serving${o.servings === 1 ? '' : 's'}`,
      });
      const rec = db.recipesById[o.recipeId];
      if (rec) store.consumeFromPantry(rec.ing.map((i) => ({ food: i.food, g: i.g * o.servings })));
    }
    repairState = null;
    renderToday();
    toast('Added to today');
  };

  const sp = $('#btn-apply-spread');
  if (sp) sp.onclick = () => {
    store.update({ targetNudge: (store.state.targetNudge ?? 0) - spread.perDay });
    repairState = null;
    renderToday();
    toast(`Target trimmed ${spread.perDay} kcal a day`);
  };

  $('#btn-hide-repair').onclick = () => { box.hidden = true; };
}

/** "I want chole bhature" — answered with arithmetic, not permission. */
function renderWantResults(term) {
  const q = term.trim().toLowerCase();
  const box = $('#want-results');
  const verdict = $('#want-verdict');
  if (!q) { box.innerHTML = ''; verdict.innerHTML = ''; return; }

  const recipes = db.recipes.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 4);
  const foods = db.foods.filter((f) => matchesFood(f, q)).slice(0, 4);

  box.innerHTML = [
    ...recipes.map((r) => `<li><button data-want="r:${r.id}">
      ${icon(iconFor(r.name))}<span class="res-name">${escapeHtml(r.name)}</span>
      <span class="res-fig">see how it fits</span></button></li>`),
    ...foods.map((f) => `<li><button data-want="f:${f.id}">
      ${icon(iconFor(f))}<span class="res-name">${escapeHtml(f.name)}</span>
      <span class="res-fig">see how it fits</span></button></li>`),
  ].join('') || '<li class="empty">Nothing by that name.</li>';
}

function showFit(key) {
  const [kind, id] = [key.slice(0, 1), key.slice(2)];
  const { consumed, target: t } = repairState;

  const item = kind === 'r'
    ? { kind: 'recipe', id }
    : { kind: 'food', id, measureId: measuresFor(db, db.foodsById[id], units())[0]?.id ?? 'g' };

  const f = fitCheck(db, {
    target: t, consumed, item, servings: 1,
    katoriScale: store.state.katoriMl / 150,
    month: monthKey(),
    priceOverrides: store.state.priceOverrides,
  });
  if (!f) return;

  $('#want-verdict').innerHTML = `
    <div class="fit ${f.fits ? 'is-ok' : 'is-over'}">
      <p class="fit-msg">${escapeHtml(f.message)}</p>
      <p class="fit-figs">${escapeHtml(f.label)} — ${f.nutrition.kcal} kcal, ${f.nutrition.p} g protein, ₹${f.cost}</p>
      <button class="btn ${f.fits ? 'btn-primary' : ''}" data-logwant="${key}">${f.fits ? 'Log it' : 'Log it anyway'}</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Barcode scanning
// ---------------------------------------------------------------------------

async function handleBarcode(code) {
  toast('Looking it up…');
  const res = await lookupBarcode(code);

  if (!res.ok) { toast(res.reason); return; }

  store.addScanned(res.food);
  rebuildDb();
  closeScanPane();
  $('#food-search').value = res.food.name;
  renderResults(res.food.name);
  openPortionPad('food', res.food.id);
  toast(`Found ${res.food.name}${res.food.priceUnknown ? ' — tap the price to add what you paid' : ''}`);
}

function openScanPane() {
  const pane = $('#scan-pane');
  pane.hidden = false;
  $('#search-results').hidden = true;
  $('#portion-pad').hidden = true;

  if (canScan()) {
    scanFromCamera($('#scan-video'), { onError: (m) => toast(m) }).then((code) => {
      if (code) handleBarcode(code);
    });
  } else {
    toast('This browser cannot use the camera — type the digits instead.');
  }
}

function closeScanPane() {
  const v = $('#scan-video');
  if (v?._stopScan) v._stopScan();
  if (v?.srcObject) { v.srcObject.getTracks().forEach((t) => t.stop()); v.srcObject = null; }
  $('#scan-pane').hidden = true;
  $('#search-results').hidden = false;
}

// ---------------------------------------------------------------------------
// Kitchen
// ---------------------------------------------------------------------------

function kitchenMode() {
  return $('#kitchen-mode input:checked')?.value ?? 'cook';
}

function renderKitchen() {
  const mode = kitchenMode();
  $('#kitchen-cook').hidden = mode !== 'cook';
  $('#kitchen-stock').hidden = mode !== 'stock';
  $('#kitchen-all').hidden = mode !== 'all';
  if (mode === 'all') renderCook();

  const pantry = store.state.pantry;
  const ids = Object.keys(pantry);
  $('#kitchen-sub').textContent = ids.length
    ? `${ids.length} thing${ids.length === 1 ? '' : 's'} tracked`
    : 'Nothing listed yet';

  if (mode === 'cook') renderCookNow(ids);
  else if (mode === 'stock') renderPantry();
}

function renderCookNow(pantryIds) {
  const matches = pantryMatch(db, pantryIds, {
    profile: store.state.profile,
    month: monthKey(),
    priceOverrides: store.state.priceOverrides,
    dislikes: store.state.dislikes,
  });

  const ready = matches.filter((m) => m.canCookNow);
  const close = matches.filter((m) => !m.canCookNow && m.missing.length <= 2);

  $('#cook-now-note').textContent = pantryIds.length === 0
    ? 'Add what you have under "What I have" and this ranks what you can cook right now. Oil, ghee, sugar, tea, ginger, garlic, chilli and coriander are assumed present.'
    : `${ready.length} ready to cook, ${close.length} within a shop of it.`;

  const rows = [...ready, ...close].slice(0, 25);
  $('#cook-now-list').innerHTML = rows.length
    ? rows.map((m) => {
        const pct = Math.round(m.coverage * 100);
        const circ = 2 * Math.PI * 14;
        return `<li class="cook-row">
          ${icon(iconFor(m.name), 'dish')}
          <span class="cover ${m.canCookNow ? '' : 'is-partial'}">
            <svg viewBox="0 0 34 34" aria-hidden="true">
              <circle class="cov-track" cx="17" cy="17" r="14"></circle>
              <circle class="cov-fill" cx="17" cy="17" r="14"
                stroke-dasharray="${(m.coverage * circ).toFixed(1)} ${circ.toFixed(1)}"></circle>
            </svg>
            ${pct}
          </span>
          <span class="cook-main">
            <span class="cook-name">${escapeHtml(m.name)}</span>
            <span class="cook-sub">${m.canCookNow
              ? `everything in · ${m.timeMin} min`
              : `<span class="miss">need ${escapeHtml(m.missingNames.join(', '))}</span> · about ₹${m.missingCost}`}</span>
          </span>
          <span class="cook-figs">${m.nutrition.kcal} kcal · ${m.nutrition.p} p</span>
          <button class="link" data-cooknow="${m.recipeId}">Cook</button>
        </li>`;
      }).join('')
    : '<li class="empty">Nothing matches yet. Add a few ingredients under "What I have".</li>';
}

function renderPantry() {
  const pantry = store.state.pantry;
  const ids = Object.keys(pantry).sort((a, b) =>
    (db.foodsById[a]?.name ?? a).localeCompare(db.foodsById[b]?.name ?? b));

  $('#pantry-list').innerHTML = ids.length
    ? ids.map((id) => {
        const f = db.foodsById[id];
        const held = pantry[id];
        const counting = held.haveG != null;
        return `<li class="pitem">
          <div class="pi-head">
            <span class="pi-name">${escapeHtml(f?.name ?? id)}</span>
            <button class="pi-del" data-prm="${id}" aria-label="Remove ${escapeHtml(f?.name ?? id)}">✕</button>
          </div>
          <div class="pi-ctl">
            <div class="pi-seg" role="group" aria-label="How to track ${escapeHtml(f?.name ?? id)}">
              <button type="button" data-pmode="${id}:always" aria-pressed="${!counting}">Always have</button>
              <button type="button" data-pmode="${id}:count" aria-pressed="${counting}">Count it</button>
            </div>
            ${counting ? `
            <div class="pi-amount">
              <button type="button" class="pi-step" data-pstep="${id}:-100" aria-label="Less">−</button>
              <input class="pi-qty" type="number" inputmode="numeric" min="0" step="50"
                value="${held.haveG}" data-pq="${id}"
                aria-label="Amount of ${escapeHtml(f?.name ?? id)} in grams">
              <span class="pi-unit">g</span>
              <button type="button" class="pi-step" data-pstep="${id}:100" aria-label="More">+</button>
            </div>` : ''}
          </div>
        </li>`;
      }).join('')
    : `<li class="pantry-empty">
         <p class="pe-title">Nothing here yet</p>
         <p class="note">Search above for what is in your fridge and cupboard. Oil, ghee, sugar, tea, ginger, garlic, chilli and coriander are already assumed.</p>
       </li>`;
}

function renderPantrySearch(q) {
  const term = q.trim().toLowerCase();
  const box = $('#pantry-results');
  if (!term) { box.innerHTML = ''; return; }
  const held = store.state.pantry;

  const hits = db.foods
    .filter((f) => f.cat !== 'packaged' && f.cat !== 'eatingout')
    .filter((f) => matchesFood(f, term))
    .slice(0, 8);

  box.innerHTML = hits.length
    ? hits.map((f) => {
        const already = !!held[f.id];
        const staple = ASSUMED_STAPLES.has(f.id);
        return `<li><button data-padd="${f.id}" ${already ? 'disabled' : ''}>
          <span class="res-name">${escapeHtml(f.name)}${staple ? ' <span class="badge-scan">assumed</span>' : ''}</span>
          <span class="res-fig">${already ? 'already added' : 'Add'}</span>
        </button></li>`;
      }).join('')
    : '<li class="empty">No match. Try the English or Hindi name.</li>';
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function wireEvents() {
  $('#setup-form').addEventListener('input', updateSetupPreview);
  $('#setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const profile = readSetupForm();
    store.update({ profile, plan: null });
    $('#nav').hidden = false;
    show('today');
    toast(`Target set: ${currentTarget().kcal} kcal a day`);
  });

  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (btn) show(btn.dataset.screen);
  });

  $('#btn-prev-day').onclick = () => { viewDate = shiftDate(viewDate, -1); renderToday(); };
  $('#btn-next-day').onclick = () => {
    if (viewDate >= today()) return toast('That day hasn\'t happened yet');
    viewDate = shiftDate(viewDate, 1); renderToday();
  };

  $('#btn-open-log').onclick = openSheet;
  $('#btn-close-sheet').onclick = closeSheet;
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  $('#food-search').addEventListener('input', (e) => {
    $('#search-results').hidden = false;
    $('#portion-pad').hidden = true;
    pending = null;
    renderResults(e.target.value);
  });
  $('#meal-pick').addEventListener('change', () => { if (pending) renderPortionPad(); });

  $('#search-results').addEventListener('click', (e) => {
    const f = e.target.closest('[data-pick-food]');
    const r = e.target.closest('[data-pick-recipe]');
    if (f) openPortionPad('food', f.dataset.pickFood);
    if (r) openPortionPad('recipe', r.dataset.pickRecipe);
  });

  $('#portion-pad').addEventListener('click', (e) => {
    const m = e.target.closest('[data-measure]');
    const k = e.target.closest('[data-size]');
    const q = e.target.closest('[data-qty]');
    if (m) { pending.measureId = m.dataset.measure; pending.qty = 1; renderPortionPad(); }
    if (k) { pending.katoriSize = k.dataset.size; renderPortionPad(); }
    if (q) {
      const step = Number(q.dataset.qty);
      const floor = Math.abs(step) >= 10 ? 5 : 0.25;
      pending.qty = Math.max(floor, Math.round((pending.qty + step) * 100) / 100);
      renderPortionPad();
    }
    if (e.target.id === 'pp-save') savePending();
  });
  $('#portion-pad').addEventListener('input', (e) => {
    if (e.target.id === 'pp-qty') {
      pending.qty = Math.max(0.25, Number(e.target.value) || 1);
      const pos = e.target.selectionStart;
      renderPortionPad();
      const next = $('#pp-qty');
      if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch {} }
    }
  });

  $('#log-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { store.removeEntry(viewDate, del.dataset.del); renderToday(); }
  });

  // --- one-tap repeat logging ---
  $('#quick-log').addEventListener('click', (e) => {
    const plate = e.target.closest('[data-plate]');
    if (plate) { logPlate(plate.dataset.plate); return; }

    if (e.target.closest('#qbtn-browse')) { openSheet(); return; }

    const q = e.target.closest('[data-quick]');
    if (!q) return;
    const favs = $('#quick-log')._favs ?? [];
    const src = favs[Number(q.dataset.quick)];
    if (!src) return;

    // Same item, same portion, into whichever meal the clock implies.
    const meal = slotForNow();
    const { id, ...rest } = src;
    store.addEntry(viewDate, { ...rest, meal });
    if (src.kind === 'recipe') {
      const r = db.recipesById[src.recipeId];
      if (r) store.consumeFromPantry(r.ing.map((i) => ({ food: i.food, g: i.g * src.servings })));
    }
    renderToday();
    toast(`${src.label} added to ${MEAL_LABEL[meal].toLowerCase()}`);
  });

  $('#btn-regen').onclick = () => { buildPlan(); renderPlan(); toast('Rebuilt this week'); };

  $('#plan-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-day]');
    if (!t) return;
    planTabDay = Number(t.dataset.day);
    $$('#plan-tabs .tab').forEach((b) => b.setAttribute('aria-selected', b === t));
    renderPlanDay(store.state.plan, planTabDay);
  });

  $('#plan-day').addEventListener('click', (e) => {
    const cook = e.target.closest('[data-cook]');
    const logp = e.target.closest('[data-logplan]');
    const dis = e.target.closest('[data-dislike]');
    if (cook) {
      openAllRecipes(db.recipesById[cook.dataset.cook]?.name ?? '');
      const d = $(`[data-recipe="${cook.dataset.cook}"]`);
      if (d) { d.open = true; renderRecipeBody(cook.dataset.cook, 1); d.scrollIntoView({ block: 'center' }); }
    }
    if (logp) {
      const [idx, meal] = logp.dataset.logplan.split(':');
      const m = store.state.plan.days[Number(idx)].meals.find((x) => x.meal === meal);
      if (m) {
        store.addEntry(today(), {
          kind: 'recipe', recipeId: m.recipeId, servings: m.servings, meal,
          label: m.name, portionLabel: `${m.servings} serving${m.servings === 1 ? '' : 's'}`,
        });
        toast(`${m.name} logged to today`);
      }
    }
    if (dis) {
      store.toggleDislike(dis.dataset.dislike);
      buildPlan();
      renderPlan();
      toast('Rebuilt without it');
    }
  });

  $('#shopping').addEventListener('click', (e) => {
    const b = e.target.closest('[data-price]');
    if (!b) return;
    const id = b.dataset.price;
    const food = db.foodsById[id];
    const current = Math.round(pricePerKg(db, id, monthKey(), store.state.priceOverrides));
    const answer = prompt(`What does ${food.name} actually cost you, in ₹ per kg?`, current);
    if (answer === null) return;
    const val = Number(answer);
    if (!Number.isFinite(val) || val <= 0) return toast('Needs a number in rupees per kg');
    store.setPrice(id, val);
    buildPlan();
    renderPlan();
    toast(`${food.name} set to ₹${val}/kg`);
  });

  $('#btn-copy-list').onclick = async () => {
    const plan = store.state.plan;
    if (!plan?.days) return;
    const list = plan.shopping ?? shoppingList(db, plan, {
      household: store.state.profile.household ?? 1,
      month: plan.month,
      priceOverrides: store.state.priceOverrides,
      pantry: store.state.pantry,
    });
    const text = list.items.filter((i) => !i.alreadyHave)
      .map((i) => `${i.name} — ${i.buyLabel} (₹${i.cost})`).join('\n') +
      `\n\nTotal ₹${list.total}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Shopping list copied');
    } catch {
      toast('Copy failed — long-press the list to select it instead');
    }
  };

  $('#recipe-search').addEventListener('input', renderCook);
  $('#recipe-sort').addEventListener('change', renderCook);
  $('#recipe-list').addEventListener('toggle', (e) => {
    const d = e.target.closest('details[data-recipe]');
    if (d?.open) renderRecipeBody(d.dataset.recipe, store.state.profile.household ?? 1);
  }, true);
  $('#recipe-list').addEventListener('input', (e) => {
    const s = e.target.closest('[data-scale]');
    if (s) renderRecipeBody(s.dataset.scale, Math.max(1, Math.min(6, Number(s.value) || 1)));
  });
  $('#recipe-list').addEventListener('click', (e) => {
    const lr = e.target.closest('[data-logrecipe]');
    const dis = e.target.closest('[data-dislike]');
    if (lr) {
      const r = db.recipesById[lr.dataset.logrecipe];
      store.addEntry(today(), {
        kind: 'recipe', recipeId: r.id, servings: 1, meal: 'lunch',
        label: r.name, portionLabel: '1 serving',
      });
      toast(`${r.name} logged`);
    }
    if (dis) {
      store.toggleDislike(dis.dataset.dislike);
      store.update({ plan: null });
      renderCook();
      toast('Plans updated');
    }
  });

  $('#weight-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const kg = Number(new FormData(e.target).get('kg'));
    if (!kg) return;
    store.addWeight(today(), kg);
    store.update({ profile: { ...store.state.profile, weightKg: kg } });
    e.target.reset();
    renderYou();
    toast('Weigh-in added');
  });

  $('#katori-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ml = Number(new FormData(e.target).get('ml'));
    if (!ml) return;
    store.update({ katoriMl: ml, plan: null });
    renderYou();
    toast(`Katori set to ${ml} ml`);
  });

  $('#btn-export').onclick = () => {
    const blob = new Blob([store.export()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `victu-backup-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      store.import(await file.text());
      toast('Backup restored');
      show('today');
    } catch (err) {
      toast(err.message);
    }
    e.target.value = '';
  });

  $('#btn-reset').onclick = () => {
    if (!confirm('This erases your profile, every logged meal and every weigh-in on this device. There is no undo.')) return;
    store.reset();
    location.reload();
  };

  // --- food filter tabs ---
  $('#food-filter').addEventListener('click', (e) => {
    const t = e.target.closest('[data-filter]');
    if (!t) return;
    $$('#food-filter .tab').forEach((b) => b.setAttribute('aria-selected', b === t));
    $('#search-results').hidden = false;
    $('#portion-pad').hidden = true;
    pending = null;
    renderResults($('#food-search').value);
  });

  // --- scanning ---
  $('#btn-scan').onclick = openScanPane;
  $('#btn-scan-cancel').onclick = closeScanPane;
  $('#scan-manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code');
    if (code) handleBarcode(String(code).trim());
  });

  // --- day repair: switching options, and "I want X" ---
  $('#repair').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const [slot, i] = pick.dataset.pick.split(':');
      repairState.picks[slot] = Number(i);
      drawRepair();
      return;
    }
    const want = e.target.closest('[data-want]');
    if (want) { showFit(want.dataset.want); return; }

    const logw = e.target.closest('[data-logwant]');
    if (logw) {
      const key = logw.dataset.logwant;
      const [kind, id] = [key.slice(0, 1), key.slice(2)];
      const meal = slotForNow();
      if (kind === 'r') {
        const r = db.recipesById[id];
        store.addEntry(viewDate, {
          kind: 'recipe', recipeId: id, servings: 1, meal,
          label: r.name, portionLabel: '1 serving',
        });
        store.consumeFromPantry(r.ing.map((i) => ({ food: i.food, g: i.g })));
      } else {
        const food = db.foodsById[id];
        const measure = db.measuresById[measuresFor(db, food, units())[0]?.id ?? 'g'];
        const { storedG } = portionToStoredGrams({ food, measure, qty: 1, katoriScale: store.state.katoriMl / 150 });
        store.addEntry(viewDate, {
          kind: 'food', foodId: id, storedG, meal,
          label: food.name, portionLabel: `1 × ${measure?.label ?? 'g'}`,
        });
      }
      repairState = null;
      renderToday();
      toast('Logged');
    }
  });

  $('#repair').addEventListener('input', (e) => {
    if (e.target.id === 'want-search') renderWantResults(e.target.value);
  });

  $('#btn-fix-day').onclick = () => {
    const box = $('#repair');
    if (!store.entriesFor(viewDate).length) return toast('Log what you have eaten first');
    renderRepair();
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // --- kitchen ---
  $('#kitchen-mode').addEventListener('change', renderKitchen);
  $('#pantry-add').addEventListener('submit', (e) => e.preventDefault());
  $('#pantry-search').addEventListener('input', (e) => renderPantrySearch(e.target.value));
  $('#pantry-results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-padd]');
    if (!b) return;
    const f = db.foodsById[b.dataset.padd];
    store.setPantry(b.dataset.padd, null);
    $('#pantry-search').value = '';
    $('#pantry-results').innerHTML = '';
    renderKitchen();
    toast(`${f?.name ?? 'Added'} added`);
    $('#pantry-search').focus();
  });
  $('#pantry-list').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-prm]');
    if (rm) { store.removePantry(rm.dataset.prm); renderKitchen(); return; }

    const mode = e.target.closest('[data-pmode]');
    if (mode) {
      const [id, want] = mode.dataset.pmode.split(':');
      const held = store.state.pantry[id];
      if (want === 'always') {
        if (held?.haveG != null) { store.setPantry(id, null); renderKitchen(); }
      } else if (held?.haveG == null) {
        store.setPantry(id, 500);
        renderKitchen();
      }
      return;
    }

    const step = e.target.closest('[data-pstep]');
    if (step) {
      const [id, deltaStr] = step.dataset.pstep.split(':');
      const held = store.state.pantry[id];
      const base = held?.haveG ?? 0;
      const next = Math.max(0, base + Number(deltaStr));
      store.setPantry(id, next);
      renderKitchen();
    }
  });
  $('#pantry-list').addEventListener('change', (e) => {
    const q = e.target.closest('[data-pq]');
    if (!q) return;
    const v = q.value.trim();
    store.setPantry(q.dataset.pq, v === '' ? null : Math.max(0, Number(v) || 0));
    renderKitchen();
  });
  $('#cook-now-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cooknow]');
    if (!b) return;
    openAllRecipes(db.recipesById[b.dataset.cooknow]?.name ?? '');
    const d = $(`[data-recipe="${b.dataset.cooknow}"]`);
    if (d) { d.open = true; renderRecipeBody(b.dataset.cooknow, 1); d.scrollIntoView({ block: 'center' }); }
  });

  // --- mark shopping bought ---
  $('#btn-bought').onclick = () => {
    const plan = store.state.plan;
    if (!plan?.days) return;
    const list = plan.shopping ?? shoppingList(db, plan, {
      household: store.state.profile.household ?? 1,
      month: plan.month,
      priceOverrides: store.state.priceOverrides,
      pantry: store.state.pantry,
    });
    store.stockFromShopping(list.items);
    toast('Added to your kitchen');
    renderPlan();
  };

  $('#units-toggle').addEventListener('change', (e) => {
    const v = e.target.value;
    store.update({ profile: { ...store.state.profile, units: v } });
    renderYou();
    toast(v === 'grams' ? 'Grams first' : 'Katoris first');
  });

  $('#btn-you').onclick = () => show('you');
  $('#btn-you-back').onclick = () => show('today');

  $('#btn-edit-profile').onclick = () => {
    const p = store.state.profile;
    const f = $('#setup-form');
    for (const [k, v] of Object.entries(p)) {
      const el = f.elements[k];
      if (!el) continue;
      if (el instanceof RadioNodeList) [...el].forEach((r) => (r.checked = r.value === v));
      else el.value = v;
    }
    show('setup');
    updateSetupPreview();
  };
}

/** Name, Hindi, brand or alias - so "capsicum" finds Shimla mirch. */
function matchesFood(f, term) {
  if (!term) return true;
  return f.name.toLowerCase().includes(term) ||
         (f.hi ?? '').includes(term) ||
         (f.alias ?? '').toLowerCase().includes(term) ||
         (f.brand ?? '').toLowerCase().includes(term);
}

/** Jump to Kitchen's recipe browser with a search already filled in. */
function openAllRecipes(term = '') {
  show('kitchen');
  const allRadio = $('#kitchen-mode input[value="all"]');
  if (allRadio) allRadio.checked = true;
  renderKitchen();
  $('#recipe-search').value = term;
  renderCook();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
