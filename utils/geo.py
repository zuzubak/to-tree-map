"""Street-network conventions shared across the mapping projects."""

# Centreline feature classes that count as "street" -- the local/arterial network
# people actually live on. Excludes expressways and their ramps (401, DVP,
# Gardiner): grade-separated through-routes that serve regional traffic rather than
# the blocks they pass over, and which are never street-tree frontage. Also excludes
# trails, walkways, rivers, shorelines, hydro corridors, rail and ferry routes.
#
# Same list the street-density project uses, so "metres of street" means the same
# thing on every map on the site.
STREET_CLASSES = [
    "Local", "Collector", "Major Arterial", "Minor Arterial", "Laneway",
    "Major Arterial Ramp", "Minor Arterial Ramp", "Collector Ramp",
    "Other Ramp", "Access Road", "Busway",
]

# How far from a centreline a tree may sit and still be counted as frontage on it.
# The City geocodes each tree to its street address, so a tree lands on the parcel,
# not the kerb -- deep lots on wide arterials need real slack. Beyond this a tree is
# left unassigned rather than attached to whatever happens to be nearest.
MAX_SNAP_M = 60
