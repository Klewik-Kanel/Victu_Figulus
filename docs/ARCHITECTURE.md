# Architecture, and the decisions behind it

## Why a PWA and not Kotlin

A diet tracker lives or dies on whether logging dinner takes eight seconds. You
only find that out by using it daily, and you only get to daily use if the build
loop is instant. A PWA installs to the Android home screen, runs full screen,
works offline, keeps its own storage, and can be changed and reloaded in a
second.

What you give up: Play Store distribution, home-screen widgets, background
notifications, and health-platform integration. All four are reachable later
through Capacitor without rewriting the logic — see the last section.

## The shape of the code

```
     data/*.json          core.js              app.js
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ foods        │──▶│ pure maths   │◀──│ screens,     │
   │ portions     │   │ no DOM       │   │ events,      │
   │ seasonality  │   │ no storage   │   │ rendering    │
   │ recipes      │   │ testable     │   └──────┬───────┘
   └──────────────┘   └──────────────┘          │
                                         ┌──────▼───────┐
                                         │ store.js     │
                                         │ localStorage │
                                         └──────────────┘
```

One rule holds the whole thing together: **every number the user sees comes from
a function in `core.js`, and every function in `core.js` is runnable under
`node --test`.** Nothing is computed inside a render function, and nothing is
stored that could be derived. A diet tracker that cannot be tested is a diet
tracker that quietly lies, and you will not notice for three months.

## The decisions worth defending

### Nutrition is stored per 100 g *as bought*, never as cooked

Cooked weight depends on how much water your dal took and how long your rice
sat. As-bought weight is a fact about the packet. So `foods.json` is per 100 g
of dry dal, raw vegetable, uncooked rice, and each food carries a
`yieldFactor` (cooked ÷ raw) to convert.

This pays off twice. Nutrition and **price** share one basis — the 50 g of dry
dal in your katori is both ~11 g of protein and ~₹6 — so a recipe's cost and its
macros can never drift apart.

### Portions are katoris, and the katori is calibrated once

Asking someone to weigh a dal is asking them to stop using the app by Thursday.
So the logger speaks katori, roti, ladle, glass, and converts invisibly.

The weakness is obvious: your katori isn't mine. Rather than guessing per dish,
there is one calibration in **You** — fill your katori, tip it into a measuring
jug, type the number — and a single scale factor applies to every katori measure
forever. One question, asked once, fixes the largest error in the system.

Parathas and puris carry an `addFatG` that is logged as a **separate line**. Fat
off the tawa is the usual reason a day blows its target, and hiding it inside
the flour would make the tracker useless exactly where it matters most.

### Calories are never typed, only computed

No recipe stores a kcal figure. It is summed from ingredients every time. A
hand-typed number that disagrees with its own ingredient list is the most common
way nutrition data rots, and it rots silently.

A test enforces that each food's macros and stated calories agree. It checks a
*band* rather than an exact figure, because food tables genuinely disagree about
whether fibre contributes carbohydrate energy — USDA excludes it for vegetables,
IFCT often doesn't. The band is tight enough to catch a typo and wide enough not
to fight the sources.

### Prices are seeded, then learned

There is no free API for Indian retail prices. Checking several sources on the
same October day gave potato anywhere from ₹15 to ₹50/kg — the spread is itself
the finding, and it is why no single source could be trusted as ground truth.

So: seed from Dept. of Consumer Affairs figures for staples and mandi averages
for produce, modulate by seasonal availability, and let a user correction
override both permanently. The app gets less wrong every week you shop.

Seasonality drives price through a crude multiplier (peak 0.8× → off-season
2.2×). Crude, but directionally right, and overridden the moment you correct a
price by hand.

### The planner is a scorer, not an optimiser

A real constraint solver would return a mathematically perfect week of boiled
soya chunks that you would abandon by Wednesday. Instead each candidate meal is
scored on protein density, cost, seasonal fit, effort and recency, then a repair
loop raises the cost weight and re-runs until the week fits the budget.

Two deliberate behaviours:

- **Recency is a hard block, not a penalty.** Soya keema out-scores any soft
  penalty on protein-per-rupee, so without a block you eat it twice a day all
  week. Anything eaten today or yesterday is excluded outright.
- **It will not fake the budget.** If the cheapest sensible week at your protein
  target costs more than you have, it says so, states the gap in rupees, and
  explicitly says it has *not* quietly cut your food. An app that silently
  shrinks portions to hit a number is worse than useless.

### Weight advice is weekly, and suspicious of itself

Daily weight is mostly water. The trend needs fourteen days before it will claim
anything, and the weekly review checks **adherence before target**: if you hit
your calories on 40% of days, the target isn't the problem yet, and cutting it
further is the wrong move. It says so instead of cutting.

## What the food APIs actually do, tested rather than assumed

Before building anything on an external API, all three candidates were called
from a real browser. The results changed the design:

| What | Result | Consequence |
|---|---|---|
| Open Food Facts, **barcode** lookup | Works cross-origin, no key. Indian packs present with real sizes — found "Lays Classics Salted ₹20, 50 g, 554 kcal/100g" | Barcode scanning is the online feature worth building |
| Open Food Facts, **name search** | Throttled for anonymous users; all three search endpoints failed cross-origin | Search never goes online. The bundled catalogue is primary |
| TheMealDB, Indian recipes | **Zero** results on the free tier | No recipe API. Recipes stay curated and offline |

The instinct to "scrape the net for recipes" runs into two walls: browsers
cannot fetch arbitrary sites (CORS), and recipe method text is copyrighted.
Scraping would need a server to proxy it and would be republishing other
people's writing. Barcode lookup gets most of the same benefit legitimately:
the data is openly licensed, built for exactly this, and about the one thing a
curated file genuinely cannot keep up with — the thousands of packets on sale.

So `js/lookup.js` is the only file that touches the network, it only ever
fetches one barcode at a time, and everything it finds is cached locally. The
app works entirely offline with the network treated as a bonus, not a
dependency.

## Day repair: the junk-food feature that needed no AI

The hard-looking request — "I had a Monster and chips, adjust for it" — turned
out to be arithmetic. `repairDay()` takes what has already been eaten, works
out which meal slots are still to come, and suggests meals that land the day on
target. It weights protein harder than the weekly planner does, because the
food that blows a day is almost always protein-free.

Three refusals are deliberate:

- **It will not drop below the safety floor** to "pay back" a bad lunch.
  Under-eating at dinner to compensate for chips is how people end up bingeing
  at 11pm.
- **It will not pretend a blown day is fixable within that day.** Past the
  target it stops suggesting and says so.
- **It does not moralise.** The ultra-processed flag is a quiet badge, not a
  scold. An app that makes you feel bad about a packet of Lays is an app you
  stop opening, and an unlogged day is worse than an ugly one.

When the day really is gone, `spreadSurplus()` distributes the excess across
the days left in the week, capped at 200 kcal a day and never below the floor.
If it cannot be absorbed gently, it says so and quantifies what is left in
grams of body weight — usually a number small enough to stop worrying about.

## Pantry: persistent, hand-edited, and honest about what it knows

The pantry is deliberately a mix of two designs. Entries can carry a quantity
or not:

- **With a quantity** — decremented when you log a recipe that uses it, topped
  up when you mark the shopping list bought.
- **Without one** — "I always have this". Never decremented, never guessed at.

That split exists because auto-decrementing everything is what makes pantry
trackers rot. Nobody knows how much atta is in the dabba, so the app does not
pretend to; it tracks what it can count and leaves the rest alone.

`pantryMatch()` ranks by ingredient coverage first and nutrition second. At 8pm
the question is "what can I actually make", not "what is optimal".

### Two bugs worth recording

**CSS specificity, twice.** The pantry's quantity box stretched across its row
and sat on top of the item name, because the base rule `input[type="number"]
{ width: 100% }` (0,1,1) out-specifies the class `.pantry-qty` (0,1,0) that was
meant to make it narrow. Fixing that exposed the same trap one level up:
`.ledger li { display: flex }` out-specified `.pitem { display: block }`, so the
controls rode up beside the name instead of stacking under it.

Both are the hazard of broad element-level base rules in a hand-written
stylesheet. The rule now: a component that needs to escape a base rule either
matches its specificity (`input.pi-qty`) or does not opt into the shared class
at all (the pantry list is `.plist`, not `.ledger`). Neither bug threw anything
and neither was visible in a unit test — both were found by screenshotting the
real page.

### A silent data bug

Pack measures (`"₹20 packet (50 g)"`) were generated per-food on the fly but
never registered in `measuresById`, which is how the logger resolves a measure.
So picking "can (350 ml)" resolved to nothing, fell through to the base case,
and silently logged **one gram** — a Monster became 0.5 kcal.

Nothing threw. The number was just quietly wrong, which is the exact failure
mode a diet tracker must not have. It was caught by driving the real UI in a
browser rather than by any unit test, and there are now two regression tests
for it. The lesson is in the README's first rule: every number the user sees
comes from a tested function — and the path from UI to that function needs
testing too.

## v2: why it looks different

v1 borrowed the stainless steel of the thali and read, accurately, as a
spreadsheet. v2 borrows what sits *inside* the masala dabba instead —
turmeric, chilli, coriander, cumin — and confines those pigments almost
entirely to the illustrations, so the food is the colourful thing and the
interface around it stays quiet.

The ground is deep aubergine rather than the warm cream that nearly every
food app and nearly every generated design lands on. Turmeric is the only
interactive accent. Type moved from Bricolage Grotesque to **Fraunces** over
**Karla**, and the monospace data labels and `·`-joined meta strings of v1 are
gone — both read as template chrome rather than decisions.

### The thali, not a progress ring

The hero is a plate seen from above with four katoris, one per meal slot, each
filling from the bottom as that meal is logged. It replaces a donut chart.
A plate filling up is both faster to read and the actual subject of the app;
a ring is a chart about the subject.

First attempt placed the bowls on a ring of radius 38 and the lunch katori
swallowed the number in the middle. They now sit at radius 63 with r=19, which
is also where they sit on a real thali.

### Illustrations, not photographs

~16 original SVG drawings on a 32×32 grid, pigmented entirely through CSS
custom properties so one set serves both themes. No photographs (weight,
licensing) and no brand packaging — a packet of crisps is drawn as a generic
foil packet, because borrowing trade dress to label a food item is not
something this app needs to do.

Mapping food names to drawings is a short ordered rule list. Two bugs are
instructive: `/lassi/` with no word boundary matched **C-lassi-c** and drew a
packet of Lay's as a bowl of curd, and a generic `chaat` rule out-ranked the
ingredient rules so corn chaat became a crisp packet. Ordered regex lists need
word boundaries and need the specific rules above the generic ones.

### Navigation and speed

Five tabs became three. Cook folded into Kitchen as a third mode beside Cook
now and What I have; You moved behind a button in the Today header, since it
is somewhere you go twice a month.

Logging a repeat meal is now one tap: the Log again row ranks the last 30 days
by frequency, carries the portion forward, and picks the meal slot from the
clock. Anything new still goes through the sheet.

## Known weaknesses

| What | Why it matters | Fix |
|---|---|---|
| `serveWith` maps measures to foods by string prefix | A new `katori_*` measure silently defaults to atta | Put the food id in the measure definition |
| Seasonality covers one region | Wrong outside the North plains | Data, not code — the file is already keyed by region |
| The planner can pick odd serving counts (2.5 bowls of sprouts) | Reads as an app gaming its own score | Clamp per-recipe, or add a plausibility bound per meal type |
| No micronutrients | Iron, B12 and calcium matter on a vegetarian diet | IFCT has the columns; it is an extraction job |
| Scanned products have no price | Cost tracking silently under-reports until you set one | Prompt for price on first log of a scanned item |
| Pantry quantities drift | Decrementing assumes you cooked exactly the recipe | Accepted: quantities are optional for this reason |
| Coverage ranking favours short recipes | A 4-ingredient recipe outranks a better 7-ingredient one | Weight coverage by ingredient importance, not count |
| localStorage only | Lost phone, lost log | Export exists; IndexedDB + optional file-based backup is the next step |

## The protein problem, stated plainly

At ₹4,000/month for one person, the planner comfortably hits calories and lands
around **90–110 g of protein a day against a 120 g+ target**. The gap is real
and it is structural: vegetarian protein that is cheap (dal, soya, chana) is
also bulky, and you run out of room in the day before you run out of money.

Three honest ways to close it, in order of cost:

1. **Soya chunks.** ₹0.75 per gram of protein — nothing else is close. 40 g dry
   carries ~21 g protein for about eight rupees.
2. **A daily katori of curd and a glass of milk.** ~₹25/day for ~12 g.
3. **Paneer.** Excellent protein, ₹2.50+ per gram, and the single fastest way to
   break a ₹4,000 budget. The planner rations it deliberately.

If none of those appeal, lowering the protein target to ~1.3 g/kg is a
defensible choice and the app should say so rather than showing you a red number
every day. That's a change to `SAFETY.proteinGPerKg` in `core.js`.

## Getting to a real APK

When the design has stopped moving:

```bash
npm init -y
npm i -D @capacitor/cli @capacitor/core @capacitor/android
npx cap init Victu com.yourname.victu --web-dir=.
npx cap add android
npx cap sync
npx cap open android      # builds in Android Studio
```

`core.js`, the data files and the whole UI move across untouched — Capacitor
just wraps them in a WebView. What you then get access to:

- **Play Store** distribution and proper app signing.
- **Home-screen widget** showing calories and rupees left today. This is the one
  that actually changes behaviour, because it removes the step of opening
  anything.
- **Notifications** — a 9pm "log dinner" nudge, and the Sunday review.
- **Health Connect** for steps, which would replace the activity multiplier's
  guess with a measured number and make the whole TDEE estimate meaningfully
  better.
- **Reliable barcode scanning.** The web `BarcodeDetector` API is used where it
  exists (Chrome on Android, which is the target) and falls back to typing the
  digits everywhere else. A native wrapper would make this work consistently on
  every device.

The order I would do them in: widget, then Health Connect, then native
scanning. The widget is a weekend and changes daily behaviour; scanning already
works well enough in Chrome that a native version can wait.
