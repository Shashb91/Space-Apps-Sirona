# Sirona Maps

Plan a rover's drive between two points without slopes steeper than it can climb.

## Choosing the two points

- Type the **start (A)** and the **destination (B)**, or click the Moon: each click sets the next one. Click A or B again to remove it.
- **Steepest slope the rover can climb**: the route never goes up or down a steeper slope.
- **Prefer**: the **shortest way**, the **flattest way**, or a **balance** of both.
- **Search area**: how far around the two points the route may go, in degrees. A larger area finds detours but takes longer.

Then click **Find route**.

## The route

- It is drawn on the Moon, coloured by how close each stretch comes to the rover's slope limit, from easy to at the limit.
- The results give its length and its steepest slope.
- If no route exists within the search area, try a larger area or a rover that climbs steeper slopes.
- **Show the slope map** paints the slopes around, to see why the route bends.

## Good to know

Routes are found by the team's Python server, on a slope map of the whole Moon (LOLA). Without the server, this mode says so.
