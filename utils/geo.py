"""Street-network conventions shared across the mapping projects."""

# Centreline feature classes that count as street-tree frontage -- the local/arterial
# network people actually live on. Excludes trails, walkways, rivers, shorelines, hydro
# corridors, rail and ferry routes, and two things worth naming:
#
# Expressways and their ramps (401, DVP, Gardiner): grade-separated through-routes that
# serve regional traffic rather than the blocks they pass over.
#
# Laneways: the City inventories almost no trees on them -- 3,918 of 4,146 laneway
# segments hold none at all, and the 343 km between them carry 1,514 trees, 0.2% of the
# inventory. Left in, they were two fifths of every block the density map coloured as
# "no street trees", which is a statement about what a laneway is rather than about
# Toronto's canopy. The handful of trees actually on one still get counted: they snap to
# whichever real street runs within 60 m instead.
#
# This is the street-density project's list minus that laneway exclusion, which is why
# "metres of street" is 5,278 km here against 5,622 km with laneways left in. The
# underlying network is the same; this map asks a narrower question of it.
STREET_CLASSES = [
    "Local", "Collector", "Major Arterial", "Minor Arterial",
    "Major Arterial Ramp", "Minor Arterial Ramp", "Collector Ramp",
    "Other Ramp", "Access Road", "Busway",
]

# How far from a centreline a tree may sit and still be counted as frontage on it.
# The City geocodes each tree to its street address, so a tree lands on the parcel,
# not the kerb -- deep lots on wide arterials need real slack. Beyond this a tree is
# left unassigned rather than attached to whatever happens to be nearest.
MAX_SNAP_M = 60
