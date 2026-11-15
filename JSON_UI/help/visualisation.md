# Visualisation

Explore the Moon and what is known about its surface. Tick the layers on the left to show them on the globe.

## Moving around

- **Left-drag** turns the Moon, **right-drag** moves it, the **scroll wheel** zooms. On a touch screen: drag, pinch and two-finger drag.
- **Click** anywhere on the Moon to read its latitude, longitude and elevation in the bottom-left panel.

## Layers

- **Space Missions**: every landing and impact, coloured by country. The list on the right filters them by country and by landing or crash. Click a mission to fly to it and read its description.
- **Noteworthy Locations**: craters, seas, poles and other places worth a look, listed on the right the same way.
- **Terrain smoothness**: how easy each geologic unit is to land on (smooth, medium or uneven), a rating by the team.
- **Geology**: the age of the surface, from the USGS *Unified Geologic Map of the Moon*.
- **Altitude**: the height above a sphere of 1,737.4 km, in colours with contour lines.
- **Slope**: how steep the ground is, averaged over about 2 km.
- **Water (H₂O)**: the water held in the soil, in parts per million. Places with no colour have no data.
- **Temperature**: the surface temperature at the date and time set under its colour bar (UTC), from the team's thermal model on a smooth Moon.

## Add a category

**+ Add a category** shows a map of your own on the globe. It must cover the whole Moon in longitude and latitude: twice as wide as tall, north at the top, as a PNG or a TIFF.

- The panel checks the file before you add it: its format, its shape, its georeferencing and its values.
- **Longitude of its left edge**: 180° W for a map laid out like the Moon's colour map, or 0° for a 0–360° map. When a GeoTIFF says where it is, its own value is picked, and you can still change it. The small preview shows where the map lands.
- Up to 4 categories. Each one gets its tick box, and **×** removes it.

## The bottom-left panel

- **Relief exaggeration**: makes the hills and craters taller, from 1× (true) to 5×.
- **Music**: the round button on the right plays or stops the music.
- **Coordinate grid**: latitude and longitude lines.
- **Direction arrows**: the yellow arrow points to the Sun, the green one to the Earth, at the time shown next to it.
- **Sunlight**: lights the Moon from the real Sun's direction instead of from the camera.
- **High resolution**: a 4 times sharper colour map over the area you zoom into. Zoom in to see it.

Some parts need the team's Python server (the arrows, Sunlight and Temperature). Without it, they say so.
