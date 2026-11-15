# Parametric Search

Find every place on the Moon that meets your criteria.

## Criteria

Add as many as you need with **+ Add a criterion**, then choose how they combine:

- **All must hold**: a place matches only if it meets every criterion.
- **Any one is enough**: the places meeting the most criteria come first.

What you can test:

- **The Sun**: how much of its disc shows, its elevation, the power reaching the ground, the surface temperature, and the longest night.
- **The Earth**: its elevation, whether a radio link is possible (Earth more than 5° up), and the longest gap without a link.
- **The ground**: water in the soil, slope, altitude, geology (the age of the surface) and terrain (how easy it is to land on).

## When

- **At some point during the period**, **True during the whole period** or **On average over the period**, from the start date, over the period and with the time step you set.
- **On the start date at 00:00 UTC**: one moment only. The longest night and the longest link gap still look at the whole period.

**Map detail** sets the spacing of the places tested: 2°, 1° or 0.5°. Finer is slower.

## Results

- With **All must hold**, the matching places are painted blue. A darker blue means it holds more often.
- With **Any one is enough**, the best areas are painted in red, green, pink and cyan, with an arrow on the safest spot of each (the farthest from its edge). Their panels on the right list what matters for a landing, with ✓ and ✗ for each criterion.
- Click **two panels** to compare them row by row: ▲ higher, ▼ lower, = the same. Click a panel again to take it out. You can rename an area by clicking its name.
- Click any spot on the Moon to see which criteria hold there, and open it in **Custom Point**.

## Export the areas (CSV)

**Export the areas (CSV)** saves the areas found as a spreadsheet, one row per area. The rows are ordered by how many criteria each area meets, then by size.

A small window first asks **how many areas** to save: type a number, or pick a quick choice (the ones shown, the first 10, the ones meeting all criteria, or all of them). The file holds the first ones in the list. **Cancel** stops it, even while the Sun and Earth values are being measured.

Its columns:

1. Rank, name, the number of criteria met and the number of criteria.
2. The location of the area's safest spot: latitude (°N) and longitude (°E).
3. The surface of the area, in km².
4. For each criterion: whether the area meets it, and its value at the safest spot. For the Sun and the Earth, the value is the one the search compared: the highest, the lowest or the mean over the period.

## Good to know

- The Sun and Earth criteria need the team's Python server. The ground criteria are read on the site's own maps and work without it.
- Hills and crater walls are taken into account when the server has the relief map. The results say whether they were.
