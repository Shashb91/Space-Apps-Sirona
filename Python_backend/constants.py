"""
constants.py - physical constants and settings shared by the whole project.
"""
import os

R_MOON = 1737.4      # Moon radius [km]
R_SUN = 695700.0     # Sun radius [km]
R_EARTH = 6371.0     # Earth radius [km]
AU = 149597870.7     # astronomical unit [km]
S0 = 1361.0          # solar constant at 1 AU [W/m2]

ABCORR = "LT+S"      # SPICE aberration correction (light time + stellar aberration)

# Digital elevation model 
DEM_FILE = os.path.join(os.path.dirname(__file__), "ldem_64.tif")
DEM_PPD = 64         # raster pixels per degree
DEM_SCALE = 1.0      # factor to convert raster values to km (0.001 if the file is in metres)
DEM_LON0 = -180.0    # longitude of the raster's left edge (ldem_64.tif starts at 180° W)

# Slope map (optional, only needed for rover routes: "start"/"end" requests)
SLOPE_FILE = os.path.join(os.path.dirname(__file__), "ldem_64_slope.tif") 
SLOPE_PPD = 64     
SLOPE_SCALE = 1.0
SLOPE_LON0 = -180.0  # longitude of the raster's left edge (same layout as ldem_64.tif) 
