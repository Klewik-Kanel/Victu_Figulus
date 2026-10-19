# Victu

An Indian diet tracker that counts katoris and rupees, not just calories.

It runs offline on your phone, knows what vegetables are in season in North
India, prices a week of food at Delhi rates, and refuses to plan a diet that
is too aggressive to be safe.

Nothing leaves your device. There is no account and no server.

---

## Run it

The app reads its data over HTTP, so it needs serving rather than opening the
file directly:

```bash
cd Victu_Figulus
python3 -m http.server 8777
# or: npx serve .
```

Open `http://localhost:8777`.

## Put it on your phone

1. Make your laptop and phone sit on the same wifi.
2. Find your laptop's local address (`ipconfig getifaddr en0` on a Mac).
3. On the phone, open `http://<that-address>:8777`.
4. Chrome's menu → **Add to Home screen**.

It now opens full screen, with no browser chrome, and works with the wifi off —
which is the point, because a kitchen is exactly where signal goes.

> Service workers and `localStorage` need a secure context. `localhost` counts;
> a bare LAN IP does not on some Android builds. If offline mode or saving
> misbehaves over wifi, run the server behind `ngrok http 8777` and use the
> https URL it prints.

## Test it

```bash
node --test tests/
```

58 tests covering the energy equations, the safety floors, katori and pack
conversion, seasonal pricing, the planner's constraints, day repair, pantry
matching and the shopping-list rounding.
Run these after touching anything in `js/core.js` — every number the app shows
a user comes from a function in there.

---

## What it does

**Knows about packets and eating out.** Lay's, Kurkure, Monster, Maggi, samosas,
chole bhature, restaurant dal makhani. Logged by the pack size actually sold —
"one ₹20 packet", not "estimate the grams". Anything missing, scan the barcode
and it is fetched from Open Food Facts and cached forever.

**Fixes the rest of your day, with options.** Had a Monster and two packets of
chips for lunch? Tap *Plan the rest* and it offers three choices for each
remaining meal — best fit, cheapest, quickest — and updates the projection as
you switch between them. You can also name something you want ("chole
bhature") and it tells you whether it fits, or what portion would. It will not starve you to pay for a bad
lunch, and past a point it says the day is gone and offers to spread the
surplus gently across the week instead.

**Cooks from what is in your kitchen.** List what you have; the Kitchen screen
ranks every recipe by how much of it is already in the house and names what is
missing and what that costs. Oil, ghee, sugar, tea, ginger, garlic, chilli and
coriander are assumed present, because nobody lists those.

**Repeats a meal in one tap.** Most people eat the same twenty things. The
Log again row on Today carries whatever you eat most, with the portion you
used last time, going into whichever meal the clock implies.

**Logs in the units you actually use.** A katori of dal, two rotis, a glass of
milk. Each resolves to grams of the food *as bought* — a katori of cooked dal
becomes the ~50 g of dry dal that went into it, which is what carries the
protein and what you paid for. Calibrate your own katori once in **You**, and
every katori you ever log scales to it.

**Plans a week against four constraints at once.** Calories and protein,
your monthly budget, what is in season this month, and your diet setting.
Output is seven days plus one consolidated shopping list with a running cost.

**Costs it the way you actually pay.** A recipe using 20 g of milk does not
cost 20 g worth of milk — you buy a 500 ml packet. Every food is marked as
sold in packs or sold loose, and the shopping list buys whole packs. The plan
shows three numbers: what you hand over at the till, what gets eaten this
week, and what stays in your cupboard for later.

**A salad every day.** Ten of them, Indian ones — kachumber, koshimbir, mooli
salad, sprouted moong — and the planner serves one alongside lunch or dinner
rather than leaving them in a list nobody opens. Raw vegetables are the
cheapest way to add volume and fibre to a deficit.

**Light or dark, your choice.** Set in You, defaulting to light. The app does
not follow your operating system unless you ask it to.

**Grams or katoris, your choice.** Set it at sign-up and change it any time in
You. On a kitchen scale everything leads with grams; without one you get
household measures. Neither mode removes the other — a scale owner can still
log a katori when eating out.

**Costs everything.** Every meal, every plan and every shopping list carries a
rupee figure. Tap any price in the shopping list to correct it; the correction
sticks and every later plan uses your number instead of the seeded one.

**Won't plan something unsafe.** Loss is capped at 0.75 kg/week, the deficit at
25% of maintenance, and intake at 1500 kcal for men / 1200 for women. When it
clamps your goal it says so rather than quietly overriding you.

**Adjusts weekly, not daily.** Daily weight is mostly water. The trend uses a
7-day average over at least two weeks, and it blames poor adherence before it
blames your target.

---

## What it does not do

- **Barcode search only works online, and only by barcode.** Open Food Facts
  throttles anonymous name-search, so typing "kurkure" never goes to the
  network — it searches the bundled catalogue. Scanning a barcode does go
  online, and caches the result forever.
- **Scanned products arrive without a price or a veg flag.** Open Food Facts
  doesn't carry Indian retail prices and its veg data is patchy. Set both once
  and they stick.
- **No cloud sync.** A lost phone is a lost log. Export from **You** sometimes.
- **Prices drift.** They were seeded in October 2026 from Dept. of Consumer
  Affairs figures and Delhi mandi averages. Correct them as you shop; the app
  learns and stops being wrong.
- **Packaged nutrition is from pack labels.** Lay's and Monster figures came
  straight out of Open Food Facts; the rest are good estimates. Scanning
  overwrites any of them with that pack's own data.
- **One region.** Seasonality is North India plains. The file is keyed for more
  regions; adding one is a data job, not a code job.
- **Nutrition is estimates.** Seeded from IFCT 2017 and USDA composites. Good
  enough to steer by, not lab truth.

---

## Where things are

```
index.html              app shell, every screen (Today, Plan, Kitchen, You)
css/app.css             the whole stylesheet
js/core.js              all the arithmetic, zero DOM - this is the real app
js/app.js               screens and interaction
js/store.js             localStorage, wrapped so a private window degrades
data/foods.json         nutrition + seeded Delhi prices, per 100 g as stored
data/portions.json      katori/roti/ladle to grams, and the thali shortcuts
data/seasonality.json   month x produce for North India, drives price + suggestions
data/recipes.json       48 recipes, quantities per serving
data/packaged.json      chips, drinks, biscuits, street food, restaurant dishes
js/lookup.js            the only file that touches the network (barcode lookup)
assets/icons.svg        the illustration set - original drawings, no brand marks
tests/core.test.mjs     run these before you trust a change
sw.js                   offline cache - bump VERSION when files change
```

The split that matters: **`core.js` has no DOM and no storage.** It is a pile of
pure functions, which is why the maths can be tested and why the whole thing can
be lifted into a native app later without rewriting the logic.

## Adding food

`data/foods.json`, one line per food, nutrition per 100 g **as stored** — dry
dal, raw vegetable, uncooked rice. `yieldFactor` is cooked weight ÷ raw weight,
and it is what lets a katori of cooked dal resolve back to dry grams.

Add a recipe in `data/recipes.json` with per-serving quantities in the same
as-stored grams. Never type a calorie count: it is computed from the
ingredients, and a hand-typed number that disagrees with them is the fastest way
to make a tracker lie.

Run the tests afterwards — they check that every ingredient resolves, that no
food's macros contradict its stated calories, and that seasonality doesn't
reference foods that don't exist.
